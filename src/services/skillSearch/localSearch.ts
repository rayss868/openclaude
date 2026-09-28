import memoize from 'lodash-es/memoize.js'

import type { Command } from '../../types/command.js'

export type SkillMatch = {
  name: string
  command: Command
  score: number
}

/** Minimum length for a query term to be considered. */
const MIN_TERM_LENGTH = 3

/** Minimum length for a mid-word substring to match at all. */
const MIN_SUBSTRING_LENGTH = 4

/** Minimum total score before a skill is reported as a match. */
const MIN_SCORE = 6

/** Maximum number of meaningful query terms considered. */
const MAX_TERMS = 8

/** Weight applied to matches in the skill name over its description. */
const NAME_WEIGHT = 2

/** Common English function words that carry no intent. */
const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','but','by','can','do','for','from','had',
  'has','have','he','her','his','how','i','if','in','is','it','its','me','my',
  'no','not','of','on','or','our','please','she','so','than','that','the',
  'their','them','then','there','these','they','this','to','up','was','we',
  'were','what','when','where','which','who','will','with','would','you','your',
])

const NON_WORD = /[^a-z0-9]/

/**
 * Score a query term against a skill's searchable text. Whole-word matches
 * rank highest, then word-prefix matches, then (for longer terms) substrings
 * inside a word. Short interior substrings are rejected so one- and two-letter
 * terms cannot score against nearly every skill.
 */
function scoreTerm(text: string, term: string): number {
  const idx = text.indexOf(term)
  if (idx === -1) return 0
  const boundaryStart = idx === 0 || NON_WORD.test(text.charAt(idx - 1))
  const end = idx + term.length
  const boundaryEnd = end >= text.length || NON_WORD.test(text.charAt(end))
  if (boundaryStart && boundaryEnd) return 10
  if (boundaryStart) return 6
  return term.length >= MIN_SUBSTRING_LENGTH ? 3 : 0
}

function scoreCommand(cmd: Command, terms: string[]): number {
  const nameText = cmd.name.replace(/^\//, '').toLowerCase()
  const descText = [cmd.description, cmd.whenToUse ?? '']
    .join(' ')
    .toLowerCase()
  let score = 0
  for (const term of terms) {
    const nameScore = scoreTerm(nameText, term)
    const descScore = scoreTerm(descText, term)
    score += Math.max(nameScore * NAME_WEIGHT, descScore)
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
 * by keyword overlap with the skill's name/description/whenToUse. Stopwords
 * and very short terms are dropped, partial words ("image") still find full
 * names ("imagegen-frontend-web"), and a minimum score keeps weak accidental
 * substring hits out of the results.
 */
export async function searchLocalSkills(
  query: string,
  commands: readonly Command[],
  maxResults = 10,
): Promise<SkillMatch[]> {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return []
  const terms = Array.from(
    new Set(
      trimmed
        .split(/\s+/)
        .filter(t => t.length >= MIN_TERM_LENGTH && !STOPWORDS.has(t)),
    ),
  ).slice(0, MAX_TERMS)

  const skills = await getLocalSkillIndex(commands)
  const scored: SkillMatch[] = []
  for (const command of skills) {
    const score = scoreCommand(command, terms)
    if (score >= MIN_SCORE) {
      scored.push({ name: command.name, command, score })
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, maxResults)
}