#!/usr/bin/env node
/**
 * 冒烟脚本：真实拉起 Electron 窗口 → 逐视图截图 → 落盘 snapshot.json。
 *
 * 用法：node scripts/smoke.mjs [--out <dir>] [--timeout <ms>]
 * 产出：overview.png / devices.png / detail.png / printers.png / printermanage.png / settings.png / diagnostics.png / router.png + snapshot.json
 *
 * 主进程侧只暴露钩子，截图例程在 SMOKE=1 分支里由 src/main/smoke.ts 执行（生产路径不参与）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const outDir = path.resolve(argValue('--out', path.join(root, '.agent-runs/2026-10-25/task-001/artifacts')));
const timeoutMs = Number(argValue('--timeout', '60000'));

const electronBin = path.join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

if (!fs.existsSync(electronBin)) {
  console.error(`[smoke] 未找到 Electron 可执行文件: ${electronBin}`);
  console.error('[smoke] 先运行 npm install（Electron 需下载约 120MB 二进制）');
  process.exit(2);
}

const mainBundle = path.join(root, 'dist', 'main', 'index.cjs');
const preloadBundle = path.join(root, 'dist', 'main', 'preload.cjs');
if (!fs.existsSync(mainBundle) || !fs.existsSync(preloadBundle)) {
  console.error('[smoke] dist/main 产物缺失，先运行 npm run build:main && npm run build:preload');
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

console.log(`[smoke] electron : ${electronBin}`);
console.log(`[smoke] app root : ${root}`);
console.log(`[smoke] out dir  : ${outDir}`);

// 关键环境清理：某些 CI/IDE 环境（如 WorkBuddy 宿主）会注入 ELECTRON_RUN_AS_NODE=1，
// 这会让 electron.exe 退化成纯 Node 运行，require('electron') 拿不到 API（app 为 undefined）。
const childEnv = {
  ...process.env,
  SMOKE: '1',
  SMOKE_OUT: outDir,
  ELECTRON_ENABLE_LOGGING: '0',
};
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [root], {
  cwd: root,
  windowsHide: true,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString('utf8');
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8');
  process.stderr.write(chunk);
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`[smoke] 超时 ${timeoutMs}ms，强制结束`);
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
}, timeoutMs);

const exitCode = await new Promise((resolve) => {
  child.on('close', (code) => resolve(code ?? 1));
  child.on('error', (err) => {
    console.error('[smoke] spawn 失败', err);
    resolve(1);
  });
});
clearTimeout(timer);

// —— 证据校验 ——
const expected = ['overview.png', 'devices.png', 'printers.png', 'detail.png', 'router.png'];
let bad = 0;
console.log('\n[smoke] 截图完整性：');
for (const name of expected) {
  const target = path.join(outDir, name);
  if (!fs.existsSync(target)) {
    console.log(`  ${name.padEnd(14)} MISSING`);
    bad += 1;
    continue;
  }
  const buf = fs.readFileSync(target);
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const ok = isPng && buf.length > 10 * 1024;
  if (!ok) bad += 1;
  console.log(`  ${name.padEnd(14)} ${String(buf.length).padStart(8)} B  ${ok ? 'OK' : 'INVALID(<10KB 或非 PNG)'}`);
}

const snapshotPath = path.join(outDir, 'snapshot.json');
if (fs.existsSync(snapshotPath)) {
  try {
    const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    console.log(
      `\n[smoke] snapshot: devices=${snap.devices?.length ?? 0} printers=${snap.printers?.length ?? 0} dataSource=${snap.dataSource}`,
    );
    if (!snap.devices?.length || !snap.printers?.length) bad += 1;
  } catch (err) {
    console.log(`[smoke] snapshot.json 解析失败: ${err.message}`);
    bad += 1;
  }
} else {
  console.log('\n[smoke] snapshot.json MISSING');
  bad += 1;
}

// 主进程 stderr 出现未捕获异常视为失败
const rejection = /UnhandledPromiseRejection|unhandledRejection|uncaughtException/i.test(stderr);
if (rejection) {
  console.error('[smoke] 主进程出现未捕获异常（见上方 stderr）');
  bad += 1;
}

console.log(`\n[smoke] electron exit=${exitCode} timedOut=${timedOut} problems=${bad}`);
process.exit(timedOut || exitCode !== 0 || bad > 0 ? 1 : 0);
