import figures from 'figures'
import sample from 'lodash-es/sample.js'
import * as React from 'react'
import { useState } from 'react'
import { getSpinnerVerbs } from '../../constants/spinnerVerbs.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { summarizeRecentActivities } from '../../utils/collapseReadSearch.js'
import { formatNumber, truncateToWidth } from '../../utils/format.js'
import { toInkColor } from '../../utils/ink.js'
import { TEAMMATE_SELECT_HINT } from './teammateSelectHint.js'
import { joinMeta, rowTimeMeta, treePrefix } from './teammateRowMeta.js'

type Props = {
  teammate: InProcessTeammateTaskState
  isLast: boolean
  isSelected?: boolean
  isForegrounded?: boolean
}

/**
 * One teammate row under the leader, matching Claude Code 2.1.332's tree rows:
 * a plain `├`/`└` prefix (highlighting never changes the glyph), the `@name`,
 * a `:`-separated status, then the `started`/`last active` meta list.
 */
export function TeammateSpinnerLine({
  teammate,
  isLast,
  isSelected,
  isForegrounded,
}: Props): React.ReactNode {
  const [randomVerb] = useState(
    () => teammate.spinnerVerb ?? sample(getSpinnerVerbs()),
  )
  const isHighlighted = isSelected || isForegrounded
  const nameColor = toInkColor(teammate.identity.color)
  const { columns } = useTerminalSize()

  // Meta recomputes on each render; teammate progress updates drive those
  // renders while a teammate is running, so it stays fresh without its own
  // clock.
  const metaText = joinMeta(
    rowTimeMeta(
      {
        startedAt: teammate.startTime,
        lastActivityAt: teammate.lastActivityAt ?? teammate.startTime,
      },
      Date.now(),
    ),
  )

  // Layout: paddingLeft(3) + pointer(1) + space(1) + tree(2) + space(1)
  const basePrefix = 8
  const fullAgentName = `@${teammate.identity.agentName}`
  const fullNameWidth = stringWidth(fullAgentName)

  const toolUseCount = teammate.progress?.toolUseCount ?? 0
  const tokenCount = teammate.progress?.tokenCount ?? 0
  const statsText = ` · ${toolUseCount} tool ${toolUseCount === 1 ? 'use' : 'uses'} · ${formatNumber(tokenCount)} tokens`
  const statsWidth = stringWidth(statsText)
  const selectHintText = ` · ${TEAMMATE_SELECT_HINT}`
  const selectHintWidth = stringWidth(selectHintText)
  const viewHintText = ' · enter to view'
  const viewHintWidth = stringWidth(viewHintText)
  const metaWidth = stringWidth(metaText) + (metaText ? 3 : 0)

  const minActivityWidth = 25

  const spaceWithFullName = columns - basePrefix - fullNameWidth - 2
  const showName = columns >= 60 && spaceWithFullName >= minActivityWidth
  const nameWidth = showName ? fullNameWidth + 2 : 0
  const availableForActivity = columns - basePrefix - nameWidth

  const showViewHint =
    isSelected &&
    !isForegrounded &&
    availableForActivity >
      viewHintWidth + statsWidth + metaWidth + minActivityWidth + 5
  const showSelectHint =
    isHighlighted &&
    availableForActivity >
      selectHintWidth +
        (showViewHint ? viewHintWidth : 0) +
        statsWidth +
        metaWidth +
        minActivityWidth +
        5
  const showStats =
    availableForActivity > statsWidth + metaWidth + minActivityWidth + 5

  const extrasCost =
    (showStats ? statsWidth : 0) +
    (showSelectHint ? selectHintWidth : 0) +
    (showViewHint ? viewHintWidth : 0)
  const activityMaxWidth = Math.max(
    minActivityWidth,
    availableForActivity - extrasCost - 1,
  )

  const activityText = (() => {
    const activities = teammate.progress?.recentActivities
    if (activities && activities.length > 0) {
      const summary = summarizeRecentActivities(activities)
      if (summary) return truncateToWidth(summary, activityMaxWidth)
    }
    const desc = teammate.progress?.lastActivity?.activityDescription
    if (desc) return truncateToWidth(desc, activityMaxWidth)
    return randomVerb
  })()

  const renderStatus = (): React.ReactNode => {
    if (teammate.shutdownRequested) return <Text dimColor>stopped</Text>
    if (teammate.awaitingPlanApproval) {
      return <Text color="warning">awaiting approval</Text>
    }
    if (teammate.isIdle) return <Text dimColor>idle</Text>
    if (isHighlighted) return null
    return (
      <Text dimColor>
        {activityText?.endsWith('…') ? activityText : `${activityText}…`}
      </Text>
    )
  }

  return (
    <Box flexDirection="column">
      <Box paddingLeft={3}>
        <Text color={isSelected ? 'suggestion' : undefined} bold={isSelected}>
          {isSelected ? figures.pointer : ' '}
        </Text>
        <Text dimColor={!isSelected}>{treePrefix(1, isLast)}</Text>
        {showName && (
          <Text color={isSelected ? 'suggestion' : nameColor}>
            {fullAgentName}
          </Text>
        )}
        {showName && <Text dimColor>:</Text>}
        {renderStatus()}
        {metaText && <Text dimColor> · {metaText}</Text>}
        {showStats && <Text dimColor>{statsText}</Text>}
        {showSelectHint && <Text dimColor> · {TEAMMATE_SELECT_HINT}</Text>}
        {showViewHint && <Text dimColor> · enter to view</Text>}
      </Box>
    </Box>
  )
}
