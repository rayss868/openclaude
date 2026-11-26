import { describe, expect, test } from 'bun:test'
import {
  besidesPromptRows,
  besidesPromptWidth,
  BESIDE_PROMPT_MAX_COLUMNS,
  BESIDE_PROMPT_MAX_ROWS,
  measurePanelColumns,
  panelMaxColumns,
} from './besidePromptLayout.js'

describe('besidesPromptWidth', () => {
  test('matches Claude: min(cols - 60, floor(cols / 3) + 1)', () => {
    expect(besidesPromptWidth(80)).toBe(20)
    expect(besidesPromptWidth(120)).toBe(41)
    expect(besidesPromptWidth(200)).toBe(67)
  })

  test('collapses to zero when the transcript needs its full reserve', () => {
    expect(besidesPromptWidth(60)).toBe(0)
    expect(besidesPromptWidth(40)).toBe(0)
  })
})

describe('besidesPromptRows', () => {
  test('caps the panel at eight rows', () => {
    expect(besidesPromptRows(24)).toBe(BESIDE_PROMPT_MAX_ROWS)
    expect(besidesPromptRows(90)).toBe(BESIDE_PROMPT_MAX_ROWS)
  })

  test('takes a third of a short terminal', () => {
    expect(besidesPromptRows(9)).toBe(3)
    expect(besidesPromptRows(2)).toBe(0)
  })
})

describe('measurePanelColumns', () => {
  test('stops before a row that would overflow the budget', () => {
    expect(measurePanelColumns([10, 12, 40], 30)).toBe(24)
  })

  test('reports zero when even the first row does not fit', () => {
    expect(measurePanelColumns([80], 30)).toBe(0)
  })

  test('ignores zero-width rows without advancing', () => {
    expect(measurePanelColumns([10, 0, 5], 30)).toBe(17)
  })

  test('honours the max columns cap exactly', () => {
    expect(measurePanelColumns([5, 5], 12)).toBe(12)
    expect(measurePanelColumns([8, 5], 11)).toBe(9)
  })
})

describe('panelMaxColumns', () => {
  test('keeps one column inside the reserve Claude computes', () => {
    expect(panelMaxColumns(80)).toBe(19)
    expect(panelMaxColumns(60)).toBe(0)
  })

  test('is bounded by the panel width cap on huge terminals', () => {
    expect(Math.min(panelMaxColumns(400), BESIDE_PROMPT_MAX_COLUMNS)).toBe(40)
  })
})

