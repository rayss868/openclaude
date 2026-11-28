/**
 * Row metadata and tree prefixes for the background-task list, ported from
 * Claude Code 2.1.332 (`wC`, `oCo`, `eG`, `nCo`, `rCo`, `ETe`).
 *
 * Claude renders each background row as `treePrefix + label` followed by a
 * `·`-joined meta list so a row reads:
 *
 *   ├─ @fixer · started 2m ago · last active 12s ago
 *   └─ b4f1 · stopped
 *
 * The tree glyphs are plain box-drawing characters with no heavy variants —
 * highlighting does not change the glyph.
 */

import { formatRelativeTimeAgo } from '../../utils/format.js'

/** Claude's `wC`: the only four glyphs the task tree uses. */
export const TREE_GLYPHS = {
  branch: '├',
  last: '└',
  pipe: '│',
  teeDown: '┬',
  teeUp: '┴',
} as const

/** Claude's `tCo`: deeper nesting is clamped so the label never runs away. */
export const MAX_TREE_DEPTH = 6

/**
 * Claude's `oCo`. Depth 0 has no prefix; rows below the cap get `│ ` per level
 * then `├ `/`└ ` for the row itself.
 */
export function treePrefix(depth: number, isLastSibling: boolean): string {
  if (depth <= 0) return ''
  const pipes = `${TREE_GLYPHS.pipe} `.repeat(
    Math.min(depth, MAX_TREE_DEPTH) - 1,
  )
  return `${pipes}${isLastSibling ? TREE_GLYPHS.last : TREE_GLYPHS.branch} `
}

/** Claude's `nCo`: `@name` when the agent has one, else its type. */
export function rowName(entry: {
  name?: string
  agentType?: string
}): string {
  const name = entry.name?.trim()
  if (name) return `@${name}`
  return entry.agentType?.trim() ?? ''
}

/**
 * Claude's `rCo`. `last active` is suppressed when it resolves to the same
 * relative string as `started` — for a row that just launched the two lines
 * would be identical, so the meta list shows only `started`.
 */
export function rowTimeMeta(
  entry: { startedAt?: number; lastActivityAt?: number },
  now: number,
): string[] {
  const started =
    entry.startedAt === undefined
      ? ''
      : formatRelativeTimeAgo(new Date(entry.startedAt), { now: new Date(now) })
  const lastActivity =
    entry.lastActivityAt === undefined
      ? ''
      : formatRelativeTimeAgo(new Date(entry.lastActivityAt), {
          now: new Date(now),
        })
  const parts: string[] = []
  if (started) parts.push(`started ${started}`)
  if (lastActivity && lastActivity !== started) {
    parts.push(`last active ${lastActivity}`)
  }
  return parts
}

/**
 * Claude's `ETe` meta list, in its original order: refusal, stop, name, then
 * the two time facts. Empty entries are dropped by the caller at join time.
 */
export function rowMeta(
  entry: {
    isRefused?: boolean
    stoppedByUser?: boolean
    name?: string
    agentType?: string
    startedAt?: number
    lastActivityAt?: number
  },
  now: number,
): string[] {
  return [
    entry.isRefused ? 'cannot be opened' : '',
    entry.stoppedByUser ? 'stopped' : '',
    rowName(entry),
    ...rowTimeMeta(entry, now),
  ].filter(part => part !== '')
}

/** Join meta parts the way Claude does: a middle dot with spaces. */
export function joinMeta(parts: string[]): string {
  return parts.join(' · ')
}
