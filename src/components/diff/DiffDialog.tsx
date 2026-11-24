import type { StructuredPatchHunk } from 'diff'
import React, { useEffect, useRef, useState } from 'react'

import type { CommandResultDisplay } from '../../commands.js'
import {
  useModalOrTerminalSize,
  useModalScrollRef,
} from '../../context/modalContext.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import { type DiffData, useDiffData } from '../../hooks/useDiffData.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { type TurnDiff, useTurnDiffs } from '../../hooks/useTurnDiffs.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import type { Message } from '../../types/message.js'
import { plural } from '../../utils/stringUtils.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { LoadingState } from '../design-system/LoadingState.js'
import { Tab, Tabs } from '../design-system/Tabs.js'
import { DiffDetailView } from './DiffDetailView.js'
import { DiffFileList } from './DiffFileList.js'
import {
  getDiffSplitLayout,
  MIN_DIFF_PREVIEW_COLUMNS,
} from './diffLayout.js'

type Props = {
  messages: Message[]
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

type ViewMode = 'list' | 'detail'

type DiffSource = { type: 'current' } | { type: 'turn'; turn: TurnDiff }

type ScrollCommand =
  | 'up'
  | 'down'
  | 'pageUp'
  | 'pageDown'
  | 'fullPageUp'
  | 'fullPageDown'
  | 'top'
  | 'bottom'

function turnDiffToDiffData(turn: TurnDiff): DiffData {
  const files = Array.from(turn.files.values())
    .map(f => ({
      path: f.filePath,
      linesAdded: f.linesAdded,
      linesRemoved: f.linesRemoved,
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
      isNewFile: f.isNewFile,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const hunks = new Map<string, StructuredPatchHunk[]>()
  for (const f of turn.files.values()) {
    hunks.set(f.filePath, f.hunks)
  }

  return {
    stats: {
      filesCount: turn.stats.filesChanged,
      linesAdded: turn.stats.linesAdded,
      linesRemoved: turn.stats.linesRemoved,
    },
    files,
    hunks,
    loading: false,
  }
}

export function DiffDialog({ messages, onDone }: Props) {
  const gitDiffData = useDiffData()
  const turnDiffs = useTurnDiffs(messages)
  const modalScrollRef = useModalScrollRef()
  const terminalSize = useTerminalSize()
  const { rows } = useModalOrTerminalSize(terminalSize)
  const splitLayout = getDiffSplitLayout({
    columns: terminalSize.columns,
    rows,
  })
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [sourceIndex, setSourceIndex] = useState(0)

  const sources: DiffSource[] = [
    { type: 'current' },
    ...turnDiffs.map(turn => ({ type: 'turn' as const, turn })),
  ]
  const currentSource = sources[sourceIndex]
  const currentTurn =
    currentSource?.type === 'turn' ? currentSource.turn : null
  const diffData = currentTurn ? turnDiffToDiffData(currentTurn) : gitDiffData
  const selectedFile = diffData.files[selectedIndex]
  const selectedHunks = selectedFile
    ? diffData.hunks.get(selectedFile.path) || []
    : []

  useEffect(() => {
    if (sourceIndex >= sources.length) {
      setSourceIndex(Math.max(0, sources.length - 1))
    }
  }, [sourceIndex, sources.length])

  const prevSourceIndex = useRef(sourceIndex)
  useEffect(() => {
    if (prevSourceIndex.current !== sourceIndex) {
      setSelectedIndex(0)
      prevSourceIndex.current = sourceIndex
    }
  }, [sourceIndex])

  useRegisterOverlay('diff-dialog', true)

  function scrollDetail(command: ScrollCommand): void {
    const handle = modalScrollRef?.current
    if (viewMode !== 'detail' || !handle) return
    const halfPage = Math.max(1, Math.floor(handle.getViewportHeight() / 2))
    const fullPage = Math.max(1, handle.getViewportHeight())
    switch (command) {
      case 'up':
        handle.scrollBy(-1)
        break
      case 'down':
        handle.scrollBy(1)
        break
      case 'pageUp':
        handle.scrollBy(-halfPage)
        break
      case 'pageDown':
        handle.scrollBy(halfPage)
        break
      case 'fullPageUp':
        handle.scrollBy(-fullPage)
        break
      case 'fullPageDown':
        handle.scrollBy(fullPage)
        break
      case 'top':
        handle.scrollTo(0)
        break
      case 'bottom':
        handle.scrollToBottom()
        break
    }
  }

  function handleCancel(): void {
    if (viewMode === 'detail') {
      setViewMode('list')
    } else {
      onDone('Diff dialog dismissed', { display: 'system' })
    }
  }

  useKeybindings(
    {
      'diff:previousSource': () => {
        if (viewMode === 'detail') {
          setViewMode('list')
        } else if (sources.length > 1) {
          setSourceIndex(prev => (prev - 1 + sources.length) % sources.length)
        }
      },
      'diff:nextSource': () => {
        if (viewMode === 'list' && sources.length > 1) {
          setSourceIndex(prev => (prev + 1) % sources.length)
        }
      },
      'diff:back': () => {
        if (viewMode === 'detail') {
          setViewMode('list')
        }
      },
      'diff:viewDetails': () => {
        if (viewMode === 'list' && selectedFile) {
          setViewMode('detail')
        }
      },
      'diff:previousFile': () => {
        if (viewMode === 'detail') {
          scrollDetail('up')
        } else {
          setSelectedIndex(prev => Math.max(0, prev - 1))
        }
      },
      'diff:nextFile': () => {
        if (viewMode === 'detail') {
          scrollDetail('down')
        } else {
          setSelectedIndex(prev =>
            Math.min(diffData.files.length - 1, prev + 1),
          )
        }
      },
    },
    { context: 'DiffDialog' },
  )

  useKeybindings(
    {
      'scroll:pageUp': () => scrollDetail('pageUp'),
      'scroll:pageDown': () => scrollDetail('pageDown'),
      'scroll:fullPageUp': () => scrollDetail('fullPageUp'),
      'scroll:fullPageDown': () => scrollDetail('fullPageDown'),
      'scroll:top': () => scrollDetail('top'),
      'scroll:bottom': () => scrollDetail('bottom'),
    },
    { context: 'DiffDialog', isActive: viewMode === 'detail' },
  )

  const subtitle = diffData.stats ? (
    <Text dimColor>
      {diffData.stats.filesCount}{' '}
      {plural(diffData.stats.filesCount, 'file')} changed
      {diffData.stats.linesAdded > 0 && (
        <Text color="diffAddedWord"> +{diffData.stats.linesAdded}</Text>
      )}
      {diffData.stats.linesRemoved > 0 && (
        <Text color="diffRemovedWord"> -{diffData.stats.linesRemoved}</Text>
      )}
    </Text>
  ) : null

  const headerTitle = currentTurn
    ? `Turn ${currentTurn.turnIndex}`
    : 'Uncommitted changes'
  const headerSubtitle = currentTurn
    ? currentTurn.userPromptPreview
      ? `"${currentTurn.userPromptPreview}"`
      : ''
    : '(git diff HEAD)'
  const title = (
    <Text>
      {headerTitle}
      {headerSubtitle ? <Text dimColor> {headerSubtitle}</Text> : null}
    </Text>
  )

  const dismissShortcut = useShortcutDisplay('diff:dismiss', 'DiffDialog', 'esc')

  let emptyMessage: string
  if (currentTurn) {
    emptyMessage = 'No file changes in this turn'
  } else if (
    diffData.stats &&
    diffData.stats.filesCount > 0 &&
    diffData.files.length === 0
  ) {
    emptyMessage = 'Too many files to display details'
  } else {
    emptyMessage = 'No changes yet'
  }

  const content =
    diffData.files.length === 0 ? (
      diffData.loading ? (
        <LoadingState message="Loading diff…" />
      ) : (
        <Box marginTop={1}>
          <Text dimColor>{emptyMessage}</Text>
        </Box>
      )
    ) : viewMode === 'list' ? (
      <Box flexDirection="column" marginTop={1}>
        {splitLayout.showPreview ? (
          <Box flexDirection="row" gap={2}>
            <Box
              flexDirection="column"
              flexShrink={0}
              width={splitLayout.listWidth}
            >
              <DiffFileList
                files={diffData.files}
                selectedIndex={selectedIndex}
                width={splitLayout.listWidth}
              />
            </Box>
            <Box
              flexDirection="column"
              width={splitLayout.previewWidth}
              height={splitLayout.previewHeight}
              borderStyle="round"
              borderDimColor
              paddingX={1}
              overflow="hidden"
            >
              <DiffDetailView
                filePath={selectedFile?.path || ''}
                hunks={selectedHunks}
                isLargeFile={selectedFile?.isLargeFile}
                isBinary={selectedFile?.isBinary}
                isTruncated={selectedFile?.isTruncated}
                isUntracked={selectedFile?.isUntracked}
                width={Math.max(20, splitLayout.previewWidth - 4)}
              />
            </Box>
          </Box>
        ) : (
          <>
            <DiffFileList files={diffData.files} selectedIndex={selectedIndex} />
            <Box marginTop={1}>
              <Text dimColor>
                Resize your terminal to at least {MIN_DIFF_PREVIEW_COLUMNS}{' '}
                columns to show the diff panel
              </Text>
            </Box>
          </>
        )}
      </Box>
    ) : (
      <Box flexDirection="column" marginTop={1}>
        <DiffDetailView
          filePath={selectedFile?.path || ''}
          hunks={selectedHunks}
          isLargeFile={selectedFile?.isLargeFile}
          isBinary={selectedFile?.isBinary}
          isTruncated={selectedFile?.isTruncated}
          isUntracked={selectedFile?.isUntracked}
        />
      </Box>
    )

  const body = (
    <Box flexDirection="column">
      {subtitle}
      {content}
    </Box>
  )

  return (
    <Dialog
      title={title}
      onCancel={handleCancel}
      color="background"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : viewMode === 'list' ? (
          <Byline>
            {sources.length > 1 && <Text>←/→ source</Text>}
            <Text>↑/↓ select</Text>
            <Text>Enter view</Text>
            <Text>{dismissShortcut} close</Text>
          </Byline>
        ) : (
          <Byline>
            <Text>↑/↓ scroll</Text>
            <Text>{dismissShortcut} back</Text>
          </Byline>
        )
      }
    >
      <Tabs
        hidden={sources.length <= 1}
        selectedTab={String(sourceIndex)}
        onTabChange={tabId => setSourceIndex(Number(tabId))}
        disableNavigation
      >
        {sources.map((source, index) => (
          <Tab
            key={index}
            id={String(index)}
            title={
              source.type === 'current' ? 'Current' : `T${source.turn.turnIndex}`
            }
          >
            {body}
          </Tab>
        ))}
      </Tabs>
    </Dialog>
  )
}
