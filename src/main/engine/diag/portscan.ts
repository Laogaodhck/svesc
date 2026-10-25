/**
 * 自定义端口范围扫描器（task-025，诊断中心）。
 *
 * 约束（诚实 + 可控）：
 *  - 范围 1-65535，单次上限 WATCH.portScanMaxPorts（1024）端口，超出如实拒绝；
 *  - net.connect 探测，开放 = 可建立 TCP 连接；失败/超时 = 关闭（不区分 filtered，
 *    UI 文案已注明"TCP 可连接"口径）；
 *  - 目标先过 validateDiagTarget（与诊断中心同一白名单），失败返回 error。
 *
 * 本文件不 import electron，可被 vitest 在纯 Node 下直接导入。
 */
import net from 'node:net';
import { WATCH } from '../../../shared/constants';
import type { PortScanResult } from '../../../shared/types';
import { validateDiagTarget } from './netdiag';

export interface PortScanOptions {
  concurrency?: number;
  timeoutMs?: number;
}

/** 单端口 TCP 探测：可连接 = 开放。绝不抛。 */
function probePort(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (open: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    try {
      sock.connect(port, ip);
    } catch {
      done(false);
    }
  });
}

/**
 * 扫描 [from, to] 闭区间的 TCP 端口。
 * 返回 PortScanResult：参数非法 / 校验失败时 ok:false + error；其余如实汇报。
 */
export async function scanPortRange(
  ip: string,
  from: number,
  to: number,
  opts: PortScanOptions = {},
): Promise<PortScanResult> {
  const startedAt = Date.now();
  const fail = (error: string): PortScanResult => ({
    ok: false,
    ports: [],
    openPorts: [],
    durationMs: Date.now() - startedAt,
    error,
  });

  const target = String(ip ?? '').trim();
  const check = validateDiagTarget('ports', target);
  if (!check.ok) return fail(check.error ?? '目标校验未通过');
  const f = Math.trunc(Number(from));
  const t = Math.trunc(Number(to));
  if (!Number.isFinite(f) || !Number.isFinite(t) || f < 1 || t > 65535 || f > t) {
    return fail('端口范围无效（需 1-65535 且起 ≤ 止）');
  }
  const count = t - f + 1;
  if (count > WATCH.portScanMaxPorts) {
    return fail(`单次最多扫描 ${WATCH.portScanMaxPorts} 个端口（当前 ${count} 个），请缩小范围`);
  }

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 64, 256));
  const timeoutMs = Math.max(50, Math.min(opts.timeoutMs ?? 700, 5000));
  const ports: number[] = [];
  for (let p = f; p <= t; p += 1) ports.push(p);

  const openSet = new Set<number>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      const port = ports[idx];
      if (port === undefined) return;
      if (await probePort(target, port, timeoutMs)) openSet.add(port);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, () => worker()));
  } catch (err) {
    return fail(`扫描执行异常：${err instanceof Error ? err.message : String(err)}`);
  }

  const resultPorts = ports.map((port) => ({ port, open: openSet.has(port) }));
  const openPorts = ports.filter((p) => openSet.has(p));
  return {
    ok: true,
    ports: resultPorts,
    openPorts,
    durationMs: Date.now() - startedAt,
    error: null,
  };
}
