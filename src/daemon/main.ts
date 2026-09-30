/**
 * `claude daemon` supervisor entrypoint.
 *
 * Runs the Agent Hall daemon: a per-user coordination server for independent
 * OpenClaude sessions (presence, advisory claims, peer messaging). The daemon
 * exits on its own after a period with zero connected sessions, so this entry
 * never supervises anything long-lived.
 *
 * The call site in entrypoints/cli.tsx does not catch errors (`await main()`),
 * so failures are swallowed and the process exits 0 rather than surfacing an
 * unhandled rejection. No import-time side effects.
 */

import { logForDebugging } from '../utils/debug.js'
import { runHallDaemon } from '../hall/run.js'

export async function daemonMain(args: string[]): Promise<void> {
  const idleTimeoutMs = parseIdleTimeout(args)
  try {
    await runHallDaemon(idleTimeoutMs === undefined ? {} : { idleTimeoutMs })
  } catch (err) {
    logForDebugging(`Hall daemon exited with error: ${(err as Error).message}`)
  }
}

/** `--idle-timeout-ms=<n>` overrides the default idle shutdown window. */
function parseIdleTimeout(args: string[]): number | undefined {
  const flag = args.find(a => a.startsWith('--idle-timeout-ms='))
  if (!flag) return undefined
  const value = Number(flag.slice('--idle-timeout-ms='.length))
  return Number.isFinite(value) && value > 0 ? value : undefined
}
