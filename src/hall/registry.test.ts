import { describe, expect, test } from 'bun:test'
import type { SessionRecord } from './protocol.js'
import { HallRegistry, claimsOverlap, normalizeResource } from './registry.js'

function session(id: string, root = '/work'): SessionRecord {
  const now = new Date().toISOString()
  return {
    session_id: id,
    agent_name: `agent-${id}`,
    pid: 1000,
    started_at: now,
    connected_at: now,
    last_heartbeat: now,
    status: 'working',
    workspace: { raw_root: root, canonical_root: root },
    task: { title: 'Working', status: 'working', updated_at: now },
  }
}

describe('normalizeResource', () => {
  test('normalizes separators and strips trailing slashes', () => {
    expect(normalizeResource('src\\utils\\a.ts', 'linux')).toBe('src/utils/a.ts')
    expect(normalizeResource('src/utils/', 'linux')).toBe('src/utils')
  })

  test('lowercases on Windows only', () => {
    expect(normalizeResource('Src/Util.ts', 'win32')).toBe('src/util.ts')
    expect(normalizeResource('Src/Util.ts', 'linux')).toBe('Src/Util.ts')
  })
})

describe('claimsOverlap', () => {
  const file = (r: string) => ({ normalized_resource: r, resource_type: 'file' as const })
  const dir = (r: string) => ({ normalized_resource: r, resource_type: 'dir' as const })

  test('identical paths conflict', () => {
    expect(claimsOverlap(file('src/a.ts'), file('src/a.ts'), 'linux')).toBe(true)
  })

  test('a directory claim overlaps a file under it', () => {
    expect(claimsOverlap(dir('src'), file('src/a.ts'), 'linux')).toBe(true)
    expect(claimsOverlap(file('src/a.ts'), dir('src'), 'linux')).toBe(true)
  })

  test('sibling directories do not overlap', () => {
    expect(claimsOverlap(dir('src/core'), dir('src/ui'), 'linux')).toBe(false)
  })

  test('a prefix that is not a path segment does not overlap', () => {
    expect(claimsOverlap(dir('src/co'), file('src/core/a.ts'), 'linux')).toBe(false)
  })
})

describe('HallRegistry presence', () => {
  test('registers, updates, and removes sessions', () => {
    const reg = new HallRegistry()
    reg.registerSession(session('a'))
    reg.registerSession(session('b'))
    expect(reg.sessionCount).toBe(2)

    expect(reg.touchHeartbeat('a', new Date(Date.now() + 5000).toISOString())).toBe(true)
    expect(reg.touchHeartbeat('missing', new Date().toISOString())).toBe(false)

    reg.unregisterSession('a')
    expect(reg.sessionCount).toBe(1)
  })

  test('listWorkspacePeers excludes the caller and other workspaces', () => {
    const reg = new HallRegistry()
    reg.registerSession(session('a', '/work'))
    reg.registerSession(session('b', '/work'))
    reg.registerSession(session('c', '/other'))
    const peers = reg.listWorkspacePeers('a', '/work')
    expect(peers.map(p => p.session_id)).toEqual(['b'])
  })

  test('sweepStaleSessions drops sessions past their lease and their claims', () => {
    const reg = new HallRegistry()
    const stale = session('stale')
    stale.last_heartbeat = new Date(Date.now() - 60_000).toISOString()
    reg.registerSession(stale)
    reg.registerSession(session('fresh'))
    reg.acquireClaim({
      sessionId: 'stale',
      workspaceId: '/work',
      resource: 'src/a.ts',
      resourceType: 'file',
      mode: 'write',
      ttlMs: 60_000,
    })

    const removed = reg.sweepStaleSessions(Date.now(), 45_000)
    expect(removed).toEqual(['stale'])
    expect(reg.listClaims().length).toBe(0)
  })
})

describe('HallRegistry claims', () => {
  test('acquire reports conflicts with other sessions but always grants', () => {
    const reg = new HallRegistry()
    reg.registerSession(session('a'))
    reg.registerSession(session('b'))
    reg.acquireClaim({
      sessionId: 'a',
      workspaceId: '/work',
      resource: 'src/a.ts',
      resourceType: 'file',
      mode: 'write',
      ttlMs: 60_000,
    })

    const { claim, conflicts } = reg.acquireClaim({
      sessionId: 'b',
      workspaceId: '/work',
      resource: 'src/a.ts',
      resourceType: 'file',
      mode: 'write',
      ttlMs: 60_000,
    })
    expect(claim.claim_id).toBeTruthy()
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]?.session_id).toBe('a')
  })

  test('a claim never conflicts with another claim from the same session', () => {
    const reg = new HallRegistry()
    reg.registerSession(session('a'))
    reg.acquireClaim({
      sessionId: 'a', workspaceId: '/work', resource: 'src/a.ts',
      resourceType: 'file', mode: 'write', ttlMs: 60_000,
    })
    const second = reg.acquireClaim({
      sessionId: 'a', workspaceId: '/work', resource: 'src/a.ts',
      resourceType: 'file', mode: 'write', ttlMs: 60_000,
    })
    expect(second.conflicts.length).toBe(0)
  })

  test('renew and release enforce ownership', () => {
    const reg = new HallRegistry()
    reg.registerSession(session('a'))
    const { claim } = reg.acquireClaim({
      sessionId: 'a', workspaceId: '/work', resource: 'src/a.ts',
      resourceType: 'file', mode: 'write', ttlMs: 60_000,
    })

    expect(reg.renewClaim(claim.claim_id, 'b', 60_000)).toBeNull()
    expect(reg.releaseClaim(claim.claim_id, 'b')).toBe(false)
    expect(reg.renewClaim(claim.claim_id, 'a', 60_000)?.claim_id).toBe(claim.claim_id)
    expect(reg.releaseClaim(claim.claim_id, 'a')).toBe(true)
    expect(reg.listClaims().length).toBe(0)
  })

  test('sweepExpiredClaims removes only expired leases', () => {
    const reg = new HallRegistry()
    reg.registerSession(session('a'))
    const { claim } = reg.acquireClaim({
      sessionId: 'a', workspaceId: '/work', resource: 'src/a.ts',
      resourceType: 'file', mode: 'write', ttlMs: 1_000,
    })
    expect(reg.sweepExpiredClaims(Date.now()).length).toBe(0)
    const removed = reg.sweepExpiredClaims(Date.now() + 5_000)
    expect(removed).toEqual([claim.claim_id])
  })
})
