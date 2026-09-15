import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { agenticSessionSearch } from './agenticSessionSearch.js'
import type { LogOption } from '../types/logs.js'

const sessionId1 = '00000000-0000-4000-8000-000000000111'
const sessionId2 = '00000000-0000-4000-8000-000000000222'
const ts = '2026-04-02T00:00:00.000Z'

function makeLog(sessionId: string, fullPath: string, firstPrompt: string): LogOption {
  return {
    date: ts,
    messages: [],
    fullPath,
    value: 0,
    created: new Date(ts),
    modified: new Date(ts),
    firstPrompt,
    messageCount: 0,
    isSidechain: false,
    sessionId,
  }
}

describe('agenticSessionSearch deep substring match', () => {
  test('finds content inside session files for lite logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openclaude-agentic-search-'))

    const file1 = join(dir, 'one.jsonl')
    const file2 = join(dir, 'two.jsonl')
    await writeFile(
      file1,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'deploy the rate limiter to production' }] } })}\n` +
        `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Adding the limiter.' }] } })}\n`,
    )
    await writeFile(
      file2,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the css on the landing page' }] } })}\n`,
    )

    const logs: LogOption[] = [
      makeLog(sessionId1, file1, 'Do the thing'),
      makeLog(sessionId2, file2, 'Other thing'),
    ]

    const results = await agenticSessionSearch('rate limiter', logs)

    expect(results).toHaveLength(1)
    expect(results[0]!.sessionId).toBe(sessionId1)
  })

  test('matches on title metadata without needing file content', async () => {
    const results = await agenticSessionSearch('billing page', [
      makeLog(sessionId1, join(tmpdir(), 'missing.jsonl'), 'Build the billing page'),
      makeLog(sessionId2, join(tmpdir(), 'missing2.jsonl'), 'Unrelated title'),
    ])

    expect(results).toHaveLength(1)
    expect(results[0]!.sessionId).toBe(sessionId1)
  })
})