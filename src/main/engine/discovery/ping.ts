/**
 * ICMP 探测（质量采样，不是在线判定的主信号 —— plan.md §5.1）。
 *
 * 只用 `ping -n 1 -w 800 <ip>`（禁止 -n 4 做扫描，禁止 ping -a：单次 4.6s）。
 * 输出为 GBK 中文，正则照抄 investigation-report.md §3.3。
 * 解析失败绝不抛异常，返回 alive:false 并计入 parseWarning。
 */
import { runGbkNative } from '../exec';
import { TIMEOUTS, CONCURRENCY } from '../../../shared/constants';

export interface PingResult {
  ip: string;
  alive: boolean;
  rttMs: number | null;
  ttl: number | null;
  /** 输出明确表示超时/不可达 */
  timedOut: boolean;
  /** 输出无法解析（不影响判定，仅记录） */
  parseWarning: boolean;
  ms: number;
}

/** 回复行（中/英）：`来自 X 的回复: 字节=32 时间=3ms TTL=64`，时间可能是 `<1ms` */
export const RE_PING_REPLY =
  /(?:来自\s*(\S+)\s*的回复|Reply from\s*(\S+?))[:：]\s*(?:字节|bytes)\s*[=＝]\s*(\d+)\s*(?:时间|time)\s*[=＝<＜]\s*(\d+)\s*ms\s*TTL\s*[=＝]\s*(\d+)/i;
/** 超时：`请求超时。` / `Request timed out.` */
export const RE_PING_TIMEOUT = /请求超时|Request timed out/i;
/** 统计：`已发送 = 1，已接收 = 1，丢失 = 0 (0% 丢失)` */
export const RE_PING_LOSS =
  /(?:已发送|Sent)\s*[=＝]\s*(\d+)[，,]\s*(?:已接收|Received)\s*[=＝]\s*(\d+)[，,]\s*(?:丢失|Lost)\s*[=＝]\s*(\d+)\s*\((\d+)%/i;
/** 平均 RTT：`平均 = 3ms` */
export const RE_PING_AVG = /(?:平均|Average)\s*[=＝]\s*(\d+)\s*ms/i;
/** `<1ms` 变体：按 Vera 建议记 0，避免抖动计算失真 */
const RE_PING_SUB_MS = /(?:时间|time)\s*[<＜]\s*\d+\s*ms/i;

/**
 * 纯函数：解析 `ping -n 1` 输出。
 * 判定优先级：exitCode===0 或命中回复行 → alive；命中超时字样 → dead。
 */
export function parsePingOutput(ip: string, text: string, exitCode: number | null): PingResult {
  const reply = RE_PING_REPLY.exec(text);
  const timedOut = RE_PING_TIMEOUT.test(text);
  if (reply) {
    const ttl = Number(reply[5]);
    const raw = Number(reply[4]);
    const rttMs = RE_PING_SUB_MS.test(reply[0]) ? 0 : raw;
    return {
      ip,
      alive: true,
      rttMs: Number.isFinite(rttMs) ? rttMs : null,
      ttl: Number.isFinite(ttl) ? ttl : null,
      timedOut: false,
      parseWarning: false,
      ms: 0,
    };
  }
  if (exitCode === 0) {
    return {
      ip,
      alive: true,
      rttMs: null,
      ttl: null,
      timedOut: false,
      parseWarning: true,
      ms: 0,
    };
  }
  return {
    ip,
    alive: false,
    rttMs: null,
    ttl: null,
    timedOut,
    parseWarning: !timedOut,
    ms: 0,
  };
}

/** 纯函数：解析 `ping -n 4` 统计（丢包率 / 平均 RTT），供质量采样使用。 */
export function parsePingStats(text: string): { lossPct: number | null; avgRttMs: number | null; rtts: number[] } {
  const rtts: number[] = [];
  const globalRe = new RegExp(RE_PING_REPLY.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(text)) !== null) {
    const raw = Number(m[4]);
    rtts.push(RE_PING_SUB_MS.test(m[0]) ? 0 : raw);
  }
  const loss = RE_PING_LOSS.exec(text);
  const avg = RE_PING_AVG.exec(text);
  return {
    lossPct: loss ? Number(loss[4]) : null,
    avgRttMs: avg ? Number(avg[1]) : null,
    rtts,
  };
}

export async function pingHost(ip: string, timeoutMs: number = TIMEOUTS.ping): Promise<PingResult> {
  const started = Date.now();
  const res = await runGbkNative('ping', ['-n', '1', '-w', String(timeoutMs), ip], TIMEOUTS.pingKill);
  const parsed = parsePingOutput(ip, res.stdout, res.code);
  return {
    ...parsed,
    alive: parsed.alive && !res.spawnError,
    parseWarning: parsed.parseWarning || Boolean(res.spawnError),
    ms: Date.now() - started,
  };
}

export interface SweepOptions {
  concurrency?: number;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
  /** 判定整体超预算后提前收尾 */
  deadline?: number;
}

/** 并发 ping 扫描（令牌闸门在 exec.ts 里统一限流）。 */
export async function pingSweep(
  hosts: string[],
  opts: SweepOptions = {},
): Promise<{ results: Map<string, PingResult>; parseWarnings: number; ms: number }> {
  const started = Date.now();
  const concurrency = opts.concurrency ?? CONCURRENCY.pingSweep;
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.ping;
  const results = new Map<string, PingResult>();
  let parseWarnings = 0;
  let done = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= hosts.length) return;
      const ip = hosts[idx];
      if (!ip) return;
      if (opts.deadline && Date.now() > opts.deadline) {
        results.set(ip, {
          ip,
          alive: false,
          rttMs: null,
          ttl: null,
          timedOut: false,
          parseWarning: true,
          ms: 0,
        });
        parseWarnings += 1;
        done += 1;
        opts.onProgress?.(done, hosts.length);
        continue;
      }
      const r = await pingHost(ip, timeoutMs);
      if (r.parseWarning) parseWarnings += 1;
      results.set(ip, r);
      done += 1;
      opts.onProgress?.(done, hosts.length);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, Math.max(hosts.length, 1)) }, () => worker());
  await Promise.all(workers);
  return { results, parseWarnings, ms: Date.now() - started };
}

/** 质量采样：`ping -n 4 -w 800`，仅对 alive 主机、并发 ≤8（Vera §6.C.3）。 */
export async function pingQuality(ip: string, count = 4): Promise<{ lossPct: number | null; avgRttMs: number | null; rtts: number[] }> {
  const res = await runGbkNative(
    'ping',
    ['-n', String(count), '-w', String(TIMEOUTS.ping), ip],
    TIMEOUTS.pingKill * count,
  );
  return parsePingStats(res.stdout);
}
