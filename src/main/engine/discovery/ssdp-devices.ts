/**
 * SSDP 全网设备自报发现（task-023）。
 *
 * 原理：M-SEARCH `ST: ssdp:all` 广播到 239.255.255.250:1900，设备回 200-OK（带
 * LOCATION 描述页）；组播端口同时会收到设备周期性的 NOTIFY alive（同样带 LOCATION）。
 * 拉 LOCATION 的描述 XML 取 `<deviceType>`——**设备自己声明类型**，比 OUI/端口推断可靠。
 *
 * 映射（只收录高置信；拿不准不定 kind——数据诚实原则）：
 *  - urn:schemas-upnp-org:device:InternetGatewayDevice → router（osHint 'UPnP IGD（网关）'）
 *  - urn:schemas-upnp-org:device:WLANAccessPointDevice → ap（osHint '无线AP (UPnP)'）
 *  - urn:schemas-upnp-org:device:MediaRenderer        → iot（osHint '投屏/音响 (UPnP)'）
 *  - urn:schemas-upnp-org:device:MediaServer          → 不定 kind，仅 osHint 兜底
 *    （NAS / PC / 电视都可能自称 MediaServer，定 kind 就是猜）
 *
 * 任何异常静默返回 []（增强路径，绝不拖垮扫描主流程）。
 */
import dgram from 'node:dgram';
import { httpRequest } from '../router/httpx';

/** 单轮窗口（与 mDNS/WS-Discovery 在 augment 阶段并行，总耗时≈最长窗口）。 */
export const SSDP_DISCOVER_TIMEOUT_MS = 1500;
/** 描述页拉取：单页超时与并发上限。 */
export const SSDP_DESC_TIMEOUT_MS = 1000;
export const SSDP_DESC_CONCURRENCY = 4;
export const SSDP_DESC_MAX_LOCATIONS = 10;

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

/** M-SEARCH ssdp:all 报文（纯函数，可单测）。MX 决定设备随机延迟回包的窗口。 */
export function buildMsearchAll(msx = 2): string {
  return [
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'MAN: "ssdp:discover"',
    `MX: ${msx}`,
    'ST: ssdp:all',
    '',
    '',
  ].join('\r\n');
}

/** 从单个 SSDP 报文提取 LOCATION（M-SEARCH 200-OK 与 NOTIFY alive 通吃；无则 null）。 */
export function parseSsdpLocation(text: string): string | null {
  const m = text.match(/^LOCATION:\s*(\S+)\s*$/im);
  return m ? m[1] ?? null : null;
}

/** 描述 XML 的首个 deviceType（纯函数；前缀无关）。 */
export function parseDeviceTypeFromXml(xml: string): string | null {
  const m = /<[\w.-]*:?deviceType>\s*([^<\s][^<]*?)\s*<\/[\w.-]*:?deviceType>/i.exec(xml);
  return m ? m[1] ?? null : null;
}

export interface SsdpClassification {
  kind: 'router' | 'ap' | 'iot' | null;
  osHint: string;
}

/** deviceType → 类别 + 展示文案（纯函数）。未收录类型返回 null——不猜。 */
export function classifySsdpDeviceType(deviceType: string): SsdpClassification | null {
  const t = deviceType.toLowerCase();
  if (!t) return null;
  if (t.includes('internetgatewaydevice')) {
    return { kind: 'router', osHint: 'UPnP IGD（网关）' };
  }
  if (t.includes('wlanaccesspointdevice')) {
    return { kind: 'ap', osHint: '无线AP (UPnP)' };
  }
  if (t.includes('mediarenderer')) {
    return { kind: 'iot', osHint: '投屏/音响 (UPnP)' };
  }
  if (t.includes('mediaserver')) {
    return { kind: null, osHint: '媒体服务器 (UPnP)' };
  }
  return null;
}

/** 聚合优先级：ap > router > iot > 仅 osHint（MediaServer）。同 IP 高优先级胜出。 */
function rank(c: SsdpClassification): number {
  if (c.kind === 'ap') return 4;
  if (c.kind === 'router') return 3;
  if (c.kind === 'iot') return 2;
  return 1;
}

export interface SsdpDeviceHint {
  ip: string;
  kind: 'router' | 'ap' | 'iot' | null;
  osHint: string;
}

/** 同 IP 聚合（纯函数）：按 rank 取最高；低优先 osHint 丢弃。 */
export function aggregateSsdpHints(
  entries: ReadonlyArray<{ ip: string; classification: SsdpClassification }>,
): SsdpDeviceHint[] {
  const byIp = new Map<string, SsdpDeviceHint>();
  for (const { ip, classification } of entries) {
    const prev = byIp.get(ip);
    if (!prev || rank(classification) > rank(prev)) {
      byIp.set(ip, { ip, kind: classification.kind, osHint: classification.osHint });
    }
  }
  return Array.from(byIp.values());
}

/** 从 LOCATION URL 提取 host 的 IPv4（组播地址/域名返回 null 并丢弃）。 */
function ipv4FromUrl(url: string): string | null {
  const m = /https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\//i.exec(url);
  return m ? m[1] ?? null : null;
}

/**
 * 全网 SSDP 设备发现入口：M-SEARCH 广播 + 窗口内收集 LOCATION（去重，上限
 * SSDP_DESC_MAX_LOCATIONS）→ 并发拉描述 XML → deviceType 归类。
 * 任何异常静默返回 []。
 */
export async function discoverSsdpDevices(timeoutMs = SSDP_DISCOVER_TIMEOUT_MS): Promise<SsdpDeviceHint[]> {
  const locations: string[] = [];
  try {
    await new Promise<void>((resolve) => {
      let socket: dgram.Socket;
      try {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      } catch {
        resolve();
        return;
      }
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          /* 已关闭 */
        }
        resolve();
      };
      const timer = setTimeout(close, timeoutMs);
      socket.on('error', close);
      socket.on('message', (msg: Buffer) => {
        try {
          const loc = parseSsdpLocation(msg.toString('utf8'));
          // NOTIFY alive 无 LOCATION 的也常见；非 SSDP 噪音（其它 UDP 1900 包）由 null 过滤
          if (loc && !locations.includes(loc) && ipv4FromUrl(loc)) locations.push(loc);
        } catch {
          /* 单包忽略 */
        }
      });
      try {
        const query = Buffer.from(buildMsearchAll(), 'utf8');
        socket.bind(() => {
          try {
            socket.send(query, SSDP_PORT, SSDP_ADDR);
          } catch {
            close();
          }
        });
      } catch {
        close();
      }
    });
  } catch {
    return [];
  }

  const slice = locations.slice(0, SSDP_DESC_MAX_LOCATIONS);
  if (slice.length === 0) return [];

  // 描述页拉取总预算：窗口结束后最多再花 600ms（与 mDNS/nbtstat 并行时
  // phaseFingerprint 总耗时不超 1.6s 旅标的关键）
  const descDeadline = Date.now() + 600;
  const entries: Array<{ ip: string; classification: SsdpClassification }> = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= descDeadline) return;
      const idx = cursor;
      cursor += 1;
      const loc = slice[idx];
      if (!loc) return;
      const ip = ipv4FromUrl(loc);
      if (!ip) continue;
      try {
        const u = new URL(loc);
        const res = await httpRequest(loc, {
          port: Number(u.port) || 80,
          path: u.pathname + u.search,
          timeoutMs: SSDP_DESC_TIMEOUT_MS,
        });
        if (res.error || res.status !== 200) continue;
        const deviceType = parseDeviceTypeFromXml(res.body);
        if (!deviceType) continue;
        const classification = classifySsdpDeviceType(deviceType);
        if (classification) entries.push({ ip, classification });
      } catch {
        /* 单个描述失败忽略 */
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SSDP_DESC_CONCURRENCY, slice.length) }, () => worker()),
  );
  return aggregateSsdpHints(entries);
}
