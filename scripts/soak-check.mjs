#!/usr/bin/env node
/**
 * 长跑取证：真实引擎跑 95s（>90s），验证质量口径在真实时间轴上成立。
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
    `  t+${String(Math.round(s.elapsedMs / 1000)).padStart(3)}s  degraded=${s.degraded}  unknown=${s.unknown}` +
      `${detail ? `  [${detail}]` : ''}`,
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

const checks = [
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
  JSON.stringify({ durationMs: result.durationMs, samples: result.samples, finalQuality: result.finalQuality }, null, 2),
  'utf8',
);
console.log(`\nsoak report → ${outPath}`);
process.exit(allPass ? 0 : 1);
