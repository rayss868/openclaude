import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendChunkedWrite,
  cleanupChunkedWrites,
  commitChunkedWrite,
  MAX_FILE_WRITE_CHUNK_CHARS,
  startChunkedWrite,
} from './chunkedWrite.js'

const tempDirs: string[] = []

function snapshot(expectedInitialMtimeMs: number | null, oldContent: string | null = null) {
  return {
    expectedInitialMtimeMs,
    oldContent,
    encoding: 'utf8' as BufferEncoding,
    lineEndings: 'LF' as const,
  }
}

afterEach(async () => {
  await cleanupChunkedWrites()
  await Promise.all(
    tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  )
})

async function tempTarget(initial?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-write-chunk-'))
  tempDirs.push(dir)
  const target = join(dir, 'target.txt')
  if (initial !== undefined) await writeFile(target, initial, 'utf8')
  return target
}

async function tempFiles(target: string): Promise<string[]> {
  const names = await readdir(join(target, '..'))
  return names.filter(name => name.endsWith('.openclaude.tmp'))
}

test('start leaves an existing target unchanged', async () => {
  const target = await tempTarget('old')
  const initialMtimeMs = Math.floor((await stat(target)).mtimeMs)
  const result = await startChunkedWrite(
    target,
    'new-',
    snapshot(initialMtimeMs, 'old'),
  )

  expect(result.type).toBe('chunked_start')
  if (result.type === 'chunked_start') {
    expect(result.nextChunkIndex).toBe(1)
  }
  expect(await readFile(target, 'utf8')).toBe('old')
})

test('ordered chunks commit the exact concatenated content', async () => {
  const target = await tempTarget()
  const started = await startChunkedWrite(target, 'first-', snapshot(null))

  await expect(
    appendChunkedWrite(target, started.writeId, 2, 'wrong-order'),
  ).rejects.toThrow(/chunk index/i)
  await appendChunkedWrite(target, started.writeId, 1, 'second-')
  await appendChunkedWrite(target, started.writeId, 2, 'third')
  const finalized = await commitChunkedWrite(target, started.writeId)

  expect(finalized.status.type).toBe('chunked_finish')
  expect(finalized.oldContent).toBeNull()
  expect(await readFile(target, 'utf8')).toBe('first-second-third')
})

test('oversized chunks are rejected', async () => {
  const target = await tempTarget()
  await expect(
    startChunkedWrite(
      target,
      'x'.repeat(MAX_FILE_WRITE_CHUNK_CHARS + 1),
      snapshot(null),
    ),
  ).rejects.toThrow(/32000/)
})

test('append rejects oversized chunks', async () => {
  const target = await tempTarget()
  const started = await startChunkedWrite(target, 'first-', snapshot(null))

  await expect(
    appendChunkedWrite(
      target,
      started.writeId,
      1,
      'x'.repeat(MAX_FILE_WRITE_CHUNK_CHARS + 1),
    ),
  ).rejects.toThrow(/32000/)

  await expect(commitChunkedWrite(target, started.writeId)).resolves.toMatchObject({
    status: { type: 'chunked_finish' },
  })
  expect(await readFile(target, 'utf8')).toBe('first-')
})
test('unknown IDs and mismatched paths are rejected', async () => {
  const target = await tempTarget()
  await expect(appendChunkedWrite(target, 'missing', 1, 'x')).rejects.toThrow(
    /unknown/i,
  )

  const started = await startChunkedWrite(target, 'x', snapshot(null))
  const other = await tempTarget()
  await expect(
    commitChunkedWrite(other, started.writeId),
  ).rejects.toThrow(/target path/i)
})

test('external modification rejects commit and preserves the target', async () => {
  const target = await tempTarget('old')
  const started = await startChunkedWrite(
    target,
    'new',
    snapshot(Math.floor((await stat(target)).mtimeMs), 'old'),
  )
  await writeFile(target, 'external', 'utf8')

  await expect(commitChunkedWrite(target, started.writeId)).rejects.toThrow(
    /modified/i,
  )
  expect(await readFile(target, 'utf8')).toBe('external')
  expect((await tempFiles(target)).length).toBe(1)
})

test('cleanup removes temporary state without removing the target', async () => {
  const target = await tempTarget('old')
  await startChunkedWrite(
    target,
    'new',
    snapshot(Math.floor((await stat(target)).mtimeMs), 'old'),
  )
  expect((await tempFiles(target)).length).toBe(1)

  await cleanupChunkedWrites()

  expect(await readFile(target, 'utf8')).toBe('old')
  expect(await tempFiles(target)).toEqual([])
})

test('missing temporary file clears the active state', async () => {
  const target = await tempTarget()
  const started = await startChunkedWrite(target, 'new', snapshot(null))
  const files = await tempFiles(target)
  await rm(join(target, '..', files[0]!))

  await expect(commitChunkedWrite(target, started.writeId)).rejects.toThrow(
    /temporary/i,
  )
  await expect(
    commitChunkedWrite(target, started.writeId),
  ).rejects.toThrow(/unknown/i)
})
