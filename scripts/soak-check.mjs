#!/usr/bin/env node
/**
 * 长跑取证：真实引擎跑 95s（>90s）+ 注入时钟的 DEVICE_NEW 生命周期检查。
 *
 * 用法：
 *   node scripts/soak-check.mjs                  # 默认 95s
 *   node scripts/soak-check.mjs --duration 120   # 自定义秒数
 *   LAN_SNMP=0 node scripts/soak-check.mjs       # 跳过 SNMP
 *
 * 产物：.agent-runs/2026-10-25/task-001/artifacts/soak-report.json
 * 退出码：全部断言 PASS → 0，否则 1。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const durationSec = Number(argValue('--duration', '95'));
const bundlePath = path.join(os.tmpdir(), `svesc-soak-${process.pid}.cjs`);
const outPath = path.join(root, '.agent-runs/2026-10-25/task-001/artifacts/soak-report.json');

await build({
  entryPoints: [path.join(root, 'src/main/engine/soak.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  outfile: bundlePath,
  logLevel: 'error',
});

const mod = await import(pathToFileURL(bundlePath).href);
const api = typeof mod.runSoak === 'function' ? mod : mod.default;

console.log(`================ soak-check (${durationSec}s) ================`);
const result = await api.runSoak({ durationMs: durationSec * 1000 });

try {
  fs.unlinkSync(bundlePath);
} catch {
  /* 清理失败无害 */
}

// —— 真实时间轴采样 ——
console.log('---- 采样（每 5s）----');
for (const s of result.samples) {
  const detail = s.degradedDetail.map((d) => `${d.ip}:${d.grade}/s=${d.samples}/loss=${d.lossPct.toFixed(1)}%`).join(' ');
  console.log(
    `  t+${String(Math.round(s.elapsedMs / 1000)).padStart(3)}s  degraded=${s.degraded}  unknown=${s.unknown}  ` +
      `info=${s.alarmCounts.info}  NEW(active/resolved)=${s.deviceNewActive}/${s.deviceNewResolved}  ` +
      `sameMs=${s.maxSameMsResolved}${detail ? `  [${detail}]` : ''}`,
  );
}

console.log('---- 最终质量分布 ----');
for (const q of result.finalQuality) {
  console.log(
    `  ${q.ip.padEnd(15)} ${q.grade.padEnd(9)} samples=${String(q.samples).padStart(2)} loss=${q.lossPct.toFixed(1)}% lat=${q.latencyMs ?? '-'}ms`,
  );
}

// —— 断言 ——
const late = result.samples.filter((s) => s.elapsedMs >= 60_000);
const lateDegraded = late.reduce((sum, s) => sum + s.degraded, 0);
const degradedFromTooFewSamples = late.flatMap((s) => s.degradedDetail).filter((d) => d.samples < 2).length;
const lc = result.lifecycle;

const checks = [
  ['lifecycle: 首轮 seed 不产生 DEVICE_NEW', lc.seededCreated === 0, `seededCreated=${lc.seededCreated}`],
  ['lifecycle: 第二轮新 MAC 产生 1 条', lc.created === 1, `created=${lc.created}`],
  ['lifecycle: 产生后第 3 轮仍 active', lc.activeAfterNextRounds === 1, `active=${lc.activeAfterNextRounds}`],
  ['lifecycle: 90s 后仍 active', lc.activeAfter90s === 1, `active=${lc.activeAfter90s}`],
  ['lifecycle: 90s 后 alarmCounts.info=1', lc.infoCountAfter90s === 1, `info=${lc.infoCountAfter90s}`],
  ['lifecycle: ack 后 resolved', lc.ackedResolved === true, `ackedResolved=${lc.ackedResolved}`],
  [
    'lifecycle: TTL 10min 自动 resolved',
    lc.ttlResolved === true && lc.ttlResolvedAtDeltaMs === 600_000,
    `resolved@+${lc.ttlResolvedAtDeltaMs}ms`,
  ],
  ['lifecycle: 无同毫秒批量恢复', lc.batchResolved === 0, `maxSameMs=${lc.batchResolved}`],
  ['soak: ≥60s 后无 degraded（真实丢包除外）', lateDegraded === 0, `degraded=${lateDegraded}`],
  ['soak: 无"样本不足导致的 degraded"', degradedFromTooFewSamples === 0, `samples<2 的 degraded=${degradedFromTooFewSamples}`],
];

console.log('---- 断言 ----');
let allPass = true;
for (const [label, pass, actual] of checks) {
  if (!pass) allPass = false;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(38, '.')} ${actual}`);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify({ durationMs: result.durationMs, lifecycle: lc, samples: result.samples, finalQuality: result.finalQuality }, null, 2),
  'utf8',
);
console.log(`\nsoak report → ${outPath}`);
process.exit(allPass ? 0 : 1);
