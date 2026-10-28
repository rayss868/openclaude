import { describe, expect, test } from 'bun:test'
import { coerceArgsToInputSchema } from './argCoercion.js'

describe('coerceArgsToInputSchema', () => {
  test('coerces numeric strings to numbers', () => {
    const schema = {
      properties: {
        limit: { type: 'number' },
        offset: { type: 'integer' },
      },
    }
    expect(
      coerceArgsToInputSchema({ limit: '2000', offset: '3' }, schema),
    ).toEqual({ limit: 2000, offset: 3 })
  })

  test('coerces boolean strings to booleans', () => {
    const schema = {
      properties: {
        recursive: { type: 'boolean' },
      },
    }
    expect(
      coerceArgsToInputSchema({ recursive: 'true' }, schema),
    ).toEqual({ recursive: true })
    expect(
      coerceArgsToInputSchema({ recursive: 'false' }, schema),
    ).toEqual({ recursive: false })
  })

  test('leaves non-convertible strings untouched', () => {
    const schema = {
      properties: {
        limit: { type: 'number' },
        query: { type: 'string' },
      },
    }
    expect(
      coerceArgsToInputSchema({ limit: 'abc', query: '2000' }, schema),
    ).toEqual({ limit: 'abc', query: '2000' })
  })

  test('leaves empty strings untouched', () => {
    const schema = { properties: { limit: { type: 'number' } } }
    expect(coerceArgsToInputSchema({ limit: '' }, schema)).toEqual({
      limit: '',
    })
  })

  test('passes through values that already match the schema', () => {
    const schema = { properties: { limit: { type: 'number' } } }
    expect(coerceArgsToInputSchema({ limit: 2000 }, schema)).toEqual({
      limit: 2000,
    })
  })

  test('recurses into nested object schemas', () => {
    const schema = {
      properties: {
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'number' },
          },
        },
      },
    }
    expect(
      coerceArgsToInputSchema({ pagination: { page: '2' } }, schema),
    ).toEqual({ pagination: { page: 2 } })
  })

  test('coerces array items from the items schema', () => {
    const schema = {
      properties: {
        ids: { type: 'array', items: { type: 'integer' } },
      },
    }
    expect(coerceArgsToInputSchema({ ids: ['1', '2'] }, schema)).toEqual({
      ids: [1, 2],
    })
  })

  test('returns the same object when no schema is available', () => {
    const args = { limit: '2000' }
    expect(coerceArgsToInputSchema(args, undefined)).toBe(args)
    expect(coerceArgsToInputSchema(args, {})).toBe(args)
    expect(coerceArgsToInputSchema(args, { properties: undefined })).toBe(args)
  })

  test('keeps non-string values unchanged', () => {
    const schema = { properties: { limit: { type: 'number' } } }
    const input = { limit: null, flag: undefined, url: 'https://x.io' }
    expect(coerceArgsToInputSchema(input, schema)).toEqual(input)
  })

  test('ignores union-type schema entries', () => {
    const schema = {
      properties: {
        mystery: { type: ['string', 'null'] },
      },
    }
    expect(coerceArgsToInputSchema({ mystery: '2000' }, schema)).toEqual({
      mystery: '2000',
    })
  })
})
