import { PassThrough } from 'node:stream'

import { afterEach, expect, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../../ink.js'
import instances from '../../ink/instances.js'
import { Select } from './select.js'
import { SelectMulti } from './SelectMulti.js'

// Mouse dispatch is gated behind fullscreen (alt-screen) mode in production;
// these tests drive the same hit-test pipeline the App uses by flipping the
// flag on the renderer instance instead of standing up a real alt screen.
type MouseCapableInk = {
  altScreenActive: boolean
  dispatchHover: (col: number, row: number) => void
  dispatchClick: (col: number, row: number) => boolean
}

type TestStreams = {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: () => void
    ref: () => void
    unref: () => void
  }
}

function createTestStreams(): TestStreams {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStreams['stdin']
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 80
  ;(stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 24
  ;(stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true
  return { stdout, stdin }
}

async function mount(element: React.ReactElement) {
  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(element)
  await Bun.sleep(80)
  // createRoot registers the concrete Ink instance (the one that owns the
  // hit-test pipeline) under its stdout stream.
  const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as MouseCapableInk
  ink.altScreenActive = true
  return {
    ink,
    unmount: () => {
      root.unmount()
    },
  }
}

/** Hover every rendered row until `getFocus` reports the wanted value. */
async function hoverUntil(
  ink: MouseCapableInk,
  getFocus: () => unknown,
  wanted: unknown,
): Promise<number> {
  for (let row = 0; row < 12; row += 1) {
    ink.dispatchHover(1, row)
    await Bun.sleep(15)
    if (getFocus() === wanted) return row
  }
  throw new Error(`No row hovered to ${String(wanted)}`)
}

const OPTIONS = [
  { label: 'Alpha', value: 'a' },
  { label: 'Beta', value: 'b' },
  { label: 'Gamma', value: 'c' },
]

afterEach(() => {
  // Each test unmounts in its own finally block; nothing global to restore.
})

test('hover moves focus to an option and click selects it', async () => {
  const focused: string[] = []
  const changes: string[] = []
  const { ink, unmount } = await mount(
    <Select
      options={OPTIONS}
      defaultFocusValue="a"
      onFocus={value => focused.push(value)}
      onChange={value => changes.push(value)}
    />,
  )

  try {
    const row = await hoverUntil(ink, () => focused.at(-1), 'b')
    expect(ink.dispatchClick(1, row)).toBe(true)
    await Bun.sleep(20)
    expect(changes).toEqual(['b'])
  } finally {
    unmount()
  }
})

test('clicking a disabled option never selects it', async () => {
  const focused: string[] = []
  const changes: string[] = []
  const { ink, unmount } = await mount(
    <Select
      options={[
        { label: 'Locked', value: 'locked', disabled: true },
        { label: 'Open', value: 'open' },
      ]}
      onFocus={value => focused.push(value)}
      onChange={value => changes.push(value)}
    />,
  )

  try {
    const row = await hoverUntil(ink, () => focused.at(-1), 'locked')
    ink.dispatchClick(1, row)
    await Bun.sleep(20)
    expect(changes).toEqual([])
  } finally {
    unmount()
  }
})

test('click toggles a multi-select row', async () => {
  const focused: string[] = []
  const changes: string[][] = []
  const { ink, unmount } = await mount(
    <SelectMulti
      options={OPTIONS}
      defaultValue={['a']}
      onCancel={() => {}}
      onFocus={value => focused.push(value)}
      onChange={values => changes.push(values)}
    />,
  )

  try {
    const row = await hoverUntil(ink, () => focused.at(-1), 'b')
    ink.dispatchClick(1, row)
    await Bun.sleep(20)
    expect(changes.at(-1)).toEqual(['a', 'b'])
  } finally {
    unmount()
  }
})
