/**
 * 控制台检查：收集 Runtime.consoleAPICalled + Log.entryAdded，
 * 用于验收「界面无未捕获异常、React 无 key 警告」。
 * 用法：node console-check.mjs <url> [waitMs]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const url = process.argv[2] ?? 'http://127.0.0.1:8901/index.html?perf#devices'
const waitMs = Number(process.argv[3] ?? 10000)
const port = 9800 + Math.floor(Math.random() * 150)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-prof-'))

const child = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url],
  { stdio: 'ignore' }
)

let wsUrl = null
for (let i = 0; i < 60 && !wsUrl; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    const list = await res.json()
    const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
    if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl
  } catch {
    /* wait */
  }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('no target')

const ws = new WebSocket(wsUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true })
  ws.addEventListener('error', j, { once: true })
})

const entries = []
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) {
    entries.push({
      kind: `console.${m.params.type}`,
      text: (m.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400),
    })
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    entries.push({ kind: 'exception', text: (d.exception?.description ?? d.text ?? '').slice(0, 400) })
  }
  if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
    entries.push({ kind: `log.${m.params.entry.level}`, text: m.params.entry.text.slice(0, 400) })
  }
})

const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Runtime.enable')
await send('Log.enable')
await send('Page.reload')
await sleep(waitMs)

const state = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ ready: window.__ready === true, rows: document.querySelectorAll('tbody tr').length, perf: window.__perf && { avg: window.__perf.avgMs, max: window.__perf.maxMs, n: window.__perf.samples.length } })`,
  returnByValue: true,
})

console.log('STATE ' + (state.result?.result?.value ?? ''))
console.log('ISSUES ' + entries.length)
for (const e of entries.slice(0, 20)) console.log(`- [${e.kind}] ${e.text}`)
ws.close()
child.kill()
await sleep(300)
try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(0)
