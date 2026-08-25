import { dirname, sep } from 'path'
import { type UUID } from 'crypto'
import { logEvent } from 'src/services/analytics/index.js'
import { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from '../../services/teamMemorySync/teamMemSecretGuard.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { countLinesChanged, getPatchForDisplay } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { getFileModificationTime, writeTextContent } from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  fetchSingleFileGitDiff,
  type ToolUseDiff,
} from '../../utils/gitDiff.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { gitDiffSchema, hunkSchema } from '../FileEditTool/types.js'
import { FILE_WRITE_TOOL_NAME, getWriteToolDescription } from './prompt.js'
import {
  appendChunkedWrite,
  commitChunkedWrite,
  MAX_FILE_WRITE_CHUNK_CHARS,
  startChunkedWrite,
} from './chunkedWrite.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'

export const inputSchema = lazySchema(() =>
  z
    .strictObject({
      file_path: z
        .string()
        .describe(
          'The absolute path to the file to write (must be absolute, not relative)',
        ),
      write_mode: z
        .enum(['replace', 'start', 'append', 'finish'])
        .default('replace')
        .describe('Write lifecycle mode'),
      write_id: z.string().optional().describe('Chunked write identifier'),
      chunk_index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Zero-based chunk sequence index'),
      content: z.string().optional().describe('Content to write to the file'),
    })
    .superRefine((value, ctx) => {
      if (value.write_mode === 'finish') {
        if (value.content !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['content'],
            message: 'content must be omitted when write_mode is finish',
          })
        }
        if (!value.write_id) {
          ctx.addIssue({
            code: 'custom',
            path: ['write_id'],
            message: 'write_id is required when write_mode is finish',
          })
        }
        return
      }

      if (value.content === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['content'],
          message: `content is required when write_mode is ${value.write_mode}`,
        })
      } else if (value.content.length > MAX_FILE_WRITE_CHUNK_CHARS) {
        ctx.addIssue({
          code: 'custom',
          path: ['content'],
          message: `content must be at most ${MAX_FILE_WRITE_CHUNK_CHARS} characters`,
        })
      }

      if (value.write_mode === 'replace' || value.write_mode === 'start') {
        if (value.write_id !== undefined || value.chunk_index !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `write_id and chunk_index are only valid for append mode`,
          })
        }
      } else {
        if (!value.write_id) {
          ctx.addIssue({
            code: 'custom',
            path: ['write_id'],
            message: 'write_id is required when write_mode is append',
          })
        }
        if (value.chunk_index === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['chunk_index'],
            message: 'chunk_index is required when write_mode is append',
          })
        }
      }
    }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.union([
    z.object({
      type: z.literal('create'),
      filePath: z.string().describe('The path to the file that was written'),
      content: z.string().describe('The content that was written to the file'),
      structuredPatch: z
        .array(hunkSchema())
        .describe('Diff patch showing the changes'),
      originalFile: z
        .literal(null)
        .describe('The original file content before the write'),
      gitDiff: gitDiffSchema().optional(),
    }),
    z.object({
      type: z.literal('update'),
      filePath: z.string().describe('The path to the file that was written'),
      content: z.string().describe('The content that was written to the file'),
      structuredPatch: z
        .array(hunkSchema())
        .describe('Diff patch showing the changes'),
      originalFile: z
        .string()
        .describe('The original file content before the write'),
      gitDiff: gitDiffSchema().optional(),
    }),
    z.object({
      type: z.literal('chunked_start'),
      filePath: z.string(),
      writeId: z.string(),
      nextChunkIndex: z.number().int().nonnegative(),
    }),
    z.object({
      type: z.literal('chunked_append'),
      filePath: z.string(),
      writeId: z.string(),
      nextChunkIndex: z.number().int().nonnegative(),
    }),
    z.object({
      type: z.literal('chunked_finish'),
      filePath: z.string(),
      writeId: z.string(),
    }),
  ]),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
export type FileWriteToolInput = InputSchema

async function runPreWriteEffects({
  filePath,
  updateFileHistoryState,
  dynamicSkillDirTriggers,
  parentMessage,
}: {
  filePath: string
  updateFileHistoryState: ToolUseContext['updateFileHistoryState']
  dynamicSkillDirTriggers: ToolUseContext['dynamicSkillDirTriggers']
  parentMessage: { uuid: UUID }
}): Promise<void> {
  const cwd = getCwd()
  const newSkillDirs = await discoverSkillDirsForPaths([filePath], cwd)
  if (newSkillDirs.length > 0) {
    for (const skillDir of newSkillDirs) {
      dynamicSkillDirTriggers?.add(skillDir)
    }
    addSkillDirectories(newSkillDirs).catch(() => {})
  }
  activateConditionalSkillsForPaths([filePath], cwd)

  await diagnosticTracker.beforeFileEditedCompat(filePath)
  await getFsImplementation().mkdir(dirname(filePath))
  if (fileHistoryEnabled()) {
    await fileHistoryTrackEdit(
      updateFileHistoryState,
      filePath,
      parentMessage.uuid,
    )
  }
}

type FinalizedWriteEffectsArgs = {
  filePath: string
  displayPath: string
  content: string
  oldContent: string | null
  readFileState: ToolUseContext['readFileState']
  dynamicSkillDirTriggers: ToolUseContext['dynamicSkillDirTriggers']
}

async function runFinalizedWriteEffects(
  args: FinalizedWriteEffectsArgs & { compactOnly: true },
): Promise<void>
async function runFinalizedWriteEffects(
  args: FinalizedWriteEffectsArgs & { compactOnly?: false },
): Promise<Output>
async function runFinalizedWriteEffects({
  filePath,
  displayPath,
  content,
  oldContent,
  readFileState,
  dynamicSkillDirTriggers,
  compactOnly = false,
}: FinalizedWriteEffectsArgs & { compactOnly?: boolean }): Promise<Output | void> {
  const cwd = getCwd()
  const newSkillDirs = await discoverSkillDirsForPaths([filePath], cwd)
  if (newSkillDirs.length > 0) {
    for (const skillDir of newSkillDirs) {
      dynamicSkillDirTriggers?.add(skillDir)
    }
    addSkillDirectories(newSkillDirs).catch(() => {})
  }
  activateConditionalSkillsForPaths([filePath], cwd)

  const lspManager = getLspServerManager()
  if (lspManager) {
    clearDeliveredDiagnosticsForFile(`file://${filePath}`)
    lspManager.changeFile(filePath, content).catch((err: Error) => {
      logForDebugging(
        `LSP: Failed to notify server of file change for ${filePath}: ${err.message}`,
      )
      logError(err)
    })
    lspManager.saveFile(filePath).catch((err: Error) => {
      logForDebugging(
        `LSP: Failed to notify server of file save for ${filePath}: ${err.message}`,
      )
      logError(err)
    })
  }

  notifyVscodeFileUpdated(filePath, oldContent, content)
  readFileState.set(filePath, {
    content,
    timestamp: getFileModificationTime(filePath),
    offset: undefined,
    limit: undefined,
  })

  if (filePath.endsWith(`${sep}AGENTS.md`) || filePath.endsWith(`${sep}CLAUDE.md`)) {
    logEvent('tengu_write_claudemd', {})
  }

  if (compactOnly) {
    logFileOperation({
      operation: 'write',
      tool: 'FileWriteTool',
      filePath,
      type: oldContent !== null ? 'update' : 'create',
    })
    return
  }

  let gitDiff: ToolUseDiff | undefined
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_quartz_lantern', false)
  ) {
    const startTime = Date.now()
    const diff = await fetchSingleFileGitDiff(filePath)
    if (diff) gitDiff = diff
    logEvent('tengu_tool_use_diff_computed', {
      isWriteTool: true,
      durationMs: Date.now() - startTime,
      hasDiff: !!diff,
    })
  }

  if (oldContent !== null) {
    const patch = getPatchForDisplay({
      filePath: displayPath,
      fileContents: oldContent,
      edits: [
        {
          old_string: oldContent,
          new_string: content,
          replace_all: false,
        },
      ],
    })
    countLinesChanged(patch)
    logFileOperation({
      operation: 'write',
      tool: 'FileWriteTool',
      filePath,
      type: 'update',
    })
    return {
      type: 'update',
      filePath: displayPath,
      content,
      structuredPatch: patch,
      originalFile: oldContent,
      ...(gitDiff && { gitDiff }),
    }
  }

  countLinesChanged([], content)
  logFileOperation({
    operation: 'write',
    tool: 'FileWriteTool',
    filePath,
    type: 'create',
  })
  return {
    type: 'create',
    filePath: displayPath,
    content,
    structuredPatch: [],
    originalFile: null,
    ...(gitDiff && { gitDiff }),
  }
}

export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  searchHint: 'create or overwrite files',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return 'Write a file to the local filesystem.'
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Writing ${summary}` : 'Writing file'
  },
  async prompt() {
    return getWriteToolDescription()
  },
  renderToolUseMessage,
  isResultTruncated,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    return `${input.file_path}: ${input.content ?? ''}`
  },
  getPath(input): string {
    return input.file_path
  },
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileWriteTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText() {
    // Transcript render shows either content (create, via HighlightedCode)
    // or a structured diff (update). The heuristic's 'content' allowlist key
    // would index the raw content string even in update mode where it's NOT
    // shown — phantom. Under-count: tool_use already indexes file_path.
    return ''
  },
  async validateInput(
    { file_path, write_mode, write_id, chunk_index, content },
    toolUseContext: ToolUseContext,
  ) {
    const fullFilePath = expandPath(file_path)

    if (write_mode === 'finish' && !write_id) {
      return {
        result: false,
        message: 'write_id is required when finishing a chunked write.',
        errorCode: 0,
      }
    }

    if (content === undefined && write_mode !== 'finish') {
      return {
        result: false,
        message: `content is required when write_mode is ${write_mode}.`,
        errorCode: 0,
      }
    }
    if (content !== undefined && content.length > MAX_FILE_WRITE_CHUNK_CHARS) {
      return {
        result: false,
        message:
          `Content is ${content.length} characters but must be at most ` +
          `${MAX_FILE_WRITE_CHUNK_CHARS} characters. Use write_mode "start" ` +
          'and then "append" for larger files.',
        errorCode: 0,
      }
    }
    if (write_mode === 'append' && (!write_id || chunk_index === undefined)) {
      return {
        result: false,
        message:
          'write_id and chunk_index are required when appending a chunked write.',
        errorCode: 0,
      }
    }

    if (content !== undefined) {
      const secretError = checkTeamMemSecrets(fullFilePath, content)
      if (secretError) {
        return { result: false, message: secretError, errorCode: 0 }
      }
    }

    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 1,
      }
    }

    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()
    let fileMtimeMs: number
    try {
      const fileStat = await fs.stat(fullFilePath)
      fileMtimeMs = fileStat.mtimeMs
    } catch (e) {
      if (isENOENT(e)) {
        return { result: true }
      }
      throw e
    }

    const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
    if (!readTimestamp || readTimestamp.isPartialView) {
      return {
        result: false,
        message:
          'File has not been read yet. Read it first before writing to it.',
        errorCode: 2,
      }
    }

    const lastWriteTime = Math.floor(fileMtimeMs)
    if (lastWriteTime > readTimestamp.timestamp) {
      return {
        result: false,
        message:
          'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
        errorCode: 3,
      }
    }

    return { result: true }
  },
  async call(
    { file_path, write_mode, write_id, chunk_index, content },
    { readFileState, updateFileHistoryState, dynamicSkillDirTriggers },
    _canUseTool,
    parentMessage,
    _onProgress,
  ) {
    const fullFilePath = expandPath(file_path)

    if (write_mode === 'start') {
      const initialRead = readFileState.get(fullFilePath)
      let snapshot: ReturnType<typeof readFileSyncWithMetadata> | null
      try {
        snapshot = readFileSyncWithMetadata(fullFilePath)
      } catch (error) {
        if (isENOENT(error)) {
          snapshot = null
        } else {
          throw error
        }
      }
      const status = await startChunkedWrite(fullFilePath, content!, {
        expectedInitialMtimeMs:
          initialRead?.timestamp === undefined
            ? null
            : Math.floor(initialRead.timestamp),
        oldContent: initialRead?.content ?? snapshot?.content ?? null,
        encoding: snapshot?.encoding ?? 'utf8',
        lineEndings: snapshot?.lineEndings ?? 'LF',
      })
      return { data: status }
    }

    if (write_mode === 'append') {
      const status = await appendChunkedWrite(
        fullFilePath,
        write_id!,
        chunk_index!,
        content!,
      )
      return { data: status }
    }

    if (write_mode === 'finish') {
      await runPreWriteEffects({
        filePath: fullFilePath,
        updateFileHistoryState,
        dynamicSkillDirTriggers,
        parentMessage,
      })
      const finalized = await commitChunkedWrite(fullFilePath, write_id!)
      const finalMeta = readFileSyncWithMetadata(fullFilePath)
      await runFinalizedWriteEffects({
        filePath: fullFilePath,
        displayPath: file_path,
        content: finalMeta.content,
        oldContent: finalized.oldContent,
        readFileState,
        dynamicSkillDirTriggers,
        compactOnly: true,
      })
      return {
        data: {
          type: 'chunked_finish',
          filePath: file_path,
          writeId: finalized.status.writeId,
        },
      }
    }

    if (content === undefined) {
      throw new Error('content is required for replace mode')
    }

    const dir = dirname(fullFilePath)

    await runPreWriteEffects({
      filePath: fullFilePath,
      updateFileHistoryState,
      dynamicSkillDirTriggers,
      parentMessage,
    })

    // Load current state and confirm no changes since last read.
    // Please avoid async operations between here and writing to disk to preserve atomicity.
    let meta: ReturnType<typeof readFileSyncWithMetadata> | null
    try {
      meta = readFileSyncWithMetadata(fullFilePath)
    } catch (e) {
      if (isENOENT(e)) {
        meta = null
      } else {
        throw e
      }
    }

    if (meta !== null) {
      const lastWriteTime = getFileModificationTime(fullFilePath)
      const lastRead = readFileState.get(fullFilePath)
      if (!lastRead || lastWriteTime > lastRead.timestamp) {
        const isFullRead =
          lastRead &&
          lastRead.offset === undefined &&
          lastRead.limit === undefined
        if (!isFullRead || meta.content !== lastRead.content) {
          throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        }
      }
    }

    const enc = meta?.encoding ?? 'utf8'
    const oldContent = meta?.content ?? null

    // Write is a full content replacement — the model sent explicit line endings
    // in `content` and meant them.
    writeTextContent(fullFilePath, content, enc, 'LF')

    const finalMeta = readFileSyncWithMetadata(fullFilePath)
    const data = await runFinalizedWriteEffects({
      filePath: fullFilePath,
      displayPath: file_path,
      content: finalMeta.content,
      oldContent,
      readFileState,
      dynamicSkillDirTriggers,
    })
    return { data }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.type === 'chunked_start') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Started chunked write for ${output.filePath}; next chunk index is ${output.nextChunkIndex}.`,
      }
    }
    if (output.type === 'chunked_append') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Appended chunk to ${output.filePath}; next chunk index is ${output.nextChunkIndex}.`,
      }
    }
    if (output.type === 'chunked_finish') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Finished chunked write for ${output.filePath}.`,
      }
    }

    const { filePath, type } = output
    switch (type) {
      case 'create':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `File created successfully at: ${filePath}`,
        }
      case 'update':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `The file ${filePath} has been updated successfully.`,
        }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
