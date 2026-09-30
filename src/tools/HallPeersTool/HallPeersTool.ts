import { z } from 'zod/v4'
import { getHallClient, isHallEnabled } from '../../hall/session.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { HALL_PEERS_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    connected: z.boolean(),
    peers: z.array(
      z.object({
        session_id: z.string(),
        agent_name: z.string(),
        status: z.string(),
        task_title: z.string().optional(),
        task_summary: z.string().optional(),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

type RawPeer = {
  session_id?: unknown
  agent_name?: unknown
  status?: unknown
  task?: { title?: unknown; summary?: unknown }
}

export const HallPeersTool = buildTool({
  name: HALL_PEERS_TOOL_NAME,
  searchHint: 'list Agent Hall peers in this workspace',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'HallPeers'
  },
  shouldDefer: true,
  isEnabled() {
    return isHallEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async call() {
    const client = getHallClient()
    if (!client || !client.isConnected) {
      return { data: { connected: false, peers: [] } }
    }
    const raw = (await client.listPeers()) as RawPeer[]
    const peers = raw.map(peer => ({
      session_id: String(peer.session_id ?? ''),
      agent_name: String(peer.agent_name ?? peer.session_id ?? 'unknown'),
      status: String(peer.status ?? 'working'),
      task_title:
        typeof peer.task?.title === 'string' ? peer.task.title : undefined,
      task_summary:
        typeof peer.task?.summary === 'string' ? peer.task.summary : undefined,
    }))
    return { data: { connected: true, peers } }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { connected, peers } = content as Output
    if (!connected) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content:
          'Agent Hall is not connected for this session (Hall may be disabled).',
      }
    }
    if (peers.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No peers in this workspace.',
      }
    }
    const lines = peers.map(peer => {
      const title = peer.task_title ? ` — ${peer.task_title}` : ''
      const summary = peer.task_summary ? ` (${peer.task_summary})` : ''
      return `- ${peer.agent_name} [${peer.status}]${title}${summary}`
    })
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
}) satisfies ToolDef<InputSchema, Output>
