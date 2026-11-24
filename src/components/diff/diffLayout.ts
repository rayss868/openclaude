/**
 * Layout math for the /diff split preview.
 *
 * The 110-column floor matches Claude Code's diff panel: below it the panel
 * shows "Resize your terminal to at least 110 columns to show the diff panel".
 * Claude also auto-opens its panel at 144 columns; OpenClaude's /diff is always
 * opened manually, so only the manual floor applies here.
 */
export const MIN_DIFF_PREVIEW_COLUMNS = 110

const MIN_LIST_WIDTH = 40
const MAX_LIST_WIDTH = 48
const LIST_WIDTH_RATIO = 0.38
const MIN_PREVIEW_WIDTH = 50
const PREVIEW_MIN_HEIGHT = 8
const PREVIEW_MAX_HEIGHT = 24
const DIALOG_CHROME_ROWS = 10
/** Dialog borders, pane padding, and the modal gutter around the split. */
const DIALOG_CHROME_COLUMNS = 12

export type DiffSplitLayout = {
  showPreview: boolean
  listWidth: number
  previewWidth: number
  previewHeight: number
}

export function getDiffSplitLayout({
  columns,
  rows,
}: {
  columns: number
  rows: number
}): DiffSplitLayout {
  const showPreview = columns >= MIN_DIFF_PREVIEW_COLUMNS
  const listWidth = clamp(
    Math.round((columns - 6) * LIST_WIDTH_RATIO),
    MIN_LIST_WIDTH,
    MAX_LIST_WIDTH,
  )
  const previewWidth = Math.max(
    MIN_PREVIEW_WIDTH,
    columns - listWidth - DIALOG_CHROME_COLUMNS,
  )
  const previewHeight = clamp(
    rows - DIALOG_CHROME_ROWS,
    PREVIEW_MIN_HEIGHT,
    PREVIEW_MAX_HEIGHT,
  )
  return { showPreview, listWidth, previewWidth, previewHeight }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
