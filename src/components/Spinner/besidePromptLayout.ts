/**
 * Geometry for Claude Code's "beside prompt" agent panel, ported from
 * 2.1.332 (`xpo`, `QZe`, `zZe`, `U8`).
 *
 * The panel is not a docked column: it is an absolutely positioned block
 * anchored to the bottom-right of the prompt area, and the prompt is narrowed
 * by exactly the width the panel reports back. Claude recomputes that width
 * from the widest row it actually drew, clamped by `panelWidthFor` below.
 */

/** Claude's `xpo`: columns the transcript keeps before the panel may appear. */
export const BESIDE_PROMPT_RESERVE_COLUMNS = 60

/** Claude's `zZe`: the panel never draws wider than this. */
export const BESIDE_PROMPT_MAX_COLUMNS = 40

/** Claude's `QZe`: the panel never draws taller than this. */
export const BESIDE_PROMPT_MAX_ROWS = 8

/**
 * Claude's `U8`. Zero means "no room" — the caller must not narrow the prompt
 * in that case, so `min(cols-60, floor(cols/3)+1)` also acts as the threshold.
 */
export function besidesPromptWidth(columns: number): number {
  return Math.max(
    0,
    Math.min(columns - BESIDE_PROMPT_RESERVE_COLUMNS, Math.floor(columns / 3) + 1),
  )
}

/** Claude's `Math.min(QZe, Math.floor(rows/3))` row cap. */
export function besidesPromptRows(rows: number): number {
  return Math.min(BESIDE_PROMPT_MAX_ROWS, Math.floor(rows / 3))
}

/**
 * Claude measures the panel by walking the drawn rows and summing
 * `1 + width` per row until the running total would exceed `maxColumns`,
 * then returns `last + 1`. A single over-wide first row therefore still
 * reports 0, which collapses the panel instead of clipping the prompt.
 *
 * `widths` are the rendered widths of the panel's rows, top to bottom.
 */
export function measurePanelColumns(widths: number[], maxColumns: number): number {
  let last = -1
  for (const width of widths) {
    const next = width === 0 ? last : last + 1 + width
    if (next > maxColumns) break
    last = next
  }
  return last > 0 ? last + 1 : 0
}

/**
 * Panel width clamped to the space the prompt can give up. Claude passes
 * `U8(columns) - 1` as `maxColumns`, so the panel stays one column inside the
 * reserve it computed.
 */
export function panelMaxColumns(columns: number): number {
  return Math.max(0, besidesPromptWidth(columns) - 1)
}
