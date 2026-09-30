import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HallClient } from './client.js'
import { HallDaemon, type HallDaemonOptions } from './daemon.js'

/** A unique per-test endpoint so concurrent test files never collide. */
function uniqueEndpoint(): string {
  const name = `openclaude-hall-test-${process.pid}-${randomUUID().slice(0, 8)}`
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`
  return join(tmpdir(), `${name}.sock`)
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

async function startDaemon(options: Partial<HallDaemonOptions> = {}) {
  const endpointPath = uniqueEndpoint()
  const discoveryPath = join(tmpdir(), `openclaude-hall-test-${randomUUID()}.json`)
  const daemon = new HallDaemon({ endpointPath, discoveryPath, ...options })
  await daemon.listen()
  cleanups.push(async () => {
    await daemon.close()
    try {
      rmSync(discoveryPath)
    } catch {
      // best effort
    }
  })
  return { daemon, endpointPath }
}

function makeClient(endpointPath: string, sessionId: string, extra = {}) {
  return new HallClient({
    sessionId,
    endpointPath,
    heartbeatIntervalMs: 50_000,
    requestTimeoutMs: 2_000,
    ...extra,
  })
}

describe('HallDaemon + HallClient over a real socket', () => {
  test('a client handshakes, registers, and appears as a peer', async () => {
    const { daemon, endpointPath } = await startDaemon()

    const a = makeClient(endpointPath, 'sess-a', {
      agentName: 'agent-a',
      workspace: { raw_root: '/w', canonical_root: '/w' },
    })
    const b = makeClient(endpointPath, 'sess-b', {
      agentName: 'agent-b',
      workspace: { raw_root: '/w', canonical_root: '/w' },
    })
    cleanups.push(() => a.stop())
    cleanups.push(() => b.stop())

    expect(await a.start()).toBe(true)
    expect(await b.start()).toBe(true)
    expect(daemon.getSessionCount()).toBe(2)

    const peers = await a.listPeers()
    expect(peers.length).toBe(1)
    expect((peers[0] as { agent_name: string }).agent_name).toBe('agent-b')
  })

  test('a task update is accepted and reflected in peer listing', async () => {
    const { endpointPath } = await startDaemon()
    const a = makeClient(endpointPath, 'sess-a')
    const b = makeClient(endpointPath, 'sess-b')
    cleanups.push(() => a.stop())
    cleanups.push(() => b.stop())
    await a.start()
    await b.start()

    expect(await b.updateTask({ title: 'Implementing claims', status: 'working' })).toBe(true)
    const peers = (await a.listPeers()) as Array<{ session_id: string; task: { title: string } }>
    const bPeer = peers.find(p => p.session_id === 'sess-b')
    expect(bPeer?.task.title).toBe('Implementing claims')
  })

  test('claims report conflicts across sessions but are still granted', async () => {
    const { endpointPath } = await startDaemon()
    const a = makeClient(endpointPath, 'sess-a')
    const b = makeClient(endpointPath, 'sess-b')
    cleanups.push(() => a.stop())
    cleanups.push(() => b.stop())
    await a.start()
    await b.start()

    const first = await a.claim('src/router.ts', 'write')
    expect(first?.claimId).toBeTruthy()
    expect(first?.conflicts).toEqual([])

    const second = await b.claim('src/router.ts', 'write')
    expect(second?.conflicts.length).toBe(1)
  })

  test('a released claim no longer conflicts', async () => {
    const { endpointPath } = await startDaemon()
    const a = makeClient(endpointPath, 'sess-a')
    const b = makeClient(endpointPath, 'sess-b')
    cleanups.push(() => a.stop())
    cleanups.push(() => b.stop())
    await a.start()
    await b.start()

    const first = await a.claim('src/x.ts', 'write')
    expect(await a.releaseClaim(first!.claimId)).toBe(true)
    const second = await b.claim('src/x.ts', 'write')
    expect(second?.conflicts.length).toBe(0)
  })

  test('peer messaging delivers to a connected target', async () => {
    const { endpointPath } = await startDaemon()
    const a = makeClient(endpointPath, 'sess-a')
    const b = makeClient(endpointPath, 'sess-b')
    cleanups.push(() => a.stop())
    cleanups.push(() => b.stop())
    await a.start()
    await b.start()

    const received: unknown[] = []
    b.onFrame(frame => {
      if (frame.type === 'message.received') received.push(frame.payload)
    })

    const ok = await a.send({
      destination: { kind: 'session', session_id: 'sess-b' },
      payload: { text: 'Are you touching router.ts?' },
    })
    expect(ok).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 100))
    expect(received.length).toBe(1)
    expect((received[0] as { from_session_id: string }).from_session_id).toBe('sess-a')
  })

  test('messaging an unknown session fails without throwing', async () => {
    const { endpointPath } = await startDaemon()
    const a = makeClient(endpointPath, 'sess-a')
    cleanups.push(() => a.stop())
    await a.start()
    const ok = await a.send({
      destination: { kind: 'session', session_id: 'ghost' },
      payload: { text: 'hi' },
    })
    expect(ok).toBe(false)
  })

  test('unregistering removes the session from the daemon', async () => {
    const { daemon, endpointPath } = await startDaemon()
    const a = makeClient(endpointPath, 'sess-a')
    await a.start()
    expect(daemon.getSessionCount()).toBe(1)
    await a.stop()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(daemon.getSessionCount()).toBe(0)
  })

  test('starting against a missing endpoint resolves false, not a throw', async () => {
    const a = makeClient(uniqueEndpoint(), 'sess-a')
    expect(await a.start()).toBe(false)
  })

  test('the daemon shuts down on its idle timer once empty', async () => {
    const { daemon, endpointPath } = await startDaemon({ idleTimeoutMs: 50 })
    const a = makeClient(endpointPath, 'sess-a')
    await a.start()
    await a.stop()
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(daemon.isClosed()).toBe(true)
  })
})
