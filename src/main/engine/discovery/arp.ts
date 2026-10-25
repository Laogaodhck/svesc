/**
 * ARP 表读取（在线判定的主信号，plan.md §5.1 第 2 条）。
 *
 * 主路径：直接 spawn `arp -a` + GB18030 解码（实测 83-90ms，中文表头正确）。
 * 回退：Get-NetNeighbor（JSON，UTF-8），过滤 Unreachable / 全零 MAC。
 * 正则与过滤规则照抄 investigation-report.md §3.1/§3.2（已在本机中文 Windows 验证）。
 */
import { runGbkNative, runPowerShell, psJsonCommand, parsePsJson } from '../exec';
import { TIMEOUTS } from '../../../shared/constants';
import { normalizeMac } from './oui';

export interface ArpEntry {
  ip: string;
  mac: string;
  iface: string | null;
}

export interface ArpScanResult {
  entries: Map<string, ArpEntry>;
  raw: string;
  ms: number;
  /** 主路径解析出 0 条时视为一次解析告警（不抛异常） */
  parseWarning: boolean;
  source: 'arp' | 'neighbor' | 'none';
  error: string | null;
  /**
   * 同一 IP 解析出多个不同 MAC（task-017 侦测增强）。
   * 典型成因：IP 地址手工配置冲突、ARP 欺骗/中间人。空数组 = 本轮无冲突。
   */
  conflicts: ArpConflict[];
}

/** 同 IP 多 MAC 的冲突记录（macs 已按解析顺序去重）。 */
export interface ArpConflict {
  ip: string;
  macs: string[];
}

/**
 * 纯函数：从逐行解析结果里找"同一 IP 对应多个不同 MAC"。
 * 多网卡同条目（同 IP 同 MAC 重复行）不算；只有 MAC 真的分歧才算冲突。
 */
export function collectArpConflicts(entries: ArpEntry[]): ArpConflict[] {
  const byIp = new Map<string, Set<string>>();
  for (const e of entries) {
    let macs = byIp.get(e.ip);
    if (!macs) {
      macs = new Set<string>();
      byIp.set(e.ip, macs);
    }
    macs.add(e.mac);
  }
  const out: ArpConflict[] = [];
  for (const [ip, macs] of byIp) {
    if (macs.size > 1) out.push({ ip, macs: Array.from(macs) });
  }
  return out;
}

/** 段头：`接口: 192.168.2.179 --- 0x5` / `Interface: ...` */
const RE_ARP_IFACE = /^\s*(?:接口|Interface)\s*:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*---\s*(0x[0-9a-f]+)\s*$/i;
/** 行：`192.168.2.1  e4-67-1e-12-68-a9  动态` */
const RE_ARP_LINE = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+(\S+)\s*$/i;

/** 组播 / 广播 / 保留地址过滤。 */
export function isSkippableArpIp(ip: string): boolean {
  return (
    ip.startsWith('224.') ||
    ip.startsWith('239.') ||
    ip.startsWith('255.') ||
    ip.endsWith('.255') ||
    ip.endsWith('.0') ||
    ip === '255.255.255.255'
  );
}

function isBogusMac(mac: string): boolean {
  const m = normalizeMac(mac);
  return m === 'ff-ff-ff-ff-ff-ff' || m === '00-00-00-00-00-00';
}

/**
 * 纯函数：解析 `arp -a` 文本。
 * @param prefix 目标网段前缀（如 `192.168.2.`）；给定时只保留该网段条目，避免 172.x 虚拟网卡污染
 */
export function parseArp(
  text: string,
  prefix: string | null = null,
): { entries: ArpEntry[]; parseWarning: boolean; warnings: string[] } {
  const entries: ArpEntry[] = [];
  const warnings: string[] = [];
  let iface: string | null = null;
  let sawIfaceHeader = false;
  let lineLooksLikeTableRow = 0;

  for (const line of text.split(/\r?\n/)) {
    const ifaceMatch = RE_ARP_IFACE.exec(line);
    if (ifaceMatch) {
      iface = ifaceMatch[1] ?? null;
      sawIfaceHeader = true;
      continue;
    }
    const m = RE_ARP_LINE.exec(line);
    if (!m) {
      // 表头行（Internet 地址 / 物理地址 / 类型）不含数字 IP，忽略
      if (/\d{1,3}(?:\.\d{1,3}){3}/.test(line)) lineLooksLikeTableRow += 1;
      continue;
    }
    const ip = m[1] ?? '';
    const mac = normalizeMac(m[2] ?? '');
    if (!ip || !mac) continue;
    if (isSkippableArpIp(ip)) continue;
    if (isBogusMac(mac)) continue;
    if (prefix && !ip.startsWith(prefix)) continue;
    entries.push({ ip, mac, iface: iface ?? null });
  }

  // 有像样的行但一条都没解析出来 → 视为解析失败（例如编码错位）
  const parseWarning = entries.length === 0 && (lineLooksLikeTableRow > 0 || sawIfaceHeader);
  if (parseWarning) warnings.push('arp 文本存在表格行但未解析出有效条目（疑似编码或 locale 不匹配）');
  return { entries, parseWarning, warnings };
}

interface NeighborRow {
  IPAddress?: string;
  LinkLayerAddress?: string;
  State?: string;
  InterfaceAlias?: string;
}

/** 纯函数：解析 Get-NetNeighbor JSON 行（回退路径，带 Unreachable 过滤）。 */
export function parseNeighborRows(rows: NeighborRow[], prefix: string | null = null): ArpEntry[] {
  const out: ArpEntry[] = [];
  for (const row of rows) {
    // State 在部分 PowerShell 版本里被序列化成枚举数字（如 3/4），不能直接 .toLowerCase()
    const ip = String(row.IPAddress ?? '');
    const macRaw = String(row.LinkLayerAddress ?? '');
    const state = String(row.State ?? '').toLowerCase();
    if (!ip || !/^[0-9a-f]{2}(?:[-:][0-9a-f]{2}){5}$/i.test(macRaw)) continue;
    if (state === 'unreachable' || state === 'permanent') continue;
    const mac = normalizeMac(macRaw);
    if (isBogusMac(mac)) continue;
    if (isSkippableArpIp(ip)) continue;
    if (prefix && !ip.startsWith(prefix)) continue;
    out.push({ ip, mac, iface: row.InterfaceAlias ?? null });
  }
  return out;
}

/** 读 ARP 表：主路径 arp -a，解析空则回退 Get-NetNeighbor。 */
export async function readArp(prefix: string | null = null): Promise<ArpScanResult> {
  const started = Date.now();
  const res = await runGbkNative('arp', ['-a'], TIMEOUTS.arp);
  if (!res.spawnError && res.stdout.trim()) {
    const parsed = parseArp(res.stdout, prefix);
    if (parsed.entries.length > 0) {
      const entries = new Map<string, ArpEntry>();
      for (const e of parsed.entries) entries.set(e.ip, e);
      return {
        entries,
        raw: res.stdout,
        ms: Date.now() - started,
        parseWarning: false,
        source: 'arp',
        error: null,
        conflicts: collectArpConflicts(parsed.entries),
      };
    }
  }

  // 回退：Get-NetNeighbor（结构化，但耗时约 890ms，且含 Unreachable 假条目）
  try {
    const { stdout } = await runPowerShell(
      psJsonCommand(
        "Get-NetNeighbor -AddressFamily IPv4 | Where-Object { $_.State -ne 'Unreachable' -and $_.State -ne 'Permanent' } | Select-Object IPAddress,LinkLayerAddress,State,InterfaceAlias",
      ),
    );
    const { items, error } = parsePsJson<NeighborRow>(stdout);
    const rows = parseNeighborRows(items, prefix);
    const entries = new Map<string, ArpEntry>();
    for (const e of rows) entries.set(e.ip, e);
    return {
      entries,
      raw: res.stdout,
      ms: Date.now() - started,
      parseWarning: entries.size === 0,
      source: entries.size > 0 ? 'neighbor' : 'none',
      error: error ?? res.spawnError,
      conflicts: collectArpConflicts(rows),
    };
  } catch (err) {
    return {
      entries: new Map(),
      raw: res.stdout,
      ms: Date.now() - started,
      parseWarning: true,
      source: 'none',
      error: err instanceof Error ? err.message : String(err),
      conflicts: [],
    };
  }
}

/** 由 MAC 反查 IP（用于 WSD 端口的打印机：名称里带 MAC，端口无 IP）。 */
export function findIpByMac(entries: Map<string, ArpEntry>, mac: string | null): string | null {
  if (!mac) return null;
  const target = normalizeMac(mac);
  for (const [ip, entry] of entries) {
    if (entry.mac === target) return ip;
  }
  return null;
}
