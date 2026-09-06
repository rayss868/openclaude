import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import type { LineEndingType } from '../../utils/fileRead.js'
import { getErrnoCode } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { commitSiblingTempFileAtomic } from '../../utils/atomicReplace.js'

/**
 * Maximum characters allowed in a single chunk written through the chunked
 * write helper. Callers must split content larger than this into multiple
 * sequential chunks.
 */
export const MAX_FILE_WRITE_CHUNK_CHARS = 32_000

/**
 * Lifecycle stage of a chunked write. Exported for callers/tooling that need to
 * reason about the state machine; the concrete operation is selected by calling
 * the matching start/append/commit function.
 */
export type ChunkedWriteMode = 'start' | 'append' | 'finish'

/** In-session state for one in-progress chunked write. */
export type ChunkedWriteState = {
  writeId: string
  targetPath: string
  tempPath: string
  nextChunkIndex: number
  initialMtimeMs: number | null
  oldContent: string | null
  encoding: BufferEncoding
  lineEndings: LineEndingType
}

/** Status reported back to the caller after each chunked write step. */
export type ChunkedWriteStatus =
  | {
      type: 'chunked_start'
      filePath: string
      writeId: string
      nextChunkIndex: number
    }
  | {
      type: 'chunked_append'
      filePath: string
      writeId: string
      nextChunkIndex: number
    }
  | {
      type: 'chunked_finish'
      filePath: string
      writeId: string
    }

export type ChunkedWriteFinalization = {
  status: Extract<ChunkedWriteStatus, { type: 'chunked_finish' }>
  oldContent: string | null
  encoding: BufferEncoding
  lineEndings: LineEndingType
}

/** Error thrown for actionable invariant failures in the chunked write flow. */
export class ChunkedWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChunkedWriteError'
  }
}

const states = new Map<string, ChunkedWriteState>()

function tempPathFor(targetPath: string, writeId: string): string {
  const resolved = resolve(targetPath)
  return join(
    dirname(resolved),
    `${basename(resolved)}.${writeId}.openclaude.tmp`,
  )
}

function enforceChunkLimit(content: string): void {
  if (content.length > MAX_FILE_WRITE_CHUNK_CHARS) {
    throw new ChunkedWriteError(
      `Chunk is ${content.length} characters but must be at most ` +
        `${MAX_FILE_WRITE_CHUNK_CHARS} characters; split it into smaller chunks.`,
    )
  }
}

/**
 * Begin a chunked write. Creates a sibling temporary file holding the first
 * chunk and records in-session state. The target file is never modified by
 * this call.
 */
export async function startChunkedWrite(
  targetPath: string,
  content: string,
  snapshot: {
    expectedInitialMtimeMs: number | null
    oldContent: string | null
    encoding: BufferEncoding
    lineEndings: LineEndingType
  },
): Promise<ChunkedWriteStatus> {
  enforceChunkLimit(content)

  const fs = getFsImplementation()
  const resolvedTarget = resolve(targetPath)
  const writeId = randomUUID()
  const tempPath = tempPathFor(resolvedTarget, writeId)

  let initialMtimeMs = snapshot.expectedInitialMtimeMs

  if (snapshot.expectedInitialMtimeMs !== null) {
    let fileStat
    try {
      fileStat = await fs.stat(resolvedTarget)
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        throw new ChunkedWriteError(
          `Target ${resolvedTarget} is missing but a prior snapshot was supplied`,
        )
      }
      throw error
    }
    if (Math.floor(fileStat.mtimeMs) !== snapshot.expectedInitialMtimeMs) {
      throw new ChunkedWriteError(
        `Target ${resolvedTarget} was modified before the chunked write started`,
      )
    }
  } else {
    try {
      const fileStat = await fs.stat(resolvedTarget)
      initialMtimeMs = Math.floor(fileStat.mtimeMs)
    } catch (error) {
      if (getErrnoCode(error) !== 'ENOENT') throw error
    }
  }

  try {
    await fs.writeFile(tempPath, content, { encoding: snapshot.encoding })
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {})
    throw new ChunkedWriteError(
      `Failed to create chunk temporary file: ${(error as Error).message}`,
    )
  }

  states.set(writeId, {
    writeId,
    targetPath: resolvedTarget,
    tempPath,
    nextChunkIndex: 1,
    initialMtimeMs,
    oldContent: snapshot.oldContent,
    encoding: snapshot.encoding,
    lineEndings: snapshot.lineEndings,
  })

  return {
    type: 'chunked_start',
    filePath: resolvedTarget,
    writeId,
    nextChunkIndex: 1,
  }
}

/**
 * Append a chunk to an in-progress chunked write. Requires the exact
 * next sequential index and preserves ordering invariants.
 */
export async function appendChunkedWrite(
  targetPath: string,
  writeId: string,
  chunkIndex: number,
  content: string,
): Promise<ChunkedWriteStatus> {
  enforceChunkLimit(content)

  const state = states.get(writeId)
  if (!state) {
    throw new ChunkedWriteError(`Unknown writeId: ${writeId}`)
  }
  if (resolve(targetPath) !== state.targetPath) {
    throw new ChunkedWriteError(
      `Target path ${targetPath} does not match the chunked write for ${writeId}`,
    )
  }
  if (chunkIndex !== state.nextChunkIndex) {
    throw new ChunkedWriteError(
      `Chunk index must be ${state.nextChunkIndex}, received ${chunkIndex}`,
    )
  }

  const fs = getFsImplementation()
  await fs.appendFile(state.tempPath, content, { encoding: 'utf8' })

  state.nextChunkIndex = chunkIndex + 1

  return {
    type: 'chunked_append',
    filePath: state.targetPath,
    writeId,
    nextChunkIndex: state.nextChunkIndex,
  }
}

function isStaleTargetError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === 'Target was modified before commit'
  )
}

async function discardChunkedWriteState(writeId: string): Promise<void> {
  await clearChunkedWrite(writeId).catch(() => {})
}

/**
 * Commit a chunked write: validate the active state and target, then perform
 * an atomic sibling-temp move. The target is left untouched on any failure.
 * Stale-target failures preserve the state for recovery; unrecoverable
 * failures discard only this write's state and temporary file.
 */
export async function commitChunkedWrite(
  targetPath: string,
  writeId: string,
): Promise<ChunkedWriteFinalization> {
  const state = states.get(writeId)
  if (!state) {
    throw new ChunkedWriteError(`Unknown writeId: ${writeId}`)
  }
  if (resolve(targetPath) !== state.targetPath) {
    throw new ChunkedWriteError(
      `Target path ${targetPath} does not match the chunked write for ${writeId}`,
    )
  }

  const fs = getFsImplementation()
  let tempStat
  try {
    tempStat = await fs.lstat(state.tempPath)
  } catch (error) {
    await discardChunkedWriteState(writeId)
    if (getErrnoCode(error) === 'ENOENT') {
      throw new ChunkedWriteError(
        `Temporary chunk file is missing for ${writeId}; cannot finish`,
      )
    }
    throw error
  }
  if (!tempStat.isFile()) {
    await discardChunkedWriteState(writeId)
    throw new ChunkedWriteError(
      `Temporary chunk file is not a regular file for ${writeId}`,
    )
  }

  try {
    await commitSiblingTempFileAtomic(state.tempPath, state.targetPath, {
      expectedTargetMtimeMs: state.initialMtimeMs,
    })
  } catch (error) {
    if (!isStaleTargetError(error)) {
      await discardChunkedWriteState(writeId)
    }
    throw new ChunkedWriteError((error as Error).message)
  }

  states.delete(writeId)

  return {
    status: {
      type: 'chunked_finish',
      filePath: state.targetPath,
      writeId,
    },
    oldContent: state.oldContent,
    encoding: state.encoding,
    lineEndings: state.lineEndings,
  }
}

/** Remove a single chunked write's state and temporary file (ENOENT tolerant). */
export async function clearChunkedWrite(writeId: string): Promise<void> {
  const state = states.get(writeId)
  if (!state) return
  states.delete(writeId)
  await getFsImplementation()
    .unlink(state.tempPath)
    .catch(error => {
      if (getErrnoCode(error) !== 'ENOENT') throw error
    })
}

/** Snapshot and remove all in-session chunked write state and temporary files.
 *  Never removes any target path. */
export async function cleanupChunkedWrites(): Promise<void> {
  const entries = [...states.values()]
  states.clear()
  await Promise.all(
    entries.map(entry =>
      getFsImplementation()
        .unlink(entry.tempPath)
        .catch(error => {
          if (getErrnoCode(error) !== 'ENOENT') throw error
        }),
    ),
  )
}
