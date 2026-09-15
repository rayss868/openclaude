import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { Command } from '../../types/command.js'
import type { Attachment } from '../../utils/attachments.js'
import {
  collectSkillDiscoveryPrefetch,
  getTurnZeroSkillDiscovery,
  startSkillDiscoveryPrefetch,
} from './prefetch.js'
import { clearSkillIndexCache } from './localSearch.js'

const skill = (overrides: Partial<Command> & { name: string }): Command =>
  ({
    type: 'prompt',
    source: 'skills',
    loadedFrom: 'skills',
    description: '',
    prompt: '',
    ...overrides,
  }) as unknown as Command

const contextWith = (commands: Command[]): ToolUseContext =>
  ({ options: { commands } }) as unknown as ToolUseContext

describe('skill discovery prefetch', () => {
  test('startSkillDiscoveryPrefetch returns null for a short query', () => {
    const ctx = contextWith([])
    expect(startSkillDiscoveryPrefetch('ok', [], ctx)).toBeNull()
  })

  test('startSkillDiscoveryPrefetch resolves to a skill_discovery attachment', async () => {
    clearSkillIndexCache()
    const ctx = contextWith([
      skill({ name: '/imagegen-frontend-web', description: 'Generate frontend images' }),
    ])
    const pending = startSkillDiscoveryPrefetch('make me an image please', [], ctx)
    expect(pending).not.toBeNull()
    const atts = await collectSkillDiscoveryPrefetch(pending!)
    expect(atts).toHaveLength(1)
    const att = atts[0] as Attachment & { type: 'skill_discovery' }
    expect(att.type).toBe('skill_discovery')
    expect(att.source).toBe('native')
    expect(att.signal).toBe('user_input')
    expect(att.skills.map(s => s.name)).toEqual(['/imagegen-frontend-web'])
  })

  test('getTurnZeroSkillDiscovery returns empty when nothing matches', async () => {
    clearSkillIndexCache()
    const ctx = contextWith([skill({ name: '/pdf', description: 'Make PDFs' })])
    const atts = await getTurnZeroSkillDiscovery('how do I configure the weather', [], ctx)
    expect(atts).toEqual([])
  })

  test('getTurnZeroSkillDiscovery searches recent message content too', async () => {
    clearSkillIndexCache()
    const ctx = contextWith([skill({ name: '/minimalist-ui', description: 'Editorial interfaces' })])
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'we are building a minimal landing page' }] },
    ] as unknown as Message[]
    const atts = await getTurnZeroSkillDiscovery(null, messages, ctx)
    expect(atts).toHaveLength(1)
    const att = atts[0] as Attachment & { type: 'skill_discovery' }
    expect(att.skills.map(s => s.name)).toEqual(['/minimalist-ui'])
  })
})