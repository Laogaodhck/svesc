#!/usr/bin/env node
/**
 * 启动器：直接拉起 Electron 跑本应用。
 *
 * 为什么需要它：某些 IDE/CI 宿主会注入 `ELECTRON_RUN_AS_NODE=1`，
 * 这会让 electron.exe 退化成纯 Node，`require('electron')` 拿不到 API，
 * 表现为 `Cannot read properties of undefined (reading 'whenReady')`。
 * 这里显式清掉该变量后再 spawn，避免使用者踩坑。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = path.join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

if (!fs.existsSync(electronBin)) {
  console.error(`[start] 未找到 Electron: ${electronBin}`);
  console.error('[start] 先运行 npm install；若二进制缺失：');
  console.error('        ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js');
  process.exit(2);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [root, ...process.argv.slice(2)], {
  cwd: root,
  windowsHide: false,
  env,
  stdio: 'inherit',
});

child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('[start] 启动失败', err);
  process.exit(1);
});
