import { beforeEach, describe, expect, test } from 'bun:test'
import {
  recordRepeatedToolError,
  resetAllToolErrorRepeats,
  resetToolErrorRepeats,
} from './toolErrorRepeats.js'

const ERROR_TEXT = 'data/limit must be number'

describe('recordRepeatedToolError', () => {
  beforeEach(() => {
    resetAllToolErrorRepeats()
  })

  test('returns no nudge before the third identical error', () => {
    expect(recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)).toEqual({
      count: 1,
    })
    expect(recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)).toEqual({
      count: 2,
    })
  })

  test('returns a nudge on the third identical error', () => {
    recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)
    recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)
    const third = recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)
    expect(third.count).toBe(3)
    expect(third.nudge).toMatch(/system-reminder/)
    expect(third.nudge).toMatch(/re-read the original request/)
  })

  test('a different error resets the consecutive count', () => {
    recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)
    recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)
    expect(recordRepeatedToolError('agent', 'fetch_api', 'another error')).toEqual({
      count: 1,
    })
  })

  test('a different tool resets the consecutive count', () => {
    recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)
    recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)
    expect(
      recordRepeatedToolError('agent', 'research', ERROR_TEXT),
    ).toEqual({ count: 1 })
  })

  test('agents track failures independently', () => {
    recordRepeatedToolError('agent-a', 'fetch_api', ERROR_TEXT)
    recordRepeatedToolError('agent-a', 'fetch_api', ERROR_TEXT)
    expect(recordRepeatedToolError('agent-b', 'fetch_api', ERROR_TEXT)).toEqual({
      count: 1,
    })
  })

  test('error text is normalized across whitespace and digits', () => {
    recordRepeatedToolError('agent', 'fetch_api', 'timeout after 12000ms')
    const second = recordRepeatedToolError('agent', 'fetch_api', 'timeout after 15000ms')
    expect(second.count).toBe(2)
    expect(second.nudge).toBeUndefined()
  })

  test('resetToolErrorRepeats clears the count for a tool', () => {
    recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)
    recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)
    resetToolErrorRepeats('agent', 'fetch_api')
    expect(recordRepeatedToolError('agent', 'fetch_api', ERROR_TEXT)).toEqual({
      count: 1,
    })
  })
})
