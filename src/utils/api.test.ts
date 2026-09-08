import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext, type Tool, type Tools } from '../Tool.js'
import { FileWriteTool } from '../tools/FileWriteTool/FileWriteTool.js'
import { SkillTool } from '../tools/SkillTool/SkillTool.js'
import { normalizeToolInput, toolToAPISchema } from './api.js'

test('toolToAPISchema preserves provider-specific schema keywords in input_schema', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'WebFetch',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            description: 'Public HTTP or HTTPS URL',
          },
          metadata: {
            type: 'object',
            propertyNames: {
              pattern: '^[a-z]+$',
            },
            properties: {
              callback: {
                type: 'string',
                format: 'uri-reference',
              },
            },
          },
        },
      },
      prompt: async () => 'Fetch a URL',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  expect(schema).toMatchObject({
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'Public HTTP or HTTPS URL',
        },
        metadata: {
          type: 'object',
          propertyNames: {
            pattern: '^[a-z]+$',
          },
          properties: {
            callback: {
              type: 'string',
              format: 'uri-reference',
            },
          },
        },
      },
    },
  })
})

test('toolToAPISchema keeps skill required for SkillTool', async () => {
  const schema = await toolToAPISchema(SkillTool, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [] as unknown as Tools,
    agents: [],
  })

  expect((schema as { input_schema: unknown }).input_schema).toMatchObject({
    type: 'object',
    required: ['skill'],
  })
})

test('toolToAPISchema removes extra required keys not in properties (MCP schema sanitization)', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'mcp__test__create_object',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name', 'attributes'],
      },
      prompt: async () => 'Create an object',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  const inputSchema = (schema as { input_schema: { required?: string[] } }).input_schema
  expect(inputSchema.required).toEqual(['name'])
})

test('normalizeToolInput strips chunk metadata for replace/start FileWrite writes', () => {
  const replaceInput = normalizeToolInput(FileWriteTool, {
    file_path: 'a.md',
    content: 'hello',
    write_mode: 'replace',
    write_id: 'some-write-id',
    chunk_index: 3,
  } as never)
  expect(replaceInput).toEqual({ file_path: 'a.md', content: 'hello', write_mode: 'replace' })
  expect(FileWriteTool.inputSchema.safeParse(replaceInput).success).toBe(true)

  const startInput = normalizeToolInput(FileWriteTool, {
    file_path: 'a.md',
    content: 'hello',
    write_mode: 'start',
    chunk_index: 0,
  } as never)
  expect(startInput).toEqual({ file_path: 'a.md', content: 'hello', write_mode: 'start' })
  expect(FileWriteTool.inputSchema.safeParse(startInput).success).toBe(true)
})

test('normalizeToolInput keeps chunk metadata intact for append/finish FileWrite writes', () => {
  const appendInput = normalizeToolInput(FileWriteTool, {
    file_path: 'a.md',
    content: 'more',
    write_mode: 'append',
    write_id: 'w-1',
    chunk_index: 5,
  } as never)
  expect(appendInput).toEqual({
    file_path: 'a.md',
    content: 'more',
    write_mode: 'append',
    write_id: 'w-1',
    chunk_index: 5,
  })
  expect(FileWriteTool.inputSchema.safeParse(appendInput).success).toBe(true)
})
