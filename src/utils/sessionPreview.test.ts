import { expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import type { SerializedMessage } from '../types/logs.js'
import {
  SESSION_PREVIEW_MAX_MESSAGE_CHARS,
  SESSION_PREVIEW_MAX_TOTAL_CHARS,
  createSessionPreview,
} from './sessionPreview.js'

function makeMessage(
  index: number,
  content = `message-${index}`,
): SerializedMessage {
  return {
    type: 'user',
    uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` as UUID,
    timestamp: new Date(0).toISOString(),
    cwd: '/tmp',
    userType: 'external',
    sessionId: '00000000-0000-4000-8000-000000000000',
    version: 'test',
    message: { role: 'user', content },
  } as SerializedMessage
}

test('keeps sessions of twelve messages or fewer complete', () => {
  const messages = Array.from({ length: 12 }, (_, index) => makeMessage(index))
  const result = createSessionPreview(messages)

  expect(result.messages).toHaveLength(12)
  expect(result.messages.map(message => message.uuid)).toEqual(
    messages.map(message => message.uuid),
  )
  expect(result.omittedMessageCount).toBe(0)
  expect(result.truncatedMessageCount).toBe(0)
})

test('keeps the first four and last eight messages in order', () => {
  const messages = Array.from({ length: 20 }, (_, index) => makeMessage(index))
  const result = createSessionPreview(messages)

  expect(result.messages.map(message => message.uuid)).toEqual([
    ...messages.slice(0, 4).map(message => message.uuid),
    ...messages.slice(-8).map(message => message.uuid),
  ])
  expect(result.omittedMessageCount).toBe(8)
})

test('truncates oversized selected content', () => {
  const result = createSessionPreview([makeMessage(0, 'x'.repeat(8_000))])
  const content = result.messages[0]!.message.content

  expect(typeof content).toBe('string')
  expect(content).toContain('[message truncated]')
  expect(content.length).toBeLessThanOrEqual(
    SESSION_PREVIEW_MAX_MESSAGE_CHARS + '[message truncated]'.length,
  )
  expect(result.truncatedMessageCount).toBe(1)
})

test('keeps the total preview content bounded', () => {
  const result = createSessionPreview(
    Array.from({ length: 12 }, (_, index) =>
      makeMessage(index, 'x'.repeat(SESSION_PREVIEW_MAX_MESSAGE_CHARS)),
    ),
  )
  const total = result.messages.reduce((sum, message) => {
    const content = message.message.content
    return sum + (typeof content === 'string' ? content.length : 0)
  }, 0)

  expect(total).toBeLessThanOrEqual(
    SESSION_PREVIEW_MAX_TOTAL_CHARS +
      result.truncatedMessageCount * '[message truncated]'.length,
  )
  expect(result.truncatedMessageCount).toBeGreaterThan(0)
})

test('does not mutate the full restore log', () => {
  const messages = [makeMessage(0, 'x'.repeat(8_000))]
  const original = structuredClone(messages)

  const result = createSessionPreview(messages)

  expect(messages).toEqual(original)
  expect(result.messages).not.toBe(messages)
})

test('preserves assistant content blocks while bounding large text', () => {
  const messages = [
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000003' as UUID,
      timestamp: new Date(0).toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'x'.repeat(8_000) },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/file' } },
          { type: 'image', source: { type: 'base64', data: 'x'.repeat(8_000) } },
        ],
      },
    },
  ] as unknown as SerializedMessage[]

  const result = createSessionPreview(messages)
  const content = result.messages[0]!.message.content as Array<Record<string, unknown>>

  expect(Array.isArray(content)).toBe(true)
  expect(content.map(block => block.type)).toEqual(['text', 'tool_use', 'image'])
  expect(content[0]!.text).toContain('[message truncated]')
  expect(content[1]!.name).toBe('Read')
  expect(content[2]!.source).toEqual({
    type: 'base64',
    data: expect.stringContaining('[message truncated]'),
  })
  expect(
    (messages[0]!.message.content as Array<Record<string, unknown>>)[0]!.text,
  ).toHaveLength(8_000)
  expect(
    (
      (messages[0]!.message.content as Array<Record<string, unknown>>)[2]!
        .source as Record<string, unknown>
    ).data,
  ).toHaveLength(8_000)
})

test('bounds nested payloads after the total budget is exhausted', () => {
  const messages = [
    makeMessage(0, 'x'.repeat(SESSION_PREVIEW_MAX_TOTAL_CHARS)),
    {
      type: 'attachment',
      uuid: '00000000-0000-4000-8000-000000000004' as UUID,
      timestamp: new Date(0).toISOString(),
      attachment: {
        type: 'file',
        content: { file: { text: 'y'.repeat(100_000) } },
      },
    },
  ] as unknown as SerializedMessage[]

  const result = createSessionPreview(messages)

  expect(JSON.stringify(result.messages).length).toBeLessThan(
    JSON.stringify(messages).length,
  )
  expect(JSON.stringify(result.messages)).not.toContain('y'.repeat(100_000))
  expect(result.truncatedMessageCount).toBe(2)
})
