import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'diff',
  description: 'Toggle the diff panel showing uncommitted changes',
  immediate: true,
  load: () => import('./diff.js'),
} satisfies Command
