/**
 * Repeated-tool-error detection: nudge the model to stop blindly retrying.
 *
 * When the same tool fails with the same error several times in a row, retrying
 * unchanged is unlikely to help. After a threshold (default 3), we inject a
 * reminder telling the model to re-read the original request and the error.
 *
 * State is keyed per agent, mirroring doomLoop.ts: each agent tracks its own
 * consecutive identical failures.
 */

const DEFAULT_THRESHOLD = 3

interface ToolErrorState {
  lastTool: string | null
  lastError: string | null
  count: number
}

const stateByAgent = new Map<string, ToolErrorState>()

function getState(agentKey: string): ToolErrorState {
  let state = stateByAgent.get(agentKey)
  if (!state) {
    state = { lastTool: null, lastError: null, count: 0 }
    stateByAgent.set(agentKey, state)
  }
  return state
}

function normalizeText(text: string): string {
  // Collapse whitespace and digit runs so time-varying values (timestamps,
  // ports, line numbers) don't prevent matching a repeated error.
  return text.replace(/\s+/g, ' ').replace(/\d+/g, '#').trim()
}

function buildNudge(count: number): string {
  return `\n<system-reminder>This is the ${count}th consecutive failure of this tool with the same error. Do not simply retry — pause, re-read the original request and the error above, then adjust your approach.</system-reminder>`
}

/**
 * Record a tool failure and check whether the model should be nudged.
 * Returns the consecutive count and, once the threshold is reached, a nudge
 * text to append to the error message.
 */
export function recordRepeatedToolError(
  agentKey: string,
  toolName: string,
  errorText: string,
): { count: number; nudge?: string } {
  const state = getState(agentKey)
  const normalized = normalizeText(errorText)

  if (state.lastTool === toolName && state.lastError === normalized) {
    state.count++
  } else {
    state.lastTool = toolName
    state.lastError = normalized
    state.count = 1
  }

  if (state.count >= DEFAULT_THRESHOLD) {
    return { count: state.count, nudge: buildNudge(state.count) }
  }
  return { count: state.count }
}

/**
 * Reset the repeated-error tracking for a tool (e.g. after it succeeds).
 */
export function resetToolErrorRepeats(agentKey: string, toolName: string): void {
  const state = stateByAgent.get(agentKey)
  if (state && state.lastTool === toolName) {
    state.lastTool = null
    state.lastError = null
    state.count = 0
  }
}

/** Clear every agent's state. Test isolation only. */
export function resetAllToolErrorRepeats(): void {
  stateByAgent.clear()
}
