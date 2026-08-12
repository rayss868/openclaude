import { createInterface } from 'node:readline'
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKSession,
} from './sdk/v2.js'
import type { SDKPermissionRequestMessage, SDKMessage } from './sdk/shared.js'

const ACP_PROTOCOL_VERSION = 1
const ACP_AGENT_INFO = {
  name: 'openclaude',
  title: 'OpenClaude',
  version: String((globalThis as { MACRO?: { DISPLAY_VERSION?: string } }).MACRO?.DISPLAY_VERSION ?? 'dev'),
}

type JsonRpcId = string | number | null
type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown>
}
type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type AcpWriter = (message: JsonRpcResponse | { jsonrpc: '2.0'; method: string; params: unknown }) => void

type SessionState = {
  cwd: string
  session: SDKSession
  active: Promise<void> | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function textFromPrompt(params: Record<string, unknown>): string {
  const prompt = params.prompt
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) throw new Error('session/prompt requires a prompt')

  return prompt
    .filter(isRecord)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
}

function textFromMessage(message: SDKMessage): string | null {
  if (message.type === 'assistant') {
    const content = message.message.content
    if (!Array.isArray(content)) return null
    return content
      .filter(isRecord)
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('') || null
  }

  if (message.type === 'stream_event' && isRecord(message.event)) {
    const delta = message.event.delta
    if (isRecord(delta) && delta.type === 'text_delta' && typeof delta.text === 'string') {
      return delta.text
    }
  }

  return null
}

function toolUpdate(message: SDKMessage): Record<string, unknown> | null {
  if (message.type !== 'assistant' || !Array.isArray(message.message.content)) return null
  const tool = message.message.content.find(
    block => isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string',
  )
  if (!isRecord(tool)) return null

  return {
    sessionUpdate: 'tool_call',
    toolCallId: tool.id,
    title: typeof tool.name === 'string' ? tool.name : 'OpenClaude tool',
    kind: 'other',
    status: 'in_progress',
    rawInput: isRecord(tool.input) ? tool.input : {},
  }
}

export function createAcpServer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): { close: () => void } {
  const sessions = new Map<string, SessionState>()
  const pendingRequests = new Map<JsonRpcId, (result: unknown) => void>()
  let nextRequestId = 1
  let initialized = false

  const write: AcpWriter = message => {
    output.write(`${JSON.stringify(message)}\n`)
  }

  const respond = (id: JsonRpcId, result: unknown): void => {
    write({ jsonrpc: '2.0', id, result })
  }

  const fail = (id: JsonRpcId, code: number, message: string): void => {
    write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  const notify = (method: string, params: unknown): void => {
    write({ jsonrpc: '2.0', method, params })
  }

  const requestPermission = (
    sessionId: string,
    session: SDKSession,
    message: SDKPermissionRequestMessage,
  ): void => {
    const id = nextRequestId++
    pendingRequests.set(id, result => {
      const optionId = isRecord(result) && typeof result.optionId === 'string' ? result.optionId : 'reject'
      session.respondToPermission(message.tool_use_id, optionId === 'allow'
        ? {
            behavior: 'allow',
            decisionClassification: 'user_temporary',
          }
        : {
            behavior: 'deny',
            message: 'Permission denied by ACP client',
            decisionClassification: 'user_reject',
          })
    })

    write({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: {
          toolCallId: message.tool_use_id,
          title: message.tool_name,
          kind: 'other',
          rawInput: message.input,
        },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
  }

  const handle = async (message: JsonRpcRequest): Promise<void> => {
    if (message.id !== undefined && pendingRequests.has(message.id)) {
      const resolve = pendingRequests.get(message.id)!
      pendingRequests.delete(message.id)
      resolve(message.params ?? {})
      return
    }

    if (message.method === 'initialize') {
      initialized = true
      if (message.id === undefined) return
      respond(message.id, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        agentInfo: ACP_AGENT_INFO,
      })
      return
    }

    if (!initialized) {
      if (message.id !== undefined) fail(message.id, -32002, 'initialize must be called first')
      return
    }

    if (message.method === 'session/new') {
      const cwd = typeof message.params?.cwd === 'string' ? message.params.cwd : process.cwd()
      let session: SDKSession
      const onPermissionRequest = (permission: SDKPermissionRequestMessage): void => {
        requestPermission(session.sessionId, session, permission)
      }
      session = unstable_v2_createSession({ cwd, onPermissionRequest })
      sessions.set(session.sessionId, { cwd, session, active: null })
      if (message.id !== undefined) respond(message.id, { sessionId: session.sessionId })
      return
    }

    if (message.method === 'session/load') {
      const sessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : ''
      const cwd = typeof message.params?.cwd === 'string' ? message.params.cwd : process.cwd()
      if (!sessionId) {
        if (message.id !== undefined) fail(message.id, -32602, 'session/load requires sessionId')
        return
      }
      let session: SDKSession
      const onPermissionRequest = (permission: SDKPermissionRequestMessage): void => {
        requestPermission(session.sessionId, session, permission)
      }
      session = await unstable_v2_resumeSession(sessionId, { cwd, onPermissionRequest })
      sessions.set(sessionId, { cwd, session, active: null })
      if (message.id !== undefined) respond(message.id, { sessionId })
      return
    }

    if (message.method === 'session/cancel') {
      const sessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : ''
      const state = sessions.get(sessionId)
      if (state) state.session.interrupt()
      if (message.id !== undefined) respond(message.id, {})
      return
    }

    if (message.method === 'session/prompt') {
      const sessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : ''
      const state = sessions.get(sessionId)
      if (!state) {
        if (message.id !== undefined) fail(message.id, -32004, `Unknown session: ${sessionId}`)
        return
      }
      if (state.active) {
        if (message.id !== undefined) fail(message.id, -32005, 'A prompt is already active for this session')
        return
      }

      state.active = (async () => {
        try {
          for await (const sdkMessage of state.session.sendMessage(textFromPrompt(message.params ?? {}))) {
            const text = textFromMessage(sdkMessage)
            if (text) {
              notify('session/update', {
                sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
              })
            }
            const tool = toolUpdate(sdkMessage)
            if (tool) notify('session/update', { sessionId, update: tool })
          }
          if (message.id !== undefined) respond(message.id, { stopReason: 'end_turn' })
        } catch (error) {
          if (message.id !== undefined) {
            fail(message.id, -32000, error instanceof Error ? error.message : String(error))
          }
        } finally {
          state.active = null
        }
      })()
      return
    }

    if (message.id !== undefined) fail(message.id, -32601, `Method not found: ${message.method}`)
  }

  const rl = createInterface({ input, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let message: JsonRpcRequest
    try {
      message = JSON.parse(line) as JsonRpcRequest
    } catch {
      fail(null, -32700, 'Parse error')
      return
    }
    void handle(message).catch(error => {
      if (message.id !== undefined) fail(message.id, -32000, error instanceof Error ? error.message : String(error))
    })
  })

  const close = (): void => {
    rl.close()
    for (const state of sessions.values()) state.session.close()
    sessions.clear()
  }

  return { close }
}

if (import.meta.main) {
  createAcpServer()
}
