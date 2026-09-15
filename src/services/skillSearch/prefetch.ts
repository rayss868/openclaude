import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getContentText } from '../../utils/messages/content.js'
import type { Attachment } from '../../utils/attachments.js'
import type { DiscoverySignal } from './signals.js'
import { searchLocalSkills } from './localSearch.js'

type SkillDiscoveryAttachment = Extract<
  Attachment,
  { type: 'skill_discovery' }
>

/** Opaque handle for an in-flight skill-discovery prefetch. */
export type SkillDiscoveryPrefetch = {
  promise: Promise<SkillDiscoveryAttachment[]>
}

/** Maximum number of skills to surface in one discovery attachment. */
const MAX_DISCOVERED_SKILLS = 10

/** Minimum query length before discovery is worth running. */
const MIN_QUERY_LENGTH = 3

/** Flat text (user input + recent message content) to search against. */
function queryTextWith(input: string | null, messages: Message[]): string {
  const recent = messages
    .slice(-6)
    .map(m => getContentText(m.content) ?? '')
    .join(' ')
  return [input ?? '', recent].join(' ').trim()
}

function buildDiscoveryAttachment(
  query: string,
  context: ToolUseContext,
  signal: DiscoverySignal,
): Promise<SkillDiscoveryAttachment> {
  return searchLocalSkills(
    query,
    context.options.commands,
    MAX_DISCOVERED_SKILLS,
  ).then(matches => ({
    type: 'skill_discovery' as const,
    signal,
    source: 'native' as const,
    skills: matches.map(m => ({
      name: m.command.name,
      description: m.command.description,
    })),
  }))
}

function runDiscovery(
  signal: DiscoverySignal,
  input: string | null,
  messages: Message[],
  context: ToolUseContext,
): Promise<Attachment[]> {
  const query = queryTextWith(input, messages)
  if (query.length < MIN_QUERY_LENGTH) {
    return Promise.resolve([])
  }
  return buildDiscoveryAttachment(query, context, signal).then(a =>
    a.skills.length > 0 ? [a] : [],
  )
}

/**
 * Kick off inter-turn skill discovery while the model streams. Returns a
 * handle callers can await later, or null when nothing is pending (e.g. the
 * query is too short to be worth searching).
 */
export function startSkillDiscoveryPrefetch(
  input: string | null,
  messages: Message[],
  context: ToolUseContext,
): SkillDiscoveryPrefetch | null {
  const query = queryTextWith(input, messages)
  if (query.length < MIN_QUERY_LENGTH) {
    return null
  }
  const promise = buildDiscoveryAttachment(
    query,
    context,
    'user_input',
  ).then(a => (a.skills.length > 0 ? [a] : []))
  return { promise }
}

/** Collect the results of a prefetch started above. */
export async function collectSkillDiscoveryPrefetch(
  pending: SkillDiscoveryPrefetch,
): Promise<Attachment[]> {
  return pending.promise
}

/**
 * Blocking turn-0 skill discovery from the user's input. Used on the first
 * message of a session where there is no streaming turn to prefetch into.
 */
export async function getTurnZeroSkillDiscovery(
  input: string | null,
  messages: Message[],
  context: ToolUseContext,
): Promise<Attachment[]> {
  return runDiscovery('user_input', input, messages, context)
}