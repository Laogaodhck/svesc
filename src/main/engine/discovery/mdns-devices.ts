/**
 * mDNS 全设备类型侦测（task-020，摄像头/手机/IoT 区分度增强）。
 *
 * 原理：设备会通过 mDNS 自报服务身份，这是**设备自己声明**的强信号
 * （比主机名正则可靠，比 OUI 细）。查询与解析复用 printers/mdns.ts 的通用层。
 *
 * 服务 → 类型映射（只收录高置信映射；拿不准的服务不进表——数据诚实原则）：
 *  - _googlecast        → iot（Chromecast / 内置投屏的电视与音箱）
 *  - _hap               → iot（HomeKit 配件）
 *  - _androidtvremote2  → iot（Android TV 遥控服务）
 *  - _spotify-connect   → iot（Spotify Connect 音箱/电视）
 *  - _esphomelib        → iot（ESPHome 自建设备）
 *  - _companion         → mobile（Apple 设备间配对服务，iOS 专属）
 *  - _airplay / _raop   → 'apple'（AirPlay 收发端：Mac/iPad/Apple TV 均可，
 *                          **不判定具体类型**，仅作 osHint 佐证）
 */
import { mdnsQuery, type MdnsHit } from '../printers/mdns';

export type MdnsKindHint = 'iot' | 'mobile' | 'apple';

export const DEVICE_MDNS_SERVICES: Readonly<Record<string, MdnsKindHint>> = {
  '_googlecast._tcp.local': 'iot',
  '_hap._tcp.local': 'iot',
  '_androidtvremote2._tcp.local': 'iot',
  '_androidtvremote._tcp.local': 'iot',
  '_spotify-connect._tcp.local': 'iot',
  '_esphomelib._tcp.local': 'iot',
  '_companion._tcp.local': 'mobile',
  '_airplay._tcp.local': 'apple',
  '_raop._tcp.local': 'apple',
};

/** mDNS 类型侦测默认窗口（phaseFingerprint 预算内，与反查并发会挤预算，默认 1s）。 */
export const MDNS_DEVICE_TIMEOUT_MS = 1000;

export interface MdnsDeviceHint {
  ip: string;
  name: string;
  service: string;
  kind: MdnsKindHint;
}

/**
 * 从一次 mDNS 查询的命中里推导设备类型提示。
 * 同一 IP 命中多个服务时优先级：mobile > iot > apple（apple 不定类型，让位）。
 */
export function hintsFromHits(hits: MdnsHit[]): MdnsDeviceHint[] {
  const byIp = new Map<string, MdnsDeviceHint>();
  const rank: Record<MdnsKindHint, number> = { apple: 0, iot: 1, mobile: 2 };
  for (const hit of hits) {
    const kind = DEVICE_MDNS_SERVICES[hit.service.toLowerCase()];
    if (!kind || !hit.ip) continue;
    const prev = byIp.get(hit.ip);
    if (!prev || rank[kind] > rank[prev.kind]) {
      byIp.set(hit.ip, { ip: hit.ip, name: hit.name, service: hit.service, kind });
    }
  }
  return Array.from(byIp.values());
}

/** 全设备类型侦测入口：查询全部已收录服务并按 IP 聚合。任何异常静默返回 []。 */
export async function discoverMdnsDevices(timeoutMs = MDNS_DEVICE_TIMEOUT_MS): Promise<MdnsDeviceHint[]> {
  try {
    const hits = await mdnsQuery(Object.keys(DEVICE_MDNS_SERVICES), timeoutMs);
    return hintsFromHits(hits);
  } catch {
    return [];
  }
}
