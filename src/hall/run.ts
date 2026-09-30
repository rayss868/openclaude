/**
 * Hall daemon process entrypoint.
 *
 * `daemonMain` in `src/daemon/main.ts` calls this when the CLI runs
 * `claude daemon`. The process stays alive until the idle timer closes the
 * daemon (zero sessions for the configured window) or a termination signal
 * arrives. The returned promise resolves once the server has fully stopped.
 */

import { logForDebugging } from '../utils/debug.js'
import { HallDaemon, type HallDaemonOptions } from './daemon.js'

export type RunHallOptions = HallDaemonOptions & {
  /** Override signal wiring, used by tests to avoid touching process state. */
  installSignalHandlers?: boolean
}

/**
 * Start a Hall daemon and keep the process alive until it closes. Resolves to
 * the exit code the caller should use (always 0; Hall failures are non-fatal).
 */
export async function runHallDaemon(options: RunHallOptions = {}): Promise<number> {
  const daemon = new HallDaemon(options)

  if (options.installSignalHandlers !== false) {
    const onSignal = (): void => {
      void daemon.close()
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  }

  try {
    const endpoint = await daemon.listen()
    logForDebugging(`Hall daemon running at ${endpoint}`)
  } catch (err) {
    // Another Hall already owns the endpoint, or the platform refused it.
    // Either way the daemon is not needed; exit cleanly.
    logForDebugging(`Hall daemon failed to start: ${(err as Error).message}`)
    await daemon.close()
    return 0
  }

  await new Promise<void>(resolve => {
    // Ref'd, not unref'd: once the server closes, this timer must outlive the
    // drained event loop long enough to resolve, or Node exits 13 on an
    // unsettled top-level await instead of returning cleanly.
    const timer = setInterval(() => {
      if (daemon.isClosed()) {
        clearInterval(timer)
        resolve()
      }
    }, 250)
  })

  return 0
}
