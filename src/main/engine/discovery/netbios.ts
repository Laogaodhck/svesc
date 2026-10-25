/**
 * NetBIOS 名采集（task-020，设备识别增强的第二条腿）。
 *
 * 原理：Windows/设备开机后会在 NetBIOS 名表里登记机器名（`nbtstat -A <ip>` 可远查，
 * 无需目标安装任何东西）。大量设备禁 ping、无反向 DNS 记录，但有 NetBIOS 名——
 * 采集后回填 `rec.hostname`，**直接进入既有指纹管线的主机名正则**
 * （desktop/pc → workstation、camera → camera 等），零新规则复用全部既有判定。
 *
 * 约束：
 *  - 只对"ARP 在位且无主机名"的候选采集（有反查结果的不打扰）；
 *  - 每轮最多 NBTSTAT_MAX_HOSTS 台、并发 NBTSTAT_CONCURRENCY、单台 2s 超时——
 *    nbtstat 单次 0.5~2s，254 台全跑会把 phaseFingerprint 预算吃穿，轮转 cursor 均匀覆盖；
 *  - 任何异常静默跳过（增强路径，绝不拖垮扫描主流程）。
 */
import { spawn, type ChildProcess } from 'node:child_process';

/** 每轮最多采集的设备数（phaseFingerprint 预算内）。 */
export const NBTSTAT_MAX_HOSTS = 8;
export const NBTSTAT_CONCURRENCY = 4;
export const NBTSTAT_TIMEOUT_MS = 2000;

/**
 * 解析 `nbtstat -A <ip>` 输出的 NetBIOS 名表（纯函数，可单测）。
 * 规则：取第一条 `<00> Unique` 记录为机器名；没有 Unique（纯 Group）返回 null。
 */
export function parseNbtstat(stdout: string): { name: string | null } {
  if (!stdout) return { name: null };
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(.{1,15}?)\s{2,}<00>\s+Unique\s/i.exec(line);
    if (m) {
      const name = (m[1] ?? '').trim();
      if (name) return { name };
    }
  }
  return { name: null };
}

/**
 * 查询单台设备的 NetBIOS 机器名。超时/失败/无表返回 null。
 */
function queryOne(ip: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (name: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
      }
      resolve(name);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    let child: ChildProcess | undefined;
    try {
      child = spawn('nbtstat', ['-A', ip], { windowsHide: true });
    } catch {
      done(null);
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      // nbtstat 中文 Windows 输出为 GBK，但机器名本身是 ASCII；Latin1 保底不炸
      out += chunk.toString('latin1');
    });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (!settled) done(code === 0 ? parseNbtstat(out).name : null);
    });
  });
}

/**
 * 批量采集：并发受限 + 数量受限（轮转由调用方决定候选顺序）。
 * 返回 ip → NetBIOS 名（采集失败的 IP 不出现在结果里）。
 */
export async function queryNetbiosNames(ips: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = ips.slice(0, NBTSTAT_MAX_HOSTS);
  if (queue.length === 0) return out;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      const ip = queue[idx];
      if (!ip) return;
      const name = await queryOne(ip, NBTSTAT_TIMEOUT_MS);
      if (name) out.set(ip, name);
    }
  };
  await Promise.all(Array.from({ length: Math.min(NBTSTAT_CONCURRENCY, queue.length) }, () => worker()));
  return out;
}
