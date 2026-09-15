import memoize from 'lodash-es/memoize.js'

import type { Command } from '../../types/command.js'

export type SkillMatch = {
  name: string
  command: Command
  score: number
}

/**
 * Build a searchable text blob for a skill command: the display name (minus
 * the leading slash, which is not part of the name), description, and
 * when-to-use guidance (if present). Lowercased for case-insensitive
 * matching.
 */
function skillSearchText(cmd: Command): string {
  return [cmd.name.replace(/^\//, ''), cmd.description, cmd.whenToUse ?? '']
    .join(' ')
    .toLowerCase()
}

/**
 * Score a query term against a skill's searchable text. Simple word
 * tokenization with substring fallback — enough to match partial words
 * ("image" finds "imagegen") while keeping exact terms ranked highest.
 */
function scoreTerm(text: string, term: string): number {
  if (!term) return 0
  const idx = text.indexOf(term)
  if (idx === -1) return 0
  // Exact word match scores highest; prefix and substring score lower.
  if (new RegExp(`(^|\\s)${escapeRegExp(term)}(\\s|$)`).test(text)) {
    return 10
  }
  if (idx === 0) {
    return 6
  }
  return 3
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function scoreCommand(cmd: Command, terms: string[]): number {
  const text = skillSearchText(cmd)
  let score = 0
  for (const term of terms) {
    score += scoreTerm(text, term)
  }
  return score
}

/**
 * Memoized index of model-invocable skills coming from the current session's
 * command list (bundled skills, /skills dirs, MCP-provided commands). The
 * list is keyed by command names so a changing MCP skill set invalidates
 * the cache entry.
 */
export const getLocalSkillIndex = memoize(
  async (commands: readonly Command[]): Promise<Command[]> => {
    return commands.filter(isSearchableSkill)
  },
  (commands: readonly Command[]) => commands.map(c => c.name).join(','),
)

/**
 * A command is a searchable skill when it's a model-invocable prompt command
 * from a skill source (bundled, skills dir, plugin, MCP, or legacy commands).
 */
function isSearchableSkill(cmd: Command): boolean {
  return (
    cmd.type === 'prompt' &&
    cmd.source !== 'builtin' &&
    !cmd.disableModelInvocation &&
    (cmd.loadedFrom === 'bundled' ||
      cmd.loadedFrom === 'skills' ||
      cmd.loadedFrom === 'plugin' ||
      cmd.loadedFrom === 'mcp' ||
      cmd.loadedFrom === 'commands_DEPRECATED' ||
      cmd.hasUserSpecifiedDescription ||
      cmd.whenToUse !== undefined)
  )
}

/**
 * Invalidate the local skill index (called when commands/MCP skills change).
 */
export function clearSkillIndexCache(): void {
  getLocalSkillIndex.cache.clear?.()
}

/**
 * Search the local skill index for the given query. Returns matches scored
 * by keyword overlap with the skill's name/description/whenToUse. Substring
 * matching means partial words ("image") still find full names
 * ("imagegen-frontend-web").
 */
export async function searchLocalSkills(
  query: string,
  commands: readonly Command[],
  maxResults = 10,
): Promise<SkillMatch[]> {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return []
  const terms = trimmed.split(/\s+/).slice(0, 8)

  const skills = await getLocalSkillIndex(commands)
  const scored: SkillMatch[] = []
  for (const command of skills) {
    const score = scoreCommand(command, terms)
    if (score > 0) {
      scored.push({ name: command.name, command, score })
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, maxResults)
}