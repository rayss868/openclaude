/**
 * Cross-platform local transport for Agent Hall.
 *
 * One abstraction over the built-in Node `net` module: on Windows the endpoint
 * is a named pipe (`\\.\pipe\...`), everywhere else it is a filesystem Unix
 * domain socket. Both are created through the same `server.listen(path)` API,
 * so the rest of Hall never branches on platform. No new dependency.
 */

import { mkdirSync } from 'fs'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'

const HALL_DIR_NAME = 'openclaude-hall'

/** Stable per-OS-user key used to namespace the scope directory and pipe name. */
function userScopeKey(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined) return `u${uid}`
  try {
    return userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '_')
  } catch {
    return 'default'
  }
}

/**
 * Per-user directory holding Hall discovery metadata and, on Unix, the socket.
 * On Windows this only holds metadata: named pipes are not filesystem entries.
 */
export function getHallScopeDir(): string {
  const dir = join(tmpdir(), HALL_DIR_NAME, userScopeKey())
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** The transport endpoint path passed to `server.listen()` / `net.connect()`. */
export function getHallEndpointPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${HALL_DIR_NAME}-${userScopeKey()}`
  }
  return join(getHallScopeDir(), 'hall.sock')
}

/**
 * Incremental newline framer. Sockets deliver arbitrary byte boundaries; Hall
 * frames are newline-delimited JSON, so callers push chunks and receive whole
 * lines.
 */
export class LineFramer {
  private buffer = ''
  private readonly maxBytes: number

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  /** Push a chunk; returns any complete lines it completed. */
  push(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    let idx = this.buffer.indexOf('\n')
    while (idx !== -1) {
      lines.push(this.buffer.slice(0, idx))
      this.buffer = this.buffer.slice(idx + 1)
      idx = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > this.maxBytes) {
      // A single unterminated frame exceeded the cap. Drop it rather than
      // growing without bound; the peer will be told INVALID_FRAME by timeout.
      this.buffer = ''
    }
    return lines
  }

  /** Return and clear any trailing bytes not yet terminated by a newline. */
  flush(): string {
    const rest = this.buffer
    this.buffer = ''
    return rest
  }
}
