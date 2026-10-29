/**
 * 管理页会话的通用 DHCP 租约通道（实验性）。
 * 候选页未经逐台真机验证；解析失败如实报告，不伪造成功的空租约表。
 */
import type { DhcpLease, RouterBrand } from '../../../shared/types';
import { httpRequest } from './httpx';
import { normalizeDhcpLeases, normalizeLeaseHostname, normalizeLeaseMac } from './leases';

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

export const WEB_LEASE_MAX_CANDIDATES = 6;
/** Cookie 获取、所有候选与 Host 重试共用的总预算。 */
export const WEB_LEASE_TOTAL_BUDGET_MS = 6000;
export const WEB_LEASE_TIMEOUT_MS = 1200;
export const WEB_LEASES_MAX = 512;

export type WebLeaseTransport = (url: string, headers: Record<string, string>) => Promise<string | null>;

function isIpv4(value: string): boolean {
  return /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) &&
    value.split('.').every((part) => Number(part) <= 255);
}

/** 无列定义时宁可缺名：排除序号、租期、地址，多个候选也不猜。 */
function inferredHostname(fields: string[]): string | null {
  const candidates = fields.map(normalizeLeaseHostname).filter((name): name is string =>
    name !== null && !normalizeLeaseMac(name) && !isIpv4(name) &&
    !/^\d+(?:[.:/\-]\d+)*$/.test(name) &&
    !/^(?:永久|无限|infinite|infinity|permanent|forever|never)$/i.test(name) &&
    !/^(?:\d+(?:\.\d+)?\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms]|天|小时|时|分钟|分|秒)\s*)+$/i.test(name),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function leaseFromFields(fields: string[], hostnameColumn?: number): DhcpLease | null {
  const macColumns = fields.flatMap((field, index) => normalizeLeaseMac(field) ? [index] : []);
  const ips = fields.filter(isIpv4);
  if (macColumns.length !== 1 || ips.length !== 1) return null;
  const macColumn = macColumns[0];
  const hostname = hostnameColumn === undefined
    ? inferredHostname(fields.slice(0, macColumn))
    : normalizeLeaseHostname(fields[hostnameColumn]);
  return { ip: ips[0], mac: fields[macColumn], hostname, expiresAt: null };
}

/** 解码一次，拒绝非法码点；不把解码后的文本再次当 HTML 解释。 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity: string, key: string) => {
    if (!key.startsWith('#')) return named[key.toLowerCase()];
    const hex = key[1].toLowerCase() === 'x';
    const point = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : '\u0000';
  });
}

const HEADER_NAME = /^(?:host(?:name)?|client(?:name|hostname)?|device(?:name|hostname)?|computername|主机(?:名|名称)|客户端(?:名|名称)|设备(?:名|名称)|计算机(?:名|名称))$/i;
const HEADER_ADDRESS = /^(?:mac(?:address)?|ip(?:v4)?(?:address)?|mac地址|ip地址|物理地址)$/i;

function tableLeases(html: string): DhcpLease[] {
  const leases: DhcpLease[] = [];
  let hostnameColumn: number | undefined;
  // 表头仅作用于本表，不将脚本字符串里的伪 HTML 当作表格。
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const rows = /<\/?table\b[^>]*>|<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  for (const row of markup.matchAll(rows)) {
    if (row[1] === undefined) {
      hostnameColumn = undefined;
      continue;
    }
    const cells = [...row[1].matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)];
    const fields = cells.map((cell) => decodeEntities(cell[2].replace(/<[^>]*>/g, ' ')).trim());
    const labels = fields.map((field) => field.replace(/[\s_\-:：]/g, ''));
    const header = cells.some((cell) => cell[1].toLowerCase() === 'h') ||
      labels.filter((label) => HEADER_ADDRESS.test(label)).length >= 2;
    if (header) {
      hostnameColumn = labels.findIndex((label) => HEADER_NAME.test(label));
      continue;
    }
    const lease = leaseFromFields(fields, hostnameColumn);
    if (lease) leases.push(lease);
  }
  return leases;
}

/** 解码 JS 字符串的明确转义；不执行 JS，也不接受表达式/模板插值。 */
function decodeJsString(token: string): string | null {
  if (!/^(?:"(?:[^"\\\r\n]|\\[^\r\n])*"|'(?:[^'\\\r\n]|\\[^\r\n])*')$/.test(token)) return null;
  let valid = true;
  const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\u0000', '\\': '\\', '"': '"', "'": "'", '/': '/' };
  const value = token.slice(1, -1).replace(/\\(u[\da-f]{4}|x[\da-f]{2}|[\s\S])/gi, (_match: string, escape: string) => {
    if (/^(?:u[\da-f]{4}|x[\da-f]{2})$/i.test(escape)) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    if (Object.prototype.hasOwnProperty.call(simple, escape)) return simple[escape];
    valid = false;
    return '';
  });
  return valid ? value : null;
}

/** 小型词法扫描器：数组边界与字符串/注释边界分离，绝不全页搜引号。 */
function scriptArrays(script: string): string[][] {
  const tokens = script.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\\r\n])+\/[a-z]*|[a-z_$][\w$]*|\S/gi) ?? [];
  const significant = tokens.filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
  const arrays: string[][] = [];
  for (let i = 0; i < significant.length; i += 1) {
    const constructor = significant[i] === 'new' && significant[i + 1] === 'Array' && significant[i + 2] === '(';
    const literal = significant[i] === '[' && (i === 0 || /^(?:=|\(|:|,|;|\[|\{|return)$/.test(significant[i - 1]));
    if (!constructor && !literal) continue;
    const start = i + (constructor ? 3 : 1);
    const stack = [constructor ? ')' : ']'];
    let end = start;
    let matched = true;
    for (; end < significant.length && stack.length > 0; end += 1) {
      const token = significant[end];
      if (token === '[' || token === '(' || token === '{') stack.push(token === '[' ? ']' : token === '(' ? ')' : '}');
      else if (token === ']' || token === ')' || token === '}') {
        if (stack.pop() !== token) {
          matched = false;
          break;
        }
      }
    }
    if (!matched || stack.length !== 0) break;
    const contents = significant.slice(start, end - 1);
    const fields: string[] = [];
    let valid = true;
    for (let field = 0; field < contents.length; field += 1) {
      if (field % 2 === 1) {
        if (contents[field] !== ',') valid = false;
      } else {
        const value = decodeJsString(contents[field]);
        if (value === null) valid = false;
        else fields.push(value.trim()); // 空字符串也必须保留位置
      }
    }
    if (valid && fields.length > 0) arrays.push(fields);
    i = end - 1; // 非纯字符串数组整体跳过，不从其表达式/子数组捞租约
  }
  return arrays;
}

function arrayLeases(fields: string[]): DhcpLease[] {
  const anchors = fields.flatMap((field, index) => normalizeLeaseMac(field) ? [index] : []);
  if (anchors.length === 0) return [];
  // 平铺数组仅在记录宽度与 MAC 位置一致时分行取名；不明确时仍可保留紧邻的 MAC+IP。
  const width = fields.length / anchors.length;
  const aligned = Number.isInteger(width) && anchors.every((anchor, index) =>
    anchor === anchors[0] + index * width && anchor + 1 < (index + 1) * width,
  );
  return anchors.flatMap((anchor, index) => {
    if (!isIpv4(fields[anchor + 1] ?? '')) return [];
    const lease = aligned
      ? leaseFromFields(fields.slice(index * width, (index + 1) * width))
      : { mac: fields[anchor], ip: fields[anchor + 1], hostname: null, expiresAt: null };
    return lease ? [lease] : [];
  });
}

export function parseLeasesFromHtml(html: string): DhcpLease[] {
  if (!html) return [];
  const tables = tableLeases(html);
  if (tables.length > 0) return normalizeDhcpLeases(tables);
  const leases: DhcpLease[] = [];
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const script of markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    for (const fields of scriptArrays(script[1])) leases.push(...arrayLeases(fields));
  }
  return normalizeDhcpLeases(leases);
}

export interface WebLeaseResult {
  ok: boolean;
  leases: DhcpLease[];
  note: string | null;
}

/** 超时只包围单个外部操作；超时后它的迟到结果不会启动下一阶段。 */
async function bounded<T>(operation: () => Promise<T>, timeoutMs: number): Promise<{ value: T | null; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then((value) => ({ value, timedOut: false }), () => ({ value: null, timedOut: false })),
      new Promise<{ value: null; timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ value: null, timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 只借用同网关管理页的协议与端口，绝不向外部管理地址发送 Cookie。 */
function managementOrigin(gateway: string, adminUrl?: string | null): string | null {
  try {
    const fallback = new URL(`http://${gateway}/`);
    if (fallback.hostname !== gateway || fallback.username || fallback.password) return null;
    if (adminUrl) {
      try {
        const admin = new URL(adminUrl);
        if ((admin.protocol === 'http:' || admin.protocol === 'https:') && admin.hostname === fallback.hostname && !admin.username && !admin.password) return admin.origin;
      } catch { /* 无效地址仍只尝试网关默认 origin */ }
    }
    return fallback.origin;
  } catch {
    return null;
  }
}

/** 候选、Cookie provider 和仅 TP-LINK 的 Host 重试共用硬预算。 */
export async function fetchWebLeases(options: {
  gateway: string;
  cookie?: string;
  brand?: RouterBrand | null;
  transport?: WebLeaseTransport;
  cookieProvider?: (url: string) => Promise<string | null>;
  adminUrl?: string | null;
  isCurrent?: () => boolean;
}): Promise<WebLeaseResult> {
  const deadline = Date.now() + WEB_LEASE_TOTAL_BUDGET_MS;
  const remaining = (): number => options.isCurrent?.() === false ? 0 : Math.max(0, deadline - Date.now());
  const origin = managementOrigin(options.gateway, options.adminUrl);
  if (!origin) return { ok: false, leases: [], note: '管理页租约（实验通道）：无效网关地址' };
  const transport: WebLeaseTransport = options.transport ?? (async (url, headers) => {
    const u = new URL(url);
    const res = await httpRequest(url, {
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      // httpx 的硬截止为 2×timeout；也不得越过本轮剩余预算。不改变 TLS 策略。
      timeoutMs: Math.max(1, Math.min(WEB_LEASE_TIMEOUT_MS, remaining() / 2)),
      headers,
    });
    return res.error || res.status !== 200 ? null : res.body;
  });
  const paths = new Set<string>();
  const candidates = WEB_LEASE_CANDIDATES.filter((candidate) => {
    if (candidate.brand !== null && candidate.brand !== options.brand) return false;
    if (paths.has(candidate.path)) return false;
    paths.add(candidate.path);
    return true;
  }).slice(0, WEB_LEASE_MAX_CANDIDATES);
  const tried: string[] = [];
  let stopped = false;

  async function request(url: string, hostRetry = false): Promise<string | null> {
    if (remaining() <= 0 || stopped) return null;
    const cookieUrl = new URL(url);
    if (hostRetry) cookieUrl.hostname = 'tplogin.cn';
    let cookie = hostRetry ? null : options.cookie;
    if (options.cookieProvider) {
      const result = await bounded(() => options.cookieProvider!(cookieUrl.href), Math.min(WEB_LEASE_TIMEOUT_MS, remaining()));
      // provider 挂起时停止本轮，迟到的 Cookie 不得启动传输。
      if (result.timedOut) stopped = true;
      cookie = result.value;
    }
    if (remaining() <= 0 || stopped) return null;
    const headers: Record<string, string> = { Referer: `${cookieUrl.origin}/` };
    if (cookie) headers.Cookie = cookie;
    if (hostRetry) headers.Host = cookieUrl.host;
    const result = await bounded(
      () => remaining() > 0 && !stopped ? transport(url, headers) : Promise.resolve(null),
      Math.min(WEB_LEASE_TIMEOUT_MS, remaining()),
    );
    return result.value;
  }

  for (const candidate of candidates) {
    if (remaining() <= 0 || stopped) break;
    const url = `${origin}${candidate.path}`;
    let body = await request(url);
    if (body === null && options.brand === 'tplink' && remaining() > 0 && !stopped) body = await request(url, true);
    if (body !== null && remaining() > 0) {
      const leases = parseLeasesFromHtml(body);
      if (leases.length > 0 && remaining() > 0) return { ok: true, leases, note: `管理页租约（实验通道）：${leases.length} 条（${candidate.label}）` };
    }
    tried.push(body === null ? candidate.label : `${candidate.label}(200 但无可解析租约)`);
  }
  const shown = tried.slice(0, 3);
  const suffix = tried.length > shown.length ? ` 等 ${tried.length} 个候选页` : '';
  const timeout = remaining() <= 0 || stopped ? '；预算/超时截止' : '';
  return {
    ok: false,
    leases: [],
    note: `管理页租约（实验通道）：未获取（${shown.join('；')}${suffix}${timeout}）`,
  };
}
