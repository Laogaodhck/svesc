/**
 * 每设备质量滑动窗口（最近 20 次探测）+ RTT 历史（最近 60 点）。
 *
 * 语义关键点（plan.md §5.1 第 4 条）：ARP 在位但 ICMP 全超时 → samples=0 → grade 'unknown'。
 * 因此窗口里记录"未响应"（rttMs=null）只影响丢包率，不产生任何"离线"结论，
 * 也不产生告警（禁止为 ICMP 不可达告警）。
 */
import type { NetQuality } from '../../../shared/types';
import { WINDOW } from '../../../shared/constants';
import { computeQuality } from './quality';

export interface ProbeSample {
  at: number;
  rttMs: number | null;
}

interface DeviceWindow {
  samples: ProbeSample[];
  rttHistory: number[];
  lastSampleAt: number | null;
}

export class QualityTracker {
  private windows = new Map<string, DeviceWindow>();

  constructor(
    private readonly sampleWindow = WINDOW.qualitySamples,
    private readonly historyLength = WINDOW.rttHistory,
  ) {}

  private window(ip: string): DeviceWindow {
    let w = this.windows.get(ip);
    if (!w) {
      w = { samples: [], rttHistory: [], lastSampleAt: null };
      this.windows.set(ip, w);
    }
    return w;
  }

  /** 记录一次探测结果（rttMs=null 表示未响应）。 */
  record(ip: string, rttMs: number | null, at = Date.now()): void {
    const w = this.window(ip);
    w.samples.push({ at, rttMs });
    if (w.samples.length > this.sampleWindow) w.samples.splice(0, w.samples.length - this.sampleWindow);
    w.lastSampleAt = at;
    if (rttMs !== null && Number.isFinite(rttMs)) {
      w.rttHistory.push(Math.round(rttMs * 10) / 10);
      if (w.rttHistory.length > this.historyLength) {
        w.rttHistory.splice(0, w.rttHistory.length - this.historyLength);
      }
    }
  }

  /** 一次 `ping -n 4` 采样（多个 RTT + 丢失包）。 */
  recordBatch(ip: string, rtts: number[], lost = 0, at = Date.now()): void {
    for (const rtt of rtts) this.record(ip, rtt, at);
    for (let i = 0; i < lost; i += 1) this.record(ip, null, at);
  }

  samples(ip: string): ProbeSample[] {
    return this.window(ip).samples.slice();
  }

  history(ip: string): number[] {
    return this.window(ip).rttHistory.slice();
  }

  lastSampleAt(ip: string): number | null {
    return this.window(ip).lastSampleAt;
  }

  /** 当前窗口 → NetQuality（公式见 quality.ts）。 */
  quality(ip: string): NetQuality {
    const w = this.windows.get(ip);
    if (!w || w.samples.length === 0) {
      return computeQuality({ latencyMs: null, jitterMs: null, packetLossPct: 0, samples: 0 });
    }
    const rtts = w.samples.map((s) => s.rttMs).filter((v): v is number => v !== null);
    const samples = rtts.length;
    const winsize = w.samples.length;
    const packetLossPct = winsize === 0 ? 0 : ((winsize - samples) / winsize) * 100;
    const latencyMs = samples === 0 ? null : Math.round((rtts.reduce((a, b) => a + b, 0) / samples) * 10) / 10;
    let jitterMs: number | null = null;
    if (rtts.length >= 2) {
      let acc = 0;
      for (let i = 1; i < rtts.length; i += 1) {
        acc += Math.abs((rtts[i] as number) - (rtts[i - 1] as number));
      }
      jitterMs = Math.round((acc / (rtts.length - 1)) * 10) / 10;
    }
    return computeQuality({ latencyMs, jitterMs, packetLossPct, samples });
  }

  reset(ip?: string): void {
    if (ip) this.windows.delete(ip);
    else this.windows.clear();
  }
}
