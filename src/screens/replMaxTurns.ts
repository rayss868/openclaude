export const DEFAULT_REPL_MAX_TURNS = Infinity

export function resolveReplMaxTurns(maxTurns?: number): number {
  return maxTurns ?? DEFAULT_REPL_MAX_TURNS
}
