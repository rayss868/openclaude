/**
 * Singleton bootstrap for the Hall daemon.
 *
 * Only one Hall may run per OS-user scope. Election uses an exclusive-create
 * lock file (`O_EXCL`) carrying validated PID metadata, so a crashed owner
 * cannot wedge the scope: a live PID keeps the lock, a dead PID is reclaimed.
 * The winner rechecks for a live endpoint, spawns a detached daemon, and waits
 * a bounded time for readiness; losers simply wait for the winner to publish.
 */

import { spawn } from 'child_process'
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'fs'
import { connect } from 'net'
import { join } from 'path'
import { isProcessRunning } from '../utils/nativeInstaller/pidLock.js'
import { readDiscovery } from './discovery.js'
import {
  decodeFrameLine,
  encodeFrame,
  makeFrame,
  MAX_FRAME_BYTES,
} from './protocol.js'
import { getHallScopeDir, LineFramer } from './transport.js'

export const BOOTSTRAP_LOCK_NAME = 'hall.lock'

export function getBootstrapLockPath(): string {
  return join(getHallScopeDir(), BOOTSTRAP_LOCK_NAME)
}

export type SpawnDaemon = () => void

/**
 * Try to become the bootstrap winner. Returns true only for the process that
 * created the lock file, or reclaimed a lock whose owner is dead.
 */
export function tryAcquireBootstrapLock(
  lockPath: string = getBootstrapLockPath(),
): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(
        fd,
        JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
      )
      closeSync(fd)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false
      if (attempt === 1) return false

      // A lock exists. Reclaim it only when its owner is demonstrably dead.
      let ownerPid: number | undefined
      try {
        const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null) {
          const pid = (parsed as Record<string, unknown>).pid
          if (typeof pid === 'number') ownerPid = pid
        }
      } catch {
        ownerPid = undefined
      }

      if (ownerPid !== undefined && isProcessRunning(ownerPid)) return false

      try {
        unlinkSync(lockPath)
      } catch {
        return false
      }
    }
  }
  return false
}

export function releaseBootstrapLock(
  lockPath: string = getBootstrapLockPath(),
): void {
  try {
    unlinkSync(lockPath)
  } catch {
    // Already released.
  }
}

/** Connect to the endpoint and complete a handshake, bounded by a timeout. */
export function probeEndpoint(
  endpointPath: string,
  timeoutMs = 1_000,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }

    const socket = connect(endpointPath)
    const framer = new LineFramer(MAX_FRAME_BYTES)
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()

    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(encodeFrame(makeFrame('hello', {})))
    })
    socket.on('data', (chunk: string) => {
      for (const line of framer.push(chunk)) {
        const result = decodeFrameLine(line)
        if (result.ok && result.frame.type === 'hello_ack') finish(true)
      }
    })
    socket.on('error', () => finish(false))
  })
}

export type EnsureHallOptions = {
  endpointPath: string
  spawnDaemon?: SpawnDaemon
  probeTimeoutMs?: number
  maxWaitMs?: number
  pollIntervalMs?: number
  lockPath?: string
}

/** Default detached spawn of the built CLI's `daemon` command. */
function defaultSpawnDaemon(): void {
  const entry = process.argv[1]
  if (!entry) return
  const child = spawn(process.execPath, [entry, 'daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

/**
 * Ensure a live Hall is reachable, starting one if needed. Returns the endpoint
 * on success and null when no Hall could be reached within the wait window.
 */
export async function ensureHallRunning(
  options: EnsureHallOptions,
): Promise<string | null> {
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_000
  const maxWaitMs = options.maxWaitMs ?? 5_000
  const pollIntervalMs = options.pollIntervalMs ?? 100
  const spawnDaemon = options.spawnDaemon ?? defaultSpawnDaemon

  if (await probeEndpoint(options.endpointPath, probeTimeoutMs)) {
    return options.endpointPath
  }

  const lockPath = options.lockPath ?? getBootstrapLockPath()
  const deadline = Date.now() + maxWaitMs

  if (tryAcquireBootstrapLock(lockPath)) {
    try {
      // Recheck after winning: another process may have published meanwhile.
      if (await probeEndpoint(options.endpointPath, probeTimeoutMs)) {
        return options.endpointPath
      }
      spawnDaemon()
      while (Date.now() < deadline) {
        if (await probeEndpoint(options.endpointPath, pollIntervalMs)) {
          return options.endpointPath
        }
        await delay(pollIntervalMs)
      }
      return null
    } finally {
      releaseBootstrapLock(lockPath)
    }
  }

  // Lost the election: wait for the winner to publish a reachable endpoint.
  while (Date.now() < deadline) {
    const discovered = readDiscovery()
    if (
      discovered &&
      (await probeEndpoint(discovered.endpoint, pollIntervalMs))
    ) {
      return discovered.endpoint
    }
    await delay(pollIntervalMs)
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
