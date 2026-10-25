#!/usr/bin/env node
/**
 * SQLite 持久化端到端检查（task-018）。用法：
 *   node scripts/db-check.mjs                 # 默认临时目录
 *   node scripts/db-check.mjs --dir D:/tmp/x  # 指定目录
 *
 * 验证内容：建库迁移 → 设备状态同步落库 → 别名/告警实时写入 → 模拟重启 →
 * 全部数据恢复。退出码 0 = 全部断言通过。
 * 实现方式与 engine-check.mjs 相同：esbuild 打成单文件 CJS 再 require（纯 Node）。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const dir = path.resolve(argValue('--dir', path.join(os.tmpdir(), 'svesc-db-check-' + process.pid)));
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const bundlePath = path.join(os.tmpdir(), `svesc-db-check-${process.pid}.cjs`);
await build({
  entryPoints: [path.join(root, 'src/main/engine/db-check.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  outfile: bundlePath,
  logLevel: 'error',
});

const mod = await import(pathToFileURL(bundlePath).href);
const api = typeof mod.runDbCheck === 'function' ? mod : mod.default;
const result = await api.runDbCheck({ userDataDir: dir });

try {
  fs.unlinkSync(bundlePath);
} catch {
  /* 临时文件清理失败无害 */
}

// —— 直连数据库核对表结构与行数（独立于引擎的旁路验证） ——
const dbPath = path.join(dir, 'svesc-state.db');
const stats = {};
if (fs.existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tables = ['settings', 'aliases', 'devices', 'device_status_log', 'alarms', 'printers_manual', 'printers_ignored', 'known_device_keys'];
  for (const t of tables) {
    stats[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() ?? { n: -1 }).n;
  }
  const version = db.prepare('PRAGMA user_version').get();
  stats.schema_version = version.user_version;
  db.close();
}

console.log('---- db-check 结果 ----');
console.log(JSON.stringify({ ...result, stats }, null, 2));

const checks = [
  ['schema 版本 = 最新', stats.schema_version >= 1],
  ['别名写入', result.aliasWritten],
  ['重启后别名恢复', result.aliasRestored],
  ['设备状态行数 > 0', stats.devices > 0],
  ['状态转移日志 ≥ 2（首次记录 + 变化）', stats.device_status_log >= 2],
  ['重启后 firstSeen 恢复', result.deviceRows === 0 || result.firstSeenRestored > 0],
  ['告警实时落库 + 重启恢复', result.alarmRestored],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}
console.log(`---- db-check ${failed === 0 ? '全部通过' : `${failed} 项失败`} ----`);
process.exit(failed === 0 ? 0 : 1);
