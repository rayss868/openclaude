import * as React from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { getRunningTeammatesSorted } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { formatNumber } from '../../utils/format.js'
import {
  besidesPromptRows,
  BESIDE_PROMPT_MAX_COLUMNS,
  measurePanelColumns,
  panelMaxColumns,
} from './besidePromptLayout.js'
import { TREE_GLYPHS, treePrefix } from './teammateRowMeta.js'

type Row = {
  key: string
  text: string
  dim: boolean
}

/**
 * Claude Code's beside-prompt agent panel (2.1.332 `VB` / `ive`).
 *
 * In Claude this is a plugin render site — `ui.render` with
 * `component: "BesidePrompt"`, `surface: "terminal"` — so the rows themselves
 * come from a plugin and the host only owns the geometry. OpenClaude has no
 * render-site plugin host, so the host draws the running-subagent rows here.
 *
 * Claude floats it absolutely at `right: 0` over the prompt block, then narrows
 * the prompt by the width it reported back (`Math.min(written, U8(columns))`).
 * It reserves `min(1, width)` columns of left padding and aligns the content to
 * the right edge, rows capped at `min(8, floor(rows / 3))` and columns at
 * `min(40, columns)`.
 *
 * Here the panel is a flex sibling of the prompt column inside the same
 * bottom-row container: same narrowing, without the absolute-float measure
 * cycle.
 */
export function AgentsBesidePrompt(): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const tasks = useAppState(state => state.tasks)
  const teammates = getRunningTeammatesSorted(tasks)

  const rows_ = besidesPromptRows(rows)
  const built = buildRows(teammates, rows_)
  if (built.length === 0) return null

  const maxColumns = Math.min(
    panelMaxColumns(columns),
    BESIDE_PROMPT_MAX_COLUMNS,
  )
  if (maxColumns <= 0) return null

  // Claude measures the drawn rows only to know how much to narrow the prompt;
  // the float itself renders at `max(1, maxColumns)` and clips. A zero
  // measurement therefore means "the first row is wider than the budget", and
  // the equivalent non-overlapping width is the full budget.
  const measured = measurePanelColumns(
    built.map(row => stringWidth(row.text)),
    maxColumns,
  )
  const width = measured > 0 ? measured : maxColumns

  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      paddingLeft={Math.min(1, width)}
      alignItems="flex-end"
      overflow="hidden"
    >
      {built.map(row => (
        <Text key={row.key} dimColor={row.dim} wrap="truncate-end">
          {row.text}
        </Text>
      ))}
    </Box>
  )
}

function buildRows(
  teammates: ReturnType<typeof getRunningTeammatesSorted>,
  rowCap: number,
): Row[] {
  if (teammates.length === 0 || rowCap <= 0) return []
  // The overflow row occupies one of the capped slots, so real rows get
  // `rowCap - 1` when they do not all fit.
  const visible = Math.min(teammates.length, rowCap)
  const overflow = teammates.length > visible
  const drawn = overflow ? visible - 1 : visible
  const rows: Row[] = []
  for (let index = 0; index < drawn; index++) {
    const teammate = teammates[index]!
    const isLast = !overflow && index === drawn - 1
    const { piece, dim } = describeRow(teammate)
    rows.push({
      key: teammate.id,
      text: `${treePrefix(1, isLast)}@${teammate.identity.agentName} · ${piece}`,
      dim,
    })
  }
  if (overflow) {
    rows.push({
      key: 'overflow',
      text: `${treePrefix(1, true)}${TREE_GLYPHS.pipe} +${teammates.length - drawn} more · /tasks`,
      dim: true,
    })
  }
  return rows
}

function describeRow(
  teammate: ReturnType<typeof getRunningTeammatesSorted>[number],
): { piece: string; dim: boolean } {
  if (teammate.shutdownRequested) return { piece: 'stopping', dim: true }
  if (teammate.awaitingPlanApproval) {
    return { piece: 'awaiting approval', dim: false }
  }
  if (teammate.isIdle) return { piece: 'idle', dim: true }
  const toolUseCount = teammate.progress?.toolUseCount ?? 0
  const tokenCount = teammate.progress?.tokenCount ?? 0
  const activity =
    teammate.progress?.lastActivity?.activityDescription ??
    teammate.spinnerVerb ??
    'working'
  const stats =
    toolUseCount > 0
      ? ` · ${toolUseCount} ${toolUseCount === 1 ? 'tool' : 'tools'} · ${formatNumber(tokenCount)} tokens`
      : ''
  return { piece: `${activity}${stats}`, dim: false }
}
