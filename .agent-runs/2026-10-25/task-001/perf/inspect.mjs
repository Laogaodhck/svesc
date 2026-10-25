/**
 * 一次性量测脚本：打印指定选择器的盒子信息，用于排查「文字被裁切」。
 * 用法：node inspect.mjs <url> "<selector>"
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const url = process.argv[2]
const selector = process.argv[3]
const port = 9700 + Math.floor(Math.random() * 200)
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

await sleep(3000)
const expr = `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'NOT FOUND';
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const kids = [...el.children].map(k => ({
    tag: k.tagName,
    rect: (({x,y,width,height}) => ({x:Math.round(x),y:Math.round(y),w:Math.round(width),h:Math.round(height)}))(k.getBoundingClientRect())
  }));
  return JSON.stringify({ rect: {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
    minHeight: cs.minHeight, padding: cs.padding, lineHeight: cs.lineHeight,
    scrollH: el.scrollHeight, clientH: el.clientHeight, kids }, null, 1);
})()`
const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
console.log(out.result?.result?.value ?? JSON.stringify(out))
ws.close()
child.kill()
await sleep(300)
try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(0)
