import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from './constants.js'

export { FILE_WRITE_TOOL_NAME } from './constants.js'
export const DESCRIPTION = 'Write a file to the local filesystem.'

function getPreReadInstruction(): string {
  return `\n- If this is an existing file, you MUST use the ${FILE_READ_TOOL_NAME} tool first to read the file's contents. This tool will fail if you did not read the file first.`
}

function getChunkedWriteInstruction(): string {
  return '\n- Use write_mode "replace" for complete content of at most 32,000 characters.\n- For larger content, split it into chunks of at most 32,000 characters: call write_mode "start" with the first chunk, then call write_mode "append" with the returned write_id and sequential chunk_index values starting at 1, and finally call write_mode "finish" with that write_id.\n- Chunked writes keep the target unchanged until "finish" succeeds. Do not use "replace" with content larger than 32,000 characters.'
}

export function getWriteToolDescription(): string {
  return `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.${getPreReadInstruction()}${getChunkedWriteInstruction()}
- Prefer the Edit tool for modifying existing files \u2014 it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`
}
