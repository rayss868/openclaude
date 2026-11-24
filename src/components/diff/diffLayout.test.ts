import { describe, expect, test } from 'bun:test'
import {
  AUTO_OPEN_DIFF_COLUMNS,
  DIFF_PANE_RIGHT_PADDING,
  getDiffPaneWidth,
  MIN_DIFF_PREVIEW_COLUMNS,
  narrowHintVisible,
} from './diffLayout.js'

describe('getDiffPaneWidth', () => {
  test('does not dock below the minimum terminal width', () => {
    expect(getDiffPaneWidth(109)).toBe(0)
  })

  test('uses the 45% pane width at the dock threshold', () => {
    expect(getDiffPaneWidth(MIN_DIFF_PREVIEW_COLUMNS)).toBe(49)
  })

  test('caps the pane while preserving the transcript on wide terminals', () => {
    expect(getDiffPaneWidth(240)).toBe(90)
  })

  test('matches the auto-open threshold used by Claude Code', () => {
    expect(AUTO_OPEN_DIFF_COLUMNS).toBe(144)
  })

  test('leaves the configured trailing padding outside the pane', () => {
    expect(DIFF_PANE_RIGHT_PADDING).toBe(1)
  })
})

describe('narrowHintVisible', () => {
  test('shows the resize hint only below the dock threshold', () => {
    expect(narrowHintVisible(109)).toBe(true)
    expect(narrowHintVisible(110)).toBe(false)
  })
})
