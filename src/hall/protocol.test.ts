import { describe, expect, test } from 'bun:test'
import {
  PROTOCOL_VERSION,
  decodeFrameLine,
  encodeFrame,
  isClientFrameType,
  makeFrame,
} from './protocol.js'

describe('hall protocol frames', () => {
  test('makeFrame fills the envelope and round-trips through encode/decode', () => {
    const frame = makeFrame('hello', { pid: 1 }, { request_id: 'r1' })
    expect(frame.protocol_version).toBe(PROTOCOL_VERSION)
    expect(frame.type).toBe('hello')
    expect(frame.request_id).toBe('r1')

    const decoded = decodeFrameLine(encodeFrame(frame))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.frame.type).toBe('hello')
      expect(decoded.frame.payload).toEqual({ pid: 1 })
    }
  })

  test('raw JSON without a trailing newline still decodes', () => {
    const frame = makeFrame('heartbeat')
    const decoded = decodeFrameLine(JSON.stringify(frame))
    expect(decoded.ok).toBe(true)
  })

  test('malformed JSON is rejected as invalid, not thrown', () => {
    const decoded = decodeFrameLine('{not json')
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.reason).toBe('invalid')
  })

  test('a well-formed frame with the wrong protocol version is flagged as version', () => {
    const frame = { ...makeFrame('hello'), protocol_version: 99 }
    const decoded = decodeFrameLine(JSON.stringify(frame))
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.reason).toBe('version')
  })

  test('a frame missing required fields is rejected', () => {
    const decoded = decodeFrameLine(JSON.stringify({ type: 'hello' }))
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.reason).toBe('invalid')
  })

  test('empty input is rejected without throwing', () => {
    expect(decodeFrameLine('').ok).toBe(false)
    expect(decodeFrameLine('   ').ok).toBe(false)
  })

  test('isClientFrameType separates client requests from server events', () => {
    expect(isClientFrameType('claim.acquire')).toBe(true)
    expect(isClientFrameType('hello_ack')).toBe(false)
  })
})
