import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { TASK_COMPLETE_TOOL_NAME } from './constants.js'
import { DESCRIPTION } from './prompt.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    acknowledged: z.literal(true).describe('Task completion acknowledged'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TaskCompleteTool = buildTool({
  name: TASK_COMPLETE_TOOL_NAME,
  searchHint: 'signal that the current task is complete',
  maxResultSizeChars: 1000,
  userFacingName: () => 'Complete Task',
  shouldDefer: true,
  isEnabled: () => true,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isDestructive: () => false,

  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  async description() {
    return 'Signal that the current task is complete. Call this when you have fully accomplished the user\'s request.'
  },

  async prompt() {
    return DESCRIPTION
  },

  toAutoClassifierInput() {
    return 'task complete signal'
  },

  async checkPermissions() {
    // No permission checks required - this is just a completion signal
    return { behavior: 'allow', updatedInput: {} }
  },

  renderToolUseMessage() {
    return null
  },

  renderToolResultMessage() {
    return null
  },

  mapToolResultToToolResultBlockParam(_output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: 'Task completion acknowledged. Your work is marked as complete.',
    }
  },

  async call() {
    return {
      data: {
        acknowledged: true,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
