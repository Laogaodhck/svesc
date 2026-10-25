/**
 * 持续 Ping 监控（task-025）：用户指定的目标列表，独立 5s 一轮 ICMP 存活采样。
 *
 * 设计要点：
 *  - 目标配置持久化（store.watchList）；窗口/宕机统计是内存态（重启从空窗口开始，诚实）；
 *  - 每 tick 用 pingSweep 批量采样（与扫描共用子进程预算通道）；
 *  - 状态变迁（up↔down）时回调 onTransition，由 scheduler 接线到告警引擎
 *    （WATCH_DOWN 规则）并立即推帧；无样本（首轮未完成）不产生变迁（不猜）；
 *  - 样本不足时 state='unknown'，绝不把"还没采样"显示成"在线"。
 *
 * 本文件不 import electron，可被 vitest 在纯 Node 下直接导入。
 */
import { WATCH } from '../../shared/constants';
import { isValidIpv4 } from './store';
import { pingSweep } from './discovery/ping';
import type { WatchSample, WatchStatus, WatchTarget } from '../../shared/types';

export interface WatchManagerOptions {
  intervalMs?: number;
  windowSize?: number;
  pingTimeoutMs?: number;
  /** 状态变迁回调：down=true 进入宕机；false 恢复。首次从 unknown 变迁也回调。 */
  onTransition?: (down: boolean, target: WatchTarget) => void;
  /** 采样轮异常回调（写 netlog 用；周期任务失败必须可感知） */
  onError?: (message: string) => void;
}

/** 备注清洗：trim、去空、≤40 字符（与打印机手动条目一致）。 */
export function cleanWatchNote(note: string | null | undefined): string | null {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim();
  return trimmed ? trimmed.slice(0, 40) : null;
}

export class WatchManager {
  private targets = new Map<string, WatchTarget>();
  private windows = new Map<string, WatchSample[]>();
  private downSince = new Map<string, number | null>();
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private running = false;

  constructor(private readonly opts: WatchManagerOptions = {}) {}

  /** 恢复持久化目标列表（引擎启动时、start() 之前调用）。 */
  hydrate(targets: WatchTarget[]): void {
    this.targets.clear();
    for (const t of Array.isArray(targets) ? targets : []) {
      if (t && typeof t.ip === 'string' && isValidIpv4(t.ip)) {
        this.targets.set(t.ip, { ip: t.ip, addedAt: Number(t.addedAt) || Date.now(), note: cleanWatchNote(t.note) });
      }
    }
  }

  /** 目标配置列表（持久化用）。 */
  list(): WatchTarget[] {
    return Array.from(this.targets.values()).map((t) => ({ ...t }));
  }

  /** 添加目标：IP 非法拒绝；重复添加幂等（更新备注）。 */
  add(ip: string, note: string | null = null): { ok: boolean; error: string | null } {
    const trimmed = String(ip ?? '').trim();
    if (!isValidIpv4(trimmed)) return { ok: false, error: `IP 地址无效：${trimmed}` };
    const existing = this.targets.get(trimmed);
    if (existing) existing.note = cleanWatchNote(note);
    else this.targets.set(trimmed, { ip: trimmed, addedAt: Date.now(), note: cleanWatchNote(note) });
    return { ok: true, error: null };
  }

  /** 移除目标：移除同时清掉内存态窗口与宕机计时。 */
  remove(ip: string): { ok: boolean } {
    const trimmed = String(ip ?? '').trim();
    const existed = this.targets.delete(trimmed);
    this.windows.delete(trimmed);
    this.downSince.delete(trimmed);
    return { ok: existed };
  }

  /** 快照用状态视图（窗口按采样序旧→新）。 */
  status(): WatchStatus[] {
    const out: WatchStatus[] = [];
    for (const target of this.targets.values()) {
      const win = this.windows.get(target.ip) ?? [];
      const aliveCount = win.filter((s) => s.alive).length;
      const last = win.length > 0 ? win[win.length - 1] : undefined;
      out.push({
        ip: target.ip,
        addedAt: target.addedAt,
        note: target.note,
        window: win.map((s) => ({ ...s })),
        upPct: win.length > 0 ? Math.round((aliveCount / win.length) * 1000) / 10 : null,
        downSince: this.downSince.get(target.ip) ?? null,
        state: last ? (last.alive ? 'up' : 'down') : 'unknown',
      });
    }
    return out;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? WATCH.intervalMs);
    this.timer.unref?.();
    // 启动即补一轮（不用等 5s）
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 单轮采样 + 变迁检测。inFlight 闸门防重入（一轮未完不叠加）。 */
  async tick(): Promise<void> {
    if (this.tickInFlight || this.targets.size === 0) return;
    this.tickInFlight = true;
    try {
      const ips = Array.from(this.targets.keys());
      const sweep = await pingSweep(ips, {
        concurrency: 64,
        timeoutMs: this.opts.pingTimeoutMs ?? WATCH.pingTimeoutMs,
      });
      for (const target of this.targets.values()) {
        const result = sweep.results.get(target.ip);
        if (!result) continue; // 本轮未覆盖该目标（理论上不会）：不造样本
        this.record(target, result.alive, result.rttMs, Date.now());
      }
    } catch (err) {
      this.opts.onError?.(`监控采样轮异常：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.tickInFlight = false;
    }
  }

  /** 记录一个样本并检测变迁（独立方法便于单测直驱，不经过定时器）。 */
  private record(target: WatchTarget, alive: boolean, rttMs: number | null, at: number): void {
    const win = this.windows.get(target.ip) ?? [];
    win.push({ ts: at, alive, rttMs: alive ? rttMs : null });
    const size = this.opts.windowSize ?? WATCH.windowSize;
    if (win.length > size) win.splice(0, win.length - size);
    this.windows.set(target.ip, win);

    const wasDown = this.downSince.get(target.ip) ?? null;
    if (!alive) {
      // 宕机：downSince 为空说明这是宕机起始（或首个样本即宕机）→ 变迁
      if (wasDown === null) {
        this.downSince.set(target.ip, at);
        this.opts.onTransition?.(true, target);
      }
    } else if (wasDown !== null) {
      // 恢复：清掉宕机起始 → 变迁
      this.downSince.set(target.ip, null);
      this.opts.onTransition?.(false, target);
    }
  }
}
