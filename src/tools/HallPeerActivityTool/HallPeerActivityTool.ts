import { z } from 'zod/v4'
import { getHallClient, isHallEnabled } from '../../hall/session.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { HALL_PEER_ACTIVITY_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { readPeerMessages } from './transcript.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    session_id: z
      .string()
      .optional()
      .describe(
        'Target a specific peer session id; omit to read all workspace peers',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('Recent messages per peer (default 8, max 30)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    connected: z.boolean(),
    peers: z.array(
      z.object({
        session_id: z.string(),
        agent_name: z.string(),
        found: z.boolean(),
        messages: z.array(
          z.object({
            role: z.string(),
            text: z.string(),
          }),
        ),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

type RawPeer = {
  session_id?: unknown
  agent_name?: unknown
}

export const HallPeerActivityTool = buildTool({
  name: HALL_PEER_ACTIVITY_TOOL_NAME,
  searchHint: "read a peer session's recent transcript activity",
  maxResultSizeChars: 200_000,
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
    return 'HallPeerActivity'
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
  async call(input) {
    const client = getHallClient()
    if (!client || !client.isConnected) {
      return { data: { connected: false, peers: [] } }
    }
    const limit = input.limit ?? 8

    let targets: { session_id: string; agent_name: string }[]
    if (input.session_id) {
      targets = [{ session_id: input.session_id, agent_name: input.session_id }]
    } else {
      const raw = (await client.listPeers()) as RawPeer[]
      targets = raw.map(peer => ({
        session_id: String(peer.session_id ?? ''),
        agent_name: String(peer.agent_name ?? peer.session_id ?? 'unknown'),
      }))
    }

    const peers: Output['peers'] = []
    for (const target of targets) {
      const { found, messages } = await readPeerMessages(target.session_id, limit)
      peers.push({
        session_id: target.session_id,
        agent_name: target.agent_name,
        found,
        messages,
      })
    }
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
    const blocks = peers.map(peer => {
      const header = `### ${peer.agent_name} (${peer.session_id})`
      if (!peer.found) {
        return `${header}\nTranscript not found on this machine.`
      }
      if (peer.messages.length === 0) {
        return `${header}\nNo recent messages.`
      }
      const lines = peer.messages.map(m => `[${m.role}] ${m.text}`)
      return `${header}\n${lines.join('\n')}`
    })
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: blocks.join('\n\n'),
    }
  },
}) satisfies ToolDef<InputSchema, Output>
