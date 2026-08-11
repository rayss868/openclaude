import { latestVersion } from './releases'

export const SITE = {
  url: 'https://openclaude.gitlawb.com',
  name: 'openclaude',
  title: 'openclaude — open-source coding agent CLI for any model',
  description:
    'Open-source coding agent that runs in your terminal and talks to any model: OpenAI, Gemini, Ollama, GitHub Models, and 200+ more. One install, every provider.',
  installCommand: 'npm install -g @rayss-dev/openclaude@latest',
  npmUrl: 'https://www.npmjs.com/package/@rayss-dev/openclaude',
  github: 'https://github.com/rayss868/openclaude',
  gitlawb: 'https://gitlawb.com',
  gitlawbRepo: 'https://gitlawb.com/node/repos/z6MkqDnb/openclaude',
  version: latestVersion,
  ogDefault: '/og/default.png',
  ogDocs: '/og/docs.png',
} as const
