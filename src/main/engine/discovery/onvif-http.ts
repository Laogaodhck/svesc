/**
 * ONVIF HTTP 设备服务探测（task-028，摄像头识别的"自报层"补强）。
 *
 * 背景：本机实测 ONVIF WS-Discovery（UDP 3702 组播）在多数家用网络里被交换机/
 * AP 丢弃，摄像头的 554/8000 也可能不开放。但 ONVIF 设备都会在
 * `http://<ip>/onvif/device_service` 暴露 SOAP 服务，其中
 * **GetSystemDateAndTime 按规范无需认证**，返回 `<GetSystemDateAndTimeResponse>`。
 * 这是设备按行业标准自己作答，比"开着 RTSP 端口"硬得多。
 *
 * 二段探测：日期调用成功后，再试一次 GetDeviceInformation（很多设备也不校验
 * 认证），能拿到厂商/型号（如 "Hikvision / DS-2CD2T47"），写进 osHint。
 *
 * 诚实约束：
 *  - 只认 SOAP 响应体里的 ONVIF 证据（Response 元素 / onvif 命名空间），
 *    或 401/403 且 `WWW-Authenticate` realm 含 onvif；
 *  - 只在已探明开放的 HTTP 类端口上试（不新增端口面）；
 *  - 任何异常静默跳过（增强路径，绝不拖垮扫描主流程）。
 */
import { httpRequest } from '../router/httpx';
import { parseAuthRealm } from './http-fingerprint';

/** 单请求超时：日期调用与设备信息调用各自计时。 */
export const ONVIF_TIMEOUT_MS = 800;
export const ONVIF_INFO_TIMEOUT_MS = 500;
/** 单轮最多探测的设备数（调度器轮转）。 */
export const ONVIF_MAX_TARGETS = 6;
export const ONVIF_CONCURRENCY = 3;
/** 可能承载 ONVIF 服务的端口（必须是 PROBE_PORTS 已探明的端口）。 */
export const ONVIF_PORTS = [80, 8080, 8899, 8000] as const;

export interface OnvifProbeTarget {
  ip: string;
  port: number;
}

export interface OnvifHint {
  ip: string;
  /** 摄像头自报文案（含厂商/型号时直接写进去）。 */
  osHint: string;
}

/** 注入式传输结果（测试注入假数据；真实实现走 httpRequest）。 */
export interface OnvifProbeResponse {
  status: number | null;
  body: string;
  wwwAuthenticate?: string | null;
}

export type OnvifFetcher = (ip: string, port: number, soapBody: string) => Promise<OnvifProbeResponse | null>;

const ENVELOPE = (body: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
  `<s:Body>${body}</s:Body></s:Envelope>`;

export const ONVIF_DATE_BODY = ENVELOPE(
  '<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>',
);
export const ONVIF_INFO_BODY = ENVELOPE(
  '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>',
);

const defaultFetcher: OnvifFetcher = async (ip, port, soapBody) => {
  const res = await httpRequest(`http://${ip}/onvif/device_service`, {
    port,
    path: '/onvif/device_service',
    method: 'POST',
    timeoutMs: soapBody === ONVIF_INFO_BODY ? ONVIF_INFO_TIMEOUT_MS : ONVIF_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/soap+xml; charset=utf-8',
      Accept: 'application/soap+xml',
      // 部分老固件只认 Content-Length（Node 默认 chunked 会直接 400）
      'Content-Length': String(Buffer.byteLength(soapBody)),
    },
    body: soapBody,
  });
  if (res.error || res.status === null) return null;
  const auth = res.headers['www-authenticate'];
  return {
    status: res.status,
    body: res.body,
    wwwAuthenticate: Array.isArray(auth) ? (auth[0] ?? null) : (auth ?? null),
  };
};

/**
 * 响应是否证明"这是 ONVIF 设备"（纯函数）。
 * 只看设备按 ONVIF 协议给出的证据，不做端口/品牌推断。
 */
export function isOnvifResponse(res: OnvifProbeResponse | null): boolean {
  if (!res) return false;
  // 正常应答：SOAP 体里必须有 GetSystemDateAndTimeResponse
  if (/<\s*[\w.-]*:?GetSystemDateAndTimeResponse\b/i.test(res.body)) return true;
  // 认证失败：401/403 且 realm 自报 onvif（"realm=\"ONVIF\"" 是主流 IPC 的默认值）
  const realm = parseAuthRealm(res.wwwAuthenticate);
  if ((res.status === 401 || res.status === 403) && realm !== null && /onvif/i.test(realm)) {
    return true;
  }
  // 部分设备对 GetSystemDateAndTime 回 SOAP Fault（ActionNotSupported），
  // 但 Fault 详情里仍带 onvif 命名空间——协议栈确实存在，仍算 ONVIF 设备
  return /onvif\.org/i.test(res.body) && (res.status === null || res.status < 500);
}

/** 从 GetDeviceInformation 响应里取厂商/型号（纯函数；缺失均返回 null）。 */
export function parseOnvifDeviceInfo(xml: string): { manufacturer: string | null; model: string | null } {
  const pick = (tag: string): string | null => {
    const m = new RegExp(`<[\\w.-]*:?${tag}>([^<]*)</[\\w.-]*:?${tag}>`, 'i').exec(xml);
    const raw = (m?.[1] ?? '')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
    return raw.length > 0 ? raw : null;
  };
  return { manufacturer: pick('Manufacturer'), model: pick('Model') };
}

/** 组装 osHint：厂商 + 型号都自报时最有信息量。 */
export function buildOnvifOsHint(manufacturer: string | null, model: string | null): string {
  const label = [manufacturer, model].filter((v): v is string => v !== null).join(' ');
  return label.length > 0 ? `ONVIF 摄像机（${label}）` : 'ONVIF 摄像机（设备服务自报）';
}

/**
 * 批量探测：目标列表（调用方已做轮转切片）→ POST /onvif/device_service。
 * 单个失败静默跳过；日期调用成功后追加设备信息调用。
 */
export async function discoverOnvifDevices(
  targets: readonly OnvifProbeTarget[],
  fetcher: OnvifFetcher = defaultFetcher,
): Promise<OnvifHint[]> {
  if (targets.length === 0) return [];
  const slice = targets.slice(0, ONVIF_MAX_TARGETS);
  const out: OnvifHint[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      const t = slice[idx];
      if (!t) return;
      try {
        const date = await fetcher(t.ip, t.port, ONVIF_DATE_BODY);
        if (!isOnvifResponse(date)) continue;
        let manufacturer: string | null = null;
        let model: string | null = null;
        try {
          const info = await fetcher(t.ip, t.port, ONVIF_INFO_BODY);
          if (info) ({ manufacturer, model } = parseOnvifDeviceInfo(info.body));
        } catch {
          /* 设备信息可选，失败不影响摄像头结论 */
        }
        out.push({ ip: t.ip, osHint: buildOnvifOsHint(manufacturer, model) });
      } catch {
        /* 单个探测失败忽略（增强路径） */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ONVIF_CONCURRENCY, slice.length) }, () => worker()));
  return out;
}
