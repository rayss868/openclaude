import { describe, expect, test } from 'bun:test'

import type { Message } from '../../types/message.js'
import {
  collectArchivedRewinds,
  createArchivedRewindsMessage,
  parseArchivedRewinds,
} from './archivedRewinds.js'
import { createUserMessage } from '../../utils/messages/factories.js'

function prompt(uuid: string, text: string, extra?: Partial<Message>): Message {
  return {
    ...createUserMessage({ content: text }),
    uuid,
    ...extra,
  } as Message
}

describe('archivedRewinds', () => {
  test('collects selectable user prompts with the summary anchor', () => {
    const messages = [
      prompt('a', 'first prompt'),
      prompt('b', 'second prompt'),
      prompt('c', '<bash-input>run tests</bash-input>'),
    ]
    const entries = collectArchivedRewinds(messages, 'summary-1')
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({
      uuid: 'a',
      text: 'first prompt',
      ts: expect.any(String),
      summaryUuid: 'summary-1',
    })
    expect(entries[2].text).toContain('<bash-input>')
  })

  test('skips synthetic, meta, and transcript-only messages', () => {
    const messages = [
      prompt('a', 'real prompt'),
      prompt('interrupt', '[Request interrupted by user]', {
        isMeta: true,
      }),
      prompt('summary', 'context so far…', {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
      prompt('archive', '__archived_rewinds__\n[]', {
        isArchivedRewindsIndex: true,
        isVisibleInTranscriptOnly: true,
      }),
    ]
    const entries = collectArchivedRewinds(messages, 'summary-1')
    expect(entries.map(e => e.uuid)).toEqual(['a'])
  })

  test('carries over and dedupes entries from older archive carriers', () => {
    const oldEntries = [
      { uuid: 'a', text: 'first prompt', ts: 't1', summaryUuid: 'summary-0' },
      { uuid: 'b', text: 'second prompt', ts: 't2', summaryUuid: 'summary-0' },
    ]
    const carrier = createArchivedRewindsMessage(oldEntries)!
    const messages = [
      carrier,
      prompt('a', 'first prompt', { isVisibleInTranscriptOnly: true }),
      prompt('c', 'third prompt'),
    ]
    const entries = collectArchivedRewinds(messages, 'summary-1')
    // 'a' appears both as a live prompt and inside the carrier — kept once,
    // still anchored to the older summary so restore lands on the right spot.
    expect(entries).toHaveLength(3)
    expect(entries.map(e => e.uuid).sort()).toEqual(['a', 'b', 'c'])
    expect(entries.find(e => e.uuid === 'a')!.summaryUuid).toBe('summary-0')
    expect(entries.find(e => e.uuid === 'b')!.summaryUuid).toBe('summary-0')
    expect(entries.find(e => e.uuid === 'c')!.summaryUuid).toBe('summary-1')
  })

  test('returns undefined when nothing to archive', () => {
    expect(createArchivedRewindsMessage([])).toBeUndefined()
  })

  test('round-trips through the carrier message', () => {
    const entries = [
      { uuid: 'a', text: 'first prompt', ts: 't1', summaryUuid: 'summary-1' },
      { uuid: 'b', text: 'second prompt', ts: 't2', summaryUuid: 'summary-1' },
    ]
    const carrier = createArchivedRewindsMessage(entries)!
    expect(carrier.isArchivedRewindsIndex).toBe(true)
    expect(carrier.isVisibleInTranscriptOnly).toBe(true)
    expect(parseArchivedRewinds(carrier)).toEqual(entries)
  })

  test('ignores malformed payloads', () => {
    const carrier = createUserMessage({
      content: '__archived_rewinds__\nnot json',
      isArchivedRewindsIndex: true,
      isVisibleInTranscriptOnly: true,
    })
    expect(parseArchivedRewinds(carrier)).toEqual([])
    const nonCarrier = prompt('a', '__archived_rewinds__\n[]')
    expect(parseArchivedRewinds(nonCarrier)).toEqual([])
  })
})