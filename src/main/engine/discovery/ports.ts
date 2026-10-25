/**
 * TCP 端口探测。只对候选设备（ARP 在位者）探测，禁止 254×10 全打（Vera §6.A.4）。
 * 单端口超时 700ms；每主机内端口并发；主机级令牌闸门控制总并发。
 */
import net from 'node:net';
import { PORT_CONNECT_TIMEOUT_MS, PRINTER_PORTS } from '../../../shared/constants';

export interface PortProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 单端口 connect 探活。失败（含超时、拒绝）一律返回 false，不抛异常。 */
export function probePort(ip: string, port: number, opts: PortProbeOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? PORT_CONNECT_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    if (opts.signal) {
      if (opts.signal.aborted) {
        socket.destroy();
        resolve(false);
        return;
      }
      opts.signal.addEventListener('abort', () => finish(false), { once: true });
    }
    try {
      socket.connect({ host: ip, port });
    } catch {
      finish(false);
    }
  });
}

/** 一台主机的全部端口（主机内并发）。返回开放端口升序数组。 */
export async function probePorts(
  ip: string,
  ports: readonly number[],
  opts: PortProbeOptions = {},
): Promise<number[]> {
  const results = await Promise.all(
    ports.map(async (port) => ({ port, open: await probePort(ip, port, opts) })),
  );
  return results
    .filter((r) => r.open)
    .map((r) => r.port)
    .sort((a, b) => a - b);
}

/**
 * 多主机端口探测（主机级并发池）。
 * @param limit 同时探测的主机数，默认 24
 */
export async function probeHosts(
  targets: string[],
  ports: readonly number[],
  limit = 24,
  opts: PortProbeOptions = {},
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= targets.length) return;
      const ip = targets[idx];
      if (!ip) return;
      out.set(ip, await probePorts(ip, ports, opts));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, Math.max(targets.length, 1)) }, () => worker()),
  );
  return out;
}

export interface ReachabilityResult {
  reachable: boolean;
  /** 命中的第一个端口；全不通为 null */
  port: number | null;
  triedPorts: number[];
}

/**
 * 网络打印机探活：按 9100 → 631 → 515 顺序，任一通即在线。
 * 这是把 `.213` 从"spooler 假在线"纠正为 offline 的唯一依据。
 */
export async function probePrinterEndpoint(
  ip: string,
  ports: readonly number[] = PRINTER_PORTS,
  timeoutMs = PORT_CONNECT_TIMEOUT_MS,
): Promise<ReachabilityResult> {
  const tried: number[] = [];
  for (const port of ports) {
    tried.push(port);
    const ok = await probePort(ip, port, { timeoutMs });
    if (ok) return { reachable: true, port, triedPorts: tried };
  }
  return { reachable: false, port: null, triedPorts: tried };
}

/** 从开放端口推断是否是打印机（9100 / 631 / 515 任一）。 */
export function looksLikePrinter(openPorts: readonly number[]): boolean {
  return PRINTER_PORTS.some((p) => openPorts.includes(p));
}
