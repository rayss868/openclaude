import { open, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { getProjectsDir } from '../../utils/envUtils.js'

const TAIL_BYTES = 512 * 1024
const MAX_MSG_CHARS = 400
const MAX_TOOL_CHARS = 160

export type PeerMessageRole = 'user' | 'assistant' | 'tool_use' | 'tool_result'

export type PeerMessage = {
  role: PeerMessageRole
  text: string
}

/** Locate a peer's transcript file by session id, searching every project dir. */
async function findTranscriptPath(sessionId: string): Promise<string | null> {
  const projectsDir = getProjectsDir()
  let entries: string[]
  try {
    entries = await readdir(projectsDir)
  } catch {
    return null
  }
  for (const entry of entries) {
    const candidate = join(projectsDir, entry, `${sessionId}.jsonl`)
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // Not in this project dir; keep looking.
    }
  }
  return null
}

/** Read up to `maxBytes` from the end of a file as UTF-8. */
async function readTail(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    const start = Math.max(0, info.size - maxBytes)
    const length = info.size - start
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

function clip(text: string, max = MAX_MSG_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)} …`
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/**
 * One-line summary of a tool call's key argument. Picks the most
 * human-meaningful field per common tool so peers see WHAT is running, not
 * just that something ran.
 */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const candidate =
    i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.description
  if (typeof candidate === 'string') return clip(candidate, MAX_TOOL_CHARS)
  if (Array.isArray(i.file_paths)) return clip(i.file_paths.join(', '), MAX_TOOL_CHARS)
  return clip(JSON.stringify(i), MAX_TOOL_CHARS)
}

/** One-line summary of a tool result, flattening text blocks. Empty when none. */
function summarizeToolResult(content: unknown): string {
  const text = textOfContent(content)
  return text ? clip(text, MAX_TOOL_CHARS) : ''
}

type ParsedRecord = { type: string; rec: Record<string, unknown> }

/** Parse the JSONL tail, tolerating the partial first/last line a tail read may cut. */
function parseRecords(tail: string): ParsedRecord[] {
  const records: ParsedRecord[] = []
  for (const rawLine of tail.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      const rec = JSON.parse(line) as Record<string, unknown>
      records.push({ type: String(rec.type ?? ''), rec })
    } catch {
      // Partial record when the tail cut mid-line, or a non-JSON line.
    }
  }
  return records
}

/** Map tool_use_id -> tool name so tool_result lines can be labeled. */
function collectToolNames(records: ParsedRecord[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const { type, rec } of records) {
    if (type !== 'assistant') continue
    const message = rec.message as Record<string, unknown> | undefined
    if (!message || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        names.set(b.id, typeof b.name === 'string' ? b.name : 'tool')
      }
    }
  }
  return names
}

/** Build the ordered event list, including tool calls and their results. */
function buildMessages(
  records: ParsedRecord[],
  toolNames: Map<string, string>,
): PeerMessage[] {
  const messages: PeerMessage[] = []
  for (const { type, rec } of records) {
    if (type !== 'user' && type !== 'assistant') continue
    if (rec.isMeta === true) continue
    const message = rec.message as Record<string, unknown> | undefined
    if (!message) continue
    const content = message.content

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') {
          const body = clip(b.text)
          if (body) messages.push({ role: type as 'user' | 'assistant', text: body })
        } else if (type === 'assistant' && b.type === 'tool_use') {
          const name = typeof b.name === 'string' ? b.name : 'tool'
          const arg = summarizeToolInput(b.input)
          messages.push({
            role: 'tool_use',
            text: arg ? `${name}: ${arg}` : name,
          })
        } else if (type === 'user' && b.type === 'tool_result') {
          const summary = summarizeToolResult(b.content)
          if (!summary) continue
          const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
          const name = toolNames.get(id) ?? 'tool'
          messages.push({ role: 'tool_result', text: `${name}: ${summary}` })
        }
      }
      continue
    }

    const body = textOfContent(content)
    if (body.trim()) {
      messages.push({ role: type as 'user' | 'assistant', text: clip(body) })
    }
  }
  return messages
}

/** Read a peer's most recent activity from its transcript. */
export async function readPeerMessages(
  sessionId: string,
  limit: number,
): Promise<{ found: boolean; messages: PeerMessage[] }> {
  const path = await findTranscriptPath(sessionId)
  if (!path) return { found: false, messages: [] }

  const tail = await readTail(path, TAIL_BYTES)
  const records = parseRecords(tail)
  const toolNames = collectToolNames(records)
  const messages = buildMessages(records, toolNames)

  return { found: true, messages: messages.slice(-limit) }
}
