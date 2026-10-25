/**
 * 无头截图（CDP）：可在截图前执行一段表达式，用于切换 UI 状态。
 * 用法：node shot.mjs <url> <out.png> ["js expr"] [waitMs]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const url = process.argv[2]
const out = process.argv[3]
const preExpr = process.argv[4] ?? ''
const waitMs = Number(process.argv[5] ?? 2500)
const port = 9500 + Math.floor(Math.random() * 300)
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
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })

await sleep(2200)
if (preExpr) {
  const r = await send('Runtime.evaluate', { expression: preExpr, returnByValue: true })
  if (r.result?.exceptionDetails) console.log('EXPR ERROR', JSON.stringify(r.result.exceptionDetails))
  await sleep(waitMs)
} else {
  await sleep(waitMs - 1200 > 0 ? waitMs - 1200 : 500)
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log(out)
ws.close()
child.kill()
await sleep(300)
try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(0)
