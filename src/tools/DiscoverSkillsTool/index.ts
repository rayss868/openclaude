import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { isSkillSearchEnabled } from '../../services/skillSearch/featureCheck.js'
import { searchLocalSkills } from '../../services/skillSearch/localSearch.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logForDebugging } from '../../utils/debug.js'
import { DISCOVER_SKILLS_TOOL_NAME } from './prompt.js'

export const inputSchema = lazySchema(() =>
  z.object({
    query: z
      .string()
      .describe(
        'Query to find matching skills. Use space-separated keywords; partial words are matched against skill names, descriptions, and when-to-use guidance.',
      ),
    max_results: z
      .number()
      .optional()
      .default(10)
      .describe('Maximum number of skills to return (default: 10)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    matches: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
      }),
    ),
    query: z.string(),
    total_skills: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

const DISCOVER_SKILLS_PROMPT = `Search the available skills for any that are relevant to the current task, then invoke them via the Skill tool. This is useful when you need to find a skill whose name you don't remember. Each result's "name" is the skill invocation name (prefixed with a slash) and "description" explains when to use it.`

export const DiscoverSkillsTool = buildTool({
  isEnabled() {
    return isSkillSearchEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  name: DISCOVER_SKILLS_TOOL_NAME,
  maxResultSizeChars: 40_000,
  async description() {
    return DISCOVER_SKILLS_PROMPT
  },
  async prompt() {
    return DISCOVER_SKILLS_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input, context) {
    const { query, max_results = 10 } = input
    const commands = context.options.commands

    const matches = await searchLocalSkills(query, commands, max_results)

    logForDebugging(
      `DiscoverSkills: query "${query}", matched ${matches.length} skills`,
    )

    return {
      data: {
        matches: matches.map(m => ({
          name: m.command.name,
          description: m.command.description,
        })),
        query,
        total_skills: matches.length,
      },
    }
  },
  renderToolUseMessage() {
    return null
  },
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    if (content.matches.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseID,
        content:
          'No matching skills found. You can still invoke a skill by name via the Skill tool if you know it.',
      }
    }
    const text = content.matches
      .map(m => `${m.name}: ${m.description}`)
      .join('\n')
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: [
        {
          type: 'text',
          text: `Matching skills:\n${text}`,
        },
      ],
    }
  },
  userFacingName: () => 'skill search',
} satisfies ToolDef<InputSchema, Output>)