// Agent Hall inspection command. Mirrors the peers command pattern: the command
// is only listed when Hall is enabled, and its load() pulls the session client
// from the lifecycle singleton rather than opening its own connection.

import type { Command } from '../../commands.js'
import { getHallClient, isHallEnabled } from '../../hall/session.js'

type PeerSummary = {
  session_id?: string
  agent_name?: string
  status?: string
  task?: { title?: string; summary?: string }
}

function formatPeers(peers: PeerSummary[]): string {
  if (peers.length === 0) return 'No peers in this workspace.'
  const lines = peers.map(peer => {
    const name = peer.agent_name ?? peer.session_id ?? 'unknown'
    const status = peer.status ?? 'working'
    const title = peer.task?.title ? ` — ${peer.task.title}` : ''
    return `- ${name} [${status}]${title}`
  })
  return [`${peers.length} peer(s) in this workspace:`, ...lines].join('\n')
}

const hall = {
  type: 'local',
  name: 'hall',
  description: 'Show Agent Hall peers and coordination status',
  isEnabled: () => isHallEnabled(),
  isHidden: false,
  supportsNonInteractive: false,
  load: async () => ({
    call: async () => {
      const client = getHallClient()
      if (!client || !client.isConnected) {
        return {
          type: 'text' as const,
          value: 'Agent Hall is enabled but not connected.',
        }
      }
      const peers = (await client.listPeers()) as PeerSummary[]
      return { type: 'text' as const, value: formatPeers(peers) }
    },
  }),
} satisfies Command

export default hall
