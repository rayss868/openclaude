/**
 * Per-session Hall lifecycle.
 *
 * Owns the single HallClient for the current OpenClaude session. Attach this to
 * the validated startup/shutdown points rather than creating a parallel session
 * lifecycle (tech spec section 26). Activation is opt-in at runtime via the
 * `agentHallEnabled` config key (toggled in `/config`) or the OPENCLAUDE_HALL
 * environment variable, so the default single-session behavior is unchanged
 * until a user asks for coordination.
 */

import { basename } from 'path'
import { getProjectRoot, getSessionId } from '../bootstrap/state.js'
import { getSystemContext } from '../context.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { getGlobalConfig } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { ensureHallRunning } from './bootstrap.js'
import { HallClient } from './client.js'
import { getHallEndpointPath } from './transport.js'

let client: HallClient | null = null
let startPromise: Promise<void> | null = null

/** Refresh the injected system context so peer changes appear next turn. */
function refreshHallContext(): void {
  getSystemContext.cache.clear?.()
}

/** Runtime gate: the `agentHallEnabled` config key, or the env var override. */
export function isHallEnabled(): boolean {
  if (getGlobalConfig().agentHallEnabled) return true
  const flag = process.env.OPENCLAUDE_HALL
  return flag === '1' || flag === 'true'
}

/**
 * Apply the `/config` toggle without a restart: enabling starts the session
 * client if it is not already running, disabling stops it. Non-fatal.
 */
export function applyHallSetting(enabled: boolean): void {
  if (enabled) {
    if (!startPromise) startPromise = startHallSession()
    return
  }
  void stopHallSession()
}

export function getHallClient(): HallClient | null {
  return client
}

type PeerSummary = {
  session_id?: string
  agent_name?: string
  status?: string
  task?: { title?: string }
}

/**
 * Formatted peer summary for automatic system-context injection. Returns null
 * when the client is not connected or no peers share this workspace, so the
 * context stays clean for solo sessions.
 */
export async function getHallPeersContext(): Promise<string | null> {
  const current = client
  if (!current || !current.isConnected) return null
  const peers = (await current.listPeers()) as PeerSummary[]
  if (!Array.isArray(peers) || peers.length === 0) return null
  const lines = peers.map(peer => {
    const name = peer.agent_name ?? peer.session_id ?? 'unknown'
    const status = peer.status ?? 'working'
    const title = peer.task?.title ? ` — ${peer.task.title}` : ''
    return `- ${name} [${status}]${title}`
  })
  return [
    `${peers.length} other OpenClaude session(s) active in this workspace (Agent Hall).`,
    ...lines,
    'Coordinate edits to shared files; run /hall for details.',
  ].join('\n')
}

/**
 * Start the session's Hall client if enabled. Idempotent and non-fatal: any
 * failure leaves the session running without coordination.
 */
export function startHallSessionIfEnabled(): Promise<void> {
  if (!isHallEnabled()) return Promise.resolve()
  if (!startPromise) startPromise = startHallSession()
  return startPromise
}

async function startHallSession(): Promise<void> {
  try {
    const endpoint = await ensureHallRunning({
      endpointPath: getHallEndpointPath(),
    })
    if (!endpoint) {
      logForDebugging('Agent Hall unavailable; continuing without coordination')
      return
    }
    const root = getProjectRoot()
    const sessionId = getSessionId()
    const workspaceName = basename(root) || root
    const session = new HallClient({
      sessionId,
      // Human-readable peer name instead of a raw UUID, kept unique with a
      // short session suffix when several sessions share the same workspace.
      agentName: `${workspaceName}#${sessionId.slice(0, 4)}`,
      endpointPath: endpoint,
      workspace: { raw_root: root, canonical_root: root },
    })
    if (!(await session.start())) return
    client = session
    registerCleanup(() => session.stop())
    // Publish the workspace name as the task so peers do not all read as
    // "Working". Fire-and-forget: the daemon broadcast refreshes peer context.
    void session.updateTask({ title: workspaceName, status: 'working' })
    // Peer joins/leaves/task updates change what the model should know.
    session.onFrame(frame => {
      if (
        frame.type === 'session.joined' ||
        frame.type === 'session.left' ||
        frame.type === 'session.updated'
      ) {
        refreshHallContext()
      }
    })
    refreshHallContext()
    logForDebugging('Agent Hall session registered')
  } catch (err) {
    logForDebugging(`Agent Hall session start failed: ${(err as Error).message}`)
  }
}

/** Stop and forget the session client, if any. */
export async function stopHallSession(): Promise<void> {
  const current = client
  client = null
  startPromise = null
  refreshHallContext()
  if (current) await current.stop()
}
