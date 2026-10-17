import { afterEach, expect, test } from 'bun:test'

import {
  getMaxActiveMessagesHardCap,
  isAboveMaxActiveMessagesLimit,
  resolveMaxActiveMessagesLimit,
  shouldCompactActiveMessageHistory,
} from './maxActiveMessages.js'

const SAVED_ENV = {
  OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP:
    process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP,
}

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

test('invalid hard cap override falls back to the default safety cap', () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '100O'

  expect(getMaxActiveMessagesHardCap()).toBe(1000)
  expect(isAboveMaxActiveMessagesLimit(1001)).toBe(true)
})

test('explicit zero hard cap disables only the hard cap', () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '0'

  expect(getMaxActiveMessagesHardCap()).toBe(0)
  expect(isAboveMaxActiveMessagesLimit(1001)).toBe(false)
  expect(resolveMaxActiveMessagesLimit('100', undefined)).toBe(100)
  expect(resolveMaxActiveMessagesLimit('off', '5')).toBe(5)
  expect(resolveMaxActiveMessagesLimit(undefined, '5')).toBe(5)
})

test('configured and hard cap combine by choosing the tighter positive limit', () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '500'

  expect(resolveMaxActiveMessagesLimit('1000', undefined)).toBe(500)
  expect(resolveMaxActiveMessagesLimit('100', undefined)).toBe(100)
  expect(isAboveMaxActiveMessagesLimit(501)).toBe(true)
  expect(isAboveMaxActiveMessagesLimit(500)).toBe(false)
})

test('off disables the message-count guard including the hard cap', () => {
  // Regression: `off` fell through to the 1000-message hard cap, so a long
  // session with cheap messages compacted at the cap (~120k tokens) while the
  // 450k token threshold was never consulted.
  expect(resolveMaxActiveMessagesLimit('off', undefined)).toBe(0)

  const limit = resolveMaxActiveMessagesLimit('off', undefined)
  expect(isAboveMaxActiveMessagesLimit(1250, limit)).toBe(false)
  expect(isAboveMaxActiveMessagesLimit(1001, limit)).toBe(false)
})

test('off still honors an explicit legacy env limit', () => {
  expect(resolveMaxActiveMessagesLimit('off', '300')).toBe(300)
  expect(resolveMaxActiveMessagesLimit('off', '0')).toBe(0)
})

test('numeric setting still combines with the hard cap', () => {
  // Unchanged behavior for every value except `off`.
  expect(resolveMaxActiveMessagesLimit('200', undefined)).toBe(200)
  expect(resolveMaxActiveMessagesLimit('1000', undefined)).toBe(1000)
  expect(resolveMaxActiveMessagesLimit('5000', undefined)).toBe(1000)
})

test('teammate transcript compaction triggers on message count before token pressure', () => {
  expect(
    shouldCompactActiveMessageHistory({
      messageCount: 1001,
      tokenCount: 10,
      tokenThreshold: 100_000,
      activeMessageLimit: 1000,
    }),
  ).toBe(true)

  expect(
    shouldCompactActiveMessageHistory({
      messageCount: 1000,
      tokenCount: 10,
      tokenThreshold: 100_000,
      activeMessageLimit: 1000,
    }),
  ).toBe(false)
})
