/**
 * ONVIF WS-Discovery 摄像头发现（task-023）。
 *
 * 原理：IPC/NVR 会监听 UDP 3702 组播（239.255.255.250）并在收到 Probe 后单播回
 * ProbeMatches——**设备自己声明身份**（Types 里有 NetworkVideoTransmitter/Recorder），
 * 比 RTSP 端口猜测可靠得多。这也是海康/大华/宇视等主流厂商均支持的行业标准。
 *
 * 诚实约束（数据诚实原则）：
 *  - 只认 Types 里明确写着摄像头类别的响应；Windows WSD（pub:Computer）、
 *    WSD 打印（PrintBasic）等其它 WS-Discovery 参与者一律忽略——它们不是摄像头；
 *  - 任何异常静默返回 []（增强路径，绝不拖垮扫描主流程）。
 */
import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';

/** WS-Discovery 单轮窗口（fingerprint 阶段与 mDNS/SSDP 并行，总耗时≈最长窗口）。 */
export const WSD_TIMEOUT_MS = 1200;

const WSD_ADDR = '239.255.255.250';
const WSD_PORT = 3702;

/** 摄像头类别：ipc=网络摄像机，nvr=录像机（语义只用于 osHint 文案，kind 同为 camera）。 */
export type WsdCameraKind = 'ipc' | 'nvr';

export interface WsdCameraHint {
  ip: string;
  kind: WsdCameraKind;
  /** 设备自报的设备服务地址（XAddrs 首个 URL），仅展示用途。 */
  xaddr: string | null;
}

/**
 * 构造 Probe 报文（纯函数，可单测）。types 为 null 时发通配 Probe（不带 d:Types，
 * 覆盖"只响应通配探测"的 NVR——响应里仍会带 Types，由 classifyTypes 判定）。
 */
export function buildProbeMessage(messageId: string, types: string | null): string {
  const typesXml = types ? `<d:Types>${types}</d:Types>` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"' +
    ' xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"' +
    ' xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    '<e:Header>' +
    `<w:MessageID>urn:uuid:${messageId}</w:MessageID>` +
    '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>' +
    '</e:Header>' +
    '<e:Body><d:Probe>' +
    typesXml +
    '</d:Probe></e:Body></e:Envelope>'
  );
}

export interface WsdProbeMatch {
  ip: string | null;
  /** 原始 Types 值（未归类）。 */
  types: string;
  xaddr: string | null;
}

/** 从 XAddrs/地址串提取 IPv4（纯函数）。 */
export function extractIpv4(text: string): string | null {
  const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(text);
  if (!m) return null;
  return m[1] ?? null;
}

/**
 * 解析 ProbeMatches 响应（纯函数，可单测）。
 * 命名空间前缀不固定（d:/dn:/无前缀都有），用前缀无关正则；单包畸形不影响其它字段。
 */
export function parseProbeMatches(xml: string): WsdProbeMatch[] {
  const out: WsdProbeMatch[] = [];
  if (!xml) return out;
  const matches = xml.match(/<[\w.-]*:?ProbeMatch\b[\s\S]*?<\/[\w.-]*:?ProbeMatch>/g);
  if (!matches) return out;
  for (const block of matches) {
    const xaddrM = /<[\w.-]*:?XAddrs>([^<]*)<\/[\w.-]*:?XAddrs>/i.exec(block);
    const typesM = /<[\w.-]*:?Types>([^<]*)<\/[\w.-]*:?Types>/i.exec(block);
    if (!xaddrM && !typesM) continue;
    const xaddr = (xaddrM?.[1] ?? '').trim() || null;
    out.push({
      ip: xaddr ? extractIpv4(xaddr) : null,
      types: (typesM?.[1] ?? '').trim(),
      xaddr,
    });
  }
  return out;
}

/**
 * Types → 摄像头类别（纯函数）。非摄像头类别（pub:Computer / PrintBasic / wsdp:Device …）
 * 一律 null——不猜。前缀无关匹配（dn:NetworkVideoTransmitter / NetworkVideoTransmitter 都认）。
 */
export function classifyTypes(types: string): WsdCameraKind | null {
  const t = types.toLowerCase();
  if (!t) return null;
  if (t.includes('networkvideotransmitter')) return 'ipc';
  if (t.includes('networkvideorecorder')) return 'nvr';
  return null;
}

/** 多包聚合：同 IP 取优先级更高的 kind（ipc > nvr）；无 IP 的命中丢弃。 */
export function hintsFromMatches(matches: WsdProbeMatch[]): WsdCameraHint[] {
  const rank: Record<WsdCameraKind, number> = { nvr: 1, ipc: 2 };
  const byIp = new Map<string, WsdCameraHint>();
  for (const m of matches) {
    const kind = classifyTypes(m.types);
    if (!kind || !m.ip) continue;
    const prev = byIp.get(m.ip);
    if (!prev || rank[kind] > rank[prev.kind]) {
      byIp.set(m.ip, { ip: m.ip, kind, xaddr: m.xaddr });
    }
  }
  return Array.from(byIp.values());
}

/**
 * 全网 WS-Discovery 摄像头侦测入口：发"ONVIF 专用 + 通配"两个 Probe，
 * 窗口内收集全部响应后统一解析归类。任何异常静默返回 []。
 */
export async function discoverCamerasWsdiscovery(timeoutMs = WSD_TIMEOUT_MS): Promise<WsdCameraHint[]> {
  const messages: string[] = [];
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
        // 响应包可能分片（超大 ProbeMatches），utf8 解码失败的单包静默丢弃
        try {
          messages.push(msg.toString('utf8'));
        } catch {
          /* 忽略单包 */
        }
      });
      try {
        const probes = [
          Buffer.from(buildProbeMessage(randomUUID(), 'dn:NetworkVideoTransmitter'), 'utf8'),
          Buffer.from(buildProbeMessage(randomUUID(), null), 'utf8'),
        ];
        for (const probe of probes) {
          socket.send(probe, WSD_PORT, WSD_ADDR, (err) => {
            if (err) close();
          });
        }
      } catch {
        close();
      }
    });
  } catch {
    return [];
  }
  const all = messages.flatMap((xml) => parseProbeMatches(xml));
  return hintsFromMatches(all);
}
