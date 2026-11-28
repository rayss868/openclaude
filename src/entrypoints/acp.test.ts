import { afterAll, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'node:stream'

// mock.module is process-global, so capture the real modules and restore them
// in afterAll (see src/buddy/companion.test.ts for the same pattern).
const actualInit = await import(`./init.js?real=${Date.now()}`)
const actualSdkV2 = await import(`./sdk/v2.js?real=${Date.now()}`)

const calls: string[] = []
const fakeSession = {
  sessionId: 'test-session',
  interrupt: () => {},
  close: () => {},
}

mock.module('./init.js', () => ({
  init: async () => {
    calls.push('init')
  },
}))

mock.module('./sdk/v2.js', () => ({
  unstable_v2_createSession: () => {
    calls.push('createSession')
    return fakeSession
  },
  unstable_v2_resumeSession: async () => {
    calls.push('resumeSession')
    return fakeSession
  },
}))

const { createAcpServer } = await import('./acp.js')

afterAll(() => {
  mock.module('./init.js', () => actualInit)
  mock.module('./sdk/v2.js', () => actualSdkV2)
})

function send(input: PassThrough, message: unknown): void {
  input.write(`${JSON.stringify(message)}\n`)
}

type JsonRpcResponse = { jsonrpc: string; id?: number; result?: unknown }

function collect(output: PassThrough): () => JsonRpcResponse[] {
  let buffer = ''
  output.on('data', chunk => {
    buffer += chunk.toString()
  })
  return () =>
    buffer
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
}

describe('ACP server startup', () => {
  test('session/new awaits init before building the session engine', async () => {
    calls.length = 0
    const input = new PassThrough()
    const output = new PassThrough()
    const messages = collect(output)
    const server = createAcpServer(input, output)

    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    })
    send(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: '/tmp' },
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    server.close()

    expect(calls).toEqual(['init', 'createSession'])
    expect(messages()).toContainEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { sessionId: 'test-session' },
    })
  })

  test('session/load awaits init before resuming', async () => {
    calls.length = 0
    const input = new PassThrough()
    const output = new PassThrough()
    const server = createAcpServer(input, output)

    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    })
    send(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/load',
      params: { sessionId: 'test-session', cwd: '/tmp' },
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    server.close()

    expect(calls).toEqual(['init', 'resumeSession'])
  })
})
