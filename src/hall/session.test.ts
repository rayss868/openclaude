import { afterEach, describe, expect, test } from 'bun:test'
import {
  getHallClient,
  isHallEnabled,
  startHallSessionIfEnabled,
  stopHallSession,
} from './session.js'

const originalFlag = process.env.OPENCLAUDE_HALL

afterEach(async () => {
  if (originalFlag === undefined) delete process.env.OPENCLAUDE_HALL
  else process.env.OPENCLAUDE_HALL = originalFlag
  await stopHallSession()
})

describe('hall session gate', () => {
  test('is disabled by default so a plain session is unchanged', () => {
    delete process.env.OPENCLAUDE_HALL
    expect(isHallEnabled()).toBe(false)
  })

  test('accepts 1 and true as the opt-in values', () => {
    process.env.OPENCLAUDE_HALL = '1'
    expect(isHallEnabled()).toBe(true)
    process.env.OPENCLAUDE_HALL = 'true'
    expect(isHallEnabled()).toBe(true)
    process.env.OPENCLAUDE_HALL = 'no'
    expect(isHallEnabled()).toBe(false)
  })

  test('there is no client until a session starts one', () => {
    expect(getHallClient()).toBeNull()
  })

  test('start is a no-op while disabled and never throws', async () => {
    delete process.env.OPENCLAUDE_HALL
    await expect(startHallSessionIfEnabled()).resolves.toBeUndefined()
    expect(getHallClient()).toBeNull()
  })
})
