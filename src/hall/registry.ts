/**
 * In-memory Hall state owned by the daemon: presence, resource claims, and
 * peer queries. All mutations are synchronous and server-serialized, which is
 * the v1 ordering model (protocol doc section 14).
 */

import { randomUUID } from 'crypto'
import type {
  ClaimMode,
  ClaimRecord,
  SessionRecord,
  TaskRecord,
} from './protocol.js'

/** Normalize a resource path for overlap comparison. */
export function normalizeResource(
  resource: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let normalized = resource.replace(/\\/g, '/').replace(/\/+$/, '')
  if (platform === 'win32') normalized = normalized.toLowerCase()
  return normalized
}

/**
 * Overlap rules for v1 (tech spec section 13):
 * - identical normalized paths always overlap;
 * - a directory claim overlaps any path underneath it;
 * - otherwise no overlap.
 */
export function claimsOverlap(
  a: { normalized_resource: string; resource_type: 'file' | 'dir' },
  b: { normalized_resource: string; resource_type: 'file' | 'dir' },
  platform: NodeJS.Platform = process.platform,
): boolean {
  const left = normalizeResource(a.normalized_resource, platform)
  const right = normalizeResource(b.normalized_resource, platform)
  if (left === right) return true
  if (a.resource_type === 'dir' && right.startsWith(`${left}/`)) return true
  if (b.resource_type === 'dir' && left.startsWith(`${right}/`)) return true
  return false
}

export type ClaimConflict = {
  session_id: string
  agent_name: string
  resource: string
  mode: ClaimMode
}

export class HallRegistry {
  private sessions = new Map<string, SessionRecord>()
  private claims = new Map<string, ClaimRecord>()

  get sessionCount(): number {
    return this.sessions.size
  }

  registerSession(record: SessionRecord): SessionRecord {
    this.sessions.set(record.session_id, record)
    return record
  }

  unregisterSession(sessionId: string): boolean {
    const removed = this.sessions.delete(sessionId)
    for (const [id, claim] of this.claims) {
      if (claim.session_id === sessionId) this.claims.delete(id)
    }
    return removed
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId)
  }

  touchHeartbeat(sessionId: string, now: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.last_heartbeat = now
    return true
  }

  updateTask(sessionId: string, task: TaskRecord): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.task = task
    session.status = task.status
    return true
  }

  /** Remove sessions whose lease expired and drop their claims. */
  sweepStaleSessions(nowMs: number, leaseMs: number): string[] {
    const removed: string[] = []
    for (const [id, session] of this.sessions) {
      const last = Date.parse(session.last_heartbeat)
      if (Number.isNaN(last) || nowMs - last > leaseMs) {
        this.sessions.delete(id)
        for (const [claimId, claim] of this.claims) {
          if (claim.session_id === id) this.claims.delete(claimId)
        }
        removed.push(id)
      }
    }
    return removed
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()]
  }

  /** Peers in the same canonical workspace root, excluding the caller. */
  listWorkspacePeers(
    sessionId: string,
    canonicalRoot: string,
  ): SessionRecord[] {
    return this.listSessions().filter(
      session =>
        session.session_id !== sessionId &&
        session.workspace.canonical_root === canonicalRoot,
    )
  }

  listClaims(sessionId?: string): ClaimRecord[] {
    const all = [...this.claims.values()]
    return sessionId
      ? all.filter(claim => claim.session_id === sessionId)
      : all
  }

  /**
   * Record a claim and report advisory conflicts. v1 never rejects: the claim
   * is always granted, and conflicts are returned so the client can warn.
   */
  acquireClaim(input: {
    sessionId: string
    workspaceId: string
    resource: string
    resourceType: 'file' | 'dir'
    mode: ClaimMode
    ttlMs: number
    now?: number
  }): { claim: ClaimRecord; conflicts: ClaimConflict[] } {
    const now = input.now ?? Date.now()
    const normalized = normalizeResource(input.resource)
    const candidate = {
      normalized_resource: normalized,
      resource_type: input.resourceType,
    }

    const conflicts: ClaimConflict[] = []
    for (const existing of this.claims.values()) {
      if (existing.session_id === input.sessionId) continue
      if (!claimsOverlap(candidate, existing)) continue
      const session = this.sessions.get(existing.session_id)
      conflicts.push({
        session_id: existing.session_id,
        agent_name: session?.agent_name ?? 'unknown',
        resource: existing.resource,
        mode: existing.mode,
      })
    }

    const claim: ClaimRecord = {
      claim_id: randomUUID(),
      session_id: input.sessionId,
      workspace_id: input.workspaceId,
      resource_type: input.resourceType,
      resource: input.resource,
      normalized_resource: normalized,
      mode: input.mode,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + input.ttlMs).toISOString(),
    }
    this.claims.set(claim.claim_id, claim)
    return { claim, conflicts }
  }

  /** Refresh a claim's lease. Returns the claim, or null if not owned/found. */
  renewClaim(
    claimId: string,
    sessionId: string,
    ttlMs: number,
    now: number = Date.now(),
  ): ClaimRecord | null {
    const claim = this.claims.get(claimId)
    if (!claim || claim.session_id !== sessionId) return null
    claim.expires_at = new Date(now + ttlMs).toISOString()
    return claim
  }

  /** Release a claim. Returns true only if the caller owned it. */
  releaseClaim(claimId: string, sessionId: string): boolean {
    const claim = this.claims.get(claimId)
    if (!claim || claim.session_id !== sessionId) return false
    this.claims.delete(claimId)
    return true
  }

  /** Drop claims whose lease expired. */
  sweepExpiredClaims(now: number = Date.now()): string[] {
    const removed: string[] = []
    for (const [id, claim] of this.claims) {
      const expires = Date.parse(claim.expires_at)
      if (!Number.isNaN(expires) && expires <= now) {
        this.claims.delete(id)
        removed.push(id)
      }
    }
    return removed
  }
}
