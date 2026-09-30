export const DESCRIPTION =
  "Read a peer session's recent conversation from its local transcript (Agent Hall)"

export function getPrompt(): string {
  return `Use this tool to read the recent activity of another OpenClaude session in this workspace, by reading that session's local transcript file.

## When to Use This Tool

- When the user asks what another active session is actually working on
- To see the most recent user prompts and assistant replies of a peer, beyond the metadata returned by HallPeers
- Before coordinating on shared files, to understand the peer's current intent

## Privacy

This reads the peer's transcript JSONL from this machine's OpenClaude config home. It exposes conversation content, so use it only for sessions belonging to the same user on this machine. HallPeerActivity is a deliberate override of Hall's default "coordination metadata only" boundary.

## Input

- **session_id** (optional): a peer session id from HallPeers. When omitted, reads every peer in this workspace.
- **limit** (optional): how many recent messages per peer to return (1-30, default 8).

## Output

For each peer: the session id, agent name, whether its transcript was found, and a list of recent messages with role and text.`
}
