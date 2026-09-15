import { describe, expect, it } from 'bun:test'
import { computeStallState } from './useStalledAnimation.js'

describe('computeStallState', () => {
  it('is not stalled before 3s of no new tokens', () => {
    expect(computeStallState(0).isStalled).toBe(false)
    expect(computeStallState(2500).isStalled).toBe(false)
    expect(computeStallState(3000).isStalled).toBe(false) // boundary: not > 3s
  })

  it('is stalled after 3s of no new tokens', () => {
    expect(computeStallState(3001).isStalled).toBe(true)
    expect(computeStallState(5000).isStalled).toBe(true)
    expect(computeStallState(12000).isStalled).toBe(true)
  })

  it('fades intensity over 2 seconds after the 3s threshold', () => {
    expect(computeStallState(3500).intensity).toBeCloseTo(0.25)
    expect(computeStallState(4000).intensity).toBeCloseTo(0.5)
    expect(computeStallState(5000).intensity).toBeCloseTo(1)
    // Saturates at 1 — never exceeds it.
    expect(computeStallState(12000).intensity).toBe(1)
  })
})