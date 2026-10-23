import { expect, test } from 'bun:test'

import { FileWriteTool, inputSchema } from './FileWriteTool.js'
import { MAX_FILE_WRITE_CHUNK_CHARS } from './chunkedWrite.js'

const filePath = 'C:/tmp/openclaude-write.txt'

test('defaults to replace and accepts the maximum replace payload', () => {
  const result = inputSchema().safeParse({
    file_path: filePath,
    content: 'x'.repeat(MAX_FILE_WRITE_CHUNK_CHARS),
  })

  expect(result.success).toBe(true)
  if (result.success) {
    expect(result.data.write_mode).toBe('replace')
  }
})

test('rejects content larger than one write payload', () => {
  const result = inputSchema().safeParse({
    file_path: filePath,
    content: 'x'.repeat(MAX_FILE_WRITE_CHUNK_CHARS + 1),
  })

  expect(result.success).toBe(false)
})

test('accepts start, append, and finish lifecycle inputs', () => {
  expect(
    inputSchema().safeParse({
      file_path: filePath,
      write_mode: 'start',
      content: 'first',
    }).success,
  ).toBe(true)
  expect(
    inputSchema().safeParse({
      file_path: filePath,
      write_mode: 'append',
      write_id: 'write-1',
      chunk_index: 1,
      content: 'second',
    }).success,
  ).toBe(true)
  expect(
    inputSchema().safeParse({
      file_path: filePath,
      write_mode: 'finish',
      write_id: 'write-1',
    }).success,
  ).toBe(true)
})

test('requires append metadata and finish write_id', () => {
  expect(
    inputSchema().safeParse({
      file_path: filePath,
      write_mode: 'append',
      content: 'second',
    }).success,
  ).toBe(false)
  expect(
    inputSchema().safeParse({
      file_path: filePath,
      write_mode: 'finish',
    }).success,
  ).toBe(false)
})

test('finish rejects content and replace rejects chunk metadata', () => {
  expect(
    inputSchema().safeParse({
      file_path: filePath,
      write_mode: 'finish',
      write_id: 'write-1',
      content: 'unexpected',
    }).success,
  ).toBe(false)

  // replace mode rejects chunk metadata at the schema level; the stripping
  // happens earlier in normalizeToolInputForValidation
  const result = inputSchema().safeParse({
    file_path: filePath,
    content: 'new content',
    write_id: 'write-1',
  })
  expect(result.success).toBe(false)
})

test('replace with chunk metadata is rejected by the schema', () => {
  const result = inputSchema().safeParse({
    file_path: filePath,
    content: 'new content',
    chunk_index: 0,
  })

  expect(result.success).toBe(false)
  if (!result.success) {
    const message = result.error.issues.map(i => i.message).join(' ')
    expect(message).toContain('only valid for append mode')
  }
})

test('start mode rejects chunk metadata at the schema level', () => {
  const result = inputSchema().safeParse({
    file_path: filePath,
    write_mode: 'start',
    content: 'first chunk',
    write_id: 'some-id',
    chunk_index: 0,
  })

  expect(result.success).toBe(false)
})

test('chunked results expose the write_id the model must echo back', () => {
  const started = FileWriteTool.mapToolResultToToolResultBlockParam(
    {
      type: 'chunked_start',
      filePath: filePath,
      writeId: 'write-abc',
      nextChunkIndex: 1,
    },
    'tool-1',
  )
  expect(started.content).toContain('write_id is write-abc')
  expect(started.content).toContain('next chunk index is 1')

  const appended = FileWriteTool.mapToolResultToToolResultBlockParam(
    {
      type: 'chunked_append',
      filePath: filePath,
      writeId: 'write-abc',
      nextChunkIndex: 2,
    },
    'tool-2',
  )
  expect(appended.content).toContain('write_id is write-abc')
  expect(appended.content).toContain('next chunk index is 2')
})
