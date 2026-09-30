export const DESCRIPTION =
  'List other OpenClaude sessions (Agent Hall peers) in this workspace'

export function getPrompt(): string {
  return `Use this tool to see other OpenClaude sessions active in the same workspace as this session (Agent Hall peers).

## When to Use This Tool

- Before editing files that another session may also be editing, to avoid conflicting changes
- To see what other sessions in this workspace are currently working on
- When the user asks what other agents or sessions are doing

## Output

Returns each peer's:
- **session_id**: Session identifier (use it to address the peer when messaging)
- **agent_name**: Human-readable session name
- **status**: 'working', 'waiting', 'blocked', or 'done'
- **task**: The peer's current task title and summary

Returns an empty list when Agent Hall is disabled or no other session shares this workspace.`
}
