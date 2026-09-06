import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'

const moduleNonce = `vision-${Date.now()}-${Math.random()}`
const { FileReadTool } = (await import(
  `./FileReadTool.js?${moduleNonce}`
)) as typeof import('./FileReadTool.js')
const { renderPromptTemplate } = (await import(
  `./prompt.js?${moduleNonce}`
)) as typeof import('./prompt.js')

const originalOpenAIBaseUrl = process.env.OPENAI_BASE_URL
const originalOpenAIApiBase = process.env.OPENAI_API_BASE

beforeEach(async () => {
  await acquireSharedMutationLock('tools/FileReadTool/prompt.vision.test.ts')
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
})

afterEach(() => {
  try {
    if (originalOpenAIBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL
    } else {
      process.env.OPENAI_BASE_URL = originalOpenAIBaseUrl
    }
    if (originalOpenAIApiBase === undefined) {
      delete process.env.OPENAI_API_BASE
    } else {
      process.env.OPENAI_API_BASE = originalOpenAIApiBase
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function createToolUseContext(
  mainLoopModel: string,
  providerOverride?: ToolUseContext['options']['providerOverride'],
): ToolUseContext {
  return {
    options: {
      mainLoopModel,
      providerOverride,
    },
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
    readFileState: new Map(),
    nestedMemoryAttachmentTriggers: new Set(),
  } as unknown as ToolUseContext
}

describe('renderPromptTemplate — vision sentence (issue #1421)', () => {
  test('includes the image-reading sentence when the active model supports vision (default Claude)', () => {
    const rendered = renderPromptTemplate(
      '- Results are returned using cat -n format, with line numbers starting at 1',
      '',
      '',
    )

    expect(rendered).toContain('This tool allows Claude Code to read images')
  })

  test('always includes the Jupyter notebook sentence and the directory-listing hint', () => {
    const rendered = renderPromptTemplate(
      '- Results are returned using cat -n format, with line numbers starting at 1',
      '',
      '',
    )

    expect(rendered).toContain('Jupyter notebooks')
    expect(rendered).toContain('not directories')
  })
})

describe('FileReadTool.validateInput — vision gate (issue #1421)', () => {
  test('image reads are no longer blocked by pre-flight vision check', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: 'fixture.png' },
      createToolUseContext('mimo-v2.5-pro'),
    )

    expect(result).toMatchObject({ result: true })
  })

  test('provider override base URL wins over ambient OpenAI-compatible env', async () => {
    process.env.OPENAI_BASE_URL = 'https://api.xiaomimimo.com/v1'

    const result = await FileReadTool.validateInput(
      { file_path: 'fixture.png' },
      createToolUseContext('mimo-v2.5', {
        model: 'mimo-v2.5',
        baseURL: 'https://opencode.ai/zen/go/v1',
        apiKey: 'test-key',
      }),
    )

    expect(result).toMatchObject({ result: true })
  })

  test('falls back to OPENAI_BASE_URL when no provider override is present', async () => {
    process.env.OPENAI_BASE_URL = 'https://opencode.ai/zen/go/v1'

    const result = await FileReadTool.validateInput(
      { file_path: 'fixture.png' },
      createToolUseContext('mimo-v2.5'),
    )

    expect(result).toMatchObject({ result: true })
  })

  test('validates UNC image paths before the UNC no-I/O early return', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: '\\\\server\\share\\fixture.png' },
      createToolUseContext('mimo-v2.5-pro'),
    )

    expect(result).toMatchObject({ result: true })
  })
})

describe('FileReadTool.call — vision payload', () => {
  test('returns image content in newMessages for the next model turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openclaude-vision-test-'))
    const imagePath = join(directory, 'fixture.png')
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )

    try {
      await writeFile(imagePath, image)
      const result = await FileReadTool.call(
        { file_path: imagePath },
        createToolUseContext('claude-opus-4-8'),
      )

      if (result.data.type !== 'image') {
        throw new Error('Expected image tool result')
      }

      expect(result.data.file.type).toBe('image/png')
      expect(result.data.file.base64).toBeTruthy()
      expect(result.newMessages).toHaveLength(1)
      expect(result.newMessages?.[0].message.content).toMatch(
        /Image saved to temporary location:/,
      )

      const toolResult = FileReadTool.mapToolResultToToolResultBlockParam(
        result.data,
        'toolu_image_test',
      )
      expect(toolResult.content).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: result.data.file.base64,
          },
        },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
