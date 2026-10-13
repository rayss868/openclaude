import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { readPeerMessages } from './transcript.js'

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

let configHome: string

function writeTranscript(records: unknown[]): void {
  const projectDir = join(configHome, 'projects', 'some-project')
  mkdirSync(projectDir, { recursive: true })
  const body = records.map(r => JSON.stringify(r)).join('\n')
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), `${body}\n`)
}

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'hall-activity-'))
  setClaudeConfigHomeDirForTesting(configHome)
})

afterEach(() => {
  setClaudeConfigHomeDirForTesting(undefined)
  rmSync(configHome, { recursive: true, force: true })
})

describe('readPeerMessages', () => {
  test('reports not found when the transcript file is absent', async () => {
    const result = await readPeerMessages(SESSION_ID, 50)
    expect(result.found).toBe(false)
    expect(result.messages).toEqual([])
  })

  test('includes tool_use and tool_result events, not just opening text', async () => {
    writeTranscript([
      {
        type: 'user',
        message: { content: 'kerjakan fitur hall' },
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Saya mulai dengan membaca file.' }],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'bun test ./src/hall/' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: '40 pass' },
          ],
        },
      },
    ])

    const { found, messages } = await readPeerMessages(SESSION_ID, 50)
    expect(found).toBe(true)
    expect(messages).toEqual([
      { role: 'user', text: 'kerjakan fitur hall' },
      { role: 'assistant', text: 'Saya mulai dengan membaca file.' },
      { role: 'tool_use', text: 'Bash: bun test ./src/hall/' },
      { role: 'tool_result', text: 'Bash: 40 pass' },
    ])
  })

  test('summarizes Edit tool input by file path', async () => {
    writeTranscript([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-2',
              name: 'Edit',
              input: { file_path: 'src/hall/session.ts', old_string: 'a', new_string: 'b' },
            },
          ],
        },
      },
    ])

    const { messages } = await readPeerMessages(SESSION_ID, 50)
    expect(messages).toEqual([
      { role: 'tool_use', text: 'Edit: src/hall/session.ts' },
    ])
  })

  test('keeps only the most recent `limit` events', async () => {
    writeTranscript([
      { type: 'user', message: { content: 'satu' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'dua' }] } },
      { type: 'user', message: { content: 'tiga' } },
    ])

    const { messages } = await readPeerMessages(SESSION_ID, 2)
    expect(messages).toEqual([
      { role: 'assistant', text: 'dua' },
      { role: 'user', text: 'tiga' },
    ])
  })

  test('skips meta records and tool-result-only user turns without text', async () => {
    writeTranscript([
      { type: 'user', isMeta: true, message: { content: 'caveat' } },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '' }] },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'halo' }] } },
    ])

    const { messages } = await readPeerMessages(SESSION_ID, 50)
    expect(messages).toEqual([{ role: 'assistant', text: 'halo' }])
  })
})
