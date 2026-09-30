/**
 * Hall discovery metadata.
 *
 * A small per-user JSON file publishes how a client can reach the live Hall
 * daemon. It is only a hint: a client must treat it as stale until the
 * endpoint answers a valid handshake.
 */

import { readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PROTOCOL_VERSION } from './protocol.js'
import { getHallScopeDir } from './transport.js'

export const DISCOVERY_SCHEMA = 1

export type DiscoveryMetadata = {
  schema: number
  pid: number
  started_at: string
  transport: 'pipe' | 'uds'
  endpoint: string
  protocol_version: number
  instance_id: string
}

export function getHallDiscoveryPath(): string {
  return join(getHallScopeDir(), 'hall.json')
}

function isDiscoveryMetadata(value: unknown): value is DiscoveryMetadata {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.schema === DISCOVERY_SCHEMA &&
    typeof v.pid === 'number' &&
    typeof v.started_at === 'string' &&
    (v.transport === 'pipe' || v.transport === 'uds') &&
    typeof v.endpoint === 'string' &&
    typeof v.protocol_version === 'number' &&
    typeof v.instance_id === 'string'
  )
}

export function readDiscovery(path?: string): DiscoveryMetadata | null {
  try {
    const raw = readFileSync(path ?? getHallDiscoveryPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isDiscoveryMetadata(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeDiscovery(
  meta: Omit<DiscoveryMetadata, 'schema' | 'protocol_version'>,
  path?: string,
): void {
  const full: DiscoveryMetadata = {
    schema: DISCOVERY_SCHEMA,
    protocol_version: PROTOCOL_VERSION,
    ...meta,
  }
  writeFileSync(path ?? getHallDiscoveryPath(), JSON.stringify(full, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export function removeDiscovery(path?: string): void {
  try {
    unlinkSync(path ?? getHallDiscoveryPath())
  } catch {
    // Already gone; nothing to do.
  }
}
