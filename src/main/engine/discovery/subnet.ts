/**
 * 子网推导：只用 os.networkInterfaces()，不解析 ipconfig 文本（Vera §6.A.1）。
 * 排除 internal / vEthernet* / WSL / Loopback / 169.254.*，有默认路由的接口优先。
 * 一律按 /24 计算主机地址（254 个），非 /24 网段取所属 /24 块。
 */
import os from 'node:os';
import { runGbkNative } from '../exec';
import { TIMEOUTS } from '../../../shared/constants';

export interface SubnetInfo {
  /** 接口名（中文 Windows 下为「以太网」） */
  iface: string;
  /** 有效扫描网段，形如 192.168.2.0/24 */
  cidr: string;
  /** /24 前缀，形如 192.168.2. */
  prefix: string;
  /** 本机在该网段的地址 */
  address: string;
  netmask: string;
  /** 默认网关；无法确定时为 null（不猜） */
  gateway: string | null;
  /** 扫描目标主机地址（不含网络地址与广播地址） */
  hosts: string[];
}

export interface IfaceCandidate {
  iface: string;
  address: string;
  netmask: string;
}

export function isValidIpv4(ip: string): boolean {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  return ip.split('.').every((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/** 是否排除该接口（虚拟网卡 / 环回 / APIPA 链路本地）。 */
export function isExcludedIface(name: string, address: string, internal: boolean): boolean {
  if (internal) return true;
  if (address.startsWith('169.254.')) return true;
  const n = name.toLowerCase();
  return (
    n.includes('vethernet') ||
    n.includes('loopback') ||
    n.includes('wsl') ||
    n.includes('default switch') ||
    n.includes('bluetooth')
  );
}

/** 纯函数：从 networkInterfaces() 结果中筛出候选（供测试注入）。 */
export function listCandidates(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): IfaceCandidate[] {
  const out: IfaceCandidate[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      const family = String(info.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (isExcludedIface(name, info.address, info.internal)) continue;
      if (!isValidIpv4(info.address)) continue;
      out.push({ iface: name, address: info.address, netmask: info.netmask });
    }
  }
  return out;
}

function netmaskToPrefixLen(netmask: string): number {
  const parts = netmask.split('.').map(Number);
  let bits = 0;
  for (const p of parts) {
    if (!Number.isInteger(p) || p < 0 || p > 255) return 24;
    bits += p.toString(2).replace(/0/g, '').length;
  }
  return bits || 24;
}

/** 按 /24 切块：得到 "192.168.2." 这样的前缀。 */
export function to24Prefix(address: string): string {
  const parts = address.split('.');
  if (parts.length !== 4) return '';
  return `${parts[0]}.${parts[1]}.${parts[2]}.`;
}

export function buildHosts(prefix: string): string[] {
  const hosts: string[] = [];
  if (!prefix) return hosts;
  for (let i = 1; i <= 254; i += 1) hosts.push(`${prefix}${i}`);
  return hosts;
}

/**
 * 纯函数：选出主网段。preferredAddress 为默认路由所在接口地址，命中即胜出；
 * 否则按「私有地址优先级 + 接口名不像虚拟网卡」排序取第一个。
 */
export function pickSubnet(
  candidates: IfaceCandidate[],
  preferredAddress: string | null,
  gateway: string | null = null,
): SubnetInfo | null {
  if (candidates.length === 0) return null;
  let chosen: IfaceCandidate | undefined;
  if (preferredAddress) {
    chosen = candidates.find((c) => c.address === preferredAddress);
  }
  if (!chosen) {
    const scored = [...candidates].sort((a, b) => score(b) - score(a));
    chosen = scored[0];
  }
  if (!chosen) return null;
  const prefix = to24Prefix(chosen.address);
  const cidrPrefixLen = Math.min(netmaskToPrefixLen(chosen.netmask), 24);
  return {
    iface: chosen.iface,
    cidr: `${prefix}0/${cidrPrefixLen}`,
    prefix,
    address: chosen.address,
    netmask: chosen.netmask,
    gateway,
    hosts: buildHosts(prefix),
  };
}

function score(c: IfaceCandidate): number {
  let s = 0;
  if (c.address.startsWith('192.168.')) s += 30;
  else if (c.address.startsWith('10.')) s += 20;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(c.address)) s += 10;
  if (/以太网|ethernet|wi-?fi|无线|wlan/i.test(c.iface)) s += 5;
  return s;
}

const RE_DEFAULT_ROUTE =
  /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})/m;

/**
 * 读默认路由（`route print -4 0.0.0.0`，原生 exe + GBK 解码）。
 * 失败返回 null，不影响主流程。
 */
export async function readDefaultRoute(): Promise<{ gateway: string; ifaceAddress: string } | null> {
  try {
    const res = await runGbkNative('route', ['print', '-4', '0.0.0.0'], TIMEOUTS.netstat);
    const m = RE_DEFAULT_ROUTE.exec(res.stdout);
    if (!m) return null;
    const gateway = m[1] ?? '';
    const ifaceAddress = m[2] ?? '';
    if (!isValidIpv4(gateway) || !isValidIpv4(ifaceAddress)) return null;
    if (gateway === '0.0.0.0') return null;
    return { gateway, ifaceAddress };
  } catch {
    return null;
  }
}

/** 引擎入口：探测本机主网段。无可用接口时返回 null（上层降级为 demo）。 */
export async function detectSubnet(): Promise<SubnetInfo | null> {
  const candidates = listCandidates(os.networkInterfaces());
  const route = await readDefaultRoute();
  return pickSubnet(candidates, route?.ifaceAddress ?? null, route?.gateway ?? null);
}
