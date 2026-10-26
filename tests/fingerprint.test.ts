/**
 * G. 设备指纹（`src/main/engine/discovery/fingerprint.ts`）
 *
 * 关键约束（plan.md §5.1 / Vera §2.10）：TTL 在本网段失效（网关 64、SHARP 255），
 * **单独 TTL 一律不得判定 workstation/server**；端口优先。
 */
import { describe, expect, it } from 'vitest';
import { detectMotherboardVendor, gatewaySuffixMac, hasPrinterPort, inferFingerprint } from '../src/main/engine/discovery/fingerprint';

const base = { hostname: null, vendor: null, ttl: null } as const;

describe('G. 端口优先', () => {
  it('只有 9100 端口时应判为 printer', () => {
    expect(inferFingerprint({ ...base, openPorts: [9100] })).toEqual({
      osHint: '打印机固件',
      kind: 'printer',
    });
  });

  it('只有 631（IPP）端口时也应判为 printer', () => {
    expect(inferFingerprint({ ...base, openPorts: [631] }).kind).toBe('printer');
  });

  it('445（SMB）应判为 workstation + Windows (SMB)', () => {
    expect(inferFingerprint({ ...base, openPorts: [445] })).toEqual({
      osHint: 'Windows (SMB)',
      kind: 'workstation',
    });
  });

  it('22（SSH）应给出 Linux/Unix 提示', () => {
    expect(inferFingerprint({ ...base, openPorts: [22] }).osHint).toBe('Linux/Unix (SSH)');
  });

  it('62078（iPhone Sync）应判为 mobile', () => {
    expect(inferFingerprint({ ...base, openPorts: [62078] }).kind).toBe('mobile');
  });

  it('hasPrinterPort 对 [80,443,515,631,9100] 为 true，对 [80,443] 为 false', () => {
    expect([hasPrinterPort([80, 443, 515, 631, 9100]), hasPrinterPort([80, 443])]).toEqual([true, false]);
  });
});

describe('G. TTL 不得单独决定 kind', () => {
  it('TTL=255 且无端口/主机名/厂商时 kind 必须为 unknown（本机 SHARP 就是 255）', () => {
    expect(
      inferFingerprint({ ...base, openPorts: [], ttl: 255 }).kind,
      '经典 TTL→OS 规则在本网段失效，TTL 只能给弱提示',
    ).toBe('unknown');
  });

  it('TTL=64 且无其它信号时 kind 必须为 unknown（网关也是 64，不能判成 workstation）', () => {
    expect(inferFingerprint({ ...base, openPorts: [], ttl: 64 }).kind).toBe('unknown');
  });

  it('TTL=255 可以给出"嵌入式/网络设备"的弱提示，但不改变 kind', () => {
    const fp = inferFingerprint({ ...base, openPorts: [], ttl: 255 });
    expect(fp.osHint, '弱提示必须明确标注"弱提示"，UI 不能当结论').toBe('嵌入式/网络设备固件（TTL 弱提示）');
  });
});

// —— task-023：自报身份层 / 平板/交换机/AP / 随机 MAC 不误判 ——

describe('G. task-023 自报身份层', () => {
  it('WS-Discovery 自报 NetworkVideoTransmitter → camera + ONVIF 提示', () => {
    expect(inferFingerprint({ ...base, openPorts: [], wsdiscoveryKind: 'ipc' })).toEqual({
      osHint: '网络摄像机 (ONVIF)',
      kind: 'camera',
    });
  });

  it('WS-Discovery 自报 NetworkVideoRecorder → camera（NVR）', () => {
    expect(inferFingerprint({ ...base, openPorts: [], wsdiscoveryKind: 'nvr' })).toEqual({
      osHint: 'NVR 录像机 (ONVIF)',
      kind: 'camera',
    });
  });

  it('SSDP WLANAccessPointDevice → ap（自报优先于主机名猜测）', () => {
    expect(
      inferFingerprint({ ...base, openPorts: [], hostname: 'device-a1', ssdpKind: 'ap', ssdpOsHint: '无线AP (UPnP)' }).kind,
    ).toBe('ap');
  });

  it('SSDP IGD → router', () => {
    expect(inferFingerprint({ ...base, openPorts: [], ssdpKind: 'router', ssdpOsHint: 'UPnP IGD（网关）' }).kind).toBe(
      'router',
    );
  });

  it('SSDP MediaRenderer → iot', () => {
    expect(inferFingerprint({ ...base, openPorts: [], ssdpKind: 'iot', ssdpOsHint: '投屏/音响 (UPnP)' }).kind).toBe(
      'iot',
    );
  });

  it('SSDP MediaServer（kind=null）只给 osHint 兜底，kind 仍 unknown——不猜', () => {
    const fp = inferFingerprint({ ...base, openPorts: [], ssdpOsHint: '媒体服务器 (UPnP)' });
    expect(fp.kind).toBe('unknown');
    expect(fp.osHint).toBe('媒体服务器 (UPnP)');
  });

  it('mDNS 自报 camera → camera；printer → printer', () => {
    expect(inferFingerprint({ ...base, openPorts: [], mdnsKind: 'camera' }).kind).toBe('camera');
    expect(inferFingerprint({ ...base, openPorts: [], mdnsKind: 'printer' }).kind).toBe('printer');
  });

  it('自报层让位于硬端口证据：有 445 时仍判 Windows workstation', () => {
    expect(inferFingerprint({ ...base, openPorts: [445], wsdiscoveryKind: 'ipc' }).kind).toBe('workstation');
  });
});

describe('G. task-023 网关是硬事实', () => {
  it('isGateway 高于自报与 OUI：Huawei 厂商的网关必须判 router 而非 mobile', () => {
    const fp = inferFingerprint({ ...base, openPorts: [], vendor: 'Huawei', isGateway: true, mdnsKind: 'iot' });
    expect(fp.kind).toBe('router');
  });
});

describe('G. task-023 主机名新词根', () => {
  it('ipad/matepad/tablet → tablet（判在 mobile 之前）', () => {
    for (const h of ['iPad-of-user', 'MatePad-11', 'mi-pad-3', 'living-room-tablet']) {
      expect(inferFingerprint({ ...base, openPorts: [], hostname: h }).kind, h).toBe('tablet');
    }
  });

  it('switch/sw+编号/交换机 → switch', () => {
    for (const h of ['sw-1', 'switch01', 'core-switch', '交换机-2']) {
      expect(inferFingerprint({ ...base, openPorts: [], hostname: h }).kind, h).toBe('switch');
    }
  });

  it('ap+编号/wireless ap/wap+编号 → ap', () => {
    for (const h of ['ap-1', 'AP3', 'wireless-ap-2', 'wap-01']) {
      expect(inferFingerprint({ ...base, openPorts: [], hostname: h }).kind, h).toBe('ap');
    }
  });

  it('手机词根仍判 mobile，不受新词根影响', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'redmi-k60' }).kind).toBe('mobile');
  });
});

describe('G. task-023 手机厂商 OUI 推断', () => {
  it('Samsung OUI + 非网关 + 无管理端口 → mobile（osHint 明示厂商推断）', () => {
    const fp = inferFingerprint({ ...base, openPorts: [], vendor: 'Samsung', isGateway: false });
    expect(fp.kind).toBe('mobile');
    expect(fp.osHint).toContain('OUI 厂商');
  });

  it('Samsung OUI + 管理端口开放（可能是打印机/设备管理页）→ 不判 mobile', () => {
    expect(inferFingerprint({ ...base, openPorts: [80], vendor: 'Samsung' }).kind).not.toBe('mobile');
  });

  it('Huawei OUI 手机（无端口）→ mobile；Huawei ONU（开 80 管理页）→ 网络设备 router', () => {
    expect(inferFingerprint({ ...base, openPorts: [], vendor: 'Huawei' }).kind).toBe('mobile');
    expect(inferFingerprint({ ...base, openPorts: [80], vendor: 'Huawei' }).kind).toBe('router');
  });

  it('网络厂商扩充：Ruijie/Fortinet/Aruba → router', () => {
    for (const v of ['Ruijie', 'Fortinet', 'Aruba', 'MikroTik']) {
      expect(inferFingerprint({ ...base, openPorts: [], vendor: v }).kind, v).toBe('router');
    }
  });
});

describe('G. 主机名 / 厂商 / 网关', () => {
  it('主机名 XRX9C934E9C6A76.lan 应判为 printer（本机 .235 实测名）', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'XRX9C934E9C6A76.lan' }).kind).toBe(
      'printer',
    );
  });

  it('无端口但厂商为 Xerox 时应判为 printer', () => {
    expect(inferFingerprint({ ...base, openPorts: [], vendor: 'Xerox' }).kind).toBe('printer');
  });

  it('网关 + 80 端口应判为 router', () => {
    expect(
      inferFingerprint({ ...base, openPorts: [80], isGateway: true }).kind,
      '网关必须显示为 router，而不是 workstation',
    ).toBe('router');
  });

  it('没有任何信号时应返回 unknown（不猜）', () => {
    expect(inferFingerprint({ ...base, openPorts: [] })).toEqual({ osHint: null, kind: 'unknown' });
  });
});

/**
 * task-019 识别增强：camera 类型（554 RTSP / 品牌主机名 / 监控厂商 OUI）、
 * 移动端主机名扩充、Apple OUI 诚实提示。
 */
describe('G2. 监控摄像识别（task-019）', () => {
  it('554 RTSP 应判为 camera（无主机名/厂商也可判）', () => {
    expect(inferFingerprint({ ...base, openPorts: [80, 554] })).toEqual({
      osHint: '监控摄像固件 (RTSP)',
      kind: 'camera',
    });
  });

  it('Windows 机同时开 445 与 554 时优先判 Windows（554 不覆盖强 OS 信号）', () => {
    expect(inferFingerprint({ ...base, openPorts: [445, 554] }).kind).toBe('workstation');
  });

  it('海康威视 OUI（44-47-cc）应判 camera（厂商名走 lookupVendor 的小写匹配）', () => {
    expect(inferFingerprint({ ...base, openPorts: [80], vendor: 'Hikvision' })).toEqual({
      osHint: '监控摄像固件',
      kind: 'camera',
    });
    expect(inferFingerprint({ ...base, openPorts: [] }, ).kind).toBe('unknown');
    // 大华
    expect(inferFingerprint({ ...base, openPorts: [], vendor: 'Dahua' }).kind).toBe('camera');
  });

  it('主机名 cam-/nvr/ipc- 命名约定应判 camera', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'cam-front-2.lan' }).kind).toBe('camera');
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'NVR-office' }).kind).toBe('camera');
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'IPC-hall' }).kind).toBe('camera');
  });

  it('普通主机名含 cam 字样但不匹配命名约定时不得误判（camera 单词本身除外）', () => {
    // "cameo" 不是 cam- 前缀：不得判 camera
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'cameo-pc' }).kind).toBe('workstation');
  });
});

describe('G3. 移动端与 Apple（task-019）', () => {
  it('鸿蒙/小米生态主机名应判 mobile', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'HONOR-Phone' }).kind).toBe('mobile');
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'xiaomi-14-ultra' }).kind).toBe('mobile');
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'MIBOX4-living' }).kind).toBe('mobile');
  });

  it('Apple OUI 且主机名不可判：kind 保持 unknown 但给出可读提示（不猜具体类型）', () => {
    const fp = inferFingerprint({ ...base, openPorts: [], vendor: 'Apple' });
    expect({ kind: fp.kind, hasHint: fp.osHint !== null }).toEqual({ kind: 'unknown', hasHint: true });
  });
});

/**
 * task-020：mDNS 自报身份（2.6 层，端口之后、主机名之前）。
 * apple 语义是"是 Apple 设备但不定 macOS/iOS"——不定类型，继续走管线。
 */
describe('G6. mDNS 自报身份（task-020）', () => {
  it('mdnsKind=mobile 应判 mobile（优先于移动端主机名正则）', () => {
    expect(inferFingerprint({ ...base, openPorts: [], mdnsKind: 'mobile' })).toEqual({
      osHint: 'iOS 设备 (mDNS)',
      kind: 'mobile',
    });
  });

  it('mdnsKind=iot 应判 iot（优先于 OUI/IoT 厂商）', () => {
    expect(inferFingerprint({ ...base, openPorts: [], mdnsKind: 'iot' })).toEqual({
      osHint: 'IoT 设备 (mDNS)',
      kind: 'iot',
    });
  });

  it('mdnsKind=apple 不定类型：继续走管线（主机名可认出则认出）', () => {
    const fp = inferFingerprint({ ...base, openPorts: [], hostname: 'MacBook-Pro.local', mdnsKind: 'apple' });
    expect(fp.kind).toBe('workstation');
  });

  it('端口信号必须压过 mDNS：445 开放时仍判 Windows', () => {
    expect(inferFingerprint({ ...base, openPorts: [445], mdnsKind: 'iot' }).kind).toBe('workstation');
  });

  it('mDNS 必须压过主机名/OUI：iot 提示覆盖 espressif 厂商路径', () => {
    expect(inferFingerprint({ ...base, openPorts: [], vendor: 'Espressif', mdnsKind: 'iot' }).kind).toBe('iot');
  });
});

/**
 * task-021 F3：RE_MOBILE_HOST 补高置信品牌词根。
 * 每条新词根正反样例都要有——扩充识别面与防误伤面是一枚硬币的两面，
 * 只测正例的正则会悄悄长成泛匹配。
 */
describe('G7. 手机主机名词根扩充（task-021 F3）', () => {
  it('新增高置信词根 → mobile，osHint 为「手机（主机名特征）」（不再为 null）', () => {
    for (const hostname of ['oneplus-9', 'realme-gt', 'nokia-g21', 'zenfone-10', 'huawei-phone', 'SM-G991B']) {
      const fp = inferFingerprint({ ...base, openPorts: [], hostname });
      expect(fp.kind, `${hostname} 应判 mobile`).toBe('mobile');
      expect(fp.osHint, `${hostname} 的 osHint 必须点明来源是主机名特征`).toBe('手机（主机名特征）');
    }
  });

  it('误伤面反例：motorola-router 不得被 moto 泛匹配拉进 mobile（回归锁，判 router）', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'motorola-router' })).toEqual({
      osHint: '网络设备固件',
      kind: 'router',
    });
  });

  it('误伤面反例：sm-office 不命中 sm-[a-z]\\d{3}（无数字的 sm- 词不得泛匹配）', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'sm-office' })).toEqual({
      osHint: null,
      kind: 'unknown',
    });
  });

  it('正常 PC 名不受影响：desktop-01 仍是 workstation（osHint 无来源可写）', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'desktop-01' })).toEqual({
      osHint: null,
      kind: 'workstation',
    });
  });

  it('既有通道回归：端口信号仍压过主机名词根（445 开放时 SM-G991B 判 Windows）', () => {
    expect(inferFingerprint({ ...base, openPorts: [445], hostname: 'SM-G991B' })).toEqual({
      osHint: 'Windows (SMB)',
      kind: 'workstation',
    });
  });

  it('既有通道回归：62078 与 mdnsKind=mobile 的优先级不变（G.端口优先 / G6 用例的形状投影）', () => {
    expect(inferFingerprint({ ...base, openPorts: [62078], hostname: 'SM-G991B' })).toEqual({
      osHint: 'iOS',
      kind: 'mobile',
    });
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'SM-G991B', mdnsKind: 'mobile' })).toEqual({
      osHint: 'iOS 设备 (mDNS)',
      kind: 'mobile',
    });
  });
});

/**
 * task-027 识别增强组合：SSDP DigitalSecurityCamera/Printer、HTTP 管理页指纹、
 * 电视/机顶盒主机名词根、PC/电视 OUI 类别、新端口信号（8009/8554/32400）。
 * 每条新规则都配误伤面反例——扩充识别面与防误伤面是一枚硬币的两面。
 */
describe('G8. task-027 SSDP 设备类扩展', () => {
  it('SSDP DigitalSecurityCamera → camera；Printer → printer', () => {
    expect(inferFingerprint({ ...base, openPorts: [], ssdpKind: 'camera', ssdpOsHint: '网络摄像机 (UPnP)' })).toEqual({
      osHint: '网络摄像机 (UPnP)',
      kind: 'camera',
    });
    expect(inferFingerprint({ ...base, openPorts: [], ssdpKind: 'printer', ssdpOsHint: '打印机 (UPnP)' }).kind).toBe(
      'printer',
    );
  });

  it('SSDP camera 自报压过手机厂商 OUI：Huawei IPC 不误判 mobile', () => {
    expect(inferFingerprint({ ...base, openPorts: [], vendor: 'Huawei', ssdpKind: 'camera' }).kind).toBe('camera');
  });
});

describe('G9. task-027 HTTP 管理页指纹', () => {
  it('httpKind 自报：恰好命中 1 类 → 直接定 kind，osHint 带型号', () => {
    expect(inferFingerprint({ ...base, openPorts: [80], httpKind: 'router', httpOsHint: '管理页自报：TP-LINK 路由器' })).toEqual({
      osHint: '管理页自报：TP-LINK 路由器',
      kind: 'router',
    });
    expect(inferFingerprint({ ...base, openPorts: [], httpKind: 'printer', httpOsHint: '管理页自报：HP LaserJet' }).kind).toBe(
      'printer',
    );
  });

  it('httpKind 让位硬端口证据：445 开放仍判 Windows workstation', () => {
    expect(inferFingerprint({ ...base, openPorts: [445], httpKind: 'iot', httpOsHint: 'x' }).kind).toBe('workstation');
  });

  it('httpKind=null 但有 title 原文 → osHint 兜底，kind 不动（不猜）', () => {
    expect(inferFingerprint({ ...base, openPorts: [8080], httpKind: null, httpOsHint: 'Device Console' })).toEqual({
      osHint: 'Device Console',
      kind: 'unknown',
    });
  });

  it('title 兜底让位 TTL 之外的更高层：ssdpOsHint 优先于 httpOsHint', () => {
    expect(
      inferFingerprint({ ...base, openPorts: [], httpKind: null, httpOsHint: 'Device Console', ssdpOsHint: '媒体服务器 (UPnP)' }).osHint,
    ).toBe('媒体服务器 (UPnP)');
  });
});

describe('G10. task-027 电视/机顶盒主机名词根', () => {
  it('androidtv/mitv/bravia/chromecast/xbox → iot（判在 mobile 之前）', () => {
    for (const h of ['androidtv-living', 'MiTV-55', 'BRAVIA-45X', 'chromecast-hall', 'XBOX-One']) {
      const fp = inferFingerprint({ ...base, openPorts: [], hostname: h });
      expect(fp.kind, h).toBe('iot');
      expect(fp.osHint, h).toBe('电视/影音设备（主机名特征）');
    }
  });

  it('小米电视主机名压过手机厂商词：xiaomi-tv 含 xiaomi 仍判 iot 而非 mobile', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'xiaomi-tv-room' }).kind).toBe('iot');
  });

  it('误伤面反例：mibox 词根保持既有判定（G3 锁定回归）', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'MIBOX4-living' }).kind).toBe('mobile');
  });

  it('误伤面反例：普通 PC 名不受电视词根影响', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'desktop-01' }).kind).toBe('workstation');
  });
});

describe('G11. task-027 OUI 类别扩充', () => {
  it('电视/影音厂商 OUI → iot（osHint 明示厂商推断）', () => {
    for (const v of ['TCL', 'Hisense', 'Skyworth', 'Changhong', 'Roku']) {
      const fp = inferFingerprint({ ...base, openPorts: [], vendor: v });
      expect(fp.kind, v).toBe('iot');
      expect(fp.osHint, v).toContain('OUI 厂商');
    }
  });

  it('PC 整机/网卡厂商 OUI + 无管理端口 → workstation（osHint 明示厂商推断）', () => {
    // task-031 后 Gigabyte 命中主板厂商表、文案改为"技嘉主板特征"（G19 覆盖），
    // 此处保留非板卡厂的通用 PC 推断文案
    for (const v of ['Intel', 'Dell', 'Lenovo', 'Microsoft']) {
      const fp = inferFingerprint({ ...base, openPorts: [], vendor: v });
      expect(fp.kind, v).toBe('workstation');
      expect(fp.osHint, v).toContain('OUI 厂商');
    }
  });

  it('PC 厂商 OUI + 管理端口开放 → 反证守卫生效，落回 unknown（不猜）', () => {
    // Gigabyte 主板管理页（80 开放）：跳过 workstation 推断，无其它证据就 unknown
    expect(inferFingerprint({ ...base, openPorts: [80], vendor: 'Gigabyte' }).kind).toBe('unknown');
  });

  it('手机厂商优先于电视/PC：Xiaomi OUI 无端口仍判 mobile', () => {
    expect(inferFingerprint({ ...base, openPorts: [], vendor: 'Xiaomi' }).kind).toBe('mobile');
  });
});

describe('G12. task-027 新端口信号', () => {
  it('8009（Chromecast）→ iot', () => {
    expect(inferFingerprint({ ...base, openPorts: [8009] })).toEqual({
      osHint: 'Chromecast 内置投屏',
      kind: 'iot',
    });
  });

  it('8554（RTSP 备用）→ camera', () => {
    expect(inferFingerprint({ ...base, openPorts: [8554] }).kind).toBe('camera');
  });

  it('32400（Plex）→ server', () => {
    expect(inferFingerprint({ ...base, openPorts: [32400] })).toEqual({
      osHint: 'Plex 媒体服务器',
      kind: 'server',
    });
  });

  it('端口信号优先级不变：445 仍压过 8009', () => {
    expect(inferFingerprint({ ...base, openPorts: [445, 8009] }).kind).toBe('workstation');
  });
});

/**
 * task-028 五大生态扩充：手机 / 无线AP / 监控摄像头 / 电脑主板 / 路由器。
 * 每组带误伤面反例——双料厂商（ZTE 光猫、Meraki 交换机、UniFi CloudKey 等）是扩充的主风险。
 */
describe('G13. task-028 手机生态', () => {
  it('新厂商 OUI：meizu/nubia/nothing/hmd → mobile（osHint 明示厂商推断）', () => {
    for (const v of ['Meizu', 'NUBIA', 'Nothing', 'HMD Global']) {
      const fp = inferFingerprint({ ...base, openPorts: [], vendor: v });
      expect(fp.kind, v).toBe('mobile');
      expect(fp.osHint, v).toContain('OUI 厂商');
    }
  });

  it('ZTE 反证守卫：手机（无端口）→ mobile；光猫（80 开放）→ 不判 mobile', () => {
    expect(inferFingerprint({ ...base, openPorts: [], vendor: 'ZTE' }).kind).toBe('mobile');
    expect(inferFingerprint({ ...base, openPorts: [80], vendor: 'ZTE' }).kind).toBe('unknown');
  });

  it('主机名词根：Moto-/RedMagic-/iQOO → mobile', () => {
    for (const h of ['Moto-G85', 'RedMagic-9', 'iQOO-12']) {
      expect(inferFingerprint({ ...base, openPorts: [], hostname: h }).kind, h).toBe('mobile');
    }
  });
});

describe('G14. task-028 无线AP生态', () => {
  it('AP 专业厂商 OUI → ap（osHint 明示厂商推断）', () => {
    for (const v of ['Ruckus', 'EnGenius', 'WavLink', 'COMFAST', 'Cambium']) {
      const fp = inferFingerprint({ ...base, openPorts: [], vendor: v });
      expect(fp.kind, v).toBe('ap');
      expect(fp.osHint, v).toContain('OUI 厂商');
    }
  });

  it('主机名词根：unifi/wavlink/airport → ap', () => {
    for (const h of ['UniFi-AP-AC-LR', 'WavLink-AC1200', 'AirPort-Express']) {
      expect(inferFingerprint({ ...base, openPorts: [], hostname: h }).kind, h).toBe('ap');
    }
  });

  it('误伤面：UniFi 交换机名（sw+数字）仍判 switch；AP OUI 让位端口证据', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'UniFi-SW-24' }).kind).toBe('switch');
    expect(inferFingerprint({ ...base, openPorts: [445], vendor: 'Ruckus' }).kind).toBe('workstation');
  });

  it('mDNS 自报 _airport/_ubnt → ap', () => {
    expect(inferFingerprint({ ...base, openPorts: [], mdnsKind: 'ap' })).toEqual({
      osHint: '无线AP (mDNS 自报)',
      kind: 'ap',
    });
  });
});

describe('G15. task-028 监控摄像头生态', () => {
  it('新厂商 OUI：foscam/reolink/amcrest/vivotek/hanwha → camera', () => {
    for (const v of ['Foscam', 'Reolink', 'Amcrest', 'VIVOTEK', 'Hanwha']) {
      expect(inferFingerprint({ ...base, openPorts: [], vendor: v }).kind, v).toBe('camera');
    }
  });

  it('主机名词根：foscam/reolink/v380 → camera', () => {
    for (const h of ['Foscam-IPC', 'Reolink-Duo', 'V380-Pro']) {
      expect(inferFingerprint({ ...base, openPorts: [], hostname: h }).kind, h).toBe('camera');
    }
  });

  it('私有端口：34567 / 9527 → camera；554 优先级不变', () => {
    expect(inferFingerprint({ ...base, openPorts: [34567] })).toEqual({
      osHint: '监控摄像/录像机 (私有端口)',
      kind: 'camera',
    });
    expect(inferFingerprint({ ...base, openPorts: [9527] }).kind).toBe('camera');
    expect(inferFingerprint({ ...base, openPorts: [554, 9527] }).osHint).toBe('监控摄像固件 (RTSP)');
  });
});

describe('G16. task-028 电脑主板生态', () => {
  it('主机名词根：ideapad/legion/latitude/NUC/OMEN → workstation（osHint null）', () => {
    for (const h of ['DESKTOP-IDEAPAD5', 'Legion-R9000P', 'Latitude-7420', 'NUC12-WSH', 'OMEN-PC']) {
      const fp = inferFingerprint({ ...base, openPorts: [], hostname: h });
      expect(fp.kind, h).toBe('workstation');
      expect(fp.osHint, h).toBeNull();
    }
  });

  it('误伤面反例：普通主机名不受 PC 词根影响', () => {
    // 'SM-G991B' 本就命中手机词根（G6），这里用无词根名验证 PC 词根不扩大误伤
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'ABC-XYZ-01' }).kind).toBe('unknown');
  });
});

describe('G17. task-028 路由器生态', () => {
  it('新厂商 OUI：linksys/netcore/cudy/gl.inet → router', () => {
    for (const v of ['Linksys', 'Netcore', 'Cudy', 'GL.iNet']) {
      expect(inferFingerprint({ ...base, openPorts: [], vendor: v }).kind, v).toBe('router');
    }
  });

  it('主机名词根：miwifi/rt-ax/cudy/asuswrt → router', () => {
    for (const h of ['MiWiFi-R4A', 'RT-AX88U', 'Cudy-WR3000', 'ASUSWRT-RT68']) {
      expect(inferFingerprint({ ...base, openPorts: [], hostname: h }).kind, h).toBe('router');
    }
  });

  it('误伤面反例：手机名含 rt- 前缀不误判（需 ax/ac/n/be 后接数字）', () => {
    expect(inferFingerprint({ ...base, openPorts: [], hostname: 'art-museum-pc' }).kind).toBe('workstation');
  });
});

// —— task-029：随机 MAC 说明文案 / 网关同源 MAC 提示 ——

describe('G18. task-029 随机 MAC 与网关同源提示', () => {
  it('随机 MAC：kind 仍 unknown，osHint 说明统计成因（多为手机/平板）', () => {
    const fp = inferFingerprint({
      ...base,
      openPorts: [],
      vendor: '随机 MAC（厂商不可判）',
    });
    expect(fp.kind).toBe('unknown');
    expect(fp.osHint).toBe('私有 MAC（随机化地址，厂商不可判；多为手机/平板的 MAC 随机化）');
  });

  it('MAC 尾段与网关一致且首字节不同 → 同源提示，kind 不猜', () => {
    const fp = inferFingerprint({
      ...base,
      openPorts: [],
      vendor: '随机 MAC（厂商不可判）',
      mac: 'a2-a3-e3-1d-1a-50',
      gatewayMac: '60-a3-e3-1d-1a-50',
    });
    expect(fp.kind).toBe('unknown');
    expect(fp.osHint).toBe('MAC 尾段与网关一致（本地管理位变体，疑似路由器虚拟接口/Mesh 子节点）');
  });

  it('尾段不一致 / 首字节相同 / MAC 缺失 → 不给同源提示，走原随机 MAC 文案', () => {
    const mk = (mac: string, gw: string): { osHint: string; kind: string } =>
      inferFingerprint({ ...base, openPorts: [], vendor: '随机 MAC（厂商不可判）', mac, gatewayMac: gw });
    expect(mk('a2-a3-e3-1d-1a-50', '60-a3-e3-9f-8e-7d').osHint).toBe(
      '私有 MAC（随机化地址，厂商不可判；多为手机/平板的 MAC 随机化）',
    );
    expect(mk('a2-a3-e3-1d-1a-50', 'a2-a3-e3-1d-1a-50').osHint).toBe(
      '私有 MAC（随机化地址，厂商不可判；多为手机/平板的 MAC 随机化）',
    );
    expect(mk('a2-a3-e3-1d-1a-50', '').osHint).toBe(
      '私有 MAC（随机化地址，厂商不可判；多为手机/平板的 MAC 随机化）',
    );
  });

  it('gatewaySuffixMac 纯函数：点分/冒号/连字符写法等价', () => {
    expect(gatewaySuffixMac('a2:a3:e3:1d:1a:50', '60-a3-e3-1d-1a-50')).toBe(true);
    expect(gatewaySuffixMac('a2a3.e31d.1a50', '60-a3-e3-1d-1a-50')).toBe(true);
    expect(gatewaySuffixMac('62-41-c2-c9-6d-50', '60-a3-e3-1d-1a-50')).toBe(false);
  });
});

// —— task-031：主板厂商识别引擎 / 类型识别强化 ——

describe('G19. task-031 主板厂商识别', () => {
  it('ASUSTek OUI + 445(SMB)：Windows 判定不变，osHint 追加华硕主板', () => {
    const fp = inferFingerprint({
      ...base,
      openPorts: [445],
      vendor: 'ASUSTek COMPUTER INC.',
    });
    expect(fp.kind).toBe('workstation');
    expect(fp.osHint).toBe('Windows (SMB) · 华硕主板（OUI ASUSTek COMPUTER INC.）');
  });

  it('ASUSTek OUI 无端口：直接按华硕主板特征推 workstation', () => {
    const fp = inferFingerprint({ ...base, openPorts: [], vendor: 'ASUSTek COMPUTER INC.' });
    expect(fp.kind).toBe('workstation');
    expect(fp.osHint).toBe('PC/工作站（华硕主板特征：OUI ASUSTek COMPUTER INC. 推断）');
  });

  it('GIGA-BYTE/Micro-Star/ASRock/Colorful 均命中主板厂商表', () => {
    const zh = (vendor: string): string | null => detectMotherboardVendor(vendor);
    expect(zh('GIGA-BYTE TECHNOLOGY CO.,LTD.')).toBe('技嘉');
    expect(zh('Micro-Star INTL CO., LTD.')).toBe('微星');
    expect(zh('ASRock Incorporation')).toBe('华擎');
    expect(zh('Colorful Technology')).toBe('七彩虹');
    expect(zh('Shenzhen Evolveo')).toBeNull();
    expect(zh('Randomized MAC (unpredictable)')).toBeNull();
  });

  it('板卡厂 OUI + 管理端口开放时不判 PC（反证守卫与 PC_VENDORS 一致）', () => {
    const fp = inferFingerprint({ ...base, openPorts: [80], vendor: 'GIGA-BYTE TECHNOLOGY CO.,LTD.' });
    expect(fp.kind).not.toBe('workstation');
  });

  it('非板卡厂的 Windows 机器 osHint 不受影响', () => {
    expect(inferFingerprint({ ...base, openPorts: [3389], vendor: 'Intel Corporate' }).osHint).toBe('Windows (RDP)');
  });
});

describe('G19. task-031 类型识别强化', () => {
  it('135/139（RPC/NetBIOS）与 445 同级判 Windows workstation', () => {
    expect(inferFingerprint({ ...base, openPorts: [135] })).toEqual({ osHint: 'Windows (RPC/NetBIOS)', kind: 'workstation' });
    expect(inferFingerprint({ ...base, openPorts: [139] }).kind).toBe('workstation');
  });

  it('22/SSH + 路由器主机名 → router（OpenWrt/MikroTik 默认开 SSH，不再截胡成 PC）', () => {
    expect(inferFingerprint({ ...base, openPorts: [22], hostname: 'OpenWrt' }).kind).toBe('router');
    expect(inferFingerprint({ ...base, openPorts: [22], hostname: 'MikroTik-5f2a' }).kind).toBe('router');
    expect(inferFingerprint({ ...base, openPorts: [22], vendor: 'MikroTikls' }).kind).toBe('router');
  });

  it('22/SSH 无路由器特征：仍是 Linux/Unix workstation（含主板厂商追加）', () => {
    expect(inferFingerprint({ ...base, openPorts: [22], hostname: 'web-server-1' }).osHint).toBe('Linux/Unix (SSH)');
    expect(inferFingerprint({ ...base, openPorts: [22], vendor: 'ASUSTek COMPUTER INC.' }).osHint).toBe(
      'Linux/Unix (SSH) · 华硕主板（OUI ASUSTek COMPUTER INC.）',
    );
  });

  it('mDNS apple 自报不被随机 MAC 文案吞掉（随机 MAC iPhone 形态）', () => {
    const fp = inferFingerprint({
      ...base,
      openPorts: [],
      vendor: '随机 MAC（厂商不可判）',
      mdnsKind: 'apple',
    });
    expect(fp.kind).toBe('unknown');
    expect(fp.osHint).toBe('Apple 设备 (mDNS 自报，macOS/iOS 不定)');
  });

  it('XiaoQiang（小米路由器默认主机名）→ router', () => {
    expect(inferFingerprint({ ...base, openPorts: [80, 443], hostname: 'XiaoQiang' }).kind).toBe('router');
  });

  it('Realtek 芯片厂商：不判类型但给真实原因提示', () => {
    const fp = inferFingerprint({ ...base, openPorts: [], vendor: 'Realtek Semiconductor Corp.' });
    expect(fp.kind).toBe('unknown');
    expect(fp.osHint).toContain('Realtek');
  });
});
