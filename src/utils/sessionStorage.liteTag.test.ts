import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readLiteMetadata } from './sessionStorage.js'
import { LITE_READ_BUF_SIZE } from './sessionStoragePortable.js'

/** Write a session JSONL to a temp file and read its lite metadata back. */
async function readMetadata(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'lite-tag-'))
  const file = join(dir, 'session.jsonl')
  try {
    writeFileSync(file, lines.join('\n') + '\n')
    const size = statSync(file).size
    return await readLiteMetadata(file, size, Buffer.alloc(LITE_READ_BUF_SIZE))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const USER_LINE =
  '{"type":"user","message":{"role":"user","content":"hi"},"cwd":"/work/app"}'

// A tool call carrying a `tag` parameter — Docker image tags, git tags and
// cloud resource tags all look like this. It is stored as literal nested JSON
// inside the assistant entry, and is appended *after* the tag entry.
const TOOL_USE_WITH_TAG_INPUT =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"mcp__docker__push_image","input":{"image":"myapp","tag":"v1.2.3"}}]}}'

describe('readLiteMetadata tag extraction', () => {
  test('uses the first user prompt instead of the lastPrompt metadata entry', async () => {
    const meta = await readMetadata([
      '{"type":"user","message":{"role":"user","content":"prompt pertama"},"cwd":"/work/app"}',
      '{"type":"user","message":{"role":"user","content":"prompt terakhir"},"cwd":"/work/app"}',
      '{"type":"summary","lastPrompt":"prompt terakhir"}',
    ])
    expect(meta.firstPrompt).toBe('prompt pertama')
  })

  test('reads the session tag, not a tag parameter from a later tool call', async () => {
    // The tail scan is a raw substring search, so an unscoped lookup returned
    // the *last* "tag":"..." in the window — the tool's value — which surfaced
    // a phantom tag tab in /resume and misfiled the session away from its own.
    const meta = await readMetadata([
      USER_LINE,
      '{"type":"tag","tag":"backend","sessionId":"S1"}',
      TOOL_USE_WITH_TAG_INPUT,
    ])
    expect(meta.tag).toBe('backend')
  })

  test('does not invent a tag for an untagged session', async () => {
    const meta = await readMetadata([USER_LINE, TOOL_USE_WITH_TAG_INPUT])
    expect(meta.tag).toBeUndefined()
  })

  test('treats a cleared tag as untagged', async () => {
    // tagSession(id, null) writes tag:"" to clear.
    const meta = await readMetadata([
      USER_LINE,
      '{"type":"tag","tag":"backend","sessionId":"S1"}',
      '{"type":"tag","tag":"","sessionId":"S1"}',
    ])
    expect(meta.tag).toBeUndefined()
  })

  test('uses the most recent tag entry', async () => {
    const meta = await readMetadata([
      USER_LINE,
      '{"type":"tag","tag":"backend","sessionId":"S1"}',
      '{"type":"tag","tag":"frontend","sessionId":"S1"}',
    ])
    expect(meta.tag).toBe('frontend')
  })
})

describe('readLiteMetadata lastPrompt extraction', () => {
  test('ignores a trailing system informational entry', async () => {
    // Session files end each turn with a system entry carrying cache metrics in
    // a `content` field. The old raw substring fallback picked that up and the
    // cache line became the /resume row title.
    const meta = await readMetadata([
      '{"type":"user","message":{"role":"user","content":"prompt pertama"},"cwd":"/work/app"}',
      '{"type":"user","message":{"role":"user","content":"prompt terakhir"},"cwd":"/work/app"}',
      '{"type":"system","subtype":"informational","content":"[Cache: 63k read \u2022 hit 97%]","isMeta":false}',
    ])
    expect(meta.lastPrompt).toBe('prompt terakhir')
  })

  test('prefers the re-appended last-prompt entry over the tail scan', async () => {
    const meta = await readMetadata([
      '{"type":"user","message":{"role":"user","content":"prompt awal"},"cwd":"/work/app"}',
      '{"type":"last-prompt","lastPrompt":"aktivitas terakhir","sessionId":"S1"}',
    ])
    expect(meta.lastPrompt).toBe('aktivitas terakhir')
  })

  test('does not surface a built-in slash command as lastPrompt', async () => {
    // A session that only ran /model should fall back to firstPrompt, not echo
    // the literal command as the latest activity.
    const meta = await readMetadata([
      '{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\\n<command-message>model</command-message>\\n<command-args></command-args>"},"cwd":"/work/app"}',
      '{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to GPT</local-command-stdout>"},"cwd":"/work/app"}',
    ])
    expect(meta.lastPrompt).toBe('')
  })
})
