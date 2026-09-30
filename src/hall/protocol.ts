/**
 * Agent Hall wire protocol, version 1.
 *
 * Frames are newline-delimited JSON. Every inbound frame is validated before
 * use; malformed or unsupported frames are answered with an `error` frame
 * instead of being dispatched. JSON is chosen because the runtime already
 * speaks JSON everywhere (mailbox, bridge, transcripts) and it keeps the
 * protocol debuggable by eye.
 */

export const PROTOCOL_VERSION = 1

export const ERROR_CODES = [
  'PROTOCOL_UNSUPPORTED',
  'INVALID_FRAME',
  'SESSION_NOT_REGISTERED',
  'DESTINATION_NOT_FOUND',
  'WORKSPACE_REQUIRED',
  'CLAIM_INVALID',
  'CLAIM_NOT_FOUND',
  'MESSAGE_EXPIRED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export type ClientFrameType =
  | 'hello'
  | 'session.register'
  | 'session.unregister'
  | 'heartbeat'
  | 'task.update'
  | 'claim.acquire'
  | 'claim.renew'
  | 'claim.release'
  | 'peer.list'
  | 'claim.list'
  | 'message.send'
  | 'hall.status'

export type ServerFrameType =
  | 'hello_ack'
  | 'session.registered'
  | 'session.joined'
  | 'session.updated'
  | 'session.left'
  | 'claim.acquired'
  | 'claim.released'
  | 'claim.conflict'
  | 'message.received'
  | 'hall.idle'
  | 'hall.shutdown_cancelled'
  | 'error'

export type FrameType = ClientFrameType | ServerFrameType

export type Frame = {
  protocol_version: number
  frame_id: string
  type: FrameType
  sent_at: string
  session_id?: string
  request_id?: string | null
  payload: Record<string, unknown>
}

const CLIENT_TYPES = new Set<string>([
  'hello',
  'session.register',
  'session.unregister',
  'heartbeat',
  'task.update',
  'claim.acquire',
  'claim.renew',
  'claim.release',
  'peer.list',
  'claim.list',
  'message.send',
  'hall.status',
])

export function isClientFrameType(type: string): type is ClientFrameType {
  return CLIENT_TYPES.has(type)
}

/** A workspace record published by a client (spec section 8). */
export type WorkspaceRecord = {
  raw_root: string
  canonical_root: string
  repo_root?: string
  repo_id?: string
  worktree_root?: string
  branch?: string
}

export type TaskRecord = {
  title: string
  summary?: string
  status: 'working' | 'waiting' | 'blocked' | 'done'
  updated_at: string
}

export type ClaimMode = 'read' | 'write'

export type ClaimRecord = {
  claim_id: string
  session_id: string
  workspace_id: string
  resource_type: 'file' | 'dir'
  resource: string
  normalized_resource: string
  mode: ClaimMode
  created_at: string
  expires_at: string
}

export type SessionRecord = {
  session_id: string
  agent_name: string
  pid: number
  started_at: string
  connected_at: string
  last_heartbeat: string
  status: TaskRecord['status']
  workspace: WorkspaceRecord
  task: TaskRecord
}

/** Maximum size of a single decoded frame, in bytes. Hall is not a bulk bus. */
export const MAX_FRAME_BYTES = 256 * 1024

let frameCounter = 0

function nextFrameId(): string {
  frameCounter = (frameCounter + 1) % 1_000_000
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${frameCounter.toString(36)}`
}

export function makeFrame(
  type: FrameType,
  payload: Record<string, unknown> = {},
  opts?: { session_id?: string; request_id?: string | null },
): Frame {
  const frame: Frame = {
    protocol_version: PROTOCOL_VERSION,
    frame_id: nextFrameId(),
    type,
    sent_at: new Date().toISOString(),
    payload,
  }
  if (opts?.session_id !== undefined) frame.session_id = opts.session_id
  if (opts?.request_id !== undefined) frame.request_id = opts.request_id
  return frame
}

export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`
}

export type DecodeResult =
  | { ok: true; frame: Frame }
  | { ok: false; reason: 'invalid' | 'version'; request_id?: string | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse and validate one frame line. Returns a discriminated result so the
 * caller can distinguish a malformed frame from an unsupported protocol
 * version and answer with the right error code.
 */
export function decodeFrameLine(line: string): DecodeResult {
  const trimmed = line.trim()
  if (!trimmed) return { ok: false, reason: 'invalid' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'invalid' }
  }

  if (!isRecord(parsed)) return { ok: false, reason: 'invalid' }

  const requestId =
    typeof parsed.request_id === 'string' ? parsed.request_id : null

  if (
    typeof parsed.protocol_version !== 'number' ||
    typeof parsed.type !== 'string' ||
    typeof parsed.frame_id !== 'string' ||
    typeof parsed.sent_at !== 'string' ||
    !isRecord(parsed.payload)
  ) {
    return { ok: false, reason: 'invalid', request_id: requestId }
  }

  if (parsed.protocol_version !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'version', request_id: requestId }
  }

  return { ok: true, frame: parsed as Frame }
}

