#!/usr/bin/env node
/**
 * 纯 Node 驱动探测引擎跑一轮完整扫描（不启动 Electron）。
 *
 * 用法：
 *   node scripts/engine-check.mjs                       # 默认输出到 .agent-runs/.../artifacts/engine-snapshot.json
 *   node scripts/engine-check.mjs --out D:/tmp/snap.json
 *   LAN_SNMP=0 node scripts/engine-check.mjs            # 跳过 SNMP（更快）
 *
 * 退出码：devices.length > 0 && printers.length > 0 → 0，否则 1。
 * 实现方式：用 esbuild 把 src/main/engine/check.ts 打成单文件 CJS 再 require，
 * 因此引擎里的 TypeScript 不需要额外的 ts-node/tsx 依赖。
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

const outPath = path.resolve(
  argValue('--out', path.join(root, '.agent-runs/2026-10-25/task-001/artifacts/engine-snapshot.json')),
);
const bundlePath = path.join(os.tmpdir(), `svesc-engine-check-${process.pid}.cjs`);

const started = Date.now();

await build({
  entryPoints: [path.join(root, 'src/main/engine/check.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  outfile: bundlePath,
  logLevel: 'error',
});

const mod = await import(pathToFileURL(bundlePath).href);
const api = typeof mod.runEngineCheck === 'function' ? mod : mod.default;
const result = await api.runEngineCheck({
  userDataDir: path.join(os.tmpdir(), 'svesc-engine-check'),
});

try {
  fs.unlinkSync(bundlePath);
} catch {
  /* 临时文件清理失败无害 */
}

const { snapshot, phases, timings, subnet, printerMs, totalMs } = result;

console.log('================ engine-check ================');
console.log(`subnet        : ${subnet ?? '(未探测到可用网段)'}`);
console.log(`dataSource    : ${snapshot.dataSource}`);
console.log('---- 耗时分解 (ms) ----');
for (const phase of phases) {
  console.log(`  ${phase.label.padEnd(24, '.')} ${String(Math.round(phase.ms)).padStart(6)}`);
}
if (timings) {
  console.log(
    `  ${'≡ ping 存活 / ARP 条目 / 候选'.padEnd(24, '.')} ${timings.pingAlive} / ${timings.arpEntries} / ${timings.candidates}`,
  );
}
console.log(`  ${'≡ 扫描阶段合计'.padEnd(24, '.')} ${String(Math.round(timings?.total ?? 0)).padStart(6)}`);
console.log(`  ${'≡ printers 采集'.padEnd(24, '.')} ${String(Math.round(printerMs)).padStart(6)}`);
console.log(`  ${'≡ 进程总计'.padEnd(24, '.')} ${String(Math.round(totalMs || Date.now() - started)).padStart(6)}`);

console.log('---- 结果 ----');
console.log(`devices       : ${snapshot.devices.length}`);
console.log(`printers      : ${snapshot.printers.length}`);
console.log(`alarms        : ${snapshot.alarms.length}`);
console.log(`system        : online=${snapshot.system.online} offline=${snapshot.system.offline} degraded=${snapshot.system.degraded}`);

const realDevices = snapshot.devices.filter((d) => !d.id.startsWith('sim-'));
const unknownQuality = realDevices.filter((d) => d.quality.grade === 'unknown').length;
const notAttributable = realDevices.filter((d) => d.bandwidth.attributable === false).length;
console.log(`quality       : unknown=${unknownQuality}/${realDevices.length} (禁 ICMP 主机的真实体现)`);
console.log(`bandwidth     : 无流量归集 attributable=false → ${notAttributable}/${realDevices.length}`);

console.log('---- 设备（前 12 台）----');
for (const d of realDevices.slice(0, 12)) {
  console.log(
    `  ${d.ip.padEnd(15)} ${d.state.padEnd(8)} ${String(d.kind).padEnd(11)} ${(d.hostname ?? '-').padEnd(24)} mac=${d.mac ?? '-'} ports=[${d.openPorts.join(',')}] q=${d.quality.grade}`,
  );
}

console.log('---- 打印机 ----');
for (const p of snapshot.printers) {
  const lv = p.consumables.map((c) => `${c.kind}:${c.levelPct === null ? 'null' : `${c.levelPct}%`}`).join(' ') || '无数据';
  console.log(
    `  ${String(p.ip ?? '-').padEnd(15)} ${p.state.padEnd(8)} ${String(p.source).padEnd(8)} ${p.name} | jobs=${p.jobs.length} | ${lv}`,
  );
}

console.log('---- 告警 ----');
if (snapshot.alarms.length === 0) console.log('  (无)');
for (const a of snapshot.alarms) {
  console.log(`  [${a.severity}] ${a.code} → ${a.targetName} :: ${a.message}`);
}

const printerOffline = snapshot.alarms.filter((a) => a.code === 'PRINTER_OFFLINE');
// 预算口径全部从引擎常量推导：改 SCAN_BUDGET_MS 时断言线自动联动，不写死数字
const budget = mod.SCAN_BUDGET_MS ?? 10_000;
const phaseMs = (name) => phases.find((p) => p.label === name)?.ms ?? Number.POSITIVE_INFINITY;
const checks = [];
const assert = (name, value, limit) => {
  const pass = value <= limit;
  checks.push({ name, pass });
  console.log(`  ${name.padEnd(24, '.')} ${pass ? 'PASS' : 'FAIL'} (${Math.round(value)} ≤ ${limit})`);
};
const tripwire = (name, value, limit) => {
  const pass = value <= limit;
  checks.push({ name, pass, tripwire: true });
  console.log(`  ${name.padEnd(24, '.')} ${pass ? 'PASS' : 'FAIL'} (${Math.round(value)} ≤ ${limit}) [Tripwire 不计入退出码]`);
};

console.log('---- 断言 ----');
console.log(`  devices > 0            : ${snapshot.devices.length > 0 ? 'PASS' : 'FAIL'}`);
console.log(`  printers > 0           : ${snapshot.printers.length > 0 ? 'PASS' : 'FAIL'}`);
console.log(`  PRINTER_OFFLINE 产生   : ${printerOffline.length > 0 ? `PASS (${printerOffline.map((a) => a.targetName).join(', ')})` : 'FAIL(无离线打印机)'}`);
assert('扫描 ≤ 预算+2.5s', timings?.total ?? Number.POSITIVE_INFINITY, budget + 2500);
tripwire('ping ≤ 预算+1.5s', phaseMs('ping(254@64)'), budget + 1500);
// task-023：指纹阶段现在并行跑 4 路增强（mDNS 1s / WS-Discovery 1.2s / SSDP 1.5s+0.6s 描述页 / nbtstat ≤2s），
// 并行总耗时上限 ≈2.1s，旅标随之从 1.6s 调到 2.6s（仍远小于扫描预算的 1/4）
tripwire('hostnames ≤ 2.6s', phaseMs('fingerprint/dns'), 2600);
console.log(`  设备必备键齐全         : ${realDevices.every(hasRequiredKeys) ? 'PASS' : 'FAIL'}`);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');
console.log(`\nsnapshot → ${outPath}`);

function hasRequiredKeys(device) {
  const keys = ['ip', 'mac', 'hostname', 'osHint', 'quality', 'bandwidth', 'openPorts'];
  return keys.every((k) => Object.prototype.hasOwnProperty.call(device, k));
}

const hardFailed = checks.filter((c) => !c.pass && !c.tripwire).length > 0;
const ok =
  snapshot.devices.length > 0 && snapshot.printers.length > 0 && !hardFailed;
process.exit(ok ? 0 : 1);
