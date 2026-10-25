/**
 * 长跑取证入口（纯 Node，无 electron）。
 *
 * 用途：验证两条 P1 修复在**真实时间轴**上成立——
 *   1) DEVICE_NEW 产生后保持 active，至少 90s 内不被自动 resolved，且不存在"同毫秒批量 resolved"；
 *   2) 启动 60s 后不存在"样本不足导致的 degraded"（质量窗口只由 15s `ping -n 4` 填充）。
 *
 * 除真实设备长跑外，另用注入时钟驱动 AlarmEngine 做一次确定性生命周期检查
 * （ack 提前收尾 / TTL 10 分钟到期收尾），不依赖网段里恰好有新设备上线。
 */
import os from 'node:os';
import path from 'node:path';
import type { BandwidthStat, Device, NetQuality, Snapshot } from '../../shared/types';
import { NEW_DEVICE_TTL_MS } from '../../shared/constants';
import { AlarmEngine, ALARM_CODES } from './alarms';
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
  alarmCounts: { critical: number; warning: number; info: number };
  deviceNewActive: number;
  deviceNewResolved: number;
  /** resolvedAt 相同的告警里，单毫秒内被同批恢复的最大条数（>1 即视为批量恢复） */
  maxSameMsResolved: number;
  degradedDetail: QualityOutlier[];
}

export interface NewDeviceLifecycle {
  /** 首轮 seed 产生的 DEVICE_NEW 条数（必须 0） */
  seededCreated: number;
  /** 第二轮新 MAC 产生的条数（必须 1） */
  created: number;
  /** 产生后第 3 轮仍 active 的条数（必须 1） */
  activeAfterNextRounds: number;
  /** 90s 后仍 active 的条数（必须 1） */
  activeAfter90s: number;
  /** 90s 后 counts().info（必须 1） */
  infoCountAfter90s: number;
  /** ack 后同一条告警是否已 resolved（必须 true） */
  ackedResolved: boolean;
  /** TTL 10 分钟到期后是否自动 resolved（必须 true） */
  ttlResolved: boolean;
  ttlResolvedAtDeltaMs: number | null;
  /** 生命周期内出现的同毫秒批量恢复条数（必须 0） */
  batchResolved: number;
}

export interface SoakResult {
  durationMs: number;
  samples: SoakSample[];
  final: Snapshot;
  finalQuality: QualityOutlier[];
  lifecycle: NewDeviceLifecycle;
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

function fakeDevice(ip: string, mac: string, at: number): Device {
  return {
    id: `dev-${ip}`,
    ip,
    mac,
    hostname: null,
    vendor: null,
    osHint: null,
    kind: 'unknown',
    state: 'online',
    firstSeen: at,
    lastSeen: at,
    openPorts: [],
    quality: idleQuality(),
    bandwidth: idleBandwidth(),
    rttHistory: [],
    isGateway: false,
    isSelf: false,
    displayName: null,
    ipConflict: false,
  };
}

/** 同毫秒批量恢复检测：按 resolvedAt 分组，取最大组内条数（排除单条）。 */
export function maxSameMsResolved(alarms: Snapshot['alarms']): number {
  const groups = new Map<number, number>();
  for (const alarm of alarms) {
    if (alarm.resolvedAt === null) continue;
    groups.set(alarm.resolvedAt, (groups.get(alarm.resolvedAt) ?? 0) + 1);
  }
  let max = 0;
  for (const count of groups.values()) if (count > max) max = count;
  return max;
}

/** 注入时钟的确定性检查：seed → 新 MAC → 保持 active → ack / TTL 收尾。 */
export function checkNewDeviceLifecycle(): NewDeviceLifecycle {
  const t0 = 1_700_000_000_000;
  const a = fakeDevice('192.168.2.10', 'aa-aa-aa-00-00-0a', t0);
  const b = fakeDevice('192.168.2.11', 'bb-bb-bb-00-00-0b', t0);
  const engine = new AlarmEngine(500, 0);
  const step = (devices: Device[], now: number) =>
    engine.evaluate({ devices, printers: [], printerReachable: new Map(), now });

  const seeded = step([a], t0);
  const created = step([a, b], t0 + 5_000);
  step([a, b], t0 + 10_000);
  const activeAfterNextRounds = engine
    .all()
    .filter((alarm) => alarm.code === ALARM_CODES.DEVICE_NEW && alarm.resolvedAt === null).length;
  step([a, b], t0 + 90_000);
  const newAlarms = engine.all().filter((alarm) => alarm.code === ALARM_CODES.DEVICE_NEW);
  const activeAfter90s = newAlarms.filter((alarm) => alarm.resolvedAt === null);
  const infoCountAfter90s = engine.counts().info;

  // 生命周期用独立引擎，避免 ack/TTL 影响上面的计数
  const ttlEngine = new AlarmEngine(500, 0);
  const ttlStep = (devices: Device[], now: number) =>
    ttlEngine.evaluate({ devices, printers: [], printerReachable: new Map(), now });
  ttlStep([a], t0);
  const ttlCreated = ttlStep([a, b], t0 + 5_000);
  const ttlAlarm = ttlCreated.created.find((alarm) => alarm.code === ALARM_CODES.DEVICE_NEW);
  ttlStep([a, b], t0 + 5_000 + NEW_DEVICE_TTL_MS - 1_000);
  // 立刻取值：Alarm 是可变对象，下一轮 resolved 后同一个引用会被改写
  const stillActiveResolvedAt = ttlAlarm
    ? ttlEngine.all().find((x) => x.id === ttlAlarm.id)?.resolvedAt ?? null
    : null;
  ttlStep([a, b], t0 + 5_000 + NEW_DEVICE_TTL_MS + 1_000);
  const expired = ttlAlarm ? ttlEngine.all().find((x) => x.id === ttlAlarm.id) : null;

  const ackEngine = new AlarmEngine(500, 0);
  ackEngine.evaluate({ devices: [a], printers: [], printerReachable: new Map(), now: t0 });
  const ackCreated = ackEngine.evaluate({ devices: [a, b], printers: [], printerReachable: new Map(), now: t0 + 5_000 });
  const ackTarget = ackCreated.created.find((alarm) => alarm.code === ALARM_CODES.DEVICE_NEW);
  if (ackTarget) ackEngine.ack(ackTarget.id, t0 + 20_000);
  const ackedAlarm = ackTarget ? ackEngine.all().find((x) => x.id === ackTarget.id) : null;

  const allLifecycleAlarms = [...engine.all(), ...ttlEngine.all(), ...ackEngine.all()];

  return {
    seededCreated: seeded.created.filter((alarm) => alarm.code === ALARM_CODES.DEVICE_NEW).length,
    created: created.created.filter((alarm) => alarm.code === ALARM_CODES.DEVICE_NEW).length,
    activeAfterNextRounds,
    activeAfter90s: activeAfter90s.length,
    infoCountAfter90s,
    ackedResolved: ackedAlarm != null && ackedAlarm.resolvedAt !== null && ackedAlarm.ackAt !== null,
    ttlResolved: expired != null && expired.resolvedAt !== null && stillActiveResolvedAt === null,
    ttlResolvedAtDeltaMs: expired?.resolvedAt != null ? expired.resolvedAt - expired.raisedAt : null,
    batchResolved: maxSameMsResolved(allLifecycleAlarms) > 1 ? maxSameMsResolved(allLifecycleAlarms) : 0,
  };
}

/**
 * 真实长跑：按时段采样快照，记录 degraded 台数 / 告警计数 / DEVICE_NEW 活跃数 / 批量恢复。
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
    const newAlarms = snapshot.alarms.filter((alarm) => alarm.code === ALARM_CODES.DEVICE_NEW);
    samples.push({
      elapsedMs: Date.now() - startedAt,
      degraded: snapshot.system.degraded,
      unknown: realDevices.filter((d) => d.quality.grade === 'unknown').length,
      alarmCounts: snapshot.system.alarmCounts,
      deviceNewActive: newAlarms.filter((alarm) => alarm.resolvedAt === null).length,
      deviceNewResolved: newAlarms.filter((alarm) => alarm.resolvedAt !== null).length,
      maxSameMsResolved: maxSameMsResolved(snapshot.alarms),
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

  return { durationMs: Date.now() - startedAt, samples, final, finalQuality, lifecycle: checkNewDeviceLifecycle() };
}
