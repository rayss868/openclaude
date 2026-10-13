export const DESCRIPTION =
  "Read a peer session's recent activity (messages, tool calls, results) from its local transcript (Agent Hall)"

export function getPrompt(): string {
  return `Use this tool to read the recent activity of another OpenClaude session in this workspace, by reading that session's local transcript file.

## When to Use This Tool

- When the user asks what another active session is actually working on
- To follow a peer's live progress: which files it is editing, what commands it runs, and their results
- Before coordinating on shared files, to understand the peer's current intent

## Privacy

This reads the peer's transcript JSONL from this machine's OpenClaude config home. It exposes conversation content, so use it only for sessions belonging to the same user on this machine. HallPeerActivity is a deliberate override of Hall's default "coordination metadata only" boundary.

## Input

- **session_id** (optional): a peer session id from HallPeers. When omitted, reads every peer in this workspace.
- **limit** (optional): how many recent activity events per peer to return (1-100, default 50).

## Output

For each peer: the session id, agent name, whether its transcript was found, and a list of recent events in order. Each event has a role:

- **user** / **assistant**: conversation text.
- **tool_use** (shown as \`[→] ToolName: key-argument\`): a tool the peer invoked, e.g. \`[→] Bash: bun test ./src/hall/\`.
- **tool_result** (shown as \`[←] ToolName: result-summary\`): that tool's outcome.

Because tool calls and results are included, this reflects the peer's live progress within a long turn, not just its opening messages.`
}
