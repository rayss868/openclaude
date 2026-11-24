import type { StructuredPatchHunk } from 'diff'
import React, { useEffect, useRef, useState } from 'react'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import type { DiffData } from '../../hooks/useDiffData.js'
import { useDiffData } from '../../hooks/useDiffData.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { type TurnDiff, useTurnDiffs } from '../../hooks/useTurnDiffs.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { Message } from '../../types/message.js'
import { plural } from '../../utils/stringUtils.js'
import { Byline } from '../design-system/Byline.js'
import { Tab, Tabs } from '../design-system/Tabs.js'
import { DiffDetailView } from './DiffDetailView.js'
import { DiffFileList } from './DiffFileList.js'

type Props = { messages: Message[] }
type ViewMode = 'list' | 'detail'
type DiffSource = { type: 'current' } | { type: 'turn'; turn: TurnDiff }
type ScrollCommand = 'up' | 'down' | 'pageUp' | 'pageDown' | 'fullPageUp' | 'fullPageDown' | 'top' | 'bottom'

function turnDiffToDiffData(turn: TurnDiff): DiffData {
  const files = Array.from(turn.files.values())
    .map(file => ({
      path: file.filePath,
      linesAdded: file.linesAdded,
      linesRemoved: file.linesRemoved,
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
      isNewFile: file.isNewFile,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const hunks = new Map<string, StructuredPatchHunk[]>()
  for (const file of turn.files.values()) hunks.set(file.filePath, file.hunks)
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

export function DiffPane({ messages }: Props) {
  const gitDiffData = useDiffData()
  const turnDiffs = useTurnDiffs(messages)
  const terminalSize = useTerminalSize()
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [sourceIndex, setSourceIndex] = useState(0)
  const sources: DiffSource[] = [{ type: 'current' }, ...turnDiffs.map(turn => ({ type: 'turn' as const, turn }))]
  const currentSource = sources[sourceIndex]
  const currentTurn = currentSource?.type === 'turn' ? currentSource.turn : null
  const diffData = currentTurn ? turnDiffToDiffData(currentTurn) : gitDiffData
  const selectedFile = diffData.files[selectedIndex]
  const selectedHunks = selectedFile ? diffData.hunks.get(selectedFile.path) || [] : []
  const detailScrollRef = useRef<ScrollBoxHandle>(null)

  useEffect(() => {
    if (sourceIndex >= sources.length) setSourceIndex(Math.max(0, sources.length - 1))
  }, [sourceIndex, sources.length])

  const previousSourceIndex = useRef(sourceIndex)
  useEffect(() => {
    if (previousSourceIndex.current !== sourceIndex) {
      setSelectedIndex(0)
      previousSourceIndex.current = sourceIndex
    }
  }, [sourceIndex])

  function scrollDetail(command: ScrollCommand): void {
    const handle = detailScrollRef.current
    if (viewMode !== 'detail' || !handle) return
    const halfPage = Math.max(1, Math.floor(handle.getViewportHeight() / 2))
    const fullPage = Math.max(1, handle.getViewportHeight())
    switch (command) {
      case 'up': handle.scrollBy(-1); break
      case 'down': handle.scrollBy(1); break
      case 'pageUp': handle.scrollBy(-halfPage); break
      case 'pageDown': handle.scrollBy(halfPage); break
      case 'fullPageUp': handle.scrollBy(-fullPage); break
      case 'fullPageDown': handle.scrollBy(fullPage); break
      case 'top': handle.scrollTo(0); break
      case 'bottom': handle.scrollToBottom(); break
    }
  }

  useKeybindings({
    'diff:previousSource': () => {
      if (viewMode === 'detail') setViewMode('list')
      else if (sources.length > 1) setSourceIndex(prev => (prev - 1 + sources.length) % sources.length)
    },
    'diff:nextSource': () => {
      if (viewMode === 'list' && sources.length > 1) setSourceIndex(prev => (prev + 1) % sources.length)
    },
    'diff:back': () => { if (viewMode === 'detail') setViewMode('list') },
    'diff:viewDetails': () => { if (viewMode === 'list' && selectedFile) setViewMode('detail') },
    'diff:previousFile': () => {
      if (viewMode === 'detail') scrollDetail('up')
      else setSelectedIndex(prev => Math.max(0, prev - 1))
    },
    'diff:nextFile': () => {
      if (viewMode === 'detail') scrollDetail('down')
      else setSelectedIndex(prev => Math.min(diffData.files.length - 1, prev + 1))
    },
  }, { context: 'DiffPane' })

  useKeybindings({
    'scroll:pageUp': () => scrollDetail('pageUp'),
    'scroll:pageDown': () => scrollDetail('pageDown'),
    'scroll:fullPageUp': () => scrollDetail('fullPageUp'),
    'scroll:fullPageDown': () => scrollDetail('fullPageDown'),
    'scroll:top': () => scrollDetail('top'),
    'scroll:bottom': () => scrollDetail('bottom'),
  }, { context: 'DiffPane', isActive: viewMode === 'detail' })

  const dismissShortcut = 'Esc'
  const width = terminalSize.columns
  const title = currentTurn
    ? `Turn ${currentTurn.turnIndex}${currentTurn.userPromptPreview ? ` “${currentTurn.userPromptPreview}”` : ''}`
    : 'Uncommitted changes'
  const emptyMessage = currentTurn ? 'No file changes in this turn' : 'No changes yet'
  const fileList = diffData.files.length === 0 ? (
    <Box marginTop={1}><Text dimColor>{diffData.loading ? 'Loading diff…' : emptyMessage}</Text></Box>
  ) : (
    <>
      {viewMode === 'list' ? (
        <>
          <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
            <DiffDetailView
              filePath={selectedFile?.path || ''}
              hunks={selectedHunks}
              isLargeFile={selectedFile?.isLargeFile}
              isBinary={selectedFile?.isBinary}
              isTruncated={selectedFile?.isTruncated}
              isUntracked={selectedFile?.isUntracked}
              width={width}
            />
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <DiffFileList files={diffData.files} selectedIndex={selectedIndex} />
          </Box>
        </>
      ) : (
        <Box flexGrow={1} overflow="hidden">
          <DiffDetailView
            filePath={selectedFile?.path || ''}
            hunks={selectedHunks}
            isLargeFile={selectedFile?.isLargeFile}
            isBinary={selectedFile?.isBinary}
            isTruncated={selectedFile?.isTruncated}
            isUntracked={selectedFile?.isUntracked}
          />
        </Box>
      )}
    </>
  )

  return (
    <Box flexDirection="column" width={width} height="100%" overflow="hidden" paddingRight={1}>
      <Box justifyContent="space-between">
        <Text bold>{title}</Text>
        <Text dimColor>{dismissShortcut} close</Text>
      </Box>
      {diffData.stats && (
        <Text dimColor>
          {diffData.stats.filesCount} {plural(diffData.stats.filesCount, 'file')} changed
          {diffData.stats.linesAdded > 0 && <Text color="diffAddedWord"> +{diffData.stats.linesAdded}</Text>}
          {diffData.stats.linesRemoved > 0 && <Text color="diffRemovedWord"> -{diffData.stats.linesRemoved}</Text>}
        </Text>
      )}
      <Tabs
        hidden={sources.length <= 1}
        selectedTab={String(sourceIndex)}
        onTabChange={tabId => setSourceIndex(Number(tabId))}
        disableNavigation
      >
        {sources.map((source, index) => (
          <Tab key={index} id={String(index)} title={source.type === 'current' ? 'Current' : `T${source.turn.turnIndex}`}>
            <Box flexDirection="column" flexGrow={1} height="100%">
              {viewMode === 'detail' ? <ScrollBox ref={detailScrollRef} flexGrow={1}>{fileList}</ScrollBox> : fileList}
              <Box marginTop={1}>
                <Byline>
                  {sources.length > 1 && <Text>←/→ source</Text>}
                  <Text>↑/↓ {viewMode === 'list' ? 'select' : 'scroll'}</Text>
                  <Text>Enter {viewMode === 'list' ? 'view' : 'back'}</Text>
                  <Text>{dismissShortcut} close</Text>
                </Byline>
              </Box>
            </Box>
          </Tab>
        ))}
      </Tabs>
    </Box>
  )
}
