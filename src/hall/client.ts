/**
 * HallClient: one per OpenClaude session.
 *
 * Discovers the live Hall endpoint, completes the handshake, registers
 * presence, and exposes the coordination API (task updates, advisory claims,
 * peer listing, messaging). Every failure is non-fatal: callers get `false`
 * from `start()` and the session continues without coordination.
 */

import { randomUUID } from 'crypto'
import type { Socket } from 'net'
import { connect } from 'net'
import { logForDebugging } from '../utils/debug.js'
import { createSignal } from '../utils/signal.js'
import type { Signal } from '../utils/signal.js'
import {
  decodeFrameLine,
  encodeFrame,
  makeFrame,
  MAX_FRAME_BYTES,
  type ClaimMode,
  type Frame,
  type FrameType,
  type WorkspaceRecord,
} from './protocol.js'
import { getHallEndpointPath, LineFramer } from './transport.js'

export type HallClientOptions = {
  sessionId: string
  agentName?: string
  workspace?: Partial<WorkspaceRecord>
  endpointPath?: string
  heartbeatIntervalMs?: number
  pid?: number
  requestTimeoutMs?: number
}

type Pending = {
  resolve: (frame: Frame) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  accept: (frame: Frame) => boolean
}

export class HallClient {
  private readonly sessionId: string
  private readonly agentName: string
  private readonly workspace: WorkspaceRecord
  private readonly endpointPath: string
  private readonly heartbeatIntervalMs: number
  private readonly pid: number
  private readonly requestTimeoutMs: number

  private socket: Socket | null = null
  private framer = new LineFramer(MAX_FRAME_BYTES)
  private readonly pending = new Map<string, Pending>()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private connected = false
  private readonly frameSignal: Signal<[Frame]> = createSignal()

  constructor(options: HallClientOptions) {
    this.sessionId = options.sessionId
    this.agentName = options.agentName ?? options.sessionId
    this.workspace = {
      raw_root: options.workspace?.raw_root ?? '',
      canonical_root: options.workspace?.canonical_root ?? '',
      ...options.workspace,
    }
    this.endpointPath = options.endpointPath ?? getHallEndpointPath()
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000
    this.pid = options.pid ?? process.pid
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000
  }

  get isConnected(): boolean {
    return this.connected
  }

  /** Subscribe to every inbound server frame. Returns an unsubscribe fn. */
  onFrame(listener: (frame: Frame) => void): () => void {
    return this.frameSignal.subscribe(listener)
  }

  /**
   * Connect, handshake, and register presence. Resolves `true` on success and
   * `false` on any failure (unreachable endpoint, bad handshake, timeout).
   */
  async start(): Promise<boolean> {
    try {
      await this.connectSocket()
      await this.request('hello', {})
      const registered = await this.request('session.register', {
        session_id: this.sessionId,
        agent_name: this.agentName,
        pid: this.pid,
        workspace: this.workspace,
      })
      if (registered.type !== 'session.registered') return false
      this.startHeartbeat()
      return true
    } catch (err) {
      logForDebugging(`HallClient.start failed: ${(err as Error).message}`)
      this.teardown()
      return false
    }
  }

  private connectSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = connect(this.endpointPath, () => {
        this.socket = socket
        this.framer = new LineFramer(MAX_FRAME_BYTES)
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => {
          for (const line of this.framer.push(chunk)) this.handleLine(line)
        })
        socket.on('error', () => this.teardown())
        socket.on('close', () => {
          if (!this.connected) return
          this.teardown()
        })
        this.connected = true
        resolve()
      })
      socket.once('error', err => reject(err))
    })
  }

  private handleLine(line: string): void {
    const result = decodeFrameLine(line)
    if (!result.ok) return
    const frame = result.frame
    this.frameSignal.emit(frame)
    const key = frame.request_id
    if (key) {
      const pending = this.pending.get(key)
      if (pending && pending.accept(frame)) {
        this.pending.delete(key)
        clearTimeout(pending.timer)
        pending.resolve(frame)
      }
    }
  }

  private request(
    type: FrameType,
    payload: Record<string, unknown>,
    accept: (frame: Frame) => boolean = f => f.type !== 'error',
  ): Promise<Frame> {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('Hall client is not connected'))
    }
    const requestId = randomUUID()
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Hall request ${type} timed out`))
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(requestId, { resolve, reject, timer, accept })
      socket.write(
        encodeFrame(makeFrame(type, payload, { session_id: this.sessionId, request_id: requestId })),
      )
    })
  }

  /** Fire-and-forget write for liveness frames that need no reply. */
  private write(type: FrameType, payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.destroyed) return
    this.socket.write(
      encodeFrame(makeFrame(type, payload, { session_id: this.sessionId })),
    )
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      this.write('heartbeat', {})
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref?.()
  }

  private teardown(): void {
    this.connected = false
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Hall connection closed'))
    }
    this.pending.clear()
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
  }

  /** Unregister presence and close the connection. Never throws. */
  async stop(): Promise<void> {
    if (this.connected && this.socket && !this.socket.destroyed) {
      try {
        await this.request('session.unregister', {})
      } catch {
        // Best effort: a failed unregister is corrected by the lease.
      }
    }
    this.teardown()
  }

  /** Publish a task presence update. Returns true when the daemon accepted it. */
  async updateTask(task: {
    title: string
    summary?: string
    status?: 'working' | 'waiting' | 'blocked' | 'done'
  }): Promise<boolean> {
    try {
      const reply = await this.request('task.update', task as Record<string, unknown>)
      return reply.type !== 'error'
    } catch {
      return false
    }
  }

  /** Acquire an advisory claim. Returns the claim id and any conflicts. */
  async claim(
    resource: string,
    mode: ClaimMode,
    resourceType: 'file' | 'dir' = 'file',
  ): Promise<{ claimId: string; conflicts: unknown[] } | null> {
    try {
      const reply = await this.request(
        'claim.acquire',
        { resource, mode, resource_type: resourceType },
        f => f.type === 'claim.acquired' || f.type === 'error',
      )
      if (reply.type !== 'claim.acquired') return null
      return {
        claimId: String(reply.payload.claim_id ?? ''),
        conflicts: Array.isArray(reply.payload.conflicts)
          ? (reply.payload.conflicts as unknown[])
          : [],
      }
    } catch {
      return null
    }
  }

  /** Release a claim. Returns true only if the daemon confirmed it. */
  async releaseClaim(claimId: string): Promise<boolean> {
    try {
      const reply = await this.request(
        'claim.release',
        { claim_id: claimId },
        f => f.type === 'claim.released' || f.type === 'error',
      )
      return reply.type === 'claim.released'
    } catch {
      return false
    }
  }

  /** List peers in the same workspace. Returns an empty array on failure. */
  async listPeers(): Promise<unknown[]> {
    try {
      const reply = await this.request('peer.list', {})
      return Array.isArray(reply.payload.peers)
        ? (reply.payload.peers as unknown[])
        : []
    } catch {
      return []
    }
  }

  /** List this session's active claims. Returns an empty array on failure. */
  async listClaims(): Promise<unknown[]> {
    try {
      const reply = await this.request('claim.list', {})
      return Array.isArray(reply.payload.claims)
        ? (reply.payload.claims as unknown[])
        : []
    } catch {
      return []
    }
  }

  /**
   * Send a peer message. `accepted` means the daemon accepted and delivered it
   * to a connected recipient; it does not mean the recipient acted on it.
   */
  async send(message: {
    destination: { kind: 'session'; session_id: string }
    messageType?: string
    correlationId?: string
    payload?: Record<string, unknown>
  }): Promise<boolean> {
    try {
      const reply = await this.request('message.send', {
        destination: message.destination,
        message_type: message.messageType ?? 'message',
        correlation_id: message.correlationId ?? null,
        payload: message.payload ?? {},
      })
      return reply.type === 'message.received'
    } catch {
      return false
    }
  }
}
