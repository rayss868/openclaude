import { clearConversation } from '../clear/conversation.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isIncognitoEnabled, setIncognitoEnabled } from '../../utils/incognito.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'

const USAGE = `Usage: /incognito [on|off|status]

Strips memory and instruction injections from the next context. Tools, MCP
servers, and reasoning stay available; nothing is written to settings.json, so
the flag is gone on restart.`

export const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim().toLowerCase()

  if (arg === 'status') {
    return {
      type: 'text',
      value: `Incognito: ${isIncognitoEnabled() ? 'on' : 'off'}\n\n${USAGE}`,
    }
  }

  if (arg !== 'on' && arg !== 'off') {
    return { type: 'text', value: USAGE }
  }

  const enabled = arg === 'on'
  if (enabled === isIncognitoEnabled()) {
    return {
      type: 'text',
      value: `Incognito already ${arg}.`,
    }
  }

  setIncognitoEnabled(enabled)
  // The memoized sections and context caches still hold the pre-toggle prompt.
  clearSystemPromptSections()

  await clearConversation({ ...context, preserveMcp: true })

  return {
    type: 'text',
    value: enabled
      ? 'Incognito on. Context rebuilt without memory or instruction injections. Tools, MCP, and reasoning are unchanged.'
      : 'Incognito off. Context rebuilt with your normal memory and instructions.',
  }
}