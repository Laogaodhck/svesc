/**
 * OUI（MAC 前缀）厂商表。
 * 只收录常见厂商，未命中一律返回 null —— 不猜、不按概率归类（数据诚实原则）。
 * 键格式统一为小写连字符前 3 段：`00-e0-4c`。
 */

/** ≥60 条常见 OUI 前缀（打印机 / 网络设备 / 终端 / 虚拟化）。 */
export const OUI_TABLE: Readonly<Record<string, string>> = {
  // —— 打印机 / 复合机 ——
  '00-00-85': 'Canon',
  '00-1e-8f': 'Canon',
  '2c-9e-fc': 'Canon',
  '88-87-17': 'Canon',
  'f4-81-39': 'Canon',
  '8c-8e-f2': 'Canon',
  '00-00-48': 'Epson',
  '38-9d-92': 'Epson',
  '44-d2-44': 'Epson',
  'a4-ee-57': 'Epson',
  '64-eb-8c': 'Epson',
  '00-80-77': 'Brother',
  '30-05-5c': 'Brother',
  '3c-2a-f4': 'Brother',
  '80-86-f2': 'Brother',
  'b4-22-00': 'Brother',
  '00-00-aa': 'Xerox',
  '9c-93-4e': 'Xerox',
  '00-1b-a9': 'Xerox',
  '5c-e0-c5': 'Xerox',
  '20-80-58': 'Xerox',
  '00-00-74': 'Ricoh',
  '00-26-73': 'Ricoh',
  '58-38-79': 'Ricoh',
  'e0-dc-a0': 'Ricoh',
  '00-17-c8': 'Kyocera',
  '00-c0-ee': 'Kyocera',
  '60-03-08': 'Kyocera',
  '00-04-00': 'Lexmark',
  '00-21-b7': 'Lexmark',
  '00-24-04': 'Lexmark',
  '90-b1-1c': 'Lexmark',
  '00-00-f0': 'Samsung',
  '00-15-99': 'Samsung',
  '5c-49-7d': 'Samsung',
  '8c-77-12': 'Samsung',
  '3c-d9-2b': 'HP',
  '00-1f-29': 'HP',
  '00-25-b3': 'HP',
  '9c-b6-54': 'HP',
  '2c-41-38': 'HP',
  '30-e1-71': 'HP',
  '94-57-a5': 'HP',
  'b0-5a-da': 'HP',
  '00-1b-78': 'Sharp',
  '00-00-11': 'Sharp',
  '08-00-37': 'Fuji Xerox',
  '00-00-0e': 'Fuji Xerox',
  '00-40-af': 'Konica Minolta',
  '00-20-6b': 'Konica Minolta',
  '00-00-9e': 'Toshiba',
  '00-80-91': 'Toshiba',
  '00-00-4c': 'NEC',
  '00-26-ab': 'Murata',

  // —— 网络设备 ——
  '00-0a-eb': 'TP-Link',
  '50-c7-bf': 'TP-Link',
  '98-da-c4': 'TP-Link',
  'ac-84-c6': 'TP-Link',
  '00-e0-fc': 'Huawei',
  '28-6e-d4': 'Huawei',
  '48-46-fb': 'Huawei',
  '70-54-f5': 'Huawei',
  '00-09-5b': 'Netgear',
  '20-4e-7f': 'Netgear',
  '9c-3d-cf': 'Netgear',
  '00-1b-11': 'D-Link',
  '14-d6-4d': 'D-Link',
  '00-23-89': 'H3C',
  '3c-8c-40': 'H3C',
  '00-1b-54': 'Cisco',
  '00-26-0b': 'Cisco',
  '00-13-49': 'Zyxel',
  '24-5a-4c': 'Ubiquiti',
  '78-8a-20': 'Ubiquiti',
  'c8-3a-35': 'Tenda',
  '00-1a-92': 'ASUS',
  '04-d4-c4': 'ASUS',
  '2c-56-dc': 'ASUS',

  // —— 监控摄像（task-019 识别增强：海康/大华系为国内存量最大的两类 IPC）——
  '44-47-cc': 'Hikvision',
  'c0-56-e3': 'Hikvision',
  '90-02-a9': 'Dahua',
  'e0-50-8b': 'Dahua',

  // —— 终端 / 网卡 ——
  '00-e0-4c': 'Realtek',
  '52-54-00': 'Realtek/QEMU',
  '00-1b-21': 'Intel',
  '3c-97-0e': 'Intel',
  '8c-16-45': 'Intel',
  'a0-36-9f': 'Intel',
  'e4-a4-71': 'Intel',
  '00-14-22': 'Dell',
  '18-66-da': 'Dell',
  'b8-2a-72': 'Dell',
  'f8-bc-12': 'Dell',
  '00-59-07': 'Lenovo',
  '54-e1-ad': 'Lenovo',
  '68-f7-28': 'Lenovo',
  'e8-6a-64': 'Lenovo',
  '00-03-93': 'Apple',
  '3c-07-54': 'Apple',
  '68-db-ca': 'Apple',
  'a4-c3-61': 'Apple',
  'f0-18-98': 'Apple',
  '00-9e-c8': 'Xiaomi',
  '28-6c-07': 'Xiaomi',
  '64-b4-73': 'Xiaomi',
  '78-11-dc': 'Xiaomi',
  '00-03-ff': 'Microsoft',
  '28-18-78': 'Microsoft',
  '7c-1e-52': 'Microsoft',
  'c8-3f-26': 'Microsoft',
  '00-13-a9': 'Sony',
  '00-1c-62': 'LG Electronics',
  '00-0e-58': 'Sonos',
  'b8-27-eb': 'Raspberry Pi',
  'dc-a6-32': 'Raspberry Pi',
  '24-0a-c4': 'Espressif',
  '84-f3-eb': 'Espressif',
  '00-11-32': 'Synology',
  '90-09-d0': 'Synology',
  '00-08-9b': 'QNAP',

  // —— 虚拟化 ——
  '00-0c-29': 'VMware',
  '00-50-56': 'VMware',
  '08-00-27': 'VirtualBox',
  '00-15-5d': 'Hyper-V',
};

/**
 * 归一化 MAC：小写 + 冒号转连字符。
 * 三种写法收敛到同一 key（Vera §3.1 / brief-tess §1.G）：
 *   `AA-BB-CC-DD-EE-FF` / `aa:bb:cc:dd:ee:ff` / `aabb.ccdd.eeff` → `aa-bb-cc-dd-ee-ff`
 * 点分格式（Cisco/部分 IPP 报文）若原样返回，会静默丢掉厂商信息。
 */
export function normalizeMac(mac: string): string {
  const t = mac.trim().toLowerCase();
  const hex = t.replace(/[^0-9a-f]/g, '');
  if (hex.length === 12 && /^[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}$/.test(t)) {
    return hex.replace(/([0-9a-f]{2})(?=[0-9a-f])/g, '$1-');
  }
  return t.replace(/:/g, '-');
}

/** MAC 是否合法（连字符/冒号 6 组，或点分 3 组 4 位十六进制）。 */
export function isValidMac(mac: string): boolean {
  const t = mac.trim();
  if (/^[0-9a-f]{2}(?:[-:][0-9a-f]{2}){5}$/i.test(t)) return true;
  return /^[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}$/i.test(t);
}

/**
 * 厂商查询：命中返回厂商名，未命中返回 null（绝不猜）。
 */
export function lookupVendor(mac: string | null | undefined): string | null {
  if (!mac) return null;
  if (!isValidMac(mac)) return null;
  const key = normalizeMac(mac).slice(0, 8);
  return OUI_TABLE[key] ?? null;
}

export function ouiTableSize(): number {
  return Object.keys(OUI_TABLE).length;
}
