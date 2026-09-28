import { describe, expect, test } from 'bun:test'
import { findToolByName, type Tool } from './Tool.js'

const bashTool = { name: 'Bash' } as unknown as Tool
const readTool = { name: 'Read' } as unknown as Tool
const legacyTool = { name: 'TaskStop', aliases: ['KillShell'] } as unknown as Tool

const tools = [bashTool, readTool, legacyTool] as Tool[]

describe('findToolByName', () => {
  test('matches primary names and aliases exactly', () => {
    expect(findToolByName(tools, 'Bash')).toBe(bashTool)
    expect(findToolByName(tools, 'Read')).toBe(readTool)
    expect(findToolByName(tools, 'KillShell')).toBe(legacyTool)
  })

  test('falls back to case-insensitive matching for lowercase tool names', () => {
    expect(findToolByName(tools, 'bash')).toBe(bashTool)
    expect(findToolByName(tools, 'read')).toBe(readTool)
    expect(findToolByName(tools, 'READ')).toBe(readTool)
  })

  test('resolves aliases case-insensitively', () => {
    expect(findToolByName(tools, 'killshell')).toBe(legacyTool)
    expect(findToolByName(tools, 'TASKSTOP')).toBe(legacyTool)
  })

  test('returns undefined for names that match no tool', () => {
    expect(findToolByName(tools, 'Bashh')).toBeUndefined()
    expect(findToolByName(tools, '')).toBeUndefined()
  })

  test('exact matches win when two tools differ only in case', () => {
    const ambiguous = [
      { name: 'Bash' } as unknown as Tool,
      { name: 'bash' } as unknown as Tool,
    ] as Tool[]

    expect(findToolByName(ambiguous, 'Bash')).toBe(ambiguous[0])
    expect(findToolByName(ambiguous, 'bash')).toBe(ambiguous[1])
  })
})
