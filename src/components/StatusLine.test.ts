import { beforeEach, describe, expect, it } from 'bun:test'
import { resetStateForTests } from '../cost-tracker.js'
import { getUnreportedSessionUsage } from '../utils/tokens.js'
import { createCompactBoundaryMessage } from '../utils/messages/systemFactories.js'
import {
  buildStatusLineCommandInput,
  getLastAssistantMessageId,
  normalizeRefreshInterval,
  resolveStatusLineUpdateAction,
  resolveStatusLineTokenTotals,
  splitStatusLines,
  statusLineRowCap,
} from './StatusLine.js'
import { buildPromptCacheStatus } from '../utils/statusLinePromptCache.js'
import type { AssistantMessage, Message } from '../types/message.js'

;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test-version',
}

const assistantMessage = (
  content: string,
  id = 'msg_unsupported',
): AssistantMessage =>
  ({
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000001',
    timestamp: '2026-06-28T00:00:00.000Z',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'mimo-v2.5-pro',
      content: [{ type: 'text', text: content }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }) as unknown as AssistantMessage

const userMessage = (content: string): Message =>
  ({
    type: 'user',
    uuid: '00000000-0000-0000-0000-000000000002',
    timestamp: '2026-06-28T00:00:00.000Z',
    message: {
      role: 'user',
      content,
    },
  }) as Message

describe('getLastAssistantMessageId', () => {
  it('invalidates the status line at compaction before a new response arrives', () => {
    const archived = assistantMessage('Archived response.')
    const boundary = createCompactBoundaryMessage('manual', 90000)
    const summary = userMessage('Compacted summary.')

    expect(getLastAssistantMessageId([archived])).toBe(archived.uuid)
    expect(getLastAssistantMessageId([archived, boundary, summary])).toBeNull()

    const reply: AssistantMessage = {
      ...assistantMessage('Fresh response.'),
      uuid: '00000000-0000-0000-0000-000000000003',
    }
    expect(getLastAssistantMessageId([archived, boundary, summary, reply])).toBe(reply.uuid)
  })
})

describe('resolveStatusLineTokenTotals', () => {
  it('keeps reported usage totals unchanged', () => {
    expect(resolveStatusLineTokenTotals(1200, 300, null)).toEqual({
      totalInputTokens: 1200,
      totalOutputTokens: 300,
      totalTokensAreEstimated: undefined,
    })
  })

  it('adds unreported session usage to cumulative session totals', () => {
    expect(
      resolveStatusLineTokenTotals(1200, 300, {
        input_tokens: 90,
        output_tokens: 20,
      }),
    ).toEqual({
      totalInputTokens: 1290,
      totalOutputTokens: 320,
      totalTokensAreEstimated: true,
    })
  })
})

describe('resolveStatusLineUpdateAction', () => {
  it('cancels pending work and records a refresh when hidden', () => {
    expect(resolveStatusLineUpdateAction({ active: false, hasRun: true, needsRefresh: false, stateChanged: false, commandChanged: false, hasPendingUpdate: true })).toEqual({ action: 'cancel', needsRefresh: true })
  })

  it('runs once when first activated with pending changes', () => {
    expect(resolveStatusLineUpdateAction({ active: true, hasRun: false, needsRefresh: true, stateChanged: true, commandChanged: false, hasPendingUpdate: false })).toEqual({ action: 'run' })
  })

  it('runs immediately when reactivated after hidden changes', () => {
    expect(resolveStatusLineUpdateAction({ active: true, hasRun: true, needsRefresh: true, stateChanged: false, commandChanged: false, hasPendingUpdate: false })).toEqual({ action: 'run' })
  })

  it('debounces ordinary visible state changes', () => {
    expect(resolveStatusLineUpdateAction({ active: true, hasRun: true, needsRefresh: false, stateChanged: true, commandChanged: false, hasPendingUpdate: false })).toEqual({ action: 'schedule' })
  })

  it('does nothing when active and nothing changed', () => {
    expect(resolveStatusLineUpdateAction({ active: true, hasRun: true, needsRefresh: false, stateChanged: false, commandChanged: false, hasPendingUpdate: false })).toEqual({ action: 'none' })
  })

  it('runs immediately when the statusline command changes', () => {
    expect(resolveStatusLineUpdateAction({ active: true, hasRun: true, needsRefresh: false, stateChanged: false, commandChanged: true, hasPendingUpdate: false })).toEqual({ action: 'run' })
  })
})

describe('buildStatusLineCommandInput', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  it('emits estimated cumulative totals for unreported provider usage', () => {
    const messages = [
      userMessage('Please summarize this repository.'),
      assistantMessage('This repository contains source files and tests.'),
    ]
    const unreportedUsage = getUnreportedSessionUsage(messages)
    expect(unreportedUsage).not.toBeNull()

    const input = buildStatusLineCommandInput(
      'default',
      false,
      {},
      messages,
      [],
      'mimo-v2.5-pro',
    )

    expect(input.context_window).toMatchObject({
      total_input_tokens: unreportedUsage!.input_tokens,
      total_output_tokens: unreportedUsage!.output_tokens,
      total_tokens_are_estimated: true,
      current_usage: {
        is_estimated: true,
      },
    })
  })
})

describe('statusLineRowCap', () => {
  it('caps the custom status line at five rows', () => {
    expect(statusLineRowCap(60)).toBe(5)
    expect(statusLineRowCap(40)).toBe(5)
  })

  it('keeps one row on a short terminal', () => {
    expect(statusLineRowCap(12)).toBe(5)
    expect(statusLineRowCap(8)).toBe(1)
    expect(statusLineRowCap(4)).toBe(1)
  })
})

describe('splitStatusLines', () => {
  it('returns a single line unchanged', () => {
    expect(splitStatusLines('one row')).toEqual(['one row'])
  })

  it('splits rows without adding escapes to plain text', () => {
    expect(splitStatusLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('carries open SGR state onto the following rows', () => {
    const lines = splitStatusLines('\x1b[31mred\nstill red\n\x1b[0mreset')
    expect(lines[0]).toBe('\x1b[31mred')
    expect(lines[1]).toBe('\x1b[31mstill red')
    expect(lines[2]).toBe('\x1b[31m\x1b[0mreset')
  })

  it('does not repeat a color that is already applied', () => {
    const lines = splitStatusLines('\x1b[31mred\nstill red')
    expect(lines[1]).toBe('\x1b[31mstill red')
  })

  it('replaces the foreground instead of stacking colors', () => {
    const lines = splitStatusLines('\x1b[31mred\x1b[32mgreen\nafter')
    expect(lines[1]).toBe('\x1b[32mafter')
  })

  it('drops carried state when the previous row resets', () => {
    const lines = splitStatusLines('\x1b[31mred\x1b[0m\nplain')
    expect(lines[1]).toBe('plain')
  })

  it('keeps attributes that survive a foreground reset', () => {
    const lines = splitStatusLines('\x1b[1;31mbold red\x1b[39m\nstill bold')
    expect(lines[1]).toBe('\x1b[1mstill bold')
  })

  it('preserves extended 256-color sequences whole', () => {
    const lines = splitStatusLines('\x1b[38;5;208morange\nstill orange')
    expect(lines[1]).toBe('\x1b[38;5;208mstill orange')
  })

  it('reopens an OSC 8 hyperlink on the next row and closes it per row', () => {
    const lines = splitStatusLines(
      '\x1b]8;;https://example.com\x1b\\linked\nstill linked\x1b]8;;\x1b\\',
    )
    expect(lines[0]).toBe(
      '\x1b]8;;https://example.com\x1b\\linked\x1b]8;;\x1b\\',
    )
    expect(lines[1]).toBe(
      '\x1b]8;;https://example.com\x1b\\still linked\x1b]8;;\x1b\\',
    )
  })
})

describe('normalizeRefreshInterval', () => {
  it('returns null when unset', () => {
    expect(normalizeRefreshInterval(undefined)).toBeNull()
  })

  it('converts seconds to milliseconds', () => {
    expect(normalizeRefreshInterval(3)).toBe(3000)
  })

  it('clamps to the one second floor', () => {
    expect(normalizeRefreshInterval(0)).toBe(1000)
    expect(normalizeRefreshInterval(0.2)).toBe(1000)
  })
})

describe('buildPromptCacheStatus', () => {
  it('omits the field until cache usage is observed', () => {
    expect(
      buildPromptCacheStatus({ read: 0, created: 0, total: 0, hitRate: null, supported: false }),
    ).toBeUndefined()
  })

  it('aggregates writes and counts read regressions as misses', () => {
    const status = buildPromptCacheStatus(
      { read: 3000, created: 500, total: 4000, hitRate: 0.75, supported: true },
      [
        { timestamp: 1, metrics: { read: 1000, created: 400, total: 1400, hitRate: 0.7, supported: true } },
        { timestamp: 2, metrics: { read: 2000, created: 100, total: 2100, hitRate: 0.95, supported: true } },
        { timestamp: 3, metrics: { read: 500, created: 900, total: 1400, hitRate: 0.35, supported: true } },
      ],
    )
    expect(status).toMatchObject({
      warm: true,
      caching_observed: true,
      requests: 3,
      misses: 1,
      cache_write_tokens: 1400,
      miss_recache_tokens: 900,
      hit_ratio: 0.75,
    })
  })
})

describe('buildStatusLineCommandInput extra payload', () => {
  it('reports fast mode, thinking, workspace and PR state', () => {
    const input = buildStatusLineCommandInput(
      'default',
      false,
      {},
      [],
      [],
      'mimo-v2.5-pro',
      undefined,
      {
        fastMode: true,
        effortValue: undefined,
        thinkingEnabled: false,
        prStatus: { number: 42, url: 'https://github.com/o/r/pull/42', reviewState: 'approved' },
        gitWorktree: 'feat-x',
        repo: { host: 'github.com', owner: 'o', name: 'r' },
      },
    )
    expect(input.fast_mode).toBe(true)
    expect(input.thinking).toEqual({ enabled: false })
    expect(input.workspace).toMatchObject({
      git_worktree: 'feat-x',
      repo: { host: 'github.com', owner: 'o', name: 'r' },
    })
    expect(input.pr).toEqual({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      review_state: 'approved',
    })
  })

  it('omits optional fields when absent', () => {
    const input = buildStatusLineCommandInput(
      'default',
      false,
      {},
      [],
      [],
      'mimo-v2.5-pro',
    )
    expect(input.fast_mode).toBe(false)
    expect(input.thinking).toEqual({ enabled: expect.any(Boolean) })
    expect(input.pr).toBeUndefined()
    expect(input.workspace.git_worktree).toBeUndefined()
    expect(input.workspace.repo).toBeUndefined()
  })
})
