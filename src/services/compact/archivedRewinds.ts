import type { Message, UserMessage } from '../../types/message.js'
import { selectableUserMessagesFilter } from '../../utils/messageFilters.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { getContentText } from '../../utils/messages/content.js'

/**
 * A user prompt that was folded into a compact summary. Kept as a rewind point
 * even though the original message no longer exists in the transcript.
 */
export interface ArchivedRewind {
  /** Original user message uuid — also the fileHistory snapshot key. */
  uuid: string
  /** Prompt text (including any XML tags, e.g. <bash-input>). */
  text: string
  /** ISO timestamp of the original prompt. */
  ts: string
  /**
   * Uuid of the compact summary (or boundary) this prompt was folded into.
   * Conversation restore rewinds to that anchor and re-submits the prompt.
   */
  summaryUuid: string
}

/** Marker tag separating the archive payload from any surrounding text. */
export const ARCHIVED_REWINDS_TAG = '__archived_rewinds__'

export function isArchivedRewindsIndex(
  message: Message,
): message is UserMessage & { isArchivedRewindsIndex: true } {
  return message.type === 'user' && message.isArchivedRewindsIndex === true
}

/** Collect rewind-worthy prompts from a summarized message range. */
export function collectArchivedRewinds(
  toSummarize: Message[],
  summaryUuid: string,
): ArchivedRewind[] {
  const entries: ArchivedRewind[] = []
  const seen = new Set<string>()

  for (const message of toSummarize) {
    // selectableUserMessagesFilter skips synthetic/meta/transcript-only
    // messages, so archive-index messages themselves are never collected here.
    if (!selectableUserMessagesFilter(message)) continue
    const text = getContentText(message.message.content) ?? ''
    if (!text.trim()) continue
    if (seen.has(message.uuid)) continue
    seen.add(message.uuid)
    entries.push({ uuid: message.uuid, text, ts: message.timestamp, summaryUuid })
  }

  // Carry over entries from older archive-index messages inside the range so
  // prompts survive repeated compactions.
  for (const message of toSummarize) {
    if (!isArchivedRewindsIndex(message)) continue
    for (const entry of parseArchivedRewinds(message)) {
      if (seen.has(entry.uuid)) continue
      seen.add(entry.uuid)
      entries.push(entry)
    }
  }

  return entries
}

/** Build the transcript-only carrier message, or undefined when nothing to archive. */
export function createArchivedRewindsMessage(
  entries: ArchivedRewind[],
): UserMessage | undefined {
  if (entries.length === 0) return undefined
  return createUserMessage({
    content: `${ARCHIVED_REWINDS_TAG}\n${JSON.stringify(entries, null, 2)}`,
    isVisibleInTranscriptOnly: true,
    isArchivedRewindsIndex: true,
  })
}

export function parseArchivedRewinds(message: Message): ArchivedRewind[] {
  if (!isArchivedRewindsIndex(message)) return []
  const content =
    typeof message.message.content === 'string' ? message.message.content : ''
  const markerIndex = content.indexOf(ARCHIVED_REWINDS_TAG)
  if (markerIndex === -1) return []
  try {
    const parsed = JSON.parse(
      content.slice(markerIndex + ARCHIVED_REWINDS_TAG.length).trim(),
    )
    return Array.isArray(parsed)
      ? parsed.filter(isValidArchivedRewind)
      : []
  } catch {
    return []
  }
}

function isValidArchivedRewind(entry: unknown): entry is ArchivedRewind {
  if (typeof entry !== 'object' || entry === null) return false
  const e = entry as Record<string, unknown>
  return (
    typeof e.uuid === 'string' &&
    typeof e.text === 'string' &&
    typeof e.ts === 'string' &&
    typeof e.summaryUuid === 'string'
  )
}