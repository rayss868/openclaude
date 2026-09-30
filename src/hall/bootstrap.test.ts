import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureHallRunning,
  releaseBootstrapLock,
  tryAcquireBootstrapLock,
} from './bootstrap.js'
import { HallDaemon } from './daemon.js'

function lockPath(): string {
  return join(tmpdir(), `openclaude-hall-lock-${randomUUID()}.lock`)
}

function endpointPath(): string {
  const name = `openclaude-hall-boot-${process.pid}-${randomUUID().slice(0, 8)}`
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`
  return join(tmpdir(), `${name}.sock`)
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

describe('bootstrap lock election', () => {
  test('the first caller wins and a live owner blocks the second', () => {
    const path = lockPath()
    cleanups.push(() => {
      try {
        rmSync(path)
      } catch {
        // already gone
      }
    })

    expect(tryAcquireBootstrapLock(path)).toBe(true)
    expect(existsSync(path)).toBe(true)
    // The lock records this live process, so a second attempt must lose.
    expect(tryAcquireBootstrapLock(path)).toBe(false)

    releaseBootstrapLock(path)
    expect(existsSync(path)).toBe(false)
  })

  test('a stale lock owned by a dead PID is reclaimed', () => {
    const path = lockPath()
    cleanups.push(() => {
      try {
        rmSync(path)
      } catch {
        // already gone
      }
    })

    // PID 1 is never considered running by isProcessRunning (pid <= 1).
    writeFileSync(path, JSON.stringify({ pid: 1, started_at: new Date().toISOString() }))
    expect(tryAcquireBootstrapLock(path)).toBe(true)
  })

  test('an unreadable lock file is reclaimed rather than wedging the scope', () => {
    const path = lockPath()
    cleanups.push(() => {
      try {
        rmSync(path)
      } catch {
        // already gone
      }
    })

    writeFileSync(path, 'not json')
    expect(tryAcquireBootstrapLock(path)).toBe(true)
  })

  test('releasing a missing lock is a no-op', () => {
    expect(() => releaseBootstrapLock(lockPath())).not.toThrow()
  })
})

describe('ensureHallRunning', () => {
  test('returns the live endpoint when a Hall is already reachable', async () => {
    const endpoint = endpointPath()
    const daemon = new HallDaemon({ endpointPath: endpoint })
    await daemon.listen()
    cleanups.push(() => {
      void daemon.close()
    })

    const result = await ensureHallRunning({
      endpointPath: endpoint,
      probeTimeoutMs: 500,
      maxWaitMs: 500,
    })
    expect(result).toBe(endpoint)
  })

  test('elects a winner, spawns, and waits for readiness', async () => {
    const endpoint = endpointPath()
    let spawned: HallDaemon | null = null

    const result = await ensureHallRunning({
      endpointPath: endpoint,
      lockPath: lockPath(),
      spawnDaemon: () => {
        spawned = new HallDaemon({ endpointPath: endpoint })
        void spawned.listen()
      },
      probeTimeoutMs: 200,
      maxWaitMs: 3_000,
      pollIntervalMs: 50,
    })

    expect(result).toBe(endpoint)
    expect(spawned).not.toBeNull()
    cleanups.push(() => {
      if (spawned) void spawned.close()
    })
  })

  test('returns null when no Hall ever appears within the wait window', async () => {
    const result = await ensureHallRunning({
      endpointPath: endpointPath(),
      lockPath: lockPath(),
      spawnDaemon: () => {},
      probeTimeoutMs: 100,
      maxWaitMs: 300,
      pollIntervalMs: 50,
    })
    expect(result).toBeNull()
  })
})