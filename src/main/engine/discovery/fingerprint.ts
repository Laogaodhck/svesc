/**
 * 设备指纹推断。**只用端口 / 自报协议（WS-Discovery / SSDP / mDNS / HTTP 管理页）/
 * 主机名特征 / OUI 厂商**，TTL 仅在无任何信号时给一句弱提示，绝不单独用于判定
 * workstation/server（investigation-report.md §2.10/§9.7 实测：网关 TTL=64、
 * SHARP 打印机 TTL=255，经典 TTL→OS 规则在本机失效）。拿不准就返回 null / 'unknown'，不猜。
 *
 * task-023 精度改造：
 *  - 新增"自报身份层"：ONVIF WS-Discovery（摄像头）、SSDP（路由/AP/IoT）是设备自己声明
 *    的身份，优先级仅次于打印机端口与 Windows 管理端口；
 *  - 网关判定提前到 OUI 之前（默认网关是硬事实，避免 Huawei ONU/手机同厂商误判）；
 *  - 手机厂商 OUI 在"非网关 + 无管理端口"时给 mobile（osHint 明示是厂商推断）；
 *  - 主机名新增 平板/交换机/AP 词根；mDNS 服务表扩到 17 个。
 *
 * task-028 识别增强（手机/监控识别不出来）：
 *  - OUI 扩充表改为 IEEE 全量（4 万条，无白名单截断），旧表把大厂前缀砍到 20~40 条；
 *  - 厂商名匹配从 `includes()` 子串改为**整词/词组**匹配：'vivo' 不再误命中
 *    'VIVOTEK'，'asus' 通过 'asustek' 别名命中，'tp-link' 兼容 'TP-LINK' 与 'TpLink'；
 *  - 厂商类别表按"只做这类产品"原则扩表，并把 HP/Canon/Samsung/Sharp 等
 *    "打印机 + PC/手机/相机"双料厂商从打印机表移出（无打印端口时 OUI 不足以判打印机）；
 *  - 随机化 MAC 设备给出"私有 MAC"提示，而不是留一行空白。
 *
 * task-031 类型/主板识别强化：
 *  - 新增**主板厂商识别引擎**：ASUSTek/GIGA-BYTE/Micro-Star/ASRock 等板卡厂
 *    自产网卡 OUI = 主板厂商的强特征。Windows/SMB 等既有判定不被推翻，
 *    但 osHint 追加"华硕主板（OUI ASUSTek）"；仅凭 OUI 判 PC 时同样注明板卡厂；
 *  - 135/139（RPC/NetBIOS）并入 Windows 端口证据（与 445 同级）；
 *  - 22/SSH 增加"路由器特征"守卫：OpenWrt/MikroTik 等必开 SSH，仅凭 22 端口
 *    不再截胡成 workstation——主机名/厂商有路由器特征时判 router；
 *  - mDNS apple 自报不再被"随机 MAC"文案吞掉（随机 MAC 的 iPhone/Mac 常见形态）；
 *  - 主机名补 XiaoQiang（小米路由器默认名）；Realtek 网卡芯片给弱提示不判类型。
 */
import type { DeviceKind } from '../../../shared/types';
import type { HttpFingerprintKind } from './http-fingerprint';

export interface FingerprintInput {
  openPorts: readonly number[];
  hostname: string | null;
  vendor: string | null;
  ttl: number | null;
  /** 设备自身 MAC（task-029）：用于"与网关同源 MAC"识别。 */
  mac?: string | null;
  /** 网关 MAC（task-029）：由调用方从 ARP 记录取出传入；拿不到为 null。 */
  gatewayMac?: string | null;
  isGateway?: boolean;
  /** mDNS 自报身份（task-020/028）：设备自己声明服务类型，比主机名正则更可靠。apple 不定类型仅佐证。 */
  mdnsKind?: 'iot' | 'mobile' | 'apple' | 'workstation' | 'printer' | 'camera' | 'ap' | 'tablet' | null;
  /** mDNS TXT 自报型号（如 `model=MacBookPro18,3` / `model=iPhone14,5`），仅展示用途。 */
  mdnsOsHint?: string | null;
  /** WS-Discovery 自报（task-023）：ipc=网络摄像机，nvr=录像机。 */
  wsdiscoveryKind?: 'ipc' | 'nvr' | null;
  /** ONVIF 设备服务自报（task-028）：GetSystemDateAndTime 有响应即 ONVIF 设备。 */
  onvifKind?: 'camera' | null;
  /** SSDP deviceType 自报（task-023/027）。kind=null 时只有 osHint 兜底意义（如 MediaServer）。 */
  ssdpKind?: 'router' | 'ap' | 'iot' | 'camera' | 'printer' | null;
  ssdpOsHint?: string | null;
  /** HTTP 管理页指纹（task-027）：分类与 osHint 由 http-fingerprint 模块给出。 */
  httpKind?: HttpFingerprintKind | null;
  httpOsHint?: string | null;
}

export interface Fingerprint {
  osHint: string | null;
  kind: DeviceKind;
}

/**
 * 厂商名整词匹配（task-028）。
 *
 * 旧实现 `vendor.includes('vivo')` 会把 VIVOTEK 摄像机判成 vivo 手机；
 * 全量 IEEE 表里厂商名是完整法律名（"HONOR DEVICE"、"ASUSTek COMPUTER"），
 * 子串匹配的误伤面只会更大。这里把厂商名与关键词都切成小写词序列，
 * 再做**连续词序列**比较：'tp-link' 匹配 "TP-LINK TECHNOLOGIES"，
 * 'vivo' 不匹配 "VIVOTEK"。多词关键词（'konica minolta'）同样成立。
 *
 * 别名用 `|` 分隔（'asus|asustek'），用来兜住同一品牌的多种注册名。
 */
function vendorWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function containsWordRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** 厂商名是否命中关键词表（整词匹配；关键词可含 `|` 别名）。 */
export function vendorMatches(vendor: string, list: readonly string[]): boolean {
  const words = vendorWords(vendor);
  if (words.length === 0) return false;
  for (const entry of list) {
    for (const alias of entry.split('|')) {
      if (containsWordRun(words, vendorWords(alias))) return true;
    }
  }
  return false;
}

/**
 * 打印机厂商（task-028 收紧）：只留"基本只做打印/影像输出"的厂商。
 * HP/Canon/Samsung/Sharp/Toshiba 同时做 PC、手机、电视——OUI 无法区分，
 * 强行判 printer 会把 HP 笔记本标成打印机。这些厂商若无 9100/631/515 打印端口，
 * 就如实停在 unknown（厂商名照常展示），不猜。
 */
const PRINTER_VENDORS = [
  'epson|seiko epson',
  'brother|brother industries',
  'xerox',
  'ricoh',
  'kyocera',
  'lexmark',
  'konica minolta',
  'toshiba tec',
  'fuji xerox',
  'pantum',
  'oki data|oki electric',
  'zebra technologies',
];

const NAS_VENDORS = ['synology', 'qnap', 'asustor', 'terramaster', 'drobo'];

/** IoT / 智能家居厂商（task-028）：只做家电、传感、照明、扫地机等联网终端。 */
const IOT_VENDORS = [
  'espressif',
  'raspberry pi',
  'sonos',
  'tuya',
  'haier',
  'midea',
  'gree',
  'roborock',
  'ecovacs',
  'dreame',
  'aqara|lumi united',
  'shelly|allterco',
  'meross',
  'switchbot|woan technology',
  'itead|sonoff',
  'signify|philips lighting',
  'yeelight',
  'broadlink',
];

/**
 * 电视/影音厂商（task-027）：这些品牌以电视/机顶盒/影音为主——
 * OUI 命中即可推 iot。小米/华为不在此表（同厂商手机优先走 PHONE_VENDORS，
 * 其电视靠主机名词根 mitv/androidtv 认出）。
 */
const TV_VENDORS = ['tcl', 'hisense', 'skyworth', 'coocaa', 'changhong', 'roku', 'vizio'];

/**
 * PC 整机厂商（task-028）：ASUS 通过 'asustek' 别名命中；MSI 注册名是
 * "Micro-Star INTL"。Intel 是 PC 网卡/整机主力。均带管理端口反证守卫。
 * ODM（Compal/Quanta/Pegatron…）不进表：它们同时代工手机、平板、游戏机。
 */
const PC_VENDORS = [
  'intel',
  'dell',
  'lenovo',
  'microsoft',
  'acer',
  'msi|micro star',
  'gigabyte',
  'asrock',
  'supermicro',
  'fujitsu',
  'asus|asustek',
  'clevo',
  'tongfang',
  'hasee',
];

/**
 * 监控摄像厂商（task-019：OUI 表 + vendor 关键词双通道；
 * task-023 补 ezviz/imou/axis/xiongmai；task-027 补 foscam/reolink/amcrest/
 * vivotek/lorex/swann/hanwha/pelco/avigilon；task-028 补 wheatek/tiandy/
 * kedacom/bosch/mobotix/geovision/wyze/ring/arlo/nest/eufy/tapo）。
 * 海康/大华等厂商名在 IEEE 表里是英文，整词匹配不受中文别名影响。
 */
const CAMERA_VENDORS = [
  'hikvision',
  'dahua',
  'uniview',
  'ezviz',
  'imou',
  'axis',
  'xiongmai|xiong mai',
  'foscam',
  'reolink',
  'amcrest',
  'vivotek',
  'lorex',
  'swann',
  'hanwha|hanwha techwin',
  'pelco',
  'avigilon',
  'wheatek',
  'tiandy',
  'kedacom',
  'bosch security',
  'mobotix',
  'geovision',
  'wyze',
  'ring llc|ring',
  'arlo',
  'nest labs|nest',
  'eufy',
  'tapo',
];

/**
 * 手机/平板厂商 OUI（task-023/028 生态扩充）。命中且"非网关 + 无管理端口"时给
 * mobile —— 厂商本身不区分手机/路由器/电视（Huawei 光猫、Samsung 电视同厂商名），
 * 所以必须排除相反证据：管理端口（80/443/8080/SMB/RDP）开放时不判 mobile。
 * task-028 补 meizu/zte/nubia/hmd/nothing/fairphone/iqoo。zte 同时是光猫/路由器
 * 大厂——光猫几乎必开 80 管理页，反证守卫可挡住绝大多数误判。
 */
const PHONE_VENDORS = [
  'samsung',
  'huawei',
  'honor',
  'xiaomi',
  'oppo',
  'vivo',
  'oneplus',
  'realme',
  'google',
  'motorola|motorola mobility',
  'meizu',
  'zte',
  'nubia',
  'hmd',
  'nothing',
  'fairphone',
  'iqoo',
];

/** 网络设备厂商（ruijie/mikrotik/fortinet/aruba 为 task-023 扩充表新增；task-028 补 linksys/mercury/netcore/netis/edimax/belkin/cudy/gl.inet/jcg/ONT 厂商）。 */
const NETWORK_VENDORS = [
  'cisco',
  'juniper',
  'ubiquiti',
  'h3c',
  'zyxel',
  'd-link|d link',
  'netgear',
  'tp-link|tp link',
  'tenda',
  'huawei',
  'ruijie',
  'mikrotik',
  'fortinet',
  'aruba',
  'linksys',
  'mercury',
  'netcore',
  'netis',
  'edimax',
  'belkin',
  'cudy',
  'gl.inet|gl inet|gl technologies',
  'jcg',
  'sonicwall',
  'watchguard',
  'sophos',
  'palo alto',
  'extreme networks',
  'avm|fritz',
  'actiontec',
  'sagemcom',
  'sercomm',
  'calix',
  'fiberhome',
  'nokia shanghai bell',
  'raisecom',
  'maipu',
  'gongjin',
];

/**
 * 无线 AP 专业厂商（task-028 生态扩充）：AP/CPE 为主的品牌，OUI 命中即可推 ap。
 * Cisco Meraki 刻意不进表（MS 交换机/MX 路由器同名，企业环境常见）；华为/小米
 * 等"手机+路由"双料厂商也不进（走 PHONE/主机名通道）。Ruckus 等企业品牌偶有
 * 交换机，但主机名/管理端口通道可纠偏。
 */
const AP_VENDORS = ['ruckus', 'engenius', 'openmesh', 'wavlink', 'comfast', 'cambium'];


const RE_MOBILE_HOST = /iphone|android|redmi|poco|galaxy|pixel|mi-?\d|honor|oppo|vivo|harmony|oneplus|realme|nokia|zenfone|huawei|sm-[a-z]\d{3}|xperia|sony[-_ ]?xperia|moto[-_ ]|meizu|redmagic|nubia|iqoo/i;

/** 监控主机名特征：品牌名 + 通用命名约定（cam-/ipc-/nvr）。task-023 加 consumer 品牌；task-028 补 foscam/reolink/amcrest/vivotek/hanwha/swann/lorex/v380；task-034 补 dvr/cctv/ipcam/xiaobai(小米摄像机)/chuangmi(米家摄像机)。 */
const RE_CAMERA_HOST = /hikvision|dahua|uniview|ezviz|imou|tpipc|foscam|reolink|amcrest|vivotek|hanwha|swann|lorex|\bv380\b|\bcam(?:era)?[-_]|[-_]cam\b|\bipc[-_]|\bnvr[-_]|[-_]nvr\b|\bnvr$|\bdvr\b|cctv|ipcam|xiaobai|chuangmi[-_ ]?cam/i;

/** 平板词根（task-023；task-034 补三星/联想/国产 Pad 命名）。必须判在 mobile 之前（'ipad' 同时命中 mobile 词根）。 */
const RE_TABLET_HOST = /ipad|matepad|tablet|mi[-_ ]?pad|galaxy[-_ ]?tab|\btb[-_]?3\d{2}\w*|(?:huawei|honor|oppo|redmi|xiaomi)[-_ ]?pad/i;

/**
 * 电视/机顶盒/游戏主机词根（task-027）。必须判在 mobile 之前：
 * 'androidtv' 含 'android'（手机词根），'xiaomi-tv' 含手机厂商词。
 * 'shield' 仅指 NVIDIA Shield 主机；'xbox' 是 Microsoft 主机（OUI 层之前认出）。
 */
const RE_TV_HOST = /android[-_ ]?tv|google[-_ ]?tv|mi[-_ ]?tv|mitv|xiaomi[-_ ]?tv|apple[-_ ]?tv|appletv|bravia|chromecast|fire[-_ ]?tv|tv[-_ ]?box|xbox|shield|hisense|skyworth|coocaa|changhong|webox|小爱|电视|机顶盒|\bmibox/i;

/** 交换机词根（task-023）：switch/sw+编号。仅主机名证据，不猜。 */
const RE_SWITCH_HOST = /switch|交换机|\bsw[-_]?\d{1,3}\b/i;

/**
 * 智能家居词根（task-034）：米家生态默认主机名 + 通用 IoT 命名。
 * 判在 mobile 之前——'xiaoai'（小爱音箱）、'mibox'（小米盒子）此前误挂在手机词根里，
 * 实为影音/IoT；扫地机（roborock/roomba/vacuum）、米家传感器等主机名自报形态一并收口。
 */
const RE_IOT_HOST = /\bmijia\b|米家|roborock|roomba|irobot|yeelink|aqara|broadlink|switchbot|\btuya\b|\bvacuum\b|扫地机|xiaoai/i;

/** 无线 AP 词根（task-023）：ap+编号 / wireless ap / wap+编号。task-028 补 unifi/专业 AP 品牌词；task-034 补 mesh 节点（Mesh 子节点即 AP 形态）。 */
const RE_AP_HOST = /\bap[-_]?\d{1,3}\b|wireless.?ap|\bwap[-_]?\d{1,3}\b|unifi|wavlink|comfast|ruckus|engenius|edimax|airport|\bmesh[-_]?(?:node|sub|satellite)?\b/i;

export function hasPrinterPort(openPorts: readonly number[]): boolean {
  return openPorts.includes(9100) || openPorts.includes(631) || openPorts.includes(515);
}

/** 管理端口开放（手机厂商 OUI 判 mobile 的相反证据）。 */
function hasAdminPort(ports: readonly number[]): boolean {
  return ports.some((p) => p === 80 || p === 443 || p === 8080 || p === 445 || p === 22 || p === 3389);
}

/**
 * 主板/板卡厂商识别（task-031）。
 *
 * 依据：华硕/技嘉/微星/华擎等板卡厂给自产主板配**自家品牌网卡**（IEEE 注册名
 * 如 "ASUSTek COMPUTER"），网段内 PC 的 OUI 命中即主板厂商强特征。表值是
 * 中文品牌名（设备列表展示用）。不进表的：Intel（2016 年后不做主板）、
 * Realtek（网卡芯片厂，PC/家电/监控通用，见 REALTEK_HINT）、Foxconn/纬创等
 * 代工厂（同时代工全行业）。GPU 厂商（七彩虹/索泰/蓝宝石）同样自产迷你主机
 * 与板卡，一并收录。
 */
const MOTHERBOARD_VENDORS: readonly (readonly [match: string, zh: string])[] = [
  ['asus|asustek', '华硕'],
  ['gigabyte|giga byte', '技嘉'],
  ['msi|micro star', '微星'],
  ['asrock', '华擎'],
  ['supermicro', '超微'],
  ['biostar', '映泰'],
  ['colorful', '七彩虹'],
  ['zotac', '索泰'],
  ['sapphire', '蓝宝石'],
  ['maxsun', '铭瑄'],
  ['onda', '昂达'],
  ['yeston', '盈通'],
  ['soyo', '梅捷'],
  ['evga', 'EVGA'],
];

/** 从 OUI 厂商名识别主板/板卡厂商（整词匹配）。@returns 中文品牌名或 null。 */
export function detectMotherboardVendor(vendor: string): string | null {
  if (!vendor) return null;
  for (const [match, zh] of MOTHERBOARD_VENDORS) {
    if (vendorMatches(vendor, [match])) return zh;
  }
  return null;
}

/**
 * 给已确定的 osHint 追加主板厂商信息（task-031）。
 * 不改变判定本身——Windows (SMB) 就是 Windows，主板厂商只是补充证据展示。
 * 形如 `Windows (SMB) · 华硕主板（OUI ASUSTek COMPUTER）`。
 */
function withBoardHint(hint: string, rawVendor: string | null): string {
  const zh = rawVendor ? detectMotherboardVendor(rawVendor) : null;
  return zh ? `${hint} · ${zh}主板（OUI ${rawVendor}）` : hint;
}

/**
 * 两个 MAC 是否"同源但本地管理位变体"（task-029 纯函数）。
 * 判据：第 2~6 字节完全一致、且第 1 字节不同——这是 EasyMesh/MLO 等机制
 * 从主机 MAC 派生本地管理位虚拟接口的真实特征（尾段继承、首字节改写）。
 * 尾段 40 bit 随机撞车概率 ≈ 2⁻⁴⁰，作为提示证据可靠；返回 true 时不判设备类型。
 */
export function gatewaySuffixMac(macA: string, macB: string): boolean {
  const na = normalizeMacLocal(macA);
  const nb = normalizeMacLocal(macB);
  if (!na || !nb) return false;
  if (na.slice(2) !== nb.slice(2)) return false;
  return na.slice(0, 2) !== nb.slice(0, 2);
}

/** 归一化到 12 位十六进制小写（非法/非标准写法返回 null）。复用 oui 的规整思路但保持本模块零依赖。 */
function normalizeMacLocal(mac: string): string | null {
  const t = mac.trim().toLowerCase();
  if (/^[0-9a-f]{2}(?:[-:][0-9a-f]{2}){5}$/.test(t)) return t.replace(/[^0-9a-f]/g, '');
  if (/^[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}$/.test(t)) return t.replace(/[^0-9a-f]/g, '');
  return null;
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
  const withModel = (base: string): string => (input.mdnsOsHint ? `${base}：${input.mdnsOsHint}` : base);

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
  //    task-031：OUI 是板卡厂（ASUSTek 等）时把主板厂商追加进 osHint——
  //    板卡厂自产网卡的 OUI = 主板厂商强特征，判定不变、信息更完整
  if (ports.includes(445)) {
    return { osHint: withBoardHint('Windows (SMB)', input.vendor), kind: 'workstation' };
  }
  if (ports.includes(3389)) {
    return { osHint: withBoardHint('Windows (RDP)', input.vendor), kind: 'workstation' };
  }
  // task-031：135 (RPC 端点映射) / 139 (NetBIOS) 与 445 同为 Windows 标配端口，
  // 445 被防火墙单独关掉而 135/139 开放的 Windows 主机此前会漏判
  if (ports.includes(135) || ports.includes(139)) {
    return { osHint: withBoardHint('Windows (RPC/NetBIOS)', input.vendor), kind: 'workstation' };
  }

  // 2.5) 自报身份层（task-023）：WS-Discovery / SSDP 是设备自己声明的身份，
  //      置信度仅次于直接端口证据；同层内部 camera > ap > router(IGD)。
  if (input.wsdiscoveryKind === 'ipc') {
    return { osHint: '网络摄像机 (ONVIF)', kind: 'camera' };
  }
  if (input.wsdiscoveryKind === 'nvr') {
    return { osHint: 'NVR 录像机 (ONVIF)', kind: 'camera' };
  }
  // ONVIF 设备服务响应（task-028）：GetSystemDateAndTime 有合法 SOAP 响应，
  // 说明设备确实跑着 ONVIF 服务；IPC/NVR 都归 camera（与 WS-Discovery 语义一致）。
  if (input.onvifKind === 'camera') {
    return { osHint: 'ONVIF 摄像机（设备服务自报）', kind: 'camera' };
  }
  if (input.ssdpKind === 'ap') {
    return { osHint: input.ssdpOsHint ?? '无线AP (UPnP)', kind: 'ap' };
  }
  if (input.ssdpKind === 'camera') {
    return { osHint: input.ssdpOsHint ?? '网络摄像机 (UPnP)', kind: 'camera' };
  }
  if (input.ssdpKind === 'printer') {
    return { osHint: input.ssdpOsHint ?? '打印机 (UPnP)', kind: 'printer' };
  }
  if (input.ssdpKind === 'router') {
    return { osHint: input.ssdpOsHint ?? 'UPnP IGD（网关）', kind: 'router' };
  }

  // 2.6) mDNS 自报身份（task-020/023 扩充）：apple 语义是"是 Apple 设备但不定
  //      macOS/iOS"，继续走管线
  if (input.mdnsKind === 'mobile') {
    return { osHint: withModel('iOS 设备 (mDNS)'), kind: 'mobile' };
  }
  if (input.mdnsKind === 'tablet') {
    return { osHint: withModel('平板设备 (mDNS)'), kind: 'tablet' };
  }
  if (input.mdnsKind === 'camera') {
    return { osHint: '摄像机 (mDNS 自报)', kind: 'camera' };
  }
  if (input.mdnsKind === 'printer') {
    return { osHint: '打印机 (mDNS 自报)', kind: 'printer' };
  }
  if (input.mdnsKind === 'workstation') {
    return { osHint: withModel('PC (mDNS 自报)'), kind: 'workstation' };
  }
  if (input.mdnsKind === 'ap') {
    return { osHint: '无线AP (mDNS 自报)', kind: 'ap' };
  }
  if (input.mdnsKind === 'iot') {
    return { osHint: 'IoT 设备 (mDNS)', kind: 'iot' };
  }

  // 2.7) SSDP MediaRenderer → iot（plan 规定排在 mDNS 之后：手机开热点共享投屏
  //      等场景下 mDNS 的 mobile 自报更可信）
  if (input.ssdpKind === 'iot') {
    return { osHint: input.ssdpOsHint ?? '投屏/音响 (UPnP)', kind: 'iot' };
  }

  // 2.8) HTTP 管理页自报（task-027）：title/Server 头恰好命中 1 类才到这里
  //      （≥2 类命中在 http-fingerprint 层就被降为 null），属设备 Web 服务自报身份，
  //      排在端口信号之前——管理页型号名比"开着一个端口"更具体。
  if (input.httpKind) {
    return { osHint: input.httpOsHint ?? '管理页自报', kind: input.httpKind };
  }

  // 3) 其余端口信号
  if (ports.includes(554)) {
    return { osHint: '监控摄像固件 (RTSP)', kind: 'camera' };
  }
  if (ports.includes(8554)) {
    return { osHint: '监控摄像固件 (RTSP 备用)', kind: 'camera' };
  }
  // task-028 监控生态私有端口：34567（雄迈/大华系 DVR 常见）、9527（雄迈系 Web/私有）
  if (ports.includes(34567)) {
    return { osHint: '监控摄像/录像机 (私有端口)', kind: 'camera' };
  }
  if (ports.includes(9527)) {
    return { osHint: '监控摄像固件 (私有端口)', kind: 'camera' };
  }
  // task-028：8800 是 V380 等消费级 IPC 的媒体/管理口（与 554 RTSP 常同时开放）
  if (ports.includes(8800)) {
    return { osHint: '监控摄像固件 (私有端口)', kind: 'camera' };
  }
  // task-028：6668 是涂鸦（Tuya）生态设备私有口——插座/灯/传感器，不是摄像头
  if (ports.includes(6668)) {
    return { osHint: '涂鸦生态设备 (私有端口)', kind: 'iot' };
  }
  if (ports.includes(8009)) {
    return { osHint: 'Chromecast 内置投屏', kind: 'iot' };
  }
  if (ports.includes(32400)) {
    return { osHint: 'Plex 媒体服务器', kind: 'server' };
  }
  if (ports.includes(22)) {
    // task-031 守卫：OpenWrt/MikroTik/Ubiquiti 等路由器**默认开 SSH**，
    // 仅凭 22 端口判 workstation 会把这类设备截胡成 PC——主机名/厂商有
    // 路由器特征时优先判 router（网络设备固件）
    const routerishHost = /router|openwrt|routeros|mikrotik|ubiquiti|unifi|padavan|asuswrt|miwifi|hiwifi/i.test(host);
    if (routerishHost || vendorMatches(vendor, ['mikrotik|mikrotikls', 'ubiquiti', 'routerboard'])) {
      return { osHint: '网络设备固件 (SSH)', kind: 'router' };
    }
    return { osHint: withBoardHint('Linux/Unix (SSH)', input.vendor), kind: 'workstation' };
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
  // 电视/机顶盒词根在 mobile 之前：'androidtv-客厅' 含手机词根 'android'（task-027）
  if (RE_TV_HOST.test(host)) {
    return { osHint: '电视/影音设备（主机名特征）', kind: 'iot' };
  }
  // 智能家居词根在 mobile 之前（task-034）：'xiaoai-音箱' 若落在手机词根会误判 mobile
  if (RE_IOT_HOST.test(host)) {
    return { osHint: '智能家居/IoT 设备（主机名特征）', kind: 'iot' };
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
  if (/nas|synology|qnap|fileserver|server|\bdc[-_]?\d|\bad[-_]?\d/i.test(host)) {
    return { osHint: null, kind: 'server' };
  }
  if (RE_SWITCH_HOST.test(host)) {
    return { osHint: '交换机（主机名特征）', kind: 'switch' };
  }
  if (RE_AP_HOST.test(host)) {
    return { osHint: '无线AP（主机名特征）', kind: 'ap' };
  }
  if (/router|gateway|gw[-_]|tplink|tenda|openwrt|mikrotik|miwifi|hiwifi|newifi|gl-inet|cudy|linksys|asuswrt|padavan|xiaoqiang|\brt-(?:ax|ac|n|be)\d|\bon[ut]\b|光猫/i.test(host)) {
    return { osHint: '网络设备固件', kind: 'router' };
  }
  if (/-pc$|desktop|laptop|notebook|thinkpad|thinkbook|macbook|ideapad|legion|latitude|vostro|inspiron|alienware|elitebook|probook|pavilion|spectre|vivobook|zenbook|clevo|\b(?:omen|tuf|yoga)\b|\bnuc(?:[-_ ]?\d+)?\b/i.test(host)) {
    return { osHint: null, kind: 'workstation' };
  }

  // 6) OUI 厂商（整词匹配，见 vendorMatches）
  if (vendor) {
    // 摄像厂商先于手机厂商：整词匹配后 'vivo' 已不会误命中 'VIVOTEK'，
    // 但保留顺序作为双保险（摄像机识别优先于手机）。
    if (vendorMatches(vendor, CAMERA_VENDORS)) {
      return { osHint: '监控摄像固件', kind: 'camera' };
    }
    // 手机/平板厂商先于打印机厂商：Samsung 同时是手机与打印机厂商（手写表里的
    // Samsung 前缀是打印机、IEEE 扩充表里是手机），无端口时打印机本来就无证据；
    // 有打印端口的设备早在第 1 步就按端口判定了。
    if (vendorMatches(vendor, PHONE_VENDORS) && !hasAdminPort(ports)) {
      // 仅当无相反证据（非网关已保证、无管理端口）时给 mobile；
      // osHint 明示这是厂商推断，不是设备自报
      return { osHint: `移动设备（OUI 厂商 ${input.vendor} 推断）`, kind: 'mobile' };
    }
    if (vendorMatches(vendor, PRINTER_VENDORS)) {
      return { osHint: '打印机固件', kind: 'printer' };
    }
    if (vendorMatches(vendor, NAS_VENDORS)) {
      return { osHint: null, kind: 'server' };
    }
    if (vendorMatches(vendor, IOT_VENDORS)) {
      return { osHint: `智能家居/IoT 设备（OUI 厂商 ${input.vendor} 推断）`, kind: 'iot' };
    }
    if (vendorMatches(vendor, TV_VENDORS)) {
      // TCL/海信/创维/酷开/长虹/Roku/Vizio 以电视/机顶盒/影音为主（task-027）
      return { osHint: `电视/影音设备（OUI 厂商 ${input.vendor} 推断）`, kind: 'iot' };
    }
    if (vendorMatches(vendor, AP_VENDORS)) {
      // Ruckus/EnGenius/OpenMesh/WavLink/COMFAST/Cambium 以 AP/CPE 为主（task-028）
      return { osHint: `无线AP（OUI 厂商 ${input.vendor} 推断）`, kind: 'ap' };
    }
    if (vendorMatches(vendor, ['apple'])) {
      // Apple 的 OUI 不区分 macOS/iOS：主机名没认出来就如实给提示，不猜具体类型
      return { osHint: 'Apple 设备（macOS/iOS，待主机名确认）', kind: 'unknown' };
    }
    if (vendorMatches(vendor, ['vmware', 'virtualbox', 'hyper-v'])) {
      return { osHint: '虚拟机', kind: 'server' };
    }
    if (vendorMatches(vendor, NETWORK_VENDORS)) {
      return { osHint: '网络设备固件', kind: 'router' };
    }
    // task-031：板卡厂（ASUSTek/GIGA-BYTE/…）自产网卡 OUI = 主板厂商强特征，
    // 优先于通用 PC_VENDORS 兜底；守卫与 PC_VENDORS 一致（管理端口开放时
    // 可能是路由器/管理设备，不猜）
    const boardZh = detectMotherboardVendor(input.vendor ?? '');
    if (boardZh && !hasAdminPort(ports)) {
      return { osHint: `PC/工作站（${boardZh}主板特征：OUI ${input.vendor} 推断）`, kind: 'workstation' };
    }
    if (vendorMatches(vendor, PC_VENDORS) && !hasAdminPort(ports)) {
      // PC 整机厂商是最后的 OUI 兜底（task-027/028）：无管理端口反证时才推
      // workstation；osHint 明示是厂商推断。网卡芯片厂商（Realtek）不进表。
      return { osHint: `PC/工作站（OUI 厂商 ${input.vendor} 推断）`, kind: 'workstation' };
    }
  }

  // 7) SSDP 仅 osHint 兜底（MediaServer 等）：kind 已无从判定，但身份描述仍真实
  if (input.ssdpOsHint) {
    return { osHint: input.ssdpOsHint, kind: 'unknown' };
  }
  // 7.5) HTTP 管理页 title 原文兜底（task-027）：未命中任何类别时仍是真实自报文案
  if (input.httpOsHint) {
    return { osHint: input.httpOsHint, kind: 'unknown' };
  }

  // 7.8) 随机化 MAC：厂商确实不可判，但"为什么查不到厂商"本身是真实信息
  //      task-029：随机 MAC 在现网几乎全部来自手机/平板的 MAC 随机化（安卓 10+/
  //      iOS 14+ 默认按 SSID 随机），用户反馈"手机识别不出来"的主要形态就是这一类；
  //      文案如实说明统计成因（"多为"是统计陈述，不是对单台设备的判定）。
  //      另：本地管理位 MAC 若 MAC 尾段与网关一致，是路由器虚拟接口/子节点的
  //      真实特征（EasyMesh/MLO 等机制用本地管理位派生 MAC，尾段继承主机），
  //      单独标注（kind 仍 unknown——机制不唯一，不下设备类型结论）。
  // 7.7) mDNS apple 自报（task-031）：随机 MAC 的 iPhone/Mac 是常见形态——
  //      MAC 随机化导致 OUI 不可判，但设备已通过 mDNS 自报 Apple 生态。
  //      _companion-link 等服务 macOS/iOS 共用，apple 不定具体类型，kind 仍 unknown，
  //      但 osHint 必须保留自报证据（此前会被"随机 MAC"文案吞掉）
  if (input.mdnsKind === 'apple') {
    return { osHint: 'Apple 设备 (mDNS 自报，macOS/iOS 不定)', kind: 'unknown' };
  }

  if (input.mac && input.gatewayMac) {
    const suffix = gatewaySuffixMac(input.mac, input.gatewayMac);
    if (suffix) {
      return { osHint: 'MAC 尾段与网关一致（本地管理位变体，疑似路由器虚拟接口/Mesh 子节点）', kind: 'unknown' };
    }
  }
  if (vendor.includes('随机 mac')) {
    return { osHint: '私有 MAC（随机化地址，厂商不可判；多为手机/平板的 MAC 随机化）', kind: 'unknown' };
  }
  // task-031：Realtek 是网卡芯片厂而非主板/整机厂，PC/家电/监控通用——
  // 不判类型，但把"为什么 unknown"的真实原因亮出来
  if (vendorMatches(vendor, ['realtek|realtek semiconductor'])) {
    return { osHint: 'Realtek 网卡芯片（PC/家电/监控均常用，不作类型判定）', kind: 'unknown' };
  }

  // 8) TTL 仅作弱提示，不改变 kind
  if (input.ttl !== null && input.ttl >= 240) {
    return { osHint: '嵌入式/网络设备固件（TTL 弱提示）', kind: 'unknown' };
  }
  // 9) 最终兜底（task-034）：unknown 必须带原因——"识别不出来"本身要说明
  //    是哪一层证据全部缺失，而不是留空白让用户无从判断
  const reasons: string[] = [];
  if (ports.length === 0) reasons.push('无开放端口');
  if (!input.hostname) reasons.push('无主机名');
  if (!input.vendor || input.vendor.includes('随机 mac')) reasons.push('OUI 不可判');
  return { osHint: `无证据可判（${reasons.join('、') || '主机名/OUI/端口均无可识别线索'}）`, kind: 'unknown' };
}
