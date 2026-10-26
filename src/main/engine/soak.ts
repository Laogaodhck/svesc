/**
 * 长跑取证入口（纯 Node，无 electron）。
 *
 * 用途：验证质量口径修复在**真实时间轴**上成立——
 *   启动 60s 后不存在"样本不足导致的 degraded"（质量窗口只由 15s `ping -n 4` 填充）。
 */
import os from 'node:os';
import path from 'node:path';
import type { BandwidthStat, Device, NetQuality, Snapshot } from '../../shared/types';
import { createEngine } from './index';

export interface QualityOutlier {
  ip: string;
  grade: string;
  samples: number;
  lossPct: number;
  latencyMs: number | null;
}

export interface SoakSample {
  elapsedMs: number;
  degraded: number;
  unknown: number;
  degradedDetail: QualityOutlier[];
}

export interface SoakResult {
  durationMs: number;
  samples: SoakSample[];
  final: Snapshot;
  finalQuality: QualityOutlier[];
}

const idleQuality = (): NetQuality => ({
  latencyMs: null,
  jitterMs: null,
  packetLossPct: 0,
  score: 0,
  grade: 'unknown',
  samples: 0,
});

const idleBandwidth = (): BandwidthStat => ({
  rxBps: 0,
  txBps: 0,
  share: 0,
  connections: 0,
  attributable: false,
  estimated: false,
});

/**
 * 真实长跑：按时段采样快照，记录 degraded 台数 / unknown 台数。
 * 默认 95s，覆盖"≥90s"的验收窗口。
 */
export async function runSoak(options: { durationMs?: number; stepMs?: number; userDataDir?: string } = {}): Promise<SoakResult> {
  const durationMs = options.durationMs ?? 95_000;
  const stepMs = options.stepMs ?? 5_000;
  const userDataDir = options.userDataDir ?? path.join(os.tmpdir(), `svesc-soak-${Date.now()}`);
  const startedAt = Date.now();

  const engine = await createEngine({
    userDataDir,
    exportDir: userDataDir,
    forceDemo: process.env.LAN_DEMO === '1',
    snmpEnabled: process.env.LAN_SNMP !== '0',
    useMdns: process.env.LAN_MDNS === '1',
    autoScanIntervalSec: 60,
  });

  await engine.start();

  const samples: SoakSample[] = [];
  const takeSample = (): void => {
    const snapshot = engine.getSnapshot();
    const realDevices = snapshot.devices.filter((d) => !d.id.startsWith('sim-'));
    const degradedDevices = realDevices.filter((d) => d.state === 'degraded');
    samples.push({
      elapsedMs: Date.now() - startedAt,
      degraded: snapshot.system.degraded,
      unknown: realDevices.filter((d) => d.quality.grade === 'unknown').length,
      degradedDetail: degradedDevices.map((d) => ({
        ip: d.ip,
        grade: d.quality.grade,
        samples: d.quality.samples,
        lossPct: d.quality.packetLossPct,
        latencyMs: d.quality.latencyMs,
      })),
    });
  };

  takeSample();
  while (Date.now() - startedAt < durationMs) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, durationMs - (Date.now() - startedAt))));
    takeSample();
  }

  const final = engine.getSnapshot();
  const finalQuality: QualityOutlier[] = final.devices
    .filter((d) => !d.id.startsWith('sim-'))
    .map((d) => ({
      ip: d.ip,
      grade: d.quality.grade,
      samples: d.quality.samples,
      lossPct: d.quality.packetLossPct,
      latencyMs: d.quality.latencyMs,
    }));

  engine.stop();

  return { durationMs: Date.now() - startedAt, samples, final, finalQuality };
}
