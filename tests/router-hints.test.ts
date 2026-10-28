/**
 * C-1 DHCP 租约 hostname 回填（task-022）：scheduler 层边界断言。
 *
 * 数据流：RouterManager 产出 dhcpLeases → 主进程 engine.applyRouterHints →
 * scheduler.setRouterHints（内存态）→ buildDevices 时对 hostname 为空的记录按
 * MAC + 当前 IP 回填有效租约自报 hostname，单点同时喂指纹管线与展示字段。
 *
 * 本文件锁死：
 *  1) MAC 格式归一，IP 不匹配不串名；
 *  2) rDNS/mDNS 已有值不覆盖（租约只兜底）；
 *  3) 空值/占位/无效/过期租约不猜，续租与撤销立即生效；
 *  4) 回填进指纹管线（租约 hostname='oneplus-9' 必须命中 mobile 指纹）；
 *  5) 回填是投影不是污染：不建册、不续活、不改 ping/状态；
 *  6) 输入副本、冲突消歧、排序降噪与 engine 推帧门控。
 *
 * 注入方式与 scheduler-resilience.test.ts 相同：vi.mock 替换 IO 出口，
 * 不 spawn 进程、不碰网络。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// —— 注入状态（vi.hoisted 保证在 vi.mock 工厂之前可用）——
const io = vi.hoisted(() => ({
  arpEntries: [] as Array<{ ip: string; mac: string; iface: string | null }>,
  rdns: new Map<string, string | null>(),
}));

vi.mock('../src/main/engine/discovery/arp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/arp')>();
  return {
    ...actual,
    readArp: async () => ({
      entries: new Map(io.arpEntries.map((e) => [e.ip, e])),
      raw: '',
      ms: 1,
      parseWarning: false,
      source: 'arp' as const,
      error: null,
      conflicts: [],
    }),
  };
});

vi.mock('../src/main/engine/discovery/ping', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/ping')>();
  return {
    ...actual,
    pingSweep: vi.fn(async (hosts: string[]) => ({
      results: new Map(hosts.map((ip) => [ip, { ip, alive: false, rttMs: null, ttl: null, timedOut: true, parseWarning: false, ms: 1 }])),
      parseWarnings: 0,
      ms: 1,
    })),
    pingQuality: vi.fn(async () => ({ lossPct: 0, avgRttMs: 1, rtts: [1, 1, 1, 1] })),
  };
});

vi.mock('../src/main/engine/discovery/ports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/ports')>();
  return {
    ...actual,
    probeHosts: async () => new Map<string, number[]>(),
  };
});

vi.mock('../src/main/engine/printers/spooler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/printers/spooler')>();
  return {
    ...actual,
    readSpooler: async () => ({
      printers: [],
      cim: [],
      jobs: [],
      errors: { printers: null, cim: null, jobs: null },
      ms: 1,
      fallbackUsed: false,
    }),
  };
});

vi.mock('../src/main/engine/printers/mdns', () => ({
  discoverMdnsPrinters: async () => [],
}));

// augmentDeviceIdentity 的真实网络出口（mDNS/WS-Discovery/SSDP 侦测窗口 + nbtstat spawn）：替成空桩
vi.mock('../src/main/engine/discovery/mdns-devices', () => ({
  discoverMdnsDevices: async () => [],
}));
vi.mock('../src/main/engine/discovery/wsdiscovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/wsdiscovery')>();
  return {
    ...actual,
    discoverCamerasWsdiscovery: async () => [],
  };
});
vi.mock('../src/main/engine/discovery/ssdp-devices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/ssdp-devices')>();
  return {
    ...actual,
    discoverSsdpDevices: async () => [],
  };
});
vi.mock('../src/main/engine/discovery/netbios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/netbios')>();
  return {
    ...actual,
    queryNetbiosNames: async () => new Map<string, string | null>(),
  };
});
// task-027：HTTP 管理页指纹是新的网络 IO 出口，测试里同样必须替掉（不碰网络）
vi.mock('../src/main/engine/discovery/http-fingerprint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/http-fingerprint')>();
  return {
    ...actual,
    discoverHttpFingerprints: async () => [],
  };
});
vi.mock('../src/main/engine/discovery/onvif-http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/onvif-http')>();
  return { ...actual, discoverOnvifDevices: async () => [] };
});
vi.mock('../src/main/engine/network/bandwidth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/network/bandwidth')>();
  return { ...actual, readConnections: async () => [] };
});

// Engine 门面测试不探测本机路由、不创建数据库，也不启动后台扫描。
vi.mock('../src/main/engine/discovery/subnet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/subnet')>();
  return {
    ...actual,
    detectSubnet: async () => ({
      iface: 'test', cidr: '192.168.2.0/24', prefix: '192.168.2.',
      address: '192.168.2.2', netmask: '255.255.255.0', gateway: null,
      hosts: ['192.168.2.23'],
    }),
  };
});
vi.mock('../src/main/engine/db/sqlite', () => ({
  SqliteStore: class {
    settings = { autoScanIntervalSec: 60, snmpEnabled: false, useMdns: false };
    get() { return { firstSeen: {}, aliases: {} }; }
    watchTargets() { return []; }
  },
}));

// 反向 DNS 会 spawn nslookup：替成可控桩（io.rdns 决定哪些 IP 有 rDNS 结果）
vi.mock('../src/main/engine/discovery/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/index')>();
  return {
    ...actual,
    ReverseDnsCache: class {
      async lookupMany(ips: string[]): Promise<Map<string, string | null>> {
        const out = new Map<string, string | null>();
        for (const ip of ips) out.set(ip, io.rdns.get(ip) ?? null);
        return out;
      }
    },
  };
});

const { Scheduler: SchedulerClass } = await import('../src/main/engine/scheduler');
const { createEngine } = await import('../src/main/engine');
import { pingQuality, pingSweep } from '../src/main/engine/discovery/ping';
import { HEARTBEAT_PROBE } from '../src/shared/constants';
import type { Scheduler } from '../src/main/engine/scheduler';
import type { DhcpLease, Snapshot } from '../src/shared/types';

function makeScheduler(): Scheduler {
  return new SchedulerClass({
    prefix: '192.168.2.',
    hosts: ['192.168.2.23'],
    selfIp: null,
    gateway: null,
    subnetLabel: '192.168.2.0/24',
    autoScanIntervalSec: 60,
    forceDemo: false,
    snmpEnabled: false,
    useMdns: false,
  });
}

const lease = (over: Partial<DhcpLease> & { ip: string; mac: string }): DhcpLease => ({
  hostname: 'phone-alice',
  expiresAt: null,
  ...over,
});

function deviceOf(s: Scheduler, ip: string) {
  return s.buildDevices().find((d) => d.ip === ip);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  io.arpEntries = [];
  io.rdns = new Map();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('C-1 DHCP 租约 hostname 回填（task-022）', () => {
  it('MAC 大小写与冒号/连字符混用：ubus 租约和 ARP 双向归一', async () => {
    const s = makeScheduler();
    io.arpEntries = [
      { ip: '192.168.2.23', mac: 'AA-BB-CC-DD-EE-01', iface: null },
      { ip: '192.168.2.24', mac: 'aa:bb:cc:dd:ee:02', iface: null },
    ];
    await s.runFullScan();
    expect(s.setRouterHints({
      leaseHostnames: [
        lease({ ip: '192.168.2.23', mac: 'aa:bb:cc:dd:ee:01', hostname: '  phone-alice  ' }),
        lease({ ip: '192.168.2.24', mac: 'AA-BB-CC-DD-EE-02', hostname: 'laptop-bob' }),
      ],
    })).toBe(true);
    expect(
      [deviceOf(s, '192.168.2.23')?.hostname, deviceOf(s, '192.168.2.24')?.hostname],
      'MAC 格式差异必须被吸收，租约主机名只清理首尾空白',
    ).toEqual(['phone-alice', 'laptop-bob']);
  });

  it('rDNS 已有值不覆盖：租约只兜底，不抢权威来源', async () => {
    const s = makeScheduler();
    io.arpEntries = [{ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', iface: null }];
    io.rdns.set('192.168.2.23', 'nas-home.lan');
    await s.runFullScan();
    const before = deviceOf(s, '192.168.2.23');
    s.setRouterHints({
      leaseHostnames: [lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', hostname: 'oneplus-9' })],
    });
    const d = deviceOf(s, '192.168.2.23');
    expect(d?.hostname, 'rDNS 是 FQDN 更完整，已有值必须优先').toBe('nas-home.lan');
    expect(d?.displayName, 'displayName 同步走 effectiveHostname，不得各走各的').toBe('nas-home.lan');
    expect(d, '租约不得干扰权威 hostname 的指纹结果').toEqual(before);
  });

  it('未登录（空 hints）与租约 hostname 为空/null → 不猜，保持 null', async () => {
    const s = makeScheduler();
    io.arpEntries = [
      { ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', iface: null },
      { ip: '192.168.2.24', mac: 'aa-bb-cc-dd-ee-02', iface: null },
      { ip: '192.168.2.25', mac: 'aa-bb-cc-dd-ee-03', iface: null },
    ];
    await s.runFullScan();
    // 未登录/web 会话时主进程喂天然空数组
    s.setRouterHints({ leaseHostnames: [] });
    // 租约 hostname 为空串或 null（dnsmasq 里设备没自报主机名）也不得编造
    s.setRouterHints({
      leaseHostnames: [
        lease({ ip: '192.168.2.24', mac: 'aa-bb-cc-dd-ee-02', hostname: '   ' }),
        lease({ ip: '192.168.2.25', mac: 'aa-bb-cc-dd-ee-03', hostname: null }),
      ],
    });
    expect(
      [deviceOf(s, '192.168.2.23')?.hostname, deviceOf(s, '192.168.2.24')?.hostname, deviceOf(s, '192.168.2.25')?.hostname],
      '拿不到真实主机名就显示 —（null），编造即触数据诚实红线',
    ).toEqual([null, null, null]);
  });

  it('回填进指纹管线：租约 hostname 命中手机词根 → kind/osHint 同步受益', async () => {
    const s = makeScheduler();
    io.arpEntries = [{ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', iface: null }];
    await s.runFullScan();
    expect(deviceOf(s, '192.168.2.23')?.kind, '前置：无主机名时不得误判').not.toBe('mobile');

    s.setRouterHints({
      leaseHostnames: [lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', hostname: 'oneplus-9' })],
    });
    const d = deviceOf(s, '192.168.2.23');
    expect(d?.kind, '回填必须喂进 inferFingerprint（不只改展示字段），否则指纹通道白接').toBe('mobile');
    expect(d?.osHint, '手机词根命中应给出 osHint').toBe('手机（主机名特征）');
    expect(d?.displayName).toBe('oneplus-9');
  });

  it('回填是投影不是污染：hints 撤掉后记录回到原状（不 mutate records）', async () => {
    const s = makeScheduler();
    io.arpEntries = [{ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', iface: null }];
    await s.runFullScan();
    s.setRouterHints({
      leaseHostnames: [lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', hostname: 'phone-alice' })],
    });
    expect(deviceOf(s, '192.168.2.23')?.hostname).toBe('phone-alice');

    // 路由器未登录下一轮：主进程喂空数组 → 回填消失，但记录本身不得被写坏
    expect(s.setRouterHints({ leaseHostnames: [] })).toBe(true);
    expect(deviceOf(s, '192.168.2.23')?.hostname, 'hints 是单向投影：撤掉后必须干净回退').toBe(null);
    expect(s.setRouterHints({ leaseHostnames: [] })).toBe(false);
  });

  it('相同 MAC 的不同 IP 分别匹配；仅 IP 变化也必须触发名称投影变化', async () => {
    const s = makeScheduler();
    const mac = 'aa-bb-cc-dd-ee-01';
    io.arpEntries = [
      { ip: '192.168.2.23', mac, iface: null },
      { ip: '192.168.2.24', mac, iface: null },
    ];
    await s.runFullScan();
    expect(s.setRouterHints({ leaseHostnames: [lease({ ip: '192.168.2.24', mac })] })).toBe(true);
    expect(deviceOf(s, '192.168.2.23')?.hostname).toBeNull();
    expect(deviceOf(s, '192.168.2.24')?.hostname).toBe('phone-alice');
    expect(s.setRouterHints({ leaseHostnames: [lease({ ip: '192.168.2.23', mac })] })).toBe(true);
    expect(deviceOf(s, '192.168.2.23')?.hostname).toBe('phone-alice');
    expect(deviceOf(s, '192.168.2.24')?.hostname).toBeNull();

    s.setRouterHints({ leaseHostnames: [
      lease({ ip: '192.168.2.23', mac, hostname: 'phone-alice' }),
      lease({ ip: '192.168.2.24', mac, hostname: 'laptop-bob' }),
    ] });
    expect(deviceOf(s, '192.168.2.23')?.hostname).toBe('phone-alice');
    expect(deviceOf(s, '192.168.2.24')?.hostname).toBe('laptop-bob');
  });

  it('同 IP 更换 MAC 后不得沿用原设备的租约名称', async () => {
    const s = makeScheduler();
    io.arpEntries = [{ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', iface: null }];
    await s.runFullScan();
    s.setRouterHints({ leaseHostnames: [lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01' })] });
    io.arpEntries = [{ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-02', iface: null }];
    await s.runFullScan();
    expect(deviceOf(s, '192.168.2.23')?.hostname).toBeNull();
  });

  it.each(['', '   ', null, '*', '-', '--', 'UNKNOWN', '(unknown)', 'n/a', 'none', 'bad\u0000name'])(
    '占位或非法 hostname %j 不进入有效名称索引', async (hostname) => {
      const s = makeScheduler();
      io.arpEntries = [{ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', iface: null }];
      await s.runFullScan();
      expect(s.setRouterHints({
        leaseHostnames: [lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', hostname })],
      })).toBe(false);
      expect(deviceOf(s, '192.168.2.23')?.hostname).toBeNull();
    },
  );

  it('非法 IP/MAC、过期及无效期限不产生名称或无意义 changed', async () => {
    const s = makeScheduler();
    const base = lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01' });
    io.arpEntries = [{ ip: base.ip, mac: base.mac, iface: null }];
    await s.runFullScan();
    expect(s.setRouterHints({ leaseHostnames: [
      { ...base, ip: '192.168.2.999' },
      { ...base, ip: '192.168.2' },
      { ...base, ip: '::1' },
      { ...base, mac: 'aa-bb-cc' },
      { ...base, expiresAt: Date.now() - 1 },
      { ...base, expiresAt: Date.now() },
      { ...base, expiresAt: Number.NaN },
      { ...base, expiresAt: Number.POSITIVE_INFINITY },
    ] })).toBe(false);
    expect(deviceOf(s, base.ip)?.hostname).toBeNull();
  });

  it('输入数组和 lease 对象后续 mutation 不影响内部索引，重灌才生效', async () => {
    const s = makeScheduler();
    const original = lease({ ip: '192.168.2.23', mac: 'AA:BB:CC:DD:EE:01', expiresAt: Date.now() + 10_000 });
    const hints = { leaseHostnames: [original] };
    const before = structuredClone(hints);
    io.arpEntries = [{ ip: original.ip, mac: 'aa-bb-cc-dd-ee-01', iface: null }];
    await s.runFullScan();
    expect(s.setRouterHints(hints)).toBe(true);
    expect(hints, '归一化不能反向修改上游输入').toEqual(before);
    original.hostname = 'mutated';
    original.ip = '192.168.2.24';
    original.mac = 'aa-bb-cc-dd-ee-02';
    original.expiresAt = Date.now() - 1;
    hints.leaseHostnames.splice(0, 1, lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', hostname: 'replacement' }));
    expect(deviceOf(s, '192.168.2.23')?.hostname).toBe('phone-alice');
    expect(s.setRouterHints(hints)).toBe(true);
    expect(deviceOf(s, '192.168.2.23')?.hostname).toBe('replacement');
  });

  it('仅续租更新索引不报 changed；每次 buildDevices 到期撤销，过期后续租报 changed', async () => {
    const s = makeScheduler();
    const now = Date.now();
    const base = lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', hostname: 'oneplus-9' });
    io.arpEntries = [{ ip: base.ip, mac: base.mac, iface: null }];
    await s.runFullScan();
    const before = s.buildDevices();
    expect(s.setRouterHints({ leaseHostnames: [{ ...base, expiresAt: now + 1_000 }] })).toBe(true);
    vi.setSystemTime(now + 500);
    expect(s.setRouterHints({ leaseHostnames: [{ ...base, expiresAt: now + 2_000 }] })).toBe(false);
    vi.setSystemTime(now + 1_000);
    expect(deviceOf(s, base.ip)?.hostname).toBe('oneplus-9');
    vi.setSystemTime(now + 2_000);
    expect(s.buildDevices(), '到期即撤销名称及手机指纹，其他设备字段不变').toEqual(before);
    expect(s.setRouterHints({ leaseHostnames: [{ ...base, expiresAt: now + 3_000 }] })).toBe(true);
    expect(deviceOf(s, base.ip)?.hostname).toBe('oneplus-9');
    vi.setSystemTime(now + 3_000);
    expect(s.setRouterHints({ leaseHostnames: [] }), '旧索引当下已过期，空提示不算新增变化').toBe(false);
    expect(s.buildDevices()).toEqual(before);
  });

  it('有效名称的租期被缩短至过期时立即撤销，无限租约仍可续期', async () => {
    const s = makeScheduler();
    const base = lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01' });
    io.arpEntries = [{ ip: base.ip, mac: base.mac, iface: null }];
    await s.runFullScan();
    expect(s.setRouterHints({ leaseHostnames: [base] })).toBe(true);
    expect(s.setRouterHints({ leaseHostnames: [{ ...base, expiresAt: Date.now() + 1_000 }] })).toBe(false);
    expect(s.setRouterHints({ leaseHostnames: [{ ...base, expiresAt: Date.now() }] })).toBe(true);
    expect(deviceOf(s, base.ip)?.hostname).toBeNull();
    expect(s.setRouterHints({ leaseHostnames: [base] })).toBe(true);
    vi.setSystemTime(Date.now() + 1_000_000);
    expect(deviceOf(s, base.ip)?.hostname).toBe('phone-alice');
  });

  it('重复、排序与 MAC 格式不制造噪声；同 MAC/IP 名称冲突一律不猜', async () => {
    const s = makeScheduler();
    const a = lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01' });
    const b = lease({ ip: '192.168.2.24', mac: 'aa-bb-cc-dd-ee-02', hostname: 'laptop-bob' });
    io.arpEntries = [a, b].map(({ ip, mac }) => ({ ip, mac, iface: null }));
    await s.runFullScan();
    expect(s.setRouterHints({ leaseHostnames: [a, b] })).toBe(true);
    expect(s.setRouterHints({ leaseHostnames: [
      b, { ...a, mac: 'AA:BB:CC:DD:EE:01', hostname: ' phone-alice ' }, a,
      { ...a, hostname: '*' }, { ...b, ip: 'bad-ip' },
    ] })).toBe(false);
    const conflict = { ...a, hostname: 'other-phone' };
    expect(s.setRouterHints({ leaseHostnames: [a, b, conflict] })).toBe(true);
    expect(deviceOf(s, a.ip)?.hostname).toBeNull();
    expect(deviceOf(s, b.ip)?.hostname).toBe('laptop-bob');
    expect(s.setRouterHints({ leaseHostnames: [conflict, b, a, conflict] })).toBe(false);
    expect(deviceOf(s, a.ip)?.hostname).toBeNull();
    expect(s.setRouterHints({ leaseHostnames: [b, a] })).toBe(true);
    expect(deviceOf(s, a.ip)?.hostname).toBe('phone-alice');
  });

  it('租约不建册、不续活、不改变 lastSeen/状态/质量或 ping 历史', async () => {
    const s = makeScheduler();
    const base = lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', hostname: 'oneplus-9' });
    s.setRouterHints({ leaseHostnames: [base] });
    expect(s.buildDevices()).toEqual([]);
    expect(s.exportFirstSeen()).toEqual({});
    s.setRouterHints({ leaseHostnames: [] });
    io.arpEntries = [{ ip: base.ip, mac: base.mac, iface: null }];
    await s.runFullScan();
    await s.sampleQuality();
    const lastSeen = deviceOf(s, base.ip)?.lastSeen;
    s.setRouterHints({ leaseHostnames: [base] });
    io.arpEntries = [];
    for (let i = 0; i < HEARTBEAT_PROBE.offlineArpMisses; i += 1) {
      vi.setSystemTime(Date.now() + 5_000);
      await s.heartbeat();
    }
    expect(deviceOf(s, base.ip)?.state).toBe('offline');
    expect(deviceOf(s, base.ip)?.lastSeen).toBe(lastSeen);
    s.setRouterHints({ leaseHostnames: [] });
    const before = await s.getDeviceDetail(`dev-${base.ip}`);
    expect(before).not.toBeNull();
    vi.mocked(pingSweep).mockClear();
    vi.mocked(pingQuality).mockClear();
    vi.setSystemTime(Date.now() + 5_000);
    expect(s.setRouterHints({ leaseHostnames: [base] })).toBe(true);
    const after = await s.getDeviceDetail(`dev-${base.ip}`);
    expect(after).toEqual({
      ...before,
      device: { ...before!.device, hostname: 'oneplus-9', displayName: 'oneplus-9', kind: 'mobile', osHint: '手机（主机名特征）' },
    });
    expect(pingSweep).not.toHaveBeenCalled();
    expect(pingQuality).not.toHaveBeenCalled();
    s.setRouterHints({ leaseHostnames: [] });
    expect(await s.getDeviceDetail(`dev-${base.ip}`)).toEqual(before);
  });

  it('Engine 每轮交给 scheduler 更新租约，仅有效投影改变才立即推帧', async () => {
    const onSnapshot = vi.fn<(snapshot: Snapshot) => void>();
    const engine = await createEngine({ userDataDir: 'E:/GitHub/svesc', forceDemo: false, onSnapshot });
    const base = lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', expiresAt: Date.now() + 1_000 });
    io.arpEntries = [{ ip: base.ip, mac: base.mac, iface: null }];
    await engine.scheduler.runFullScan();
    onSnapshot.mockClear();
    const setHints = vi.spyOn(engine.scheduler, 'setRouterHints');
    engine.applyRouterHints({ leaseHostnames: [] });
    expect(onSnapshot).not.toHaveBeenCalled();
    engine.applyRouterHints({ leaseHostnames: [base] });
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot().devices.find((d) => d.ip === base.ip)?.hostname).toBe('phone-alice');
    const renewed = { ...base, mac: 'AA:BB:CC:DD:EE:01', expiresAt: Date.now() + 2_000 };
    engine.applyRouterHints({ leaseHostnames: [renewed, { ...base, ip: 'bad-ip' }] });
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1_000);
    expect(deviceOf(engine.scheduler, base.ip)?.hostname).toBe('phone-alice');
    vi.setSystemTime(Date.now() + 1_000);
    expect(deviceOf(engine.scheduler, base.ip)?.hostname).toBeNull();
    engine.applyRouterHints({ leaseHostnames: [{ ...renewed, expiresAt: Date.now() + 1_000 }] });
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    engine.applyRouterHints({ leaseHostnames: [{ ...renewed, ip: '192.168.2.24', expiresAt: null }] });
    expect(onSnapshot).toHaveBeenCalledTimes(3);
    expect(engine.getSnapshot().devices.find((d) => d.ip === base.ip)?.hostname).toBeNull();
    engine.applyRouterHints({ leaseHostnames: [base] });
    expect(onSnapshot).toHaveBeenCalledTimes(4);
    engine.applyRouterHints({ leaseHostnames: [{ ...base, expiresAt: null }] });
    expect(onSnapshot).toHaveBeenCalledTimes(5);
    engine.applyRouterHints({ leaseHostnames: [] });
    expect(onSnapshot).toHaveBeenCalledTimes(6);
    expect(engine.getSnapshot().devices.find((d) => d.ip === base.ip)?.hostname).toBeNull();
    engine.applyRouterHints({ leaseHostnames: [] });
    expect(onSnapshot).toHaveBeenCalledTimes(6);
    expect(setHints).toHaveBeenCalledTimes(9);
  });
});
