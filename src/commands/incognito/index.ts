import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'incognito',
  description: 'Strip memory and instruction injections from the next context',
  argumentHint: '[on|off|status]',
  supportsNonInteractive: true,
  load: () => import('./incognito.js'),
} satisfies Command