/**
 * 真实浏览器渲染耗时实测（CDP 驱动 Edge headless，不使用 virtual-time，
 * 因此 performance.now() 是真实墙钟）。
 *
 * 用法：node measure.mjs <url> <outPng> [waitMs]
 * 依赖：本机 Edge（C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const url = process.argv[2] ?? 'http://127.0.0.1:8901/index.html?perf#devices'
const outPng = process.argv[3] ?? path.join(os.tmpdir(), 'perf.png')
const waitMs = Number(process.argv[4] ?? 12000)
const port = 9333 + Math.floor(Math.random() * 200)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-prof-'))

const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,900',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    url,
  ],
  { stdio: 'ignore' }
)

async function findWs() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('未能连接到 Edge CDP')
}

const wsUrl = await findWs()
const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  try {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  } catch {
    /* ignore */
  }
})

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Page.enable')
await sleep(2500)
// 可选：先切到目标视图（如 'devices'），让后续推送的样本落在真正的长列表上
const viewExpr = process.argv[5]
if (viewExpr) {
  await send('Runtime.evaluate', { expression: viewExpr, returnByValue: true })
  await sleep(waitMs)
} else {
  await sleep(Math.max(0, waitMs - 2500))
}

const evalRes = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    ready: window.__ready === true,
    perf: window.__perf ?? null,
    rows: document.querySelectorAll('tbody tr').length,
    statusText: document.querySelector('.statusbar')?.textContent ?? ''
  })`,
  returnByValue: true,
})
console.log(evalRes.result?.result?.value ?? JSON.stringify(evalRes))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  fs.writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'))
  console.log(`screenshot: ${outPng}`)
}

ws.close()
child.kill()
await sleep(400)
try {
  fs.rmSync(profile, { recursive: true, force: true })
} catch {
  /* ignore */
}
process.exit(0)
