/**
 * 设备指纹推断。**只用端口 / 主机名特征 / OUI 厂商**，TTL 仅在无任何信号时给一句弱提示，
 * 绝不单独用于判定 workstation/server（investigation-report.md §2.10/§9.7 实测：
 * 网关 TTL=64、SHARP 打印机 TTL=255，经典 TTL→OS 规则在本机失效）。
 * 拿不准就返回 null / 'unknown'，不猜。
 */
import type { DeviceKind } from '../../../shared/types';

export interface FingerprintInput {
  openPorts: readonly number[];
  hostname: string | null;
  vendor: string | null;
  ttl: number | null;
  isGateway?: boolean;
  /** mDNS 自报身份（task-020）：设备自己声明服务类型，比主机名正则更可靠。apple 不定类型仅佐证。 */
  mdnsKind?: 'iot' | 'mobile' | 'apple' | null;
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

/** 监控摄像厂商（task-019：OUI 表 + vendor 关键词双通道，含中文厂商名）。 */
const CAMERA_VENDORS = ['hikvision', 'dahua', 'uniview', '海康', '大华'];

/** 监控主机名特征：品牌名 + 通用命名约定（cam-/ipc-/nvr）。 */
const RE_CAMERA_HOST = /hikvision|dahua|uniview|\bcam(?:era)?[-_]|[-_]cam\b|\bipc[-_]|\bnvr[-_]|[-_]nvr\b|\bnvr$/i;
/**
 * 移动主机名特征（task-019/021 扩充：鸿蒙 / 小米生态 / 高置信品牌词根）。
 * task-021 新增词根的误伤面评估：oneplus/realme/nokia/zenfone 几乎只出手机；
 * huawei 手机占比高，且路由判定（router/tplink/openwrt 等）在主机名管线中排于
 * mobile 之后才轮到——命中即收，风险可接受；sm-[a-z]\d{3} 是三星机型命名
 * （SM-G991B 等），位数约束防泛匹配。**禁** moto 泛匹配（会误伤 motorola 路由器）。
 */
const RE_MOBILE_HOST = /iphone|ipad|android|redmi|galaxy|pixel|mi-?\d|honor|oppo|vivo|harmony|mibox|xiaoai|oneplus|realme|nokia|zenfone|huawei|sm-[a-z]\d{3}/i;

export function hasPrinterPort(openPorts: readonly number[]): boolean {
  return openPorts.includes(9100) || openPorts.includes(631) || openPorts.includes(515);
}

/**
 * 纯函数：端口优先 → 主机名特征 → OUI → (TTL 弱提示)。
 * @returns osHint 可为 null；kind 可为 'unknown'
 */
export function inferFingerprint(input: FingerprintInput): Fingerprint {
  const ports = input.openPorts;
  const host = (input.hostname ?? '').toLowerCase();
  const vendor = (input.vendor ?? '').toLowerCase();
  const isGateway = input.isGateway === true;

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
  // 2.5) 554 RTSP → 监控摄像/录像机（task-019；局域网内开放 RTSP 的几乎只有 IPC/NVR，
  //      PC 上的流媒体服务极罕见。排在 Windows 之后：Windows 机同时开 554 的优先判 Windows）
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

  // 2.6) mDNS 自报身份（task-020）：放在端口之后、主机名之前——设备自己声明的
  //      服务类型比命名约定可靠；apple 语义是"是 Apple 设备但不定 macOS/iOS"，继续走管线
  if (input.mdnsKind === 'mobile') {
    return { osHint: 'iOS 设备 (mDNS)', kind: 'mobile' };
  }
  if (input.mdnsKind === 'iot') {
    return { osHint: 'IoT 设备 (mDNS)', kind: 'iot' };
  }

  // 3) 主机名特征
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
  if (/router|gateway|gw[-_]|tplink|tenda|openwrt|mikrotik/i.test(host)) {
    return { osHint: '网络设备固件', kind: 'router' };
  }
  if (/-pc$|desktop|laptop|notebook|thinkpad|macbook/i.test(host)) {
    return { osHint: null, kind: 'workstation' };
  }

  // 4) OUI 厂商
  if (vendor) {
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
    if (vendor.includes('cisco') || vendor.includes('ubiquiti') || vendor.includes('h3c') ||
        vendor.includes('zyxel') || vendor.includes('d-link') || vendor.includes('netgear')) {
      return { osHint: '网络设备固件', kind: 'router' };
    }
  }

  // 5) 只有 web 端口的网关 → router
  if (isGateway && (ports.includes(80) || ports.includes(443))) {
    return { osHint: '网络设备固件', kind: 'router' };
  }
  if (isGateway) {
    return { osHint: null, kind: 'router' };
  }

  // 6) TTL 仅作弱提示，不改变 kind
  if (input.ttl !== null && input.ttl >= 240) {
    return { osHint: '嵌入式/网络设备固件（TTL 弱提示）', kind: 'unknown' };
  }
  return { osHint: null, kind: 'unknown' };
}
