import type { SerializedMessage } from '../types/logs.js'

export const SESSION_PREVIEW_MAX_MESSAGES = 12
export const SESSION_PREVIEW_HEAD_MESSAGES = 4
export const SESSION_PREVIEW_TAIL_MESSAGES = 8
export const SESSION_PREVIEW_MAX_MESSAGE_CHARS = 4_000
export const SESSION_PREVIEW_MAX_TOTAL_CHARS = 24_000

const TRUNCATION_MARKER = '[message truncated]'

export type SessionPreviewResult = {
  messages: SerializedMessage[]
  omittedMessageCount: number
  truncatedMessageCount: number
}

type TextResult = {
  text: string
  truncated: boolean
}

function truncateText(text: string, limit: number): TextResult {
  if (text.length <= limit) return { text, truncated: false }
  if (limit <= TRUNCATION_MARKER.length) {
    return { text: TRUNCATION_MARKER.slice(0, limit), truncated: true }
  }
  return {
    text: `${text.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`,
    truncated: true,
  }
}

const PRESERVED_STRING_KEYS = new Set([
  'type',
  'role',
  'id',
  'name',
  'tool_use_id',
  'toolUseID',
  'parentToolUseID',
  'uuid',
  'timestamp',
  'cwd',
  'userType',
  'sessionId',
  'version',
  'subtype',
  'level',
  'displayPath',
  'path',
  'filePath',
  'ideName',
])
const MAX_PRESERVED_STRING_CHARS = 256

type BoundValueResult = {
  value: unknown
  used: number
  truncated: boolean
}

function boundValue(
  value: unknown,
  limit: number,
  depth = 0,
  key?: string,
): BoundValueResult {
  if (typeof value === 'string') {
    const isMetadata = key !== undefined && PRESERVED_STRING_KEYS.has(key)
    if (!isMetadata && value.length > 0 && limit <= 0) {
      return { value: TRUNCATION_MARKER, used: 0, truncated: true }
    }
    const result = truncateText(
      value,
      isMetadata ? MAX_PRESERVED_STRING_CHARS : limit,
    )
    return {
      value: result.text,
      used: isMetadata ? 0 : result.text.length,
      truncated: result.truncated,
    }
  }

  if (value === null || typeof value !== 'object') {
    return { value, used: 0, truncated: false }
  }

  if (depth >= 6) {
    return { value: TRUNCATION_MARKER, used: 0, truncated: true }
  }

  if (Array.isArray(value)) {
    const bounded: unknown[] = []
    let used = 0
    let truncated = value.length > 64

    for (const item of value.slice(0, 64)) {
      const result = boundValue(item, Math.max(0, limit - used), depth + 1)
      bounded.push(result.value)
      used += result.used
      truncated ||= result.truncated
    }

    return { value: bounded, used, truncated }
  }

  const bounded: Record<string, unknown> = {}
  let used = 0
  let truncated = false
  const entries = Object.entries(value as Record<string, unknown>)

  for (const [entryKey, item] of entries.slice(0, 64)) {
    const result = boundValue(
      item,
      Math.max(0, limit - used),
      depth + 1,
      entryKey,
    )
    bounded[entryKey] = result.value
    used += result.used
    truncated ||= result.truncated
  }

  return {
    value: bounded,
    used,
    truncated: truncated || entries.length > 64,
  }
}

function boundMessage(
  message: SerializedMessage,
  messageBudget: number,
): { message: SerializedMessage; truncated: boolean; used: number } {
  const result = boundValue(message, messageBudget)
  return {
    message: result.value as SerializedMessage,
    truncated: result.truncated,
    used: result.used,
  }
}

export function createSessionPreview(
  messages: SerializedMessage[],
): SessionPreviewResult {
  const selected =
    messages.length > SESSION_PREVIEW_MAX_MESSAGES
      ? [
          ...messages.slice(0, SESSION_PREVIEW_HEAD_MESSAGES),
          ...messages.slice(-SESSION_PREVIEW_TAIL_MESSAGES),
        ]
      : [...messages]

  let used = 0
  let truncatedMessageCount = 0
  const boundedMessages = selected.map(message => {
    const remaining = Math.max(0, SESSION_PREVIEW_MAX_TOTAL_CHARS - used)
    const budget = Math.min(SESSION_PREVIEW_MAX_MESSAGE_CHARS, remaining)
    const result = boundMessage(message, budget)
    used += result.used
    if (result.truncated) truncatedMessageCount++
    return result.message
  })

  return {
    messages: boundedMessages,
    omittedMessageCount: Math.max(0, messages.length - selected.length),
    truncatedMessageCount,
  }
}
