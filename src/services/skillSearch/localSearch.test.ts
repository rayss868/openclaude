import { describe, expect, test } from 'bun:test'

import type { Command } from '../../types/command.js'
import { clearSkillIndexCache, searchLocalSkills } from './localSearch.js'

const skill = (overrides: Partial<Command> & { name: string }): Command =>
  ({
    type: 'prompt',
    source: 'skills',
    loadedFrom: 'skills',
    description: '',
    prompt: '',
    ...overrides,
  }) as unknown as Command

describe('searchLocalSkills', () => {
  test('matches partial words against skill name', async () => {
    const commands = [
      skill({ name: '/imagegen-frontend-web', description: 'Generate premium frontend images' }),
      skill({ name: '/minimalist-ui', description: 'Clean editorial-style interfaces' }),
    ]
    const matches = await searchLocalSkills('image', commands)
    expect(matches.map(m => m.name)).toEqual(['/imagegen-frontend-web'])
  })

  test('matches substring inside the description', async () => {
    const commands = [
      skill({ name: '/pdf', description: 'Generate PDF documents from structured content' }),
      skill({ name: '/loop', description: 'Run a prompt on a fixed interval' }),
    ]
    const matches = await searchLocalSkills('document', commands)
    expect(matches.map(m => m.name)).toEqual(['/pdf'])
  })

  test('exact word match outranks substring match', async () => {
    const commands = [
      skill({ name: '/threejs-bloom', description: 'Implement production bloom in Three.js scenes' }),
      skill({ name: '/bloom', description: 'Bloom the garden of flowers daily' }),
    ]
    const matches = await searchLocalSkills('bloom', commands)
    expect(matches[0].name).toBe('/bloom')
    expect(matches[1].name).toBe('/threejs-bloom')
  })

  test('is case-insensitive', async () => {
    const commands = [skill({ name: '/PDF', description: 'Make PDFs' })]
    const matches = await searchLocalSkills('pdf', commands)
    expect(matches).toHaveLength(1)
  })

  test('ignores builtin commands and disabled-model-invocation skills', async () => {
    const commands = [
      skill({ name: '/builtin-thing', source: 'builtin', loadedFrom: undefined }),
      skill({ name: '/no-model', disableModelInvocation: true }),
      skill({ name: '/yes-model', description: 'Searchable skill' }),
    ]
    const matches = await searchLocalSkills('thing no-model yes-model', commands)
    expect(matches.map(m => m.name)).toEqual(['/yes-model'])
  })

  test('honors maxResults', async () => {
    const commands = [
      skill({ name: '/one', description: 'alpha beta gamma' }),
      skill({ name: '/two', description: 'beta gamma delta' }),
      skill({ name: '/three', description: 'gamma delta alpha' }),
    ]
    const matches = await searchLocalSkills('gamma', commands, 2)
    expect(matches).toHaveLength(2)
  })

  test('returns an empty list for an empty query', async () => {
    const commands = [skill({ name: '/one', description: 'alpha' })]
    expect(await searchLocalSkills('', commands)).toEqual([])
    expect(await searchLocalSkills('   ', commands)).toEqual([])
  })

  test('sorts ties alphabetically by name', async () => {
    const commands = [
      skill({ name: '/zebra', description: 'stripes alpha' }),
      skill({ name: '/alpha', description: 'stripes alpha' }),
    ]
    const matches = await searchLocalSkills('stripes', commands)
    expect(matches.map(m => m.name)).toEqual(['/alpha', '/zebra'])
  })
})