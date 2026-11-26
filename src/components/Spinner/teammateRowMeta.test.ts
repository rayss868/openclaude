import { describe, expect, test } from 'bun:test'
import {
  joinMeta,
  rowMeta,
  rowName,
  rowTimeMeta,
  TREE_GLYPHS,
  treePrefix,
} from './teammateRowMeta.js'

describe('treePrefix', () => {
  test('depth zero has no prefix', () => {
    expect(treePrefix(0, false)).toBe('')
    expect(treePrefix(0, true)).toBe('')
  })

  test('first level is a bare branch or last glyph', () => {
    expect(treePrefix(1, false)).toBe(`${TREE_GLYPHS.branch} `)
    expect(treePrefix(1, true)).toBe(`${TREE_GLYPHS.last} `)
  })

  test('deeper levels repeat the pipe per parent', () => {
    expect(treePrefix(2, false)).toBe(`${TREE_GLYPHS.pipe} ${TREE_GLYPHS.branch} `)
    expect(treePrefix(3, true)).toBe(
      `${TREE_GLYPHS.pipe} ${TREE_GLYPHS.pipe} ${TREE_GLYPHS.last} `,
    )
  })

  test('clamps depth so the prefix cannot run away', () => {
    expect(treePrefix(99, true)).toBe(
      `${`${TREE_GLYPHS.pipe} `.repeat(5)}${TREE_GLYPHS.last} `,
    )
  })

  test('uses plain box drawing only, no heavy variants', () => {
    expect(Object.values(TREE_GLYPHS).join('')).not.toMatch(/[╒╘╞]|\u2550/)
  })
})

describe('rowName', () => {
  test('prefixes a real name with @', () => {
    expect(rowName({ name: 'fixer', agentType: 'general-purpose' })).toBe(
      '@fixer',
    )
  })

  test('falls back to the type without @', () => {
    expect(rowName({ agentType: 'general-purpose' })).toBe('general-purpose')
    expect(rowName({})).toBe('')
  })
})

describe('rowTimeMeta', () => {
  const now = Date.parse('2026-11-24T12:00:00Z')

  test('shows started and last active when they differ', () => {
    const parts = rowTimeMeta(
      { startedAt: now - 300_000, lastActivityAt: now - 12_000 },
      now,
    )
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatch(/^started /)
    expect(parts[1]).toMatch(/^last active /)
  })

  test('suppresses duplicate last active', () => {
    const parts = rowTimeMeta(
      { startedAt: now - 5_000, lastActivityAt: now - 5_000 },
      now,
    )
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatch(/^started /)
  })

  test('omits last active when the entry has no activity time', () => {
    const parts = rowTimeMeta({ startedAt: now - 60_000 }, now)
    expect(parts).toEqual(['started 1m ago'])
  })
})

describe('rowMeta', () => {
  const now = Date.parse('2026-11-24T12:00:00Z')

  test('orders refusal, stop, name, then times', () => {
    const parts = rowMeta(
      {
        isRefused: true,
        stoppedByUser: true,
        name: 'fixer',
        startedAt: now - 120_000,
        lastActivityAt: now - 30_000,
      },
      now,
    )
    expect(parts[0]).toBe('cannot be opened')
    expect(parts[1]).toBe('stopped')
    expect(parts[2]).toBe('@fixer')
    expect(parts[3]).toMatch(/^started /)
    expect(parts[4]).toMatch(/^last active /)
  })

  test('drops empty entries', () => {
    expect(rowMeta({}, now)).toEqual([])
  })
})

describe('joinMeta', () => {
  test('joins with a spaced middle dot', () => {
    expect(joinMeta(['a', 'b'])).toBe('a · b')
    expect(joinMeta([])).toBe('')
  })
})
