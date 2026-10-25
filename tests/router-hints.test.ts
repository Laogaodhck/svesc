/**
 * C-1 DHCP 租约 hostname 回填（task-022）：scheduler 层边界断言。
 *
 * 数据流：RouterManager 产出 dhcpLeases → 主进程 engine.applyRouterHints →
 * scheduler.setRouterHints（内存态）→ buildDevices 时对 hostname 为空的记录按
 * MAC 回填租约自报 hostname，单点同时喂指纹管线与展示字段。
 *
 * 本文件锁死：
 *  1) MAC 大小写归一（ARP 表与租约的书写差异不得丢回填）；
 *  2) rDNS/mDNS 已有值不覆盖（租约只兜底）；
 *  3) 未登录（空 hints）/ 租约 hostname 为空串或 null → 不猜；
 *  4) 回填进指纹管线（租约 hostname='oneplus-9' 必须命中 mobile 指纹）；
 *  5) 回填是投影不是污染：hints 撤掉后记录原状（不 mutate records）。
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
    pingSweep: async (hosts: string[]) => ({
      results: new Map(hosts.map((ip) => [ip, { ip, alive: false, rttMs: null, ttl: null, timedOut: true, parseWarning: false, ms: 1 }])),
      parseWarnings: 0,
      ms: 1,
    }),
    pingQuality: async () => ({ lossPct: 0, avgRttMs: 1, rtts: [1, 1, 1, 1] }),
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
import type { Scheduler } from '../src/main/engine/scheduler';
import type { DhcpLease } from '../src/shared/types';

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
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('C-1 DHCP 租约 hostname 回填（task-022）', () => {
  it('MAC 大小写归一：ARP 表大写 + 租约小写（及反向）都能对上', async () => {
    const s = makeScheduler();
    io.arpEntries = [
      { ip: '192.168.2.23', mac: 'AA-BB-CC-DD-EE-01', iface: null },
      { ip: '192.168.2.24', mac: 'aa-bb-cc-dd-ee-02', iface: null },
    ];
    await s.runFullScan();
    s.setRouterHints({
      leaseHostnames: [
        lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', hostname: 'phone-alice' }),
        lease({ ip: '192.168.2.24', mac: 'AA-BB-CC-DD-EE-02', hostname: 'laptop-bob' }),
      ],
    });
    expect(
      [deviceOf(s, '192.168.2.23')?.hostname, deviceOf(s, '192.168.2.24')?.hostname],
      'MAC 书写大小写差异必须被吸收：丢一回填，设备名就永远空着',
    ).toEqual(['phone-alice', 'laptop-bob']);
  });

  it('rDNS 已有值不覆盖：租约只兜底，不抢权威来源', async () => {
    const s = makeScheduler();
    io.arpEntries = [{ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', iface: null }];
    io.rdns.set('192.168.2.23', 'nas-home.lan');
    await s.runFullScan();
    s.setRouterHints({
      leaseHostnames: [lease({ ip: '192.168.2.23', mac: 'aa-bb-cc-dd-ee-01', hostname: 'phone-alice' })],
    });
    const d = deviceOf(s, '192.168.2.23');
    expect(d?.hostname, 'rDNS 是 FQDN 更完整，已有值必须优先').toBe('nas-home.lan');
    expect(d?.displayName, 'displayName 同步走 effectiveHostname，不得各走各的').toBe('nas-home.lan');
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
    s.setRouterHints({ leaseHostnames: [] });
    expect(deviceOf(s, '192.168.2.23')?.hostname, 'hints 是单向投影：撤掉后必须干净回退').toBe(null);
  });
});
