import { describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'

import type { Attachment } from './attachments.js'

// The skill_discovery rendering path is gated on this feature flag. Under the
// default `bun test` run the flag is off, so these cases skip; run
// `bun test --feature=EXPERIMENTAL_SKILL_SEARCH` to exercise them. messages.js
// is imported lazily so a skipped default run doesn't pay its module cost.
const skillDiscoveryTest = feature('EXPERIMENTAL_SKILL_SEARCH') ? test : test.skip

const longDescription =
  'Membangun motion graphic sinematik di browser memakai HTML plus CSS plus GSAP dengan hasil yang bergerak seperti video sungguhan dan bukan slide presentasi, sangat panjang sehingga harus dipotong'

describe('skill_discovery rendering', () => {
  skillDiscoveryTest('truncates a long description to one compact line', async () => {
    const { normalizeAttachmentForAPI } = await import('./messages.js')
    const attachment = {
      type: 'skill_discovery',
      signal: 'user_input',
      source: 'native',
      skills: [{ name: '/bang-motion', description: longDescription }],
    } as unknown as Attachment

    const messages = normalizeAttachmentForAPI(attachment)
    expect(messages).toHaveLength(1)
    const content = (messages[0] as unknown as { message: { content: string } })
      .message.content
    expect(content).toContain('Skills relevant to your task:')
    expect(content).toContain('- /bang-motion: ')
    // The full description is longer than the cap, so an ellipsis must appear.
    expect(content).toContain('…')
    expect(content).not.toContain('sangat panjang sehingga harus dipotong')
  })

  skillDiscoveryTest('leaves a short description untouched', async () => {
    const { normalizeAttachmentForAPI } = await import('./messages.js')
    const attachment = {
      type: 'skill_discovery',
      signal: 'user_input',
      source: 'native',
      skills: [{ name: '/pdf', description: 'Make PDFs' }],
    } as unknown as Attachment

    const messages = normalizeAttachmentForAPI(attachment)
    const content = (messages[0] as unknown as { message: { content: string } })
      .message.content
    expect(content).toContain('- /pdf: Make PDFs')
    expect(content).not.toContain('…')
  })
})