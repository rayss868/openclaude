#!/usr/bin/env node
/**
 * ACP Web Client — chat with OpenClaude from a browser.
 *
 * Spawns the ACP stdio entrypoint (dist/acp.mjs) as a child process and
 * bridges JSON-RPC messages to a browser over HTTP + SSE.
 *
 * Session history is recorded locally (one JSON file per data dir) so the
 * browser UI can list past sessions, show their messages, and resume them
 * via ACP `session/load`.
 *
 * Usage:
 *   node scripts/acp-web-server.mjs [--port 5178] [--cwd /path/to/workdir]
 *   openclaude --web                      # after `bun run build`
 *
 * No external dependencies — only Node built-ins (node:http, node:child_process).
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Works both from scripts/ (dev) and dist/acp-web.mjs (bundled / `--web`).
const ACP_PATH =
  [join(__dirname, 'acp.mjs'), join(__dirname, '..', 'dist', 'acp.mjs')]
    .find(p => existsSync(p)) ?? join(__dirname, '..', 'dist', 'acp.mjs')

const args = process.argv.slice(2)
const getArg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(getArg('--port', process.env.ACP_WEB_PORT || '5178'))
const CWD = resolve(getArg('--cwd', process.env.ACP_WEB_CWD || process.cwd()))
const DATA_DIR = resolve(
  getArg('--data-dir', process.env.ACP_WEB_DATA_DIR || join(homedir(), '.openclaude', 'acp-web')),
)
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json')

/** ACP session registry: sessionId -> { id, cwd, createdAt, lastActive, messages, buffer, loaded } */
const sessions = new Map()

/** Pending JSON-RPC requests keyed by id. */
const pending = new Map()

/** Browser SSE clients for each session. */
const sseClients = new Map() // sessionId -> Set<res>

/** Pending ACP permission requests: requestId -> sessionId. */
const permissionRequests = new Map()

let nextRequestId = 1

/* ------------------------------------------------------------------ *
 *  Session history persistence (local JSON, not ACP state)            *
 * ------------------------------------------------------------------ */

function persist() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const data = { version: 1, sessions: {} }
    for (const [id, s] of sessions) {
      data.sessions[id] = {
        id,
        cwd: s.cwd,
        createdAt: s.createdAt,
        lastActive: s.lastActive,
        messages: s.messages,
      }
    }
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2))
  } catch (e) {
    // History is best-effort; never crash the bridge over a disk error.
    console.error('  ⚠ session history not saved:', String(e))
  }
}

function loadPersisted() {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')).sessions ?? {}
  } catch {
    return {}
  }
}

/* ------------------------------------------------------------------ *
 *  JSON-RPC plumbing over the ACP child process                       *
 * ------------------------------------------------------------------ */

const acp = spawn(process.execPath, [ACP_PATH], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: CWD,
})

const acpLines = createInterface({ input: acp.stdout })
acpLines.on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return // not JSON (shouldn't happen; ACP only writes JSON-RPC)
  }
  // Server-initiated request (has id + method): e.g. session/request_permission.
  // The client answers by sending back a request with the SAME id.
  if (msg.id !== undefined && typeof msg.method === 'string') {
    handleServerRequest(msg)
    return
  }
  // Notification (no id): session/update, etc.
  if (msg.id === undefined) {
    handleNotification(msg)
    return
  }
  // Response to a request we sent.
  const waiter = pending.get(msg.id)
  if (waiter) {
    pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(msg.error.message))
    else waiter.resolve(msg.result)
  }
})

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++
    pending.set(id, { resolve, reject })
    acp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

/** ACP requires `initialize` before any other method. */
const initPromise = sendRequest('initialize', {}).catch(err => {
  console.error('ACP initialize failed:', err)
  throw err
})

function sendNotification(method, params) {
  acp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

function handleNotification(msg) {
  const { method, params } = msg
  if (method !== 'session/update') return
  const sessionId = params?.sessionId
  const state = sessionId ? sessions.get(sessionId) : undefined
  const u = params.update
  if (!state || !u) return
  state.lastActive = Date.now()
  if (u.sessionUpdate === 'agent_message_chunk') {
    const text = u.content?.text
    if (typeof text === 'string' && text) state.buffer += text
  } else if (u.sessionUpdate === 'agent_message_complete') {
    if (state.buffer) {
      state.messages.push({ role: 'assistant', text: state.buffer, ts: Date.now() })
      state.buffer = ''
      persist()
    }
  } else if (u.sessionUpdate === 'tool_call') {
    const title = typeof u.title === 'string' ? u.title : 'tool'
    const last = state.messages[state.messages.length - 1]
    if (!last || last.role !== 'tool' || last.text !== title) {
      state.messages.push({ role: 'tool', text: title, toolName: title, ts: Date.now() })
      persist()
    }
  }
  broadcast(sessionId, msg)
}

/**
 * ACP sends session/request_permission as a server-initiated REQUEST (with an
 * id). The client answers it by writing a request with the SAME id back to the
 * ACP process; the ACP handler resolves the pending permission with
 * params.optionId. We forward the request to the browser so the UI can show
 * Allow/Reject buttons, and record the id so /api/respond can answer it.
 */
function handleServerRequest(msg) {
  const { id, method, params } = msg
  if (method === 'session/request_permission') {
    const sessionId = params?.sessionId
    if (!sessionId) return
    permissionRequests.set(id, sessionId)
    broadcast(sessionId, msg)
  }
}

/* ------------------------------------------------------------------ *
 *  HTTP + SSE server                                                  *
 * ------------------------------------------------------------------ */

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  if (req.method === 'GET' && path === '/') return serveIndex(res)
  if (req.method === 'GET' && path === '/events') return handleSse(req, res)
  if (req.method === 'GET' && path === '/api/sessions') return handleSessions(res)
  if (req.method === 'GET' && path === '/api/messages') return handleMessages(req, res)
  if (req.method === 'POST' && path === '/api/session') return handleNewSession(res)
  if (req.method === 'POST' && path === '/api/load') return handleLoad(req, res)
  if (req.method === 'POST' && path === '/api/prompt') return handlePrompt(req, res)
  if (req.method === 'POST' && path === '/api/respond') return handleRespond(req, res)
  if (req.method === 'POST' && path === '/api/cancel') return handleCancel(req, res)

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

/** Resume an ACP session that is known to us but not yet live in this process. */
async function loadSessionInto(state, cwd) {
  await initPromise
  await sendRequest('session/load', { sessionId: state.id, cwd })
  state.loaded = true
  state.lastActive = Date.now()
}

/* ---------------------------- handlers ---------------------------- */

function serveIndex(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(INDEX_HTML)
}

function handleSse(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId || !sessions.has(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown session' }))
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('retry: 2000\n\n')
  let set = sseClients.get(sessionId)
  if (!set) {
    set = new Set()
    sseClients.set(sessionId, set)
  }
  set.add(res)
  req.on('close', () => {
    set.delete(res)
    if (set.size === 0) sseClients.delete(sessionId)
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => (data += chunk))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

async function handleSessions(res) {
  const list = [...sessions.values()]
    .map(s => ({
      id: s.id,
      cwd: s.cwd,
      createdAt: s.createdAt,
      lastActive: s.lastActive,
      messageCount: s.messages.length,
    }))
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, sessions: list }))
}

async function handleMessages(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const sessionId = url.searchParams.get('sessionId')
  const state = sessionId && sessions.get(sessionId)
  if (!state) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown session' }))
    return
  }
  const messages = state.buffer
    ? [...state.messages, { role: 'assistant', text: state.buffer, ts: Date.now(), streaming: true }]
    : state.messages
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, messages }))
}

async function handleNewSession(res) {
  try {
    await initPromise
    const result = await sendRequest('session/new', { cwd: CWD })
    const sessionId = result.sessionId
    sessions.set(sessionId, {
      id: sessionId,
      cwd: CWD,
      createdAt: Date.now(),
      lastActive: Date.now(),
      messages: [],
      buffer: '',
      loaded: true,
    })
    persist()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, sessionId }))
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: String(e) }))
  }
}

async function handleLoad(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(e) }))
    return
  }
  const { sessionId } = body
  const state = sessionId && sessions.get(sessionId)
  if (!state) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown session' }))
    return
  }
  try {
    if (!state.loaded) await loadSessionInto(state, state.cwd || CWD)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, sessionId }))
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: `session/load failed: ${String(e)}` }))
  }
}

async function handlePrompt(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(e) }))
    return
  }
  const { sessionId, prompt } = body
  const state = sessionId && sessions.get(sessionId)
  if (!state) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown session' }))
    return
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'prompt is required' }))
    return
  }
  try {
    if (!state.loaded) await loadSessionInto(state, state.cwd || CWD)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: `session/load failed: ${String(e)}` }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  // Record the user message locally so reloads keep it in history.
  state.messages.push({ role: 'user', text: prompt.trim(), ts: Date.now() })
  state.buffer = ''
  state.lastActive = Date.now()
  persist()
  // Fire the prompt asynchronously — streaming goes out via SSE.
  sendRequest('session/prompt', { sessionId, prompt }).catch(() => {})
}

async function handleRespond(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(e) }))
    return
  }
  const { sessionId, requestId, optionId } = body
  if (!sessionId || !sessions.has(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown session' }))
    return
  }
  if (!permissionRequests.has(requestId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown permission request' }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  // ACP resolves session/request_permission as a request with the SAME id:
  // the client writes back a request with params.optionId.
  acp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, params: { optionId } }) + '\n')
  permissionRequests.delete(requestId)
}

async function handleCancel(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(e) }))
    return
  }
  const { sessionId } = body
  if (!sessionId || !sessions.has(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown session' }))
    return
  }
  sendRequest('session/cancel', { sessionId }).catch(() => {})
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}

/* ----------------------------- helpers ---------------------------- */

function broadcast(sessionId, msg) {
  const set = sseClients.get(sessionId)
  if (!set) return
  const payload = `data: ${JSON.stringify(msg)}\n\n`
  for (const res of set) {
    res.write(payload)
  }
}

/* ------------------------------- boot ----------------------------- */

// Restore known sessions from disk so the sidebar can list past chats.
// They are lazily resumed via ACP `session/load` when opened or prompted.
for (const [id, rec] of Object.entries(loadPersisted())) {
  sessions.set(id, {
    id,
    cwd: rec.cwd || CWD,
    createdAt: rec.createdAt || Date.now(),
    lastActive: rec.lastActive || Date.now(),
    messages: Array.isArray(rec.messages) ? rec.messages : [],
    buffer: '',
    loaded: false,
  })
}

server.listen(PORT, () => {
  console.log(`ACP Web Client running at http://localhost:${PORT}`)
  console.log(`  ACP process : ${ACP_PATH}`)
  console.log(`  Working dir : ${CWD}`)
  console.log(`  History file: ${SESSIONS_FILE}`)
})

process.on('exit', () => acp.kill())
process.on('SIGINT', () => {
  acp.kill()
  process.exit(0)
})

/* ------------------------------------------------------------------ *
 *  Inline HTML (single-file client, no build step)                    *
 * ------------------------------------------------------------------ */

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OpenClaude — ACP Web Chat</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --border:#262b36; --text:#e6e8ee; --muted:#8b93a7; --accent:#4f8cff; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; }
  #sidebar { width:260px; border-right:1px solid var(--border); padding:16px; display:flex; flex-direction:column; gap:12px; background:var(--panel); }
  #sidebar h1 { font-size:16px; margin:0; }
  #sidebar p { font-size:12px; color:var(--muted); margin:0; line-height:1.5; }
  #new-session { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:10px; cursor:pointer; font-weight:600; }
  #new-session:disabled { opacity:.5; cursor:default; }
  #session-meta { font-size:12px; color:var(--muted); word-break:break-all; }
  #session-list { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:6px; }
  #session-list .head { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:4px 0 0; }
  .sess-item { background:#12151c; border:1px solid var(--border); border-radius:8px; padding:8px 10px; cursor:pointer; font-size:12px; line-height:1.4; }
  .sess-item:hover { border-color:var(--accent); }
  .sess-item.active { border-color:var(--accent); background:#14233f; }
  .sess-item .time { font-weight:600; color:var(--text); }
  .sess-item .count { color:var(--muted); }
  .sess-item .cwd { color:var(--muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #main { flex:1; display:flex; flex-direction:column; min-width:0; }
  #messages { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:70%; padding:10px 14px; border-radius:10px; line-height:1.5; white-space:pre-wrap; word-break:break-word; font-size:14px; }
  .user { align-self:flex-end; background:var(--accent); color:#fff; }
  .assistant { align-self:flex-start; background:var(--panel); border:1px solid var(--border); }
  .tool { align-self:flex-start; background:#2a2f3a; border-left:3px solid #e2a03f; font-family:ui-monospace,monospace; font-size:12px; color:#d8dbe2; }
  .perm { align-self:flex-start; background:#2a2130; border:1px solid #6b4f8a; padding:10px 14px; border-radius:10px; max-width:80%; font-size:13px; }
  .perm button { margin:6px 6px 0 0; padding:6px 14px; border-radius:6px; border:0; cursor:pointer; font-weight:600; }
  .perm .allow { background:#2e8b57; color:#fff; }
  .perm .reject { background:#b33a3a; color:#fff; }
  .status { align-self:center; font-size:12px; color:var(--muted); }
  #inputbar { border-top:1px solid var(--border); padding:12px; display:flex; gap:8px; background:var(--panel); }
  #prompt { flex:1; background:#0f1115; color:var(--text); border:1px solid var(--border); border-radius:8px; padding:10px 12px; font-size:14px; resize:none; }
  #send { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:10px 18px; cursor:pointer; font-weight:600; }
  #send:disabled { opacity:.5; cursor:default; }
</style>
</head>
<body>
<div id="sidebar">
  <h1>OpenClaude</h1>
  <p>Chat via <strong>ACP</strong> over stdio. Riwayat sesi tersimpan lokal di <code>~/.openclaude/acp-web</code>.</p>
  <button id="new-session">New session</button>
  <div id="session-meta">No session yet.</div>
  <div id="session-list"><div class="head">Riwayat sesi</div></div>
</div>
<div id="main">
  <div id="messages"></div>
  <div id="inputbar">
    <textarea id="prompt" rows="1" placeholder="Ask OpenClaude… (Enter to send, Shift+Enter for newline)" disabled></textarea>
    <button id="send" disabled>Send</button>
  </div>
</div>
<script>
const el = {
  messages: document.getElementById('messages'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  newSession: document.getElementById('new-session'),
  meta: document.getElementById('session-meta'),
  sessionList: document.getElementById('session-list'),
}
let sessionId = null
let es = null
let streaming = false

function addMsg(html, cls) {
  const div = document.createElement('div')
  div.className = 'msg ' + cls
  div.innerHTML = html
  el.messages.appendChild(div)
  el.messages.scrollTop = el.messages.scrollHeight
  return div
}

function addText(role, text) {
  return addMsg(escapeHtml(String(text)).replace(/\\n/g, '<br>'), role)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function fmtTime(ts) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ' ' + p(d.getDate()) + '/' + p(d.getMonth() + 1)
}

function shortId(id) {
  return id ? id.slice(0, 8) + '…' : ''
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
  return res.json()
}

function setUiEnabled(on) {
  el.prompt.disabled = !on
  el.send.disabled = !on
}

function renderSessionList() {
  fetch('/api/sessions').then(r => r.json()).then(r => {
    const keep = el.sessionList.querySelector('.head')
    el.sessionList.innerHTML = ''
    el.sessionList.appendChild(keep)
    for (const s of r.sessions || []) {
      const item = document.createElement('div')
      item.className = 'sess-item' + (s.id === sessionId ? ' active' : '')
      item.innerHTML =
        '<div class="time">' + fmtTime(s.lastActive || s.createdAt) + '</div>' +
        '<div class="count">' + s.messageCount + ' pesan</div>' +
        '<div class="cwd">' + escapeHtml(s.cwd || '') + '</div>'
      item.addEventListener('click', () => loadSession(s.id))
      el.sessionList.appendChild(item)
    }
  }).catch(() => {})
}

async function renderHistory() {
  const r = await fetch('/api/messages?sessionId=' + encodeURIComponent(sessionId)).then(r => r.json())
  el.messages.innerHTML = ''
  streaming = false
  for (const m of r.messages || []) {
    if (m.role === 'tool') addMsg('<b>🔧 ' + escapeHtml(m.text) + '</b>', 'tool')
    else addText(m.role === 'user' ? 'user' : 'assistant', m.text)
  }
  if ((r.messages || []).some(m => m.streaming)) streaming = true
  el.messages.scrollTop = el.messages.scrollHeight
}

async function loadSession(id) {
  const r = await post('/api/load', { sessionId: id })
  if (!r.ok) { alert('Gagal load sesi: ' + r.error); return }
  sessionId = id
  localStorage.setItem('openclaude-acp-session', id)
  el.meta.textContent = 'Session: ' + shortId(id)
  setUiEnabled(true)
  await renderHistory()
  connectEvents()
  renderSessionList()
}

el.newSession.addEventListener('click', async () => {
  el.newSession.disabled = true
  const r = await post('/api/session', {})
  if (!r.ok) { alert('Failed: ' + r.error); el.newSession.disabled = false; return }
  sessionId = r.sessionId
  localStorage.setItem('openclaude-acp-session', sessionId)
  el.meta.textContent = 'Session: ' + shortId(sessionId)
  setUiEnabled(true)
  el.messages.innerHTML = ''
  el.newSession.disabled = false
  connectEvents()
  renderSessionList()
})

function connectEvents() {
  if (es) es.close()
  es = new EventSource('/events?sessionId=' + encodeURIComponent(sessionId))
  es.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    if (msg.method === 'session/update') {
      const u = msg.params.update
      if (u && u.sessionUpdate === 'agent_message_chunk') {
        const text = u.content && u.content.text
        if (text) {
          if (!streaming) { addText('assistant', ''); streaming = true }
          const last = el.messages.lastElementChild
          last.innerHTML = escapeHtml(last.textContent + text).replace(/\\n/g, '<br>')
          el.messages.scrollTop = el.messages.scrollHeight
        }
      } else if (u && u.sessionUpdate === 'tool_call') {
        const id = u.content && u.content.toolCallId
        const name = (u.content && u.content.title) || 'tool'
        addMsg('<b>🔧 ' + escapeHtml(name) + '</b> <span style="color:var(--muted)">(' + escapeHtml(id || '') + ')</span>', 'tool')
        renderSessionList()
      } else if (u && u.sessionUpdate === 'agent_message_complete') {
        streaming = false
        renderSessionList()
      }
    } else if (msg.method === 'session/request_permission') {
      const p = msg.params
      const opt = (p.options || []).map(o =>
        '<button class="' + (o.optionId === 'allow' ? 'allow' : 'reject') + '" data-rid="' + escapeHtml(msg.id) + '" data-opt="' + escapeHtml(o.optionId) + '">' + escapeHtml(o.name) + '</button>'
      ).join('')
      const title = p.toolCall && p.toolCall.title ? p.toolCall.title : 'tool'
      addMsg('<b>🔐 Permission: ' + escapeHtml(title) + '</b><br>' + opt, 'perm')
    }
  }
}

el.messages.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-rid]')
  if (!btn) return
  await post('/api/respond', { sessionId, requestId: btn.dataset.rid, optionId: btn.dataset.opt })
  btn.closest('.perm').innerHTML = 'Decision: ' + btn.dataset.opt
})

function send() {
  const text = el.prompt.value.trim()
  if (!text || !sessionId || el.send.disabled) return
  el.prompt.value = ''
  addText('user', text)
  streaming = false
  post('/api/prompt', { sessionId, prompt: text })
}

el.send.addEventListener('click', send)
el.prompt.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})

// Boot: list history; auto-open the last session used in this browser.
renderSessionList()
const last = localStorage.getItem('openclaude-acp-session')
if (last) loadSession(last)
</script>
</body>
</html>`