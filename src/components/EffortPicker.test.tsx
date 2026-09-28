import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'

import { render } from '../ink.js'
import { AppStateProvider, getDefaultAppState } from '../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { EffortLevel } from '../utils/effort.js'

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'CLAUDE_CODE_EFFORT_LEVEL',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  await acquireSharedMutationLock('components/EffortPicker.test.tsx')
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_BASE_URL = 'https://gateway.example.test/v1'
})

afterEach(() => {
  try {
    mock.restore()
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for EffortPicker output')
}

async function renderPicker(effortValue: EffortLevel | undefined) {
  const { EffortPicker } = await import(
    `./EffortPicker.js?ts=${Date.now()}-${Math.random()}`
  )
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const instance = await render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        mainLoopModelForSession: 'gpt-6-luna',
        effortValue,
      }}
    >
      <EffortPicker onSelect={() => {}} />
    </AppStateProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    },
  )

  return { instance, stdin, stdout, getOutput: () => output }
}

// Regression: `max` is a first-class global level now, so selecting it on an
// OpenAI/Codex route must mark the Max row as current. The old xhigh↔max alias
// marked Extra High as current too (and the initial focus/checkmark landed on
// Extra High), so reopening /effort wrongly showed xhigh as the current level.
test('marks Max (not Extra High) as current when max is selected', async () => {
  const { instance, stdin, stdout, getOutput } = await renderPicker('max')
  try {
    await waitForCondition(() => stripAnsi(getOutput()).includes('Max'))
    const frame = stripAnsi(getOutput())
    expect(frame).toContain('Max (current)')
    expect(frame).not.toContain('Extra High (current)')
  } finally {
    instance.unmount()
    stdin.end()
    stdout.end()
  }
})

// The legacy case still works: xhigh is a real level, so when it is persisted
// the Extra High row is the one marked current.
test('marks Extra High (not Max) as current when xhigh is selected', async () => {
  const { instance, stdin, stdout, getOutput } = await renderPicker('xhigh')
  try {
    await waitForCondition(() => stripAnsi(getOutput()).includes('Extra High'))
    const frame = stripAnsi(getOutput())
    expect(frame).toContain('Extra High (current)')
    expect(frame).not.toContain('Max (current)')
  } finally {
    instance.unmount()
    stdin.end()
    stdout.end()
  }
})
