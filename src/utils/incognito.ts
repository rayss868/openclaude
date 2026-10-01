/**
 * Incognito mode — process-local flag that strips memory and instruction
 * injections from the next context while leaving tools, MCP servers, and
 * reasoning untouched.
 *
 * Deliberately in-memory: it must not survive into the next session, so
 * nothing here touches settings.json or the environment.
 */
let incognitoEnabled = false

export function isIncognitoEnabled(): boolean {
  return incognitoEnabled
}

/**
 * Toggle incognito mode.
 *
 * Does not clear the memoized prompt sections or context caches — callers
 * must do that (via clearSystemPromptSections / clearConversation) so the
 * next turn rebuilds from disk under the new flag.
 */
export function setIncognitoEnabled(enabled: boolean): void {
  incognitoEnabled = enabled
}