/**
 * 带宽估算（**是估算，不是测量**，UI 必须标注）。
 *
 * 取数（Vera §6.C.1/§9.5 实测修正）：
 *  - 全网吞吐：`netstat -e`（103ms，`字节 rx tx` 两列差分 ×8 / 间隔秒 = bps）
 *  - 连接归集：`netstat -ano`（83ms），按远端 IP 聚合连接数占比分摊
 *  - 弃用 Get-NetTCPConnection（890ms）
 *  - **不与 Get-NetAdapterStatistics 混算**（实测汇总 tx 比单卡大 4 倍）
 *
 * 诚实边界：本机与 LAN 的 TCP 连接实测仅 4 条 → 绝大多数设备 share≈0，
 * 此时 `attributable=false`，UI 显示"无流量归集"而不是 0.0 Kbps。
 */
import type { BandwidthStat } from '../../../shared/types';
import { runGbkNative } from '../exec';
import { TIMEOUTS } from '../../../shared/constants';

export interface ByteCounters {
  rxBytes: number;
  txBytes: number;
  at: number;
}

export interface ConnRow {
  proto: string;
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  state: string;
  pid: number;
}

/** `字节  <rx>  <tx>`（中文）/ `Bytes  <rx>  <tx>`（英文） */
const RE_NETSTAT_E_BYTES = /^\s*(?:字节|Bytes)\s+(\d+)\s+(\d+)\s*$/m;
/** `  TCP  192.168.2.179:52344  192.168.2.170:445  ESTABLISHED  1234` */
export const RE_NETSTAT_CONN = /^\s*(TCP|UDP)\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)\s*$/i;

export function parseNetstatE(text: string): { rxBytes: number; txBytes: number } | null {
  const m = RE_NETSTAT_E_BYTES.exec(text);
  if (!m) return null;
  const rx = Number(m[1]);
  const tx = Number(m[2]);
  if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
  return { rxBytes: rx, txBytes: tx };
}

export function parseNetstatConnections(text: string): ConnRow[] {
  const rows: ConnRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = RE_NETSTAT_CONN.exec(line);
    if (!m) continue;
    const localIp = (m[2] ?? '').replace(/^\[|\]$/g, '');
    const remoteIp = (m[4] ?? '').replace(/^\[|\]$/g, '');
    rows.push({
      proto: (m[1] ?? '').toUpperCase(),
      localIp,
      localPort: Number(m[3]),
      remoteIp,
      remotePort: Number(m[5]),
      state: (m[6] ?? '').toUpperCase(),
      pid: Number(m[7]),
    });
  }
  return rows;
}

/** 纯函数：由两次计数器快照差分算 bps。间隔过小或无增量时返回 0（不猜）。 */
export function bpsFromDelta(
  prev: ByteCounters,
  curr: ByteCounters,
): { rxBps: number; txBps: number; intervalMs: number } {
  const intervalMs = curr.at - prev.at;
  if (intervalMs <= 0) return { rxBps: 0, txBps: 0, intervalMs: 0 };
  const rxDelta = Math.max(0, curr.rxBytes - prev.rxBytes);
  const txDelta = Math.max(0, curr.txBytes - prev.txBytes);
  const seconds = intervalMs / 1000;
  return {
    rxBps: Math.round((rxDelta * 8) / seconds),
    txBps: Math.round((txDelta * 8) / seconds),
    intervalMs,
  };
}

export async function readByteCounters(): Promise<ByteCounters | null> {
  const res = await runGbkNative('netstat', ['-e'], TIMEOUTS.netstat);
  if (res.spawnError) return null;
  const parsed = parseNetstatE(res.stdout);
  if (!parsed) return null;
  return { ...parsed, at: Date.now() };
}

export async function readConnections(): Promise<ConnRow[]> {
  const res = await runGbkNative('netstat', ['-ano'], TIMEOUTS.netstat);
  if (res.spawnError) return [];
  return parseNetstatConnections(res.stdout);
}

/** 纯函数：按远端 IP 聚合"与目标网段的有效连接数"。排除本机回环与自身地址。 */
export function aggregateLanConnections(
  rows: ConnRow[],
  prefix: string | null,
  selfIp: string | null,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.proto !== 'TCP') continue;
    if (row.state !== 'ESTABLISHED') continue;
    if (!prefix || !row.remoteIp.startsWith(prefix)) continue;
    if (row.remoteIp === selfIp) continue;
    if (row.remoteIp.startsWith('127.')) continue;
    out.set(row.remoteIp, (out.get(row.remoteIp) ?? 0) + 1);
  }
  return out;
}

export interface BandwidthSample {
  at: number;
  rxBps: number;
  txBps: number;
  /** 与目标网段的有效 TCP 连接总数（=0 时所有设备均不可归集） */
  lanConnections: number;
  perDevice: Map<string, number>;
  intervalMs: number;
  error: string | null;
}

/** 无流量归集时的诚实空值（attributable:false 明确告诉 UI 不要显示 0.0 Kbps）。 */
export function emptyBandwidth(): BandwidthStat {
  return { rxBps: 0, txBps: 0, share: 0, connections: 0, attributable: false, estimated: true };
}

/**
 * 带宽采样器：2s 一次。首次采样只建立基线（返回 0 且 attributable:false）。
 */
export class BandwidthMeter {
  private prev: ByteCounters | null = null;
  private last: BandwidthSample | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly prefix: string | null,
    private readonly selfIp: string | null,
  ) {}

  get lastSample(): BandwidthSample | null {
    return this.last;
  }

  async sample(): Promise<BandwidthSample> {
    const at = Date.now();
    const counters = await readByteCounters();
    const rows = await readConnections();
    const perDevice = aggregateLanConnections(rows, this.prefix, this.selfIp);
    let lanConnections = 0;
    for (const count of perDevice.values()) lanConnections += count;

    if (!counters) {
      this.lastError = 'netstat -e 解析失败';
      const sample: BandwidthSample = {
        at,
        rxBps: 0,
        txBps: 0,
        lanConnections,
        perDevice,
        intervalMs: 0,
        error: this.lastError,
      };
      this.last = sample;
      return sample;
    }

    let rxBps = 0;
    let txBps = 0;
    let intervalMs = 0;
    if (this.prev) {
      const delta = bpsFromDelta(this.prev, counters);
      rxBps = delta.rxBps;
      txBps = delta.txBps;
      intervalMs = delta.intervalMs;
    }
    this.prev = counters;
    this.lastError = null;

    const sample: BandwidthSample = {
      at,
      rxBps,
      txBps,
      lanConnections,
      perDevice,
      intervalMs,
      error: null,
    };
    this.last = sample;
    return sample;
  }

  /** 把全网吞吐按连接数占比摊到某台设备（估算，estimated 恒为 true）。 */
  statFor(ip: string): BandwidthStat {
    const sample = this.last;
    if (!sample) return emptyBandwidth();
    const connections = sample.perDevice.get(ip) ?? 0;
    const total = sample.lanConnections;
    if (total <= 0 || connections <= 0) {
      return { rxBps: 0, txBps: 0, share: 0, connections, attributable: false, estimated: true };
    }
    const share = connections / total;
    return {
      rxBps: Math.round(sample.rxBps * share),
      txBps: Math.round(sample.txBps * share),
      share: Math.round(share * 10000) / 10000,
      connections,
      attributable: true,
      estimated: true,
    };
  }
}
