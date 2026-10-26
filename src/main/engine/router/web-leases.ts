/**
 * 管理页会话的通用 DHCP 租约通道（task-030，**实验性**）。
 *
 * 背景：OpenWrt 走 ubus，其余品牌路由器经"内置浏览器登录"后在 Electron 分区里
 * 留下会话 Cookie。主进程把 Cookie 头注入引擎，本模块按候选页清单逐个尝试抓取
 * DHCP 客户端列表，用**品牌无关的 MAC 锚定解析**提取（主机名, MAC, IP）三元组。
 *
 * 实验性声明（数据诚实）：
 *  - 候选页路径基于 TP-LINK dynaform 系公开结构，**未经本机真机登录验证**；
 *  - 解析器按"MAC 是唯一可靠锚点"设计：MAC 格式跨品牌统一，主机名/IP 取
 *    同一行内相邻字段，任何解析失败都静默降级为"无租约"，绝不编造；
 *  - 抓不到时在 capabilityNotes 如实报告原因，不伪装成"无设备"。
 */
import type { DhcpLease, RouterBrand } from '../../../shared/types';
import { httpRequest } from './httpx';

/** 候选租约页（brand=null = 任意品牌兜底）。实验清单：实测验证后按真机增删。 */
export const WEB_LEASE_CANDIDATES: readonly { brand: RouterBrand | null; path: string; label: string }[] = [
  { brand: 'tplink', path: '/userRpm/DhcpSeartListRpm.htm', label: 'TP-LINK DHCP 客户端列表' },
  { brand: 'tplink', path: '/userRpm/DhcpClientsListRpm.htm', label: 'TP-LINK DHCP 客户端列表(新)' },
  { brand: 'tplink', path: '/userRpm/WlanStationRpm.htm', label: 'TP-LINK 无线客户端列表' },
  // task-032：市面常见品牌候选（路径为公开固件结构，未逐台真机验证——失败会在 note 如实列出）
  { brand: 'asus', path: '/dhcpLeaseList.asp', label: '华硕 DHCP 租约表' },
  { brand: 'asus', path: '/Main_DHCP_LEASES.asp', label: '华硕 DHCP 租约表(旧)' },
  { brand: 'netgear', path: '/DHCPTable.htm', label: 'NETGEAR DHCP 表' },
  { brand: 'netgear', path: '/dhcp_table.htm', label: 'NETGEAR DHCP 表(小写)' },
  { brand: 'xiaomi', path: '/cgi-bin/luci/admin/status/overview', label: '小米 luci 概览页' },
  { brand: 'huawei', path: '/html/ssmp/userinfo/lan_user_tree.asp', label: '华为/荣耀 LAN 用户表' },
  { brand: 'dlink', path: '/dhcp_table.htm', label: 'D-Link DHCP 表' },
  { brand: 'mercury', path: '/userRpm/DhcpSeartListRpm.htm', label: '水星 DHCP 客户端列表' },
  { brand: null, path: '/dhcp.htm', label: 'DHCP 列表(通用)' },
  { brand: null, path: '/dhcp_table.htm', label: 'DHCP 表(通用)' },
  { brand: null, path: '/DHCPTable.htm', label: 'DHCP 表(通用大写)' },
] as const;

/** 单次抓取的候选上限：超时 1s × 6 ≈ 6s 最坏路径，落在路由器 10s 轮询内不叠加。 */
export const WEB_LEASE_MAX_CANDIDATES = 6;

/** 单候选请求超时。4 候选最坏 ≈5s，发生在路由器 10s 轮询里，不进扫描预算。 */
export const WEB_LEASE_TIMEOUT_MS = 1200;
/** 解析结果上限（防御异常页面撑爆内存）。 */
export const WEB_LEASES_MAX = 512;

/** 低层传输：给定目标 URL 与请求头，返回 200 页面正文；非 200/失败返回 null。 */
export type WebLeaseTransport = (url: string, headers: Record<string, string>) => Promise<string | null>;

const RE_MAC = /\b([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5}|[0-9a-f]{4}(?:\.[0-9a-f]{4}){2})\b/i;
const RE_IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isMac(s: string): boolean {
  return RE_MAC.test(s);
}

function isIpv4(s: string): boolean {
  if (!RE_IPV4.test(s)) return false;
  return s.split('.').every((o) => Number(o) <= 255);
}

/** MAC 归一化（小写连字符），非法返回 null。 */
function normalizeMac(mac: string): string | null {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.replace(/([0-9a-f]{2})(?=[0-9a-f])/g, '$1-');
}

/** 从一行/一段字段序列里提取一条租约（纯函数）。顺序假设：主机名在 MAC 前、IP 在 MAC 后（TP-LINK/多数固件的表格布局）。 */
function leaseFromFields(fields: string[]): DhcpLease | null {
  const macIdx = fields.findIndex(isMac);
  if (macIdx < 0) return null;
  const mac = normalizeMac(fields[macIdx]);
  if (!mac) return null;
  const ip = fields.find((f, i) => i !== macIdx && isIpv4(f)) ?? null;
  if (!ip) return null;
  const hostname =
    fields.find(
      (f, i) =>
        i < macIdx &&
        !isMac(f) &&
        !isIpv4(f) &&
        f.trim() !== '' &&
        f.length <= 64 &&
        !/^\d+(?:[:\/-]\d+)+$/.test(f) &&
        !/^永久|infinite$/i.test(f),
    ) ?? null;
  // 页面抓取无法可靠解析租期（各品牌格式各异）：如实给 null，语义见类型注释
  return { ip, mac, hostname, expiresAt: null };
}

/** HTML 表格行 → 单元格文本序列（纯函数）。 */
function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const cells: string[] = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let t: RegExpExecArray | null;
    while ((t = tdRe.exec(m[1])) !== null) {
      cells.push((t[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').trim());
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** JS 字符串数组（TP-LINK dynaform 页的数据形态）→ 引号字符串平铺序列。 */
function quotedStrings(html: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const s = (m[1] ?? '').replace(/\\"/g, '"').trim();
    if (s !== '') out.push(s);
  }
  return out;
}

/** 平铺序列滑窗提取：每个 MAC 锚点取前一个字段为主机名、后一个为 IP。 */
function leasesFromFlatSequence(seq: string[]): DhcpLease[] {
  const out: DhcpLease[] = [];
  for (let i = 0; i < seq.length; i += 1) {
    if (!isMac(seq[i])) continue;
    const fields = [seq[i - 1] ?? '', seq[i], seq[i + 1] ?? ''];
    const lease = leaseFromFields(fields);
    if (lease) out.push(lease);
  }
  return out;
}

/**
 * 从任意管理页 HTML 提取 DHCP 租约（纯函数，品牌无关）。
 * 解析顺序：<tr> 表格行（含 MAC+IP 的行）→ 引号字符串平铺（JS 数组页）。
 * 无法确认的行一律丢弃——宁缺毋滥。
 */
export function parseLeasesFromHtml(html: string): DhcpLease[] {
  if (!html) return [];
  const out = new Map<string, DhcpLease>();
  for (const row of tableRows(html)) {
    const lease = leaseFromFields(row);
    if (lease && !out.has(lease.mac)) out.set(lease.mac, lease);
  }
  if (out.size === 0) {
    for (const lease of leasesFromFlatSequence(quotedStrings(html))) {
      if (!out.has(lease.mac)) out.set(lease.mac, lease);
    }
  }
  return Array.from(out.values()).slice(0, WEB_LEASES_MAX);
}

export interface WebLeaseResult {
  ok: boolean;
  leases: DhcpLease[];
  /** 供 capabilityNotes 的诚实文案；null = 无话可说（如未登录直接跳过） */
  note: string | null;
}

/**
 * 抓取管理页租约：按候选清单逐个尝试，首个解析出 ≥1 条租约的页面胜出。
 * TP-LINK 的防 DNS 重绑定（无会话 302 → tplogin.cn）用 Host 头覆写重试一次。
 * 任何异常都收敛为 ok:false + note，绝不抛出。
 */
export async function fetchWebLeases(options: {
  gateway: string;
  cookie: string;
  brand?: RouterBrand | null;
  transport?: WebLeaseTransport;
}): Promise<WebLeaseResult> {
  const { gateway, cookie, brand } = options;
  const transport: WebLeaseTransport =
    options.transport ??
    (async (url, headers) => {
      const u = new URL(url);
      const res = await httpRequest(url, {
        port: Number(u.port) || 80,
        path: u.pathname + u.search,
        timeoutMs: WEB_LEASE_TIMEOUT_MS,
        headers,
      });
      if (res.error || res.status !== 200) return null;
      return res.body;
    });

  const candidates = WEB_LEASE_CANDIDATES.filter((c) => c.brand === null || c.brand === (brand ?? null)).slice(
    0,
    WEB_LEASE_MAX_CANDIDATES,
  );
  const tried: string[] = [];
  for (const c of candidates) {
    const url = `http://${gateway}${c.path}`;
    const headers: Record<string, string> = { Cookie: cookie, Referer: `http://${gateway}/` };
    let body = await transport(url, headers).catch(() => null);
    // 防重绑定重试：302 → 本地域名（tplogin.cn 等）的固件要求 Host 为本地域名
    if (body === null) {
      body = await transport(url, { ...headers, Host: 'tplogin.cn' }).catch(() => null);
    }
    if (body === null) {
      tried.push(c.label);
      continue;
    }
    const leases = parseLeasesFromHtml(body);
    if (leases.length > 0) {
      return { ok: true, leases, note: `管理页租约（实验通道）：${leases.length} 条（${c.label}）` };
    }
    tried.push(`${c.label}(200 但无可解析租约)`);
  }
  // note 截断（task-032）：候选多了以后失败清单会淹没能力说明——只列前 3 条
  const shown = tried.slice(0, 3);
  const suffix = tried.length > shown.length ? ` 等 ${tried.length} 个候选页` : '';
  return {
    ok: false,
    leases: [],
    note: tried.length > 0 ? `管理页租约（实验通道）：未获取（${shown.join('；')}${suffix}）` : null,
  };
}
