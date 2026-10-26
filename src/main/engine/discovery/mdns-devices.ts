/**
 * mDNS 全设备类型侦测（task-020，摄像头/手机/IoT 区分度增强）。
 *
 * 原理：设备会通过 mDNS 自报服务身份，这是**设备自己声明**的强信号
 * （比主机名正则可靠，比 OUI 细）。查询与解析复用 printers/mdns.ts 的通用层。
 *
 * 服务 → 类型映射（只收录高置信映射；拿不准的服务不进表——数据诚实原则）：
 *  - _googlecast        → iot（Chromecast / 内置投屏的电视与音箱）
 *  - _hap               → iot（HomeKit 配件）
 *  - _matter            → iot（Matter 标准生态，task-028）
 *  - _androidtvremote2  → iot（Android TV 遥控服务）
 *  - _spotify-connect   → iot（Spotify Connect 音箱/电视）
 *  - _esphomelib        → iot（ESPHome 自建设备）
 *  - _shelly            → iot（Shelly 智能开关，task-028）
 *  - _amzn-wplay        → iot（Alexa 多房间音频，task-028）
 *  - _googlerpc         → iot（Google Home 生态，task-023）
 *  - _miio              → iot（小米 MIoT 生态自报：传感器/扫地机/台灯，task-027；
 *                          小米电视不走此服务而是 _androidtvremote2，不与手机冲突）
 *  - _apple-mobdev2     → mobile（iOS 设备 Wi-Fi 同步/配对，iOS 专属，task-028）
 *  - _companion-link    → 'apple'（Apple 连续互通：iPhone/iPad/Mac 都会发，
 *                          所以**不判 mobile**——旧表把 `_companion` 当 iOS 专属是错的）
 *  - _airplay / _raop   → 'apple'（AirPlay 收发端：Mac/iPad/Apple TV 均可，
 *                          **不判定具体类型**，仅作 osHint 佐证）
 *  - _sleep-proxy       → 'apple'（Bonjour 睡眠代理，Mac/Apple TV，task-023，不定类型）
 *  - _device-info       → 由 TXT `model=` 决定（iPhone→mobile / iPad→tablet /
 *                          MacBook→workstation / AppleTV→iot），无 model 不判（task-028）
 *  - _nvstream          → workstation（GeForce 串流服务，PC 专属，task-023）
 *  - _workstation       → workstation（Avahi 在 Linux/Unix 工作站上自报，task-028）
 *  - _ipp/_ipps/_ipp-tls/_pdl-datastream/_printer/_scanner/_uscan/_uscans → printer
 *                          （打印/扫描自报，task-023/027/028；
 *                          打印发现走 printers/mdns.ts，这里让设备 kind 同步受益）
 *  - _axis-video        → camera（Axis 摄像机自报，task-023）
 */
import { mdnsQuery, type MdnsHit } from '../printers/mdns';

export type MdnsKindHint = 'iot' | 'mobile' | 'apple' | 'workstation' | 'printer' | 'camera' | 'ap' | 'tablet';

export const DEVICE_MDNS_SERVICES: Readonly<Record<string, MdnsKindHint>> = {
  '_googlecast._tcp.local': 'iot',
  '_hap._tcp.local': 'iot',
  '_matter._tcp.local': 'iot',
  '_androidtvremote2._tcp.local': 'iot',
  '_androidtvremote._tcp.local': 'iot',
  '_spotify-connect._tcp.local': 'iot',
  '_esphomelib._tcp.local': 'iot',
  '_shelly._tcp.local': 'iot',
  '_amzn-wplay._tcp.local': 'iot',
  '_googlerpc._tcp.local': 'iot',
  '_miio._udp.local': 'iot',
  '_apple-mobdev2._tcp.local': 'mobile',
  '_companion-link._tcp.local': 'apple',
  '_airplay._tcp.local': 'apple',
  '_raop._tcp.local': 'apple',
  '_sleep-proxy._tcp.local': 'apple',
  '_nvstream._tcp.local': 'workstation',
  '_workstation._tcp.local': 'workstation',
  '_ipp._tcp.local': 'printer',
  '_ipps._tcp.local': 'printer',
  '_ipp-tls._tcp.local': 'printer',
  '_printer._tcp.local': 'printer',
  '_pdl-datastream._tcp.local': 'printer',
  '_scanner._tcp.local': 'printer',
  '_uscan._tcp.local': 'printer',
  '_uscans._tcp.local': 'printer',
  '_axis-video._tcp.local': 'camera',
  // task-028 AP 生态：Apple AirPort 基站与 Ubiquiti 设备的 mDNS 自报
  '_airport._tcp.local': 'ap',
  '_ubnt._tcp.local': 'ap',
};

/**
 * 实际查询的服务列表 = 静态映射表 + 需要看 TXT model 才能定类的服务。
 * `_device-info` 不放进静态表：不放 model 就判 workstation 会把 iPhone 标成 PC。
 */
export const MDNS_QUERY_SERVICES: readonly string[] = [
  ...Object.keys(DEVICE_MDNS_SERVICES),
  '_device-info._tcp.local',
];

/**
 * 单条 mDNS 命中的类型判定（纯函数）。
 * `_device-info` 特殊：Apple 用它自报硬件型号，model 缺失时不判（不猜）。
 */
export function kindFromHit(hit: MdnsHit): MdnsKindHint | null {
  const service = hit.service.toLowerCase();
  if (service === '_device-info._tcp.local') {
    return kindFromDeviceModel(hit.model ?? null);
  }
  return DEVICE_MDNS_SERVICES[service] ?? null;
}

/** Apple `_device-info` TXT model → 类型（纯函数；识别不了返回 null）。 */
export function kindFromDeviceModel(model: string | null): MdnsKindHint | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (/ipad/.test(m)) return 'tablet';
  if (/iphone|ipod/.test(m)) return 'mobile';
  if (/macbook|imac|macmini|mac-?pro|macstudio|mac\d/.test(m)) return 'workstation';
  if (/appletv|audioaccessory|homepod/.test(m)) return 'iot';
  return null;
}

/** mDNS 类型侦测默认窗口（phaseFingerprint 预算内，与反查并发会挤预算，默认 1s）。 */
export const MDNS_DEVICE_TIMEOUT_MS = 1000;

export interface MdnsDeviceHint {
  ip: string;
  name: string;
  service: string;
  kind: MdnsKindHint;
  /** TXT 自报型号（如 iPhone14,5 / MacBookPro18,3），仅展示用途。 */
  model: string | null;
}

/**
 * 从一次 mDNS 查询的命中里推导设备类型提示。
 * 同一 IP 命中多个服务时优先级：
 * tablet > mobile > camera > printer > ap > workstation > iot > apple
 * （apple 不定类型让位；具体类别让位给人机判别更强的 mobile/tablet）。
 */
export function hintsFromHits(hits: MdnsHit[]): MdnsDeviceHint[] {
  const byIp = new Map<string, MdnsDeviceHint>();
  const rank: Record<MdnsKindHint, number> = {
    apple: 0,
    iot: 1,
    workstation: 2,
    printer: 3,
    ap: 3.5,
    camera: 4,
    mobile: 5,
    tablet: 5.5,
  };
  for (const hit of hits) {
    const kind = kindFromHit(hit);
    if (!kind || !hit.ip) continue;
    const prev = byIp.get(hit.ip);
    if (!prev || rank[kind] > rank[prev.kind]) {
      byIp.set(hit.ip, {
        ip: hit.ip,
        name: hit.name,
        service: hit.service,
        kind,
        model: hit.model ?? null,
      });
    }
  }
  return Array.from(byIp.values());
}

/** 全设备类型侦测入口：查询全部已收录服务并按 IP 聚合。任何异常静默返回 []。 */
export async function discoverMdnsDevices(timeoutMs = MDNS_DEVICE_TIMEOUT_MS): Promise<MdnsDeviceHint[]> {
  try {
    const hits = await mdnsQuery(MDNS_QUERY_SERVICES, timeoutMs);
    return hintsFromHits(hits);
  } catch {
    return [];
  }
}
