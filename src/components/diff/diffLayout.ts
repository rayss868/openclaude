/** Minimum terminal width at which Claude Code admits a docked pane. */
export const MIN_DIFF_PREVIEW_COLUMNS = 110
export const AUTO_OPEN_DIFF_COLUMNS = 144
export const DIFF_PANE_RIGHT_PADDING = 1

const PANE_WIDTH_RATIO = 0.45
const PANE_MIN_WIDTH = 24
const PANE_MAX_WIDTH = 90
const PANE_TRANSCRIPT_RESERVE = 60

export function getDiffPaneWidth(columns: number): number {
  if (columns < MIN_DIFF_PREVIEW_COLUMNS) return 0
  return Math.min(
    Math.max(
      PANE_MIN_WIDTH,
      Math.min(
        Math.floor(columns * PANE_WIDTH_RATIO),
        columns - PANE_TRANSCRIPT_RESERVE,
      ),
    ),
    PANE_MAX_WIDTH,
  )
}

export function narrowHintVisible(columns: number): boolean {
  return columns < MIN_DIFF_PREVIEW_COLUMNS
}
