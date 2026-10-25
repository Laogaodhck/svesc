/**
 * G. 设备指纹（`src/main/engine/discovery/fingerprint.ts`）
 *
 * 关键约束（plan.md §5.1 / Vera §2.10）：TTL 在本网段失效（网关 64、SHARP 255），
 * **单独 TTL 一律不得判定 workstation/server**；端口优先。
 */
import { describe, expect, it } from 'vitest';
import { hasPrinterPort, inferFingerprint } from '../src/main/engine/discovery/fingerprint';

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
