/**
 * Hall daemon: the per-user coordination server.
 *
 * One process per OS-user scope listens on a local endpoint (named pipe on
 * Windows, Unix domain socket elsewhere). It owns the presence registry,
 * advisory claims, and peer message routing. State is ephemeral: on restart it
 * starts empty and clients re-register (tech spec section 16).
 */

import { randomUUID } from 'crypto'
import type { Server, Socket } from 'net'
import { createServer } from 'net'
import { logForDebugging } from '../utils/debug.js'
import {
  writeDiscovery,
  removeDiscovery,
  type DiscoveryMetadata,
} from './discovery.js'
import {
  decodeFrameLine,
  encodeFrame,
  makeFrame,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type Frame,
  type TaskRecord,
} from './protocol.js'
import { HallRegistry } from './registry.js'
import {
  getHallEndpointPath,
  LineFramer,
} from './transport.js'

export type HallDaemonOptions = {
  endpointPath?: string
  discoveryPath?: string
  idleTimeoutMs?: number
  heartbeatIntervalMs?: number
  sessionLeaseMs?: number
  claimLeaseMs?: number
  instanceId?: string
}

const DEFAULTS = {
  idleTimeoutMs: 10 * 60 * 1000,
  heartbeatIntervalMs: 15_000,
  sessionLeaseMs: 45_000,
  claimLeaseMs: 60_000,
}

type ConnState = {
  socket: Socket
  framer: LineFramer
  helloDone: boolean
  sessionId?: string
}

export class HallDaemon {
  readonly instanceId: string
  private readonly endpointPath: string
  private readonly idleTimeoutMs: number
  private readonly heartbeatIntervalMs: number
  private readonly sessionLeaseMs: number
  private readonly claimLeaseMs: number
  private readonly discoveryPath: string | undefined
  private readonly registry = new HallRegistry()
  private readonly connections = new Set<ConnState>()
  private server: Server | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private closing = false
  private readonly startedAtMs = Date.now()

  constructor(options: HallDaemonOptions = {}) {
    this.instanceId = options.instanceId ?? randomUUID()
    this.endpointPath = options.endpointPath ?? getHallEndpointPath()
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs
    this.sessionLeaseMs = options.sessionLeaseMs ?? DEFAULTS.sessionLeaseMs
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULTS.claimLeaseMs
    this.discoveryPath = options.discoveryPath
  }

  getEndpoint(): string {
    return this.endpointPath
  }

  getSessionCount(): number {
    return this.registry.sessionCount
  }

  /** True once `close()` has finished tearing the server down. */
  isClosed(): boolean {
    return this.closing && this.server === null
  }

  /** Start listening and publish discovery metadata. Resolves to the endpoint. */
  listen(): Promise<string> {
    if (this.server) return Promise.resolve(this.endpointPath)
    return new Promise<string>((resolve, reject) => {
      const server = createServer(socket => this.handleConnection(socket))
      server.once('error', reject)
      server.listen(this.endpointPath, () => {
        server.removeListener('error', reject)
        server.on('error', err =>
          logForDebugging(`Hall server error: ${err.message}`),
        )
        this.server = server
        this.publishDiscovery()
        this.sweepTimer = setInterval(
          () => this.sweep(),
          Math.max(5_000, this.heartbeatIntervalMs * 2),
        )
        this.sweepTimer.unref?.()
        // A daemon that starts and never gets a client must not linger forever.
        if (this.registry.sessionCount === 0) this.scheduleIdleShutdown()
        logForDebugging(`Hall ${this.instanceId} listening on ${this.endpointPath}`)
        resolve(this.endpointPath)
      })
    })
  }

  private publishDiscovery(): void {
    const meta: Omit<DiscoveryMetadata, 'schema' | 'protocol_version'> = {
      pid: process.pid,
      started_at: new Date().toISOString(),
      transport: process.platform === 'win32' ? 'pipe' : 'uds',
      endpoint: this.endpointPath,
      instance_id: this.instanceId,
    }
    writeDiscovery(meta, this.discoveryPath)
  }

  /** Stop accepting work, close all connections, and clear discovery. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.cancelIdleTimer()
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    for (const conn of this.connections) {
      conn.socket.destroy()
    }
    this.connections.clear()
    removeDiscovery(this.discoveryPath)
    await new Promise<void>(resolve => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      this.server = null
    })
  }

  private handleConnection(socket: Socket): void {
    if (this.closing) {
      socket.destroy()
      return
    }
    socket.setEncoding('utf8')
    const conn: ConnState = {
      socket,
      framer: new LineFramer(MAX_FRAME_BYTES),
      helloDone: false,
    }
    this.connections.add(conn)

    socket.on('data', (chunk: string) => {
      for (const line of conn.framer.push(chunk)) this.handleLine(conn, line)
    })
    socket.on('error', () => this.dropConnection(conn))
    socket.on('close', () => this.dropConnection(conn))
  }

  private handleLine(conn: ConnState, line: string): void {
    const result = decodeFrameLine(line)
    if (!result.ok) {
      const code =
        result.reason === 'version' ? 'PROTOCOL_UNSUPPORTED' : 'INVALID_FRAME'
      this.send(
        conn,
        makeFrame('error', { code, message: 'Rejected inbound frame', retryable: false }, {
          request_id: result.request_id ?? null,
        }),
      )
      return
    }
    this.dispatch(conn, result.frame)
  }

  private send(conn: ConnState, frame: Frame): void {
    if (conn.socket.destroyed) return
    conn.socket.write(encodeFrame(frame))
  }

  private broadcast(frame: Frame, exceptSessionId?: string): void {
    for (const conn of this.connections) {
      if (!conn.sessionId) continue
      if (exceptSessionId && conn.sessionId === exceptSessionId) continue
      this.send(conn, frame)
    }
  }

  private dispatch(conn: ConnState, frame: Frame): void {
    const reply = (type: Frame['type'], payload: Record<string, unknown>): void => {
      this.send(conn, makeFrame(type, payload, {
        session_id: conn.sessionId,
        request_id: frame.request_id ?? null,
      }))
    }
    const fail = (code: string, message: string): void => {
      reply('error', { code, message, retryable: false })
    }

    if (frame.type === 'hello') {
      conn.helloDone = true
      this.send(
        conn,
        makeFrame(
          'hello_ack',
          {
            instance_id: this.instanceId,
            server_version: PROTOCOL_VERSION,
            heartbeat_interval_ms: this.heartbeatIntervalMs,
            session_lease_ms: this.sessionLeaseMs,
          },
          { request_id: frame.request_id ?? null },
        ),
      )
      return
    }

    if (!conn.helloDone) {
      fail('SESSION_NOT_REGISTERED', 'Handshake required before other frames')
      return
    }

    switch (frame.type) {
      case 'session.register':
        this.onRegister(conn, frame, reply)
        break
      case 'session.unregister':
        this.onUnregister(conn, frame)
        break
      case 'heartbeat':
        this.onHeartbeat(conn, frame, fail)
        break
      case 'task.update':
        this.onTaskUpdate(conn, frame, fail)
        break
      case 'claim.acquire':
        this.onClaimAcquire(conn, frame, fail)
        break
      case 'claim.renew':
        this.onClaimRenew(conn, frame, fail)
        break
      case 'claim.release':
        this.onClaimRelease(conn, frame, fail)
        break
      case 'peer.list':
        this.onPeerList(conn, frame, reply, fail)
        break
      case 'claim.list':
        this.onClaimList(conn, frame, reply)
        break
      case 'message.send':
        this.onMessageSend(conn, frame, reply, fail)
        break
      case 'hall.status':
        this.onStatus(conn, frame, reply)
        break
      default:
        fail('INVALID_FRAME', `Unsupported frame type: ${frame.type}`)
    }
  }

  private onRegister(
    conn: ConnState,
    frame: Frame,
    reply: (type: Frame['type'], payload: Record<string, unknown>) => void,
  ): void {
    const p = frame.payload
    const sessionId =
      typeof p.session_id === 'string' && p.session_id
        ? p.session_id
        : frame.session_id
    if (!sessionId) {
      reply('error', { code: 'SESSION_NOT_REGISTERED', message: 'session_id required', retryable: false })
      return
    }
    const workspace = (p.workspace ?? {}) as Record<string, unknown>
    const now = new Date().toISOString()
    const record = {
      session_id: sessionId,
      agent_name: typeof p.agent_name === 'string' ? p.agent_name : sessionId,
      pid: typeof p.pid === 'number' ? p.pid : process.pid,
      started_at: now,
      connected_at: now,
      last_heartbeat: now,
      status: 'working' as const,
      workspace: {
        raw_root: String(workspace.raw_root ?? ''),
        canonical_root: String(workspace.canonical_root ?? ''),
      },
      task: {
        title: 'Working',
        status: 'working' as const,
        updated_at: now,
      },
    }
    this.registry.registerSession(record)
    conn.sessionId = sessionId
    this.cancelIdleTimer()

    const peers = this.registry.listSessions().filter(s => s.session_id !== sessionId)
    reply('session.registered', {
      session_id: sessionId,
      agent_name: record.agent_name,
      peer_count: peers.length,
      workspace_peer_count: this.registry.listWorkspacePeers(
        sessionId,
        record.workspace.canonical_root,
      ).length,
    })
    this.broadcast(
      makeFrame('session.joined', {
        session_id: sessionId,
        agent_name: record.agent_name,
      }, { session_id: sessionId }),
      sessionId,
    )
  }

  private onUnregister(conn: ConnState, frame: Frame): void {
    if (!frame.session_id) return
    this.registry.unregisterSession(frame.session_id)
    this.send(
      conn,
      makeFrame('session.left', { session_id: frame.session_id }, {
        session_id: frame.session_id,
        request_id: frame.request_id ?? null,
      }),
    )
    this.broadcast(
      makeFrame('session.left', { session_id: frame.session_id }, { session_id: frame.session_id }),
      frame.session_id,
    )
  }

  private onHeartbeat(
    conn: ConnState,
    frame: Frame,
    fail: (code: string, message: string) => void,
  ): void {
    if (!frame.session_id || !this.registry.touchHeartbeat(frame.session_id, new Date().toISOString())) {
      fail('SESSION_NOT_REGISTERED', 'Heartbeat for unknown session')
    }
  }

  private onTaskUpdate(
    conn: ConnState,
    frame: Frame,
    fail: (code: string, message: string) => void,
  ): void {
    if (!frame.session_id) return
    const p = frame.payload
    const task: TaskRecord = {
      title: typeof p.title === 'string' ? p.title : 'Working',
      summary: typeof p.summary === 'string' ? p.summary : undefined,
      status: (['working', 'waiting', 'blocked', 'done'] as const).includes(
        p.status as TaskRecord['status'],
      )
        ? (p.status as TaskRecord['status'])
        : 'working',
      updated_at: new Date().toISOString(),
    }
    const ok = this.registry.updateTask(frame.session_id, task)
    if (!ok) {
      fail('SESSION_NOT_REGISTERED', 'Task update for unknown session')
      return
    }
    this.send(
      conn,
      makeFrame('session.updated', { session_id: frame.session_id, task }, {
        session_id: frame.session_id,
        request_id: frame.request_id ?? null,
      }),
    )
    this.broadcast(
      makeFrame('session.updated', { session_id: frame.session_id, task }),
      frame.session_id,
    )
  }

  private onClaimAcquire(
    conn: ConnState,
    frame: Frame,
    fail: (code: string, message: string) => void,
  ): void {
    if (!frame.session_id) return
    const p = frame.payload
    const resource = typeof p.resource === 'string' ? p.resource : ''
    if (!resource) {
      fail('CLAIM_INVALID', 'resource required')
      return
    }
    const session = this.registry.getSession(frame.session_id)
    if (!session) {
      fail('SESSION_NOT_REGISTERED', 'Claim for unknown session')
      return
    }
    const { claim, conflicts } = this.registry.acquireClaim({
      sessionId: frame.session_id,
      workspaceId: session.workspace.canonical_root,
      resource,
      resourceType: p.resource_type === 'dir' ? 'dir' : 'file',
      mode: p.mode === 'read' ? 'read' : 'write',
      ttlMs: this.claimLeaseMs,
    })
    this.send(
      conn,
      makeFrame('claim.acquired', {
        claim_id: claim.claim_id,
        expires_at: claim.expires_at,
        conflicts,
      }, { session_id: conn.sessionId, request_id: frame.request_id ?? null }),
    )
    for (const conflict of conflicts) {
      this.broadcast(
        makeFrame('claim.conflict', {
          claim_id: claim.claim_id,
          resource: conflict.resource,
          holder_session_id: conflict.session_id,
        }),
      )
    }
  }

  private onClaimRenew(
    conn: ConnState,
    frame: Frame,
    fail: (code: string, message: string) => void,
  ): void {
    if (!frame.session_id) return
    const claimId = frame.payload.claim_id
    const claim =
      typeof claimId === 'string'
        ? this.registry.renewClaim(claimId, frame.session_id, this.claimLeaseMs)
        : null
    if (claim) {
      this.send(
        conn,
        makeFrame('claim.acquired', {
          claim_id: claim.claim_id,
          expires_at: claim.expires_at,
          conflicts: [],
        }, { session_id: conn.sessionId, request_id: frame.request_id ?? null }),
      )
    } else {
      fail('CLAIM_NOT_FOUND', 'Unknown claim')
    }
  }

  private onClaimRelease(
    conn: ConnState,
    frame: Frame,
    fail: (code: string, message: string) => void,
  ): void {
    if (!frame.session_id) return
    const claimId = frame.payload.claim_id
    const ok =
      typeof claimId === 'string' &&
      this.registry.releaseClaim(claimId, frame.session_id)
    if (ok) {
      this.send(
        conn,
        makeFrame('claim.released', { claim_id: claimId }, {
          session_id: conn.sessionId,
          request_id: frame.request_id ?? null,
        }),
      )
    } else {
      fail('CLAIM_NOT_FOUND', 'Unknown claim')
    }
  }

  private onPeerList(
    conn: ConnState,
    frame: Frame,
    reply: (type: Frame['type'], payload: Record<string, unknown>) => void,
    fail: (code: string, message: string) => void,
  ): void {
    const session = frame.session_id ? this.registry.getSession(frame.session_id) : undefined
    if (!session) {
      fail('SESSION_NOT_REGISTERED', 'Peer list for unknown session')
      return
    }
    const peers = this.registry
      .listWorkspacePeers(session.session_id, session.workspace.canonical_root)
      .map(s => ({
        session_id: s.session_id,
        agent_name: s.agent_name,
        status: s.status,
        task: s.task,
      }))
    reply('session.updated', { peers })
  }

  private onClaimList(
    conn: ConnState,
    frame: Frame,
    reply: (type: Frame['type'], payload: Record<string, unknown>) => void,
  ): void {
    reply('claim.acquired', {
      claims: this.registry.listClaims(frame.session_id),
    })
  }

  private onMessageSend(
    conn: ConnState,
    frame: Frame,
    reply: (type: Frame['type'], payload: Record<string, unknown>) => void,
    fail: (code: string, message: string) => void,
  ): void {
    const p = frame.payload
    const destination = p.destination as Record<string, unknown> | undefined
    const targetId =
      typeof destination?.session_id === 'string' ? destination.session_id : undefined
    let delivered = false
    if (targetId) {
      for (const target of this.connections) {
        if (target.sessionId !== targetId) continue
        this.send(
          target,
          makeFrame('message.received', {
            from_session_id: frame.session_id,
            message_type: p.message_type ?? 'message',
            correlation_id: p.correlation_id ?? null,
            payload: p.payload ?? {},
          }, { session_id: frame.session_id }),
        )
        delivered = true
        break
      }
    }
    if (!delivered) {
      fail('DESTINATION_NOT_FOUND', 'Target session is not connected')
      return
    }
    reply('message.received', { accepted: true, target: targetId })
  }

  private onStatus(
    conn: ConnState,
    frame: Frame,
    reply: (type: Frame['type'], payload: Record<string, unknown>) => void,
  ): void {
    reply('hello_ack', {
      instance_id: this.instanceId,
      session_count: this.registry.sessionCount,
      claim_count: this.registry.listClaims().length,
      uptime_ms: Date.now() - this.startedAtMs,
    })
  }

  private dropConnection(conn: ConnState): void {
    if (!this.connections.delete(conn)) return
    if (conn.sessionId) {
      this.registry.unregisterSession(conn.sessionId)
      this.broadcast(
        makeFrame('session.left', { session_id: conn.sessionId }, { session_id: conn.sessionId }),
        conn.sessionId,
      )
    }
    if (this.registry.sessionCount === 0) this.scheduleIdleShutdown()
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer || this.closing) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.registry.sessionCount !== 0) return
      void this.close()
    }, this.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  private cancelIdleTimer(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.broadcast(makeFrame('hall.shutdown_cancelled', {}))
  }

  private sweep(): void {
    const now = Date.now()
    const removed = this.registry.sweepStaleSessions(now, this.sessionLeaseMs)
    this.registry.sweepExpiredClaims(now)
    for (const sessionId of removed) {
      this.broadcast(makeFrame('session.left', { session_id: sessionId }, { session_id: sessionId }))
    }
    if (removed.length > 0 && this.registry.sessionCount === 0) {
      this.scheduleIdleShutdown()
    }
  }
}

