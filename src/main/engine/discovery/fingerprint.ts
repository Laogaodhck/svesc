/**
 * 设备指纹推断。**只用端口 / 自报协议（WS-Discovery / SSDP / mDNS）/ 主机名特征 / OUI 厂商**，
 * TTL 仅在无任何信号时给一句弱提示，绝不单独用于判定 workstation/server（investigation-report.md
 * §2.10/§9.7 实测：网关 TTL=64、SHARP 打印机 TTL=255，经典 TTL→OS 规则在本机失效）。
 * 拿不准就返回 null / 'unknown'，不猜。
 *
 * task-023 精度改造：
 *  - 新增"自报身份层"：ONVIF WS-Discovery（摄像头）、SSDP（路由/AP/IoT）是设备自己声明
 *    的身份，优先级仅次于打印机端口与 Windows 管理端口；
 *  - 网关判定提前到 OUI 之前（默认网关是硬事实，避免 Huawei ONU/手机同厂商误判）；
 *  - 手机厂商 OUI 在"非网关 + 无管理端口"时给 mobile（osHint 明示是厂商推断）；
 *  - 主机名新增 平板/交换机/AP 词根；mDNS 服务表扩到 17 个。
 */
import type { DeviceKind } from '../../../shared/types';

export interface FingerprintInput {
  openPorts: readonly number[];
  hostname: string | null;
  vendor: string | null;
  ttl: number | null;
  isGateway?: boolean;
  /** mDNS 自报身份（task-020）：设备自己声明服务类型，比主机名正则更可靠。apple 不定类型仅佐证。 */
  mdnsKind?: 'iot' | 'mobile' | 'apple' | 'workstation' | 'printer' | 'camera' | null;
  /** WS-Discovery 自报（task-023）：ipc=网络摄像机，nvr=录像机。 */
  wsdiscoveryKind?: 'ipc' | 'nvr' | null;
  /** SSDP deviceType 自报（task-023）。kind=null 时只有 osHint 兜底意义（如 MediaServer）。 */
  ssdpKind?: 'router' | 'ap' | 'iot' | null;
  ssdpOsHint?: string | null;
}

export interface Fingerprint {
  osHint: string | null;
  kind: DeviceKind;
}

/** 打印机厂商名单（与 oui.ts 保持一致的可判定集合）。 */
const PRINTER_VENDORS = [
  'canon',
  'epson',
  'brother',
  'xerox',
  'ricoh',
  'kyocera',
  'lexmark',
  'sharp',
  'konica',
  'toshiba',
  'fuji xerox',
  'hp',
  'samsung',
  'murata',
];

const NAS_VENDORS = ['synology', 'qnap'];

const IOT_VENDORS = ['espressif', 'raspberry pi', 'sonos'];

/**
 * 监控摄像厂商（task-019：OUI 表 + vendor 关键词双通道，含中文厂商名；
 * task-023 补 ezviz/imou/axis/xiongmai —— 本机实测 EZVIZ（萤石，海康子品牌）
 * IPC 78-a6-a0 前缀落在扩充表，vendor='EZVIZ'）。
 */
const CAMERA_VENDORS = ['hikvision', 'dahua', 'uniview', '海康', '大华', 'ezviz', 'imou', 'axis', 'xiongmai'];

/**
 * 手机/平板厂商 OUI（task-023）。命中且"非网关 + 无管理端口"时给 mobile ——
 * 厂商本身不区分手机/路由器/电视（Huawei 光猫、Samsung 电视同厂商名），
 * 所以必须排除相反证据：管理端口（80/443/8080/SMB/RDP）开放时不判 mobile。
 */
const PHONE_VENDORS = ['samsung', 'huawei', 'honor', 'xiaomi', 'oppo', 'vivo', 'oneplus', 'realme', 'google', 'motorola'];

/** 网络设备厂商（ruijie/mikrotik/fortinet/aruba 为 task-023 扩充表新增）。 */
const NETWORK_VENDORS = [
  'cisco',
  'ubiquiti',
  'h3c',
  'zyxel',
  'd-link',
  'netgear',
  'tp-link',
  'tenda',
  'asus',
  'huawei',
  'ruijie',
  'mikrotik',
  'fortinet',
  'aruba',
];

const RE_MOBILE_HOST = /iphone|ipad|android|redmi|galaxy|pixel|mi-?\d|honor|oppo|vivo|harmony|mibox|xiaoai|oneplus|realme|nokia|zenfone|huawei|sm-[a-z]\d{3}/i;

/** 监控主机名特征：品牌名 + 通用命名约定（cam-/ipc-/nvr）。task-023 加 consumer 品牌。 */
const RE_CAMERA_HOST = /hikvision|dahua|uniview|ezviz|imou|tpipc|\bcam(?:era)?[-_]|[-_]cam\b|\bipc[-_]|\bnvr[-_]|[-_]nvr\b|\bnvr$/i;

/** 平板词根（task-023）。必须判在 mobile 之前（'ipad' 同时命中 mobile 词根）。 */
const RE_TABLET_HOST = /ipad|matepad|tablet|mi[-_ ]?pad/i;

/** 交换机词根（task-023）：switch/sw+编号。仅主机名证据，不猜。 */
const RE_SWITCH_HOST = /switch|交换机|\bsw[-_]?\d{1,3}\b/i;

/** 无线 AP 词根（task-023）：ap+编号 / wireless ap / wap+编号。 */
const RE_AP_HOST = /\bap[-_]?\d{1,3}\b|wireless.?ap|\bwap[-_]?\d{1,3}\b/i;

export function hasPrinterPort(openPorts: readonly number[]): boolean {
  return openPorts.includes(9100) || openPorts.includes(631) || openPorts.includes(515);
}

/** 管理端口开放（手机厂商 OUI 判 mobile 的相反证据）。 */
function hasAdminPort(ports: readonly number[]): boolean {
  return ports.some((p) => p === 80 || p === 443 || p === 8080 || p === 445 || p === 22 || p === 3389);
}

/**
 * 纯函数：打印机端口 → Windows 管理端口 → 设备自报（WS-D/SSDP/mDNS）→
 * 其余端口信号 → 主机名特征 → 网关 → OUI → (TTL 弱提示)。
 * @returns osHint 可为 null；kind 可为 'unknown'
 */
export function inferFingerprint(input: FingerprintInput): Fingerprint {
  const ports = input.openPorts;
  const host = (input.hostname ?? '').toLowerCase();
  const vendor = (input.vendor ?? '').toLowerCase();
  const isGateway = input.isGateway === true;

  // 0) 网关是硬事实：默认路由持有者必是路由器，高于一切推断（task-023 提前，
  //    避免同厂商手机/电视 OUI 在自报层或 OUI 层盖过网关身份）
  if (isGateway) {
    return { osHint: null, kind: 'router' };
  }

  // 1) 打印机端口最优先：9100 单开即可判 printer（Vera §2.7）
  if (hasPrinterPort(ports)) {
    return { osHint: '打印机固件', kind: 'printer' };
  }

  // 2) 445 SMB → Windows（同时是 workstation 的强信号）
  if (ports.includes(445)) {
    return { osHint: 'Windows (SMB)', kind: 'workstation' };
  }
  if (ports.includes(3389)) {
    return { osHint: 'Windows (RDP)', kind: 'workstation' };
  }

  // 2.5) 自报身份层（task-023）：WS-Discovery / SSDP 是设备自己声明的身份，
  //      置信度仅次于直接端口证据；同层内部 camera > ap > router(IGD)。
  if (input.wsdiscoveryKind === 'ipc') {
    return { osHint: '网络摄像机 (ONVIF)', kind: 'camera' };
  }
  if (input.wsdiscoveryKind === 'nvr') {
    return { osHint: 'NVR 录像机 (ONVIF)', kind: 'camera' };
  }
  if (input.ssdpKind === 'ap') {
    return { osHint: input.ssdpOsHint ?? '无线AP (UPnP)', kind: 'ap' };
  }
  if (input.ssdpKind === 'router') {
    return { osHint: input.ssdpOsHint ?? 'UPnP IGD（网关）', kind: 'router' };
  }

  // 2.6) mDNS 自报身份（task-020/023 扩充）：apple 语义是"是 Apple 设备但不定
  //      macOS/iOS"，继续走管线
  if (input.mdnsKind === 'mobile') {
    return { osHint: 'iOS 设备 (mDNS)', kind: 'mobile' };
  }
  if (input.mdnsKind === 'camera') {
    return { osHint: '摄像机 (mDNS 自报)', kind: 'camera' };
  }
  if (input.mdnsKind === 'printer') {
    return { osHint: '打印机 (mDNS 自报)', kind: 'printer' };
  }
  if (input.mdnsKind === 'workstation') {
    return { osHint: 'PC (mDNS 自报)', kind: 'workstation' };
  }
  if (input.mdnsKind === 'iot') {
    return { osHint: 'IoT 设备 (mDNS)', kind: 'iot' };
  }

  // 2.7) SSDP MediaRenderer → iot（plan 规定排在 mDNS 之后：手机开热点共享投屏
  //      等场景下 mDNS 的 mobile 自报更可信）
  if (input.ssdpKind === 'iot') {
    return { osHint: input.ssdpOsHint ?? '投屏/音响 (UPnP)', kind: 'iot' };
  }

  // 3) 其余端口信号
  if (ports.includes(554)) {
    return { osHint: '监控摄像固件 (RTSP)', kind: 'camera' };
  }
  if (ports.includes(22)) {
    return { osHint: 'Linux/Unix (SSH)', kind: 'workstation' };
  }
  if (ports.includes(62078)) {
    return { osHint: 'iOS', kind: 'mobile' };
  }
  if (ports.includes(548)) {
    return { osHint: 'macOS (AFP)', kind: 'workstation' };
  }

  // 4) 主机名特征（平板在 mobile 之前：'ipad' 同时命中两表）
  if (RE_TABLET_HOST.test(host)) {
    return { osHint: '平板（主机名特征）', kind: 'tablet' };
  }
  if (RE_MOBILE_HOST.test(host)) {
    return { osHint: '手机（主机名特征）', kind: 'mobile' };
  }
  if (RE_CAMERA_HOST.test(host)) {
    return { osHint: '监控摄像固件', kind: 'camera' };
  }
  if (/printer|mfp|copier|scanner|alfalink|laserjet|imageclass|workcentre|imageRUNNER/i.test(host)) {
    return { osHint: '打印机固件', kind: 'printer' };
  }
  if (/xrx|sharp|canon|epson|brother|xerox|ricoh|kyocera/i.test(host)) {
    return { osHint: '打印机固件', kind: 'printer' };
  }
  if (/nas|synology|qnap|fileserver|server|dc\d|ad\d/i.test(host)) {
    return { osHint: null, kind: 'server' };
  }
  if (RE_SWITCH_HOST.test(host)) {
    return { osHint: '交换机（主机名特征）', kind: 'switch' };
  }
  if (RE_AP_HOST.test(host)) {
    return { osHint: '无线AP（主机名特征）', kind: 'ap' };
  }
  if (/router|gateway|gw[-_]|tplink|tenda|openwrt|mikrotik/i.test(host)) {
    return { osHint: '网络设备固件', kind: 'router' };
  }
  if (/-pc$|desktop|laptop|notebook|thinkpad|macbook/i.test(host)) {
    return { osHint: null, kind: 'workstation' };
  }

  // 6) OUI 厂商
  if (vendor) {
    // 手机/平板厂商先于打印机厂商：Samsung 同时是手机与打印机厂商（手写表里的
    // Samsung 前缀是打印机、IEEE 扩充表里是手机），无端口时打印机本来就无证据；
    // 有打印端口的设备早在第 1 步就按端口判定了。
    if (PHONE_VENDORS.some((v) => vendor.includes(v)) && !hasAdminPort(ports)) {
      // 仅当无相反证据（非网关已保证、无管理端口）时给 mobile；
      // osHint 明示这是厂商推断，不是设备自报
      return { osHint: `移动设备（OUI 厂商 ${input.vendor} 推断）`, kind: 'mobile' };
    }
    if (PRINTER_VENDORS.some((v) => vendor.includes(v))) {
      return { osHint: '打印机固件', kind: 'printer' };
    }
    if (CAMERA_VENDORS.some((v) => vendor.includes(v))) {
      return { osHint: '监控摄像固件', kind: 'camera' };
    }
    if (NAS_VENDORS.some((v) => vendor.includes(v))) {
      return { osHint: null, kind: 'server' };
    }
    if (IOT_VENDORS.some((v) => vendor.includes(v))) {
      return { osHint: null, kind: 'iot' };
    }
    if (vendor.includes('apple')) {
      // Apple 的 OUI 不区分 macOS/iOS：主机名没认出来就如实给提示，不猜具体类型
      return { osHint: 'Apple 设备（macOS/iOS，待主机名确认）', kind: 'unknown' };
    }
    if (vendor.includes('vmware') || vendor.includes('virtualbox') || vendor.includes('hyper-v')) {
      return { osHint: '虚拟机', kind: 'server' };
    }
    if (NETWORK_VENDORS.some((v) => vendor.includes(v))) {
      return { osHint: '网络设备固件', kind: 'router' };
    }
  }

  // 7) SSDP 仅 osHint 兜底（MediaServer 等）：kind 已无从判定，但身份描述仍真实
  if (input.ssdpOsHint) {
    return { osHint: input.ssdpOsHint, kind: 'unknown' };
  }

  // 8) TTL 仅作弱提示，不改变 kind
  if (input.ttl !== null && input.ttl >= 240) {
    return { osHint: '嵌入式/网络设备固件（TTL 弱提示）', kind: 'unknown' };
  }
  return { osHint: null, kind: 'unknown' };
}
