import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToString } from '../../utils/staticRender.js'
import { OcMonogram } from './OcMonogram.js'

describe('OcMonogram', () => {
  test('renders the OC letterform on three rows', async () => {
    const output = await renderToString(<OcMonogram />, 20)

    expect(output).toContain('O C')
    expect(output.trim().split('\n')).toHaveLength(3)
  })

  test('does not render the old mascot art', async () => {
    const output = await renderToString(<OcMonogram />, 20)

    expect(output).not.toContain('█▄█████▄██')
  })
})
