/**
 * UPnP IGD 通道（零依赖）：SSDP 发现 → 设备描述解析 → WANIPConnection SOAP。
 *
 * 数据诚实原则：
 *  - 设备不提供 GetTotalBytes* 计数器 → 该字段为 null（不填 0）
 *  - SSDP 超时/描述不可达 → capabilities.upnp=false + 能力说明文案
 */
import * as dgram from 'node:dgram';
import { ROUTER } from '../../../shared/constants';
import { httpRequest } from './httpx';

export const MSEARCH_TARGET = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1';

/** 组装 M-SEARCH 请求文本（纯函数，测试用）。 */
export function buildMsearch(msx = 3): string {
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: 239.255.255.250:1900`,
    'MAN: "ssdp:discover"',
    `MX: ${msx}`,
    `ST: ${MSEARCH_TARGET}`,
    '', // 结尾空行
    '',
  ].join('\r\n');
}

/** 从 SSDP 响应文本里提取 LOCATION 头（纯函数；非 SSDP 报文返回 null）。 */
export function parseSsdpLocation(text: string): string | null {
  if (!text.toUpperCase().startsWith('HTTP/1.1 200')) return null;
  const m = text.match(/^LOCATION:\s*(\S+)\s*$/im);
  return m ? m[1] : null;
}

export interface UpnpDescription {
  friendlyName: string | null;
  modelName: string | null;
  /** WANIPConnection 服务的 controlURL（相对路径，需以 description 基地址解析） */
  controlUrl: string | null;
}

/** 解析设备描述 XML（正则实现，零 XML 依赖；只关心这三个字段）。 */
export function parseDeviceDescription(xml: string): UpnpDescription | null {
  if (!xml.includes('<device')) return null;
  const pick = (tag: string): string | null => {
    const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
    const v = m?.[1]?.trim();
    return v ? v : null;
  };
  // controlURL 取 WANIPConnection 服务块里的（WANCommonInterfaceConfig 也可发流量计数，
  // 但 WANIPConnection 更普遍，先取前者缺失时兜底后者）。
  // 注意：必须先按块切分再匹配，否则首个 <service> 块会被惰性匹配吞进 WANIPConnection 块。
  const serviceBlocks = xml.match(/<service>[\s\S]*?<\/service>/gi) ?? [];
  const svc =
    serviceBlocks.find((b) => /urn:schemas-upnp-org:service:WANIPConnection:\d/i.test(b)) ?? null;
  const control =
    svc?.match(/<controlURL>([^<]*)<\/controlURL>/i)?.[1]?.trim() ??
    xml.match(/<controlURL>([^<]*)<\/controlURL>/i)?.[1]?.trim() ??
    null;
  return {
    friendlyName: pick('friendlyName'),
    modelName: pick('modelName'),
    controlUrl: control,
  };
}

/** 用 description 基地址把相对 controlURL 解析成绝对地址（纯函数）。 */
export function resolveControlUrl(baseUrl: string, controlUrl: string | null): string | null {
  if (!controlUrl) return null;
  try {
    return new URL(controlUrl, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').toString();
  } catch {
    return null;
  }
}

export interface SoapParams {
  [arg: string]: string;
}

/** 组装 SOAP action 信封（纯函数）。 */
export function buildSoap(action: string, params: SoapParams = {}): string {
  const args = Object.entries(params)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join('');
  return [
    '<?xml version="1.0"?>',
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<SOAP-ENV:Body>',
    `<m:${action} xmlns:m="urn:schemas-upnp-org:service:WANIPConnection:1">${args}</m:${action}>`,
    '</SOAP-ENV:Body>',
    '</SOAP-ENV:Envelope>',
  ].join('');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

/** 从 SOAP 响应里抽取指定 tag 下的全部 `<字段>值</字段>`（纯函数；兼容命名空间前缀）。 */
export function parseSoapFields(xml: string, element: string): Record<string, string> {
  const body =
    xml.match(new RegExp(`<(?:[\\w.-]+:)?${element}[\\s\\S]*?</(?:[\\w.-]+:)?${element}>`, 'i'))?.[0] ?? '';
  const fields: Record<string, string> = {};
  for (const m of body.matchAll(/<([A-Za-z][A-Za-z0-9_]*)>([^<]*)<\/\1>/g)) {
    fields[m[1]] = m[2];
  }
  return fields;
}

/** SOAP action 的 service type 与动作名 → 请求头所需字段。 */
export function soapActionHeader(action: string): Record<string, string> {
  return {
    'Content-Type': 'text/xml; charset="utf-8"',
    SOAPACTION: `"urn:schemas-upnp-org:service:WANIPConnection:1#${action}"`,
  };
}

/** SSDP M-SEARCH：广播一次并收LOCATION（无发现返回 null，绝不抛异常）。 */
export function ssdpDiscover(timeoutMs = ROUTER.ssdpTimeoutMs): Promise<{ location: string | null; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let location: string | null = null;
    const done = (): void => {
      try {
        sock.close();
      } catch {
        /* 已关闭 */
      }
      resolve({ location, ms: Date.now() - started });
    };
    const timer = setTimeout(done, timeoutMs);
    sock.on('message', (buf: Buffer) => {
      const found = parseSsdpLocation(buf.toString('utf8'));
      if (found && location === null) location = found;
    });
    sock.on('error', () => {
      clearTimeout(timer);
      done();
    });
    const query = buildMsearch();
    sock.bind(() => {
      try {
        sock.send(query, 1900, '239.255.255.250');
      } catch {
        clearTimeout(timer);
        done();
      }
    });
  });
}

export interface UpnpSnapshot {
  friendlyName: string | null;
  modelName: string | null;
  wanIp: string | null;
  /** GetTotalBytes* 计数器；设备不支持该 action 时为 null */
  totalBytesRx: number | null;
  totalBytesTx: number | null;
  /** GetStatusInfo 的连接状态（如 Connected）；设备不支持该 action 时为 null（task-024） */
  connectionStatus: string | null;
  /** GetStatusInfo 的连接时长（秒）；设备不支持该 action 时为 null（task-024） */
  uptimeSec: number | null;
  error: string | null;
}

/**
 * 一次完整的 UPnP IGD 查询：description → GetExternalIPAddress → GetTotalBytes*。
 * 任何一步失败都不中断整体：拿到的字段如实返回，拿不到的如实为 null。
 */
export async function upnpQuery(location: string, timeoutMs = ROUTER.upnpHttpTimeoutMs): Promise<UpnpSnapshot> {
  const out: UpnpSnapshot = {
    friendlyName: null,
    modelName: null,
    wanIp: null,
    totalBytesRx: null,
    totalBytesTx: null,
    connectionStatus: null,
    uptimeSec: null,
    error: null,
  };
  const base = new URL(location);
  const desc = await httpRequest(location, { port: Number(base.port) || 80, path: base.pathname, timeoutMs });
  if (desc.error || desc.status !== 200) {
    out.error = desc.error ?? `描述页 HTTP ${desc.status}`;
    return out;
  }
  const parsed = parseDeviceDescription(desc.body);
  if (!parsed) {
    out.error = '设备描述 XML 无法解析';
    return out;
  }
  out.friendlyName = parsed.friendlyName;
  out.modelName = parsed.modelName;

  const control = resolveControlUrl(location, parsed.controlUrl);
  if (!control) {
    out.error = '设备描述缺少 controlURL，无法发起 SOAP 查询';
    return out;
  }
  const controlU = new URL(control);
  const soapPort = Number(controlU.port) || 80;

  const ipRes = await httpRequest(control, {
    port: soapPort,
    path: controlU.pathname,
    method: 'POST',
    headers: soapActionHeader('GetExternalIPAddress'),
    body: buildSoap('GetExternalIPAddress'),
    timeoutMs,
  });
  if (!ipRes.error && ipRes.status === 200) {
    const fields = parseSoapFields(ipRes.body, 'GetExternalIPAddressResponse');
    // UPnP 对取不到外部 IP 的回答是 SOAP Fault（非 200）或空字段
    const ip = fields.NewExternalIPAddress?.trim();
    if (ip && isPlausibleIp(ip)) out.wanIp = ip;
  }

  for (const [action, key] of [
    ['GetTotalBytesReceived', 'totalBytesRx'],
    ['GetTotalBytesSent', 'totalBytesTx'],
  ] as const) {
    const res = await httpRequest(control, {
      port: soapPort,
      path: controlU.pathname,
      method: 'POST',
      headers: soapActionHeader(action),
      body: buildSoap(action),
      timeoutMs,
    });
    if (res.error || res.status !== 200) continue; // 设备不提供该计数器 → 保持 null
    const fields = parseSoapFields(res.body, `${action}Response`);
    // 标准字段名：NewTotalBytesReceived / NewTotalBytesSent
    const v = fields[`New${action.slice(3)}`] ?? fields.NewTotalBytes ?? null;
    const n = v === null ? NaN : Number(v);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }

  // GetStatusInfo：连接状态 + 连接时长（部分固件不实现该 action → 保持 null）
  const statusRes = await httpRequest(control, {
    port: soapPort,
    path: controlU.pathname,
    method: 'POST',
    headers: soapActionHeader('GetStatusInfo'),
    body: buildSoap('GetStatusInfo'),
    timeoutMs,
  });
  if (!statusRes.error && statusRes.status === 200) {
    const fields = parseSoapFields(statusRes.body, 'GetStatusInfoResponse');
    const conn = fields.NewConnectionStatus?.trim();
    if (conn) out.connectionStatus = conn;
    const uptime = Number(fields.NewUptime);
    if (Number.isFinite(uptime) && uptime >= 0) out.uptimeSec = uptime;
  }
  return out;
}

function isPlausibleIp(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** UPnP 重启（部分固件不实现该 action）。 */
export async function upnpReboot(controlUrl: string, timeoutMs = ROUTER.upnpHttpTimeoutMs): Promise<{ ok: boolean; error: string | null }> {
  const u = new URL(controlUrl);
  const res = await httpRequest(controlUrl, {
    port: Number(u.port) || 80,
    path: u.pathname,
    method: 'POST',
    headers: soapActionHeader('Reboot'),
    body: buildSoap('Reboot'),
    timeoutMs,
  });
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 200) return { ok: false, error: `设备拒绝 Reboot action（HTTP ${res.status}）` };
  return { ok: true, error: null };
}
