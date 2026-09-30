import { open, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { getProjectsDir } from '../../utils/envUtils.js'

const TAIL_BYTES = 512 * 1024
const MAX_MSG_CHARS = 400

export type PeerMessage = {
  role: 'user' | 'assistant'
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

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every(
    b =>
      b !== null &&
      typeof b === 'object' &&
      (b as Record<string, unknown>).type === 'tool_result',
  )
}

/** Read a peer's most recent conversation messages from its transcript. */
export async function readPeerMessages(
  sessionId: string,
  limit: number,
): Promise<{ found: boolean; messages: PeerMessage[] }> {
  const path = await findTranscriptPath(sessionId)
  if (!path) return { found: false, messages: [] }

  const tail = await readTail(path, TAIL_BYTES)
  const lines = tail.split('\n')
  const messages: PeerMessage[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Partial record when the tail cut mid-line, or a non-JSON line.
      continue
    }
    const type = rec.type
    if (type !== 'user' && type !== 'assistant') continue
    if (rec.isMeta === true) continue
    const message = rec.message as Record<string, unknown> | undefined
    if (!message) continue
    const content = message.content
    if (type === 'user' && isToolResultOnly(content)) continue
    const body = textOfContent(content)
    if (!body.trim()) continue
    messages.push({ role: type, text: clip(body) })
  }

  return { found: true, messages: messages.slice(-limit) }
}
