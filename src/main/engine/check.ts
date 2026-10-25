/**
 * engine-check 的纯 Node 入口（不含 electron）。
 *
 * 由 `scripts/engine-check.mjs` 用 esbuild 打成单个 CJS 后 require 执行：
 * 这是 Vic 在没有 GUI 的情况下验证探测能力的唯一入口，也是"引擎真的能扫到东西"的证据来源。
 */
import os from 'node:os';
import path from 'node:path';
import type { Snapshot } from '../../shared/types';
import { createEngine, type Engine } from './index';
import type { ScanTimings } from './scheduler';

export interface PhaseTiming {
  label: string;
  ms: number;
}

export interface EngineCheckResult {
  snapshot: Snapshot;
  subnet: string | null;
  phases: PhaseTiming[];
  timings: ScanTimings | null;
  printerMs: number;
  totalMs: number;
  userDataDir: string;
}

export async function runEngineCheck(options: { userDataDir?: string } = {}): Promise<EngineCheckResult> {
  const userDataDir = options.userDataDir ?? path.join(os.tmpdir(), 'svesc-engine-check');
  const startedAt = Date.now();

  const engine: Engine = await createEngine({
    userDataDir,
    exportDir: userDataDir,
    // 真机验证必须走真实数据源；demo 只用于无网环境
    forceDemo: process.env.LAN_DEMO === '1',
    snmpEnabled: process.env.LAN_SNMP !== '0',
    useMdns: process.env.LAN_MDNS === '1',
    autoScanIntervalSec: 0,
  });

  // 带宽需要两次采样才有差分基线：只有一次（或无基线）时 rxBps/txBps 必须是 null，
  // 不能兜成 0（R-02）。放在扫描前，避免扫描期的进程拥塞污染采样间隔。
  await engine.scheduler.sampleBandwidth();
  await engine.scheduler.sampleBandwidth();

  const scanStart = Date.now();
  await engine.scheduler.runFullScan();
  const scanMs = Date.now() - scanStart;

  const printerStart = Date.now();
  await engine.scheduler.refreshPrinters();
  const printerMs = Date.now() - printerStart;

  const snapshot = engine.getSnapshot();
  const timings = engine.scheduler.lastTimings;

  const phases: PhaseTiming[] = [
    { label: 'arp(首次)', ms: timings?.arp1 ?? 0 },
    { label: 'ping(254@64)', ms: timings?.ping ?? 0 },
    { label: 'arp(复读)', ms: timings?.arp2 ?? 0 },
    { label: 'ports(候选)', ms: timings?.ports ?? 0 },
    { label: 'fingerprint/dns', ms: timings?.hostnames ?? 0 },
    { label: 'printers(spooler+探活)', ms: printerMs },
  ];

  engine.stop();

  return {
    snapshot,
    subnet: engine.subnetLabel,
    phases,
    timings,
    printerMs,
    totalMs: Date.now() - startedAt,
    userDataDir,
  };
}

export type { Snapshot };

/** 供 engine-check 从常量推导断言线（避免硬编码秒数）。 */
export { SCAN_BUDGET_MS } from '../../shared/constants';
