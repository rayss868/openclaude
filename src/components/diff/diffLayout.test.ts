import { describe, expect, test } from 'bun:test'

import {
  getDiffSplitLayout,
  MIN_DIFF_PREVIEW_COLUMNS,
  narrowHintVisible,
} from './diffLayout.js'

describe('getDiffSplitLayout', () => {
  test('hides the preview below the Claude-compatible 110 columns', () => {
    expect(getDiffSplitLayout({ columns: 109, rows: 40 }).showPreview).toBe(
      false,
    )
  })

  test('shows the preview at 110 columns', () => {
    expect(getDiffSplitLayout({ columns: 110, rows: 40 }).showPreview).toBe(
      true,
    )
  })

  test('leaves dialog chrome inside the terminal width', () => {
    const layout = getDiffSplitLayout({ columns: 120, rows: 40 })
    expect(layout.listWidth).toBe(43)
    expect(layout.previewWidth).toBe(65)
    expect(layout.listWidth + 2 + layout.previewWidth).toBe(110)
  })

  test('clamps the preview height to the available modal rows', () => {
    expect(getDiffSplitLayout({ columns: 120, rows: 12 }).previewHeight).toBe(8)
    expect(getDiffSplitLayout({ columns: 120, rows: 80 }).previewHeight).toBe(
      24,
    )
  })

  test('uses 110 as the manual diff-panel floor', () => {
    expect(MIN_DIFF_PREVIEW_COLUMNS).toBe(110)
  })

  test('hides the narrow-terminal hint once the split is shown', () => {
    expect(narrowHintVisible(109)).toBe(true)
    expect(narrowHintVisible(110)).toBe(false)
  })
})
