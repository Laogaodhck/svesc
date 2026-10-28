/**
 * R-02 / R-03 / R-04 / R-06 守卫（`scheduler.ts` + `bandwidth` 契约）
 *
 * R-02 采样失败必须是 null 而不是 0（"不知道" ≠ "零流量"）
 * R-03 warnings 去重 / 上限 / 自愈
 * R-04 关闭实时监控只停"主动探测"（心跳 / 全量扫描），本机观测（带宽 / 打印机）继续
 * R-06 连续缺席观测轮判离线（task-026：心跳 5s 与扫描轮统一推进，4 轮 ≈ 20s；
 *      ARP 在位的设备不计缺席——禁 ping 主机永远不因沉默被判离线）
 *
 * 注入方式：`vi.mock` 替换四个 IO 出口（arp / ping / ports / spooler）+ 结构注入 meter。
 * 全部 fake timers + 注入时钟，不 spawn 进程、不碰网络、不依赖真实 180s。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_PROBE, PROBE_PORTS, SCAN_BUDGET_MS, SCHEDULE, WINDOW } from '../src/shared/constants';
import { emptyBandwidthStat } from './fixtures';
import type { Scheduler, SchedulerHooks } from '../src/main/engine/scheduler';
import type { MdnsDeviceHint } from '../src/main/engine/discovery/mdns-devices';
import type { WsdCameraHint } from '../src/main/engine/discovery/wsdiscovery';
import type { SsdpDeviceHint } from '../src/main/engine/discovery/ssdp-devices';

// —— 注入状态（vi.hoisted 保证在 vi.mock 工厂之前可用）——
const io = vi.hoisted(() => ({
  arpEntries: [] as Array<{ ip: string; mac: string; iface: string | null }>,
  arpParseWarning: false,
  pingAlive: new Set<string>(),
  openPorts: new Map<string, number[]>(),
  spoolerError: null as string | null,
  mdns: [] as MdnsDeviceHint[],
  wsd: [] as WsdCameraHint[],
  ssdp: [] as SsdpDeviceHint[],
  mdnsQuery: null as (() => Promise<MdnsDeviceHint[]>) | null,
  discoveryCalls: 0,
  pingGate: null as Promise<void> | null,
  probedTargets: [] as string[],
  probedPorts: [] as number[],
  calls: { arp: 0, ping: 0, ports: 0, spooler: 0, quality: 0 },
}));

vi.mock('../src/main/engine/discovery/arp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/arp')>();
  return {
    ...actual,
    readArp: async () => {
      io.calls.arp += 1;
      const entries = new Map(io.arpEntries.map((e) => [e.ip, e]));
      return {
        entries,
        raw: '',
        ms: 1,
        parseWarning: io.arpParseWarning,
        source: 'arp' as const,
        error: null,
        conflicts: [],
      };
    },
  };
});

vi.mock('../src/main/engine/discovery/ping', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/ping')>();
  return {
    ...actual,
    pingSweep: async (hosts: string[]) => {
      io.calls.ping += 1;
      if (io.pingGate) await io.pingGate;
      const results = new Map(
        hosts.map((ip) => {
          const alive = io.pingAlive.has(ip);
          return [
            ip,
            { ip, alive, rttMs: alive ? 1 : null, ttl: alive ? 64 : null, timedOut: !alive, parseWarning: false, ms: 1 },
          ];
        }),
      );
      return { results, parseWarnings: 0, ms: 1 };
    },
    pingQuality: async () => {
      io.calls.quality += 1;
      return { lossPct: 0, avgRttMs: 1, rtts: [1, 1, 1, 1] };
    },
  };
});

vi.mock('../src/main/engine/discovery/ports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/ports')>();
  return {
    ...actual,
    probeHosts: async (targets: string[], portsToProbe: readonly number[]) => {
      io.calls.ports += 1;
      io.probedTargets = [...targets];
      io.probedPorts = [...portsToProbe];
      const out = new Map<string, number[]>();
      for (const ip of targets) {
        const ports = io.openPorts.get(ip);
        if (ports && ports.length > 0) out.set(ip, ports);
      }
      return out;
    },
  };
});

vi.mock('../src/main/engine/printers/spooler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/printers/spooler')>();
  return {
    ...actual,
    readSpooler: async () => {
      io.calls.spooler += 1;
      if (io.spoolerError) throw new Error(io.spoolerError);
      return {
        printers: [],
        cim: [],
        jobs: [],
        errors: { printers: null, cim: null, jobs: null },
        ms: 1,
        fallbackUsed: false,
      };
    },
  };
});

vi.mock('../src/main/engine/printers/mdns', () => ({
  discoverMdnsPrinters: async () => [],
}));

// IPP 耗材查询发真实 http.request：其 setTimeout 超时守卫在 fake timers 下永不触发，
// 设备一旦持有 9100/631 端口（looksLikePrinter 命中）collectPrinters 就会真实连网挂死
vi.mock('../src/main/engine/printers/ipp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/printers/ipp')>();
  return {
    ...actual,
    ippGetAttributes: async () => null,
  };
});

vi.mock('../src/main/engine/discovery/mdns-devices', () => ({
  discoverMdnsDevices: async () => {
    io.discoveryCalls += 1;
    return io.mdnsQuery ? io.mdnsQuery() : io.mdns;
  },
}));

vi.mock('../src/main/engine/discovery/wsdiscovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/wsdiscovery')>();
  return {
    ...actual,
    discoverCamerasWsdiscovery: async () => io.wsd,
  };
});

vi.mock('../src/main/engine/discovery/ssdp-devices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/ssdp-devices')>();
  return {
    ...actual,
    discoverSsdpDevices: async () => io.ssdp,
  };
});

vi.mock('../src/main/engine/discovery/onvif-http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/onvif-http')>();
  return {
    ...actual,
    discoverOnvifDevices: async () => [],
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

// NetBIOS 采集会 spawn nbtstat：替掉（其内部 setTimeout 超时守卫在 fake timers 下
// 永不触发，进程一旦挂起 queryNetbiosNames 就永久 pending，扫描轮被拖死）
vi.mock('../src/main/engine/discovery/netbios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/netbios')>();
  return {
    ...actual,
    queryNetbiosNames: async () => new Map<string, string>(),
  };
});

// 反向 DNS 会 spawn nslookup：测试里必须替掉，否则一轮扫描就是一次真实网络调用
vi.mock('../src/main/engine/discovery/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/discovery/index')>();
  return {
    ...actual,
    ReverseDnsCache: class {
      async lookupMany(): Promise<Map<string, string | null>> {
        return new Map();
      }
    },
  };
});

const { Scheduler: SchedulerClass, WarningLog } = await import('../src/main/engine/scheduler');

const HAWK = { ip: '192.168.2.9', mac: 'aa-bb-cc-00-00-09', iface: null };

function makeScheduler(overrides: Record<string, unknown> = {}, hooks: SchedulerHooks = {}): Scheduler {
  return new SchedulerClass({
    prefix: '192.168.2.',
    hosts: [HAWK.ip],
    selfIp: null,
    gateway: null,
    subnetLabel: '192.168.2.0/24',
    autoScanIntervalSec: 60,
    forceDemo: false,
    snmpEnabled: false,
    useMdns: false,
    ...overrides,
  }, hooks);
}

type SampleStub = {
  at: number;
  rxBps: number;
  txBps: number;
  lanConnections: number;
  perDevice: Map<string, number>;
  intervalMs: number;
  error: string | null;
};

type MeterStub = {
  sample: () => Promise<SampleStub>;
  lastSample: SampleStub | null;
  statFor: (ip: string) => unknown;
};

/** 一次"采到了且有差分基线"的采样（intervalMs>0 才算知道）。 */
function okSample(over: Partial<SampleStub> = {}): SampleStub {
  return {
    at: Date.now(),
    rxBps: 0,
    txBps: 0,
    lanConnections: 0,
    perDevice: new Map(),
    intervalMs: 2_000,
    error: null,
    ...over,
  };
}

/**
 * 结构注入：Scheduler 内部 `new BandwidthMeter(...)`，测试直接换掉实例（不改 src）。
 *
 * 注意：不要在 stub 上写 getter —— 展开/赋值会把 getter 求值成静态值，
 * 于是"恢复后 lastSample 变好"这类用例会永远看到 null，变成假红。一律用可变属性。
 */
function injectMeter(s: Scheduler, overrides: Partial<MeterStub> = {}): MeterStub {
  const meter: MeterStub = {
    sample: async () => {
      const sample = okSample();
      meter.lastSample = sample;
      return sample;
    },
    lastSample: null,
    statFor: () => emptyBandwidthStat(),
    ...overrides,
  };
  (s as unknown as { meter: MeterStub }).meter = meter;
  return meter;
}

/** 让 meter 永远解析失败：返回 error、intervalMs=0（= 没有基线）。 */
function failMeter(s: Scheduler, message = 'netstat -e 解析失败'): MeterStub {
  const meter = injectMeter(s, {});
  meter.sample = async () => {
    const sample = okSample({ intervalMs: 0, error: message });
    meter.lastSample = sample;
    return sample;
  };
  return meter;
}

/** 读一台设备的公开状态（黑盒：只用 Device 契约字段）。 */
function deviceOf(s: Scheduler, ip: string) {
  return s.buildDevices().find((d) => d.ip === ip);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  io.arpEntries = [];
  io.arpParseWarning = false;
  io.pingAlive = new Set();
  io.openPorts = new Map();
  io.spoolerError = null;
  io.mdns = [];
  io.wsd = [];
  io.ssdp = [];
  io.mdnsQuery = null;
  io.discoveryCalls = 0;
  io.pingGate = null;
  io.probedTargets = [];
  io.probedPorts = [];
  io.calls = { arp: 0, ping: 0, ports: 0, spooler: 0, quality: 0 };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('R-02. 带宽采样失败必须是 null，不能是 0', () => {
  it('snapshot.warnings 必须始终是数组（契约要求，不得缺字段）', () => {
    const s = makeScheduler();
    expect(Array.isArray(s.buildSnapshot().warnings), 'warnings 缺失会让渲染层直接崩在 .map 上').toBe(true);
  });

  it('采样失败时 rxBps / txBps 必须严格为 null（不是 0、不是 undefined）', async () => {
    const s = makeScheduler();
    injectMeter(s, {
      sample: async () => {
        throw new Error('netstat 超时');
      },
      lastSample: null,
    });
    await s.sampleBandwidth().catch(() => {});
    const system = s.buildSnapshot().system;
    expect({ rxBps: system.rxBps, txBps: system.txBps }).toEqual({ rxBps: null, txBps: null });
  });

  it('采样失败的同一轮必须在 warnings 里留下 source=bandwidth 的条目', async () => {
    const s = makeScheduler();
    injectMeter(s, {
      sample: async () => {
        throw new Error('netstat 超时');
      },
      lastSample: null,
    });
    await s.sampleBandwidth().catch(() => {});
    const bandwidthWarnings = (s.buildSnapshot().warnings ?? []).filter((w) => w.source === 'bandwidth');
    expect(bandwidthWarnings.length, '把采集失败静默成 0 流量，用户会以为"网络没流量"而不是"采集坏了"').toBe(1);
  });

  it('正常采样时两者必须是数值，且 warnings 里不得有 bandwidth 条目', async () => {
    const s = makeScheduler();
    const meter = injectMeter(s);
    meter.lastSample = okSample({ rxBps: 1_234_567, txBps: 8_900 });
    await s.sampleBandwidth();
    meter.lastSample = okSample({ rxBps: 1_234_567, txBps: 8_900 });
    const snapshot = s.buildSnapshot();
    expect({ rxBps: snapshot.system.rxBps, txBps: snapshot.system.txBps }).toEqual({
      rxBps: 1_234_567,
      txBps: 8_900,
    });
    expect((snapshot.warnings ?? []).some((w) => w.source === 'bandwidth')).toBe(false);
  });

  it('对照：采到了且确实为零流量时必须给 0（零流量 ≠ 采样失败）', async () => {
    const s = makeScheduler();
    const meter = injectMeter(s);
    meter.lastSample = okSample({ rxBps: 0, txBps: 0 });
    await s.sampleBandwidth();
    meter.lastSample = okSample({ rxBps: 0, txBps: 0 });
    const system = s.buildSnapshot().system;
    expect({ rxBps: system.rxBps, txBps: system.txBps }).toEqual({ rxBps: 0, txBps: 0 });
  });

  it('对照：从未采过样（还没有基线）时也必须是 null，不得默认 0', () => {
    const s = makeScheduler();
    injectMeter(s, { lastSample: null });
    const system = s.buildSnapshot().system;
    expect({ rxBps: system.rxBps, txBps: system.txBps }).toEqual({ rxBps: null, txBps: null });
  });
});

describe('R-03. warnings 去重 / 自愈', () => {
  it('同一 source + message 连续触发 5 次只保留 1 条（用户不需要看 5 条同样的报错）', async () => {
    const s = makeScheduler();
    injectMeter(s, {
      sample: async () => {
        throw new Error('netstat 超时');
      },
      lastSample: null,
    });
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(2_000);
      await s.sampleBandwidth().catch(() => {});
    }
    const bandwidthWarnings = (s.buildSnapshot().warnings ?? []).filter((w) => w.source === 'bandwidth');
    expect(bandwidthWarnings, `实际 ${bandwidthWarnings.length} 条：${bandwidthWarnings.map((w) => w.message).join(' | ')}`).toHaveLength(1);
  });

  it('重复触发时那条的 at 必须更新为最后一次（否则 UI 会显示很久以前的旧时间戳）', async () => {
    const s = makeScheduler();
    injectMeter(s, {
      sample: async () => {
        throw new Error('netstat 超时');
      },
      lastSample: null,
    });
    const firstAt = Date.now();
    await s.sampleBandwidth().catch(() => {});
    vi.advanceTimersByTime(10_000);
    const lastAt = Date.now();
    await s.sampleBandwidth().catch(() => {});
    const entry = (s.buildSnapshot().warnings ?? []).find((w) => w.source === 'bandwidth');
    expect({ firstAt, lastAt, at: entry?.at }).toEqual({ firstAt, lastAt, at: lastAt });
  });

  it('条件恢复后该 source 的 warning 必须消失（自愈，否则界面永远挂着一条过期告警）', async () => {
    const s = makeScheduler();
    const meter = failMeter(s);

    await s.sampleBandwidth().catch(() => {});
    expect(
      (s.buildSnapshot().warnings ?? []).some((w) => w.source === 'bandwidth'),
      '失败轮必须留下 warning（否则下一条断言是空断言）',
    ).toBe(true);

    meter.sample = async () => {
      const sample = okSample({ rxBps: 100, txBps: 20 });
      meter.lastSample = sample;
      return sample;
    };
    vi.advanceTimersByTime(2_000);
    await s.sampleBandwidth();
    expect(
      (s.buildSnapshot().warnings ?? []).filter((w) => w.source === 'bandwidth'),
      '采集恢复后仍挂着"带宽采集失败"就是假告警',
    ).toEqual([]);
  });

  it('打印机采集异常必须留下 source=printers 的条目（不得静默保留上一轮结果）', async () => {
    const s = makeScheduler();
    io.spoolerError = 'Get-Printer 权限不足';
    await s.refreshPrinters();
    const entries = (s.buildSnapshot().warnings ?? []).filter((w) => w.source === 'printers');
    expect(entries.length, 'spooler 全失败却什么都不说，界面会显示"打印机 0 台"').toBe(1);
  });

  it('arp 解析告警必须转成 source=discovery 的条目，而不是静默返回空表', async () => {
    const s = makeScheduler();
    io.arpParseWarning = true;
    await s.runFullScan();
    const entries = (s.buildSnapshot().warnings ?? []).filter((w) => w.source === 'discovery');
    expect(entries.length, '解析失败静默成"网段里没有设备"，是本产品最不能犯的错').toBe(1);
  });

  it('不同 source 的条目必须各自保留（去重键含 source，不得互相覆盖）', async () => {
    const s = makeScheduler();
    failMeter(s);
    io.spoolerError = 'Get-Printer 权限不足';
    io.arpParseWarning = true;

    await s.sampleBandwidth().catch(() => {});
    await s.refreshPrinters();
    await s.runFullScan();

    const sources = (s.buildSnapshot().warnings ?? []).map((w) => w.source).sort();
    expect(sources, `实际条目：${sources.join(',')}`).toEqual(['bandwidth', 'discovery', 'printers']);
  });

  it('warnings 必须按 at 升序排列（UI 直接顺序渲染，不得让用户看到倒序时间线）', async () => {
    const s = makeScheduler();
    failMeter(s);
    await s.sampleBandwidth().catch(() => {});
    vi.advanceTimersByTime(5_000);
    io.spoolerError = 'Get-Printer 权限不足';
    await s.refreshPrinters();
    const ats = (s.buildSnapshot().warnings ?? []).map((w) => w.at);
    expect(ats, `实际时间戳：${ats.join(',')}`).toEqual([...ats].sort((a, b) => a - b));
  });

});

/**
 * R-03 的裁剪/去重算法本身：Max-1 已把 WarningLog 导出成纯类（`at` 可注入），
 * 于是不再需要 poke Scheduler 私有字段 —— 私有字段下次重构就断，纯函数不会。
 */
describe('R-03. WarningLog 纯函数（已导出，at 可注入）', () => {
  it('同一 source + message 连续 5 次只保留 1 条', () => {
    const log = new WarningLog();
    for (let i = 0; i < 5; i += 1) log.push('bandwidth', '带宽采样失败：netstat -e 解析失败', 1_000 + i);
    expect(log.list(), '界面不需要 5 条同样的报错').toHaveLength(1);
  });

  it('重复触发时 at 必须刷新为最后一次（否则 UI 显示陈旧时间戳）', () => {
    const log = new WarningLog();
    log.push('bandwidth', '带宽采样失败', 1_000);
    log.push('bandwidth', '带宽采样失败', 9_000);
    expect(log.list()[0]?.at).toBe(9_000);
  });

  it('clearSource 只清该 source 的条目，不得波及其他 source', () => {
    const log = new WarningLog();
    log.push('bandwidth', '带宽采样失败', 1_000);
    log.push('printers', 'Get-Printer 权限不足', 2_000);
    log.clearSource('bandwidth');
    expect(log.list().map((w) => w.source)).toEqual(['printers']);
  });

  it('同 message 不同 source 不得互相覆盖（去重键含 source）', () => {
    const log = new WarningLog();
    log.push('system', '组件崩溃', 1_000);
    log.push('discovery', '组件崩溃', 2_000);
    expect(log.list().map((w) => w.source)).toEqual(['system', 'discovery']);
  });

  it('list() 必须按 at 升序（UI 按时间顺序渲染）', () => {
    const log = new WarningLog();
    log.push('printers', 'b', 3_000);
    log.push('bandwidth', 'a', 1_000);
    log.push('discovery', 'c', 2_000);
    expect(log.list().map((w) => w.at)).toEqual([1_000, 2_000, 3_000]);
  });

  it(`超过 ${WINDOW.warnings} 条时裁剪到 ${WINDOW.warnings} 条，且丢掉的是 at 最旧那条`, () => {
    const log = new WarningLog();
    for (let i = 0; i < WINDOW.warnings + 5; i += 1) {
      log.push('system', `msg-${i}`, 1_000 + i);
    }
    const kept = log.list();
    expect({
      size: kept.length,
      keepsNewest: kept.some((w) => w.message === `msg-${WINDOW.warnings + 4}`),
      keepsOldest: kept.some((w) => w.message === 'msg-0'),
    }).toEqual({ size: WINDOW.warnings, keepsNewest: true, keepsOldest: false });
  });

  it('clearSource 后再 push 同 message 必须重新出现（对应 replaceWarnings 的 clear+push 两段式）', () => {
    const log = new WarningLog();
    log.push('bandwidth', '带宽采样失败', 1_000);
    log.clearSource('bandwidth');
    expect(log.list()).toEqual([]);
    log.push('bandwidth', '带宽采样失败', 5_000);
    expect(log.list().map((w) => w.at)).toEqual([5_000]);
  });

  it('同一轮的 messages 数组可携带多条不同文案（replaceWarnings 的入参形状）', () => {
    const log = new WarningLog();
    for (const message of ['错误 A', '错误 B']) log.push('printers', message, 2_000);
    expect(log.list().map((w) => w.message)).toEqual(['错误 A', '错误 B']);
  });

  it('list() 返回的是副本：外部改动不得污染内部状态', () => {
    const log = new WarningLog();
    log.push('system', 'x', 1_000);
    log.list().push({ source: 'system', message: '注入', at: 2_000 });
    expect(log.list()).toHaveLength(1);
  });

  it('at 可省略（默认 Date.now()），不传也能工作', () => {
    const log = new WarningLog();
    log.push('system', 'no-at');
    const entry = log.list()[0];
    expect({ length: log.list().length, atIsNumber: typeof entry?.at === 'number' }).toEqual({
      length: 1,
      atIsNumber: true,
    });
  });
});

describe('R-04. 关闭实时监控只停主动探测（心跳/全量扫描），本机观测继续', () => {
  function countingScheduler() {
    const s = makeScheduler({ autoScanIntervalSec: 60 });
    const counts = { full: 0, heartbeat: 0, bandwidth: 0, printers: 0 };
    vi.spyOn(s, 'runFullScan').mockImplementation(async () => {
      counts.full += 1;
    });
    vi.spyOn(s, 'heartbeat').mockImplementation(async () => {
      counts.heartbeat += 1;
    });
    vi.spyOn(s, 'sampleBandwidth').mockImplementation(async () => {
      counts.bandwidth += 1;
    });
    vi.spyOn(s, 'refreshPrinters').mockImplementation(async () => {
      counts.printers += 1;
    });
    s.start();
    counts.full = 0;
    counts.heartbeat = 0;
    counts.bandwidth = 0;
    counts.printers = 0;
    return { s, counts };
  }

  it('setAutoScan(false) 后 90s 内全量扫描计数必须冻结（这是被关掉的唯一东西）', async () => {
    const { s, counts } = countingScheduler();
    await vi.advanceTimersByTimeAsync(90_000);
    const before = counts.full;
    s.setAutoScan(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(counts.full, `关闭前 ${before} 次，关闭后又跑了 ${counts.full} 次`).toBe(before);
  });

  it('关闭实时监控后真实心跳必须早退：定时器仍触发但零探测（无 ARP 读取）', async () => {
    const s = makeScheduler({ autoScanIntervalSec: 60 });
    s.start();
    await vi.advanceTimersByTimeAsync(SCHEDULE.devices);
    const arpBefore = io.calls.arp;
    s.setAutoScan(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(
      io.calls.arp,
      '暂停实时监控 = 暂停主动探测：90s 内不得再读 ARP（设备状态冻结是诚实呈现）',
    ).toBe(arpBefore);
  });

  it('同一 90s 内带宽采样计数必须继续增长（流量曲线不能断）', async () => {
    const { s, counts } = countingScheduler();
    s.setAutoScan(false);
    const before = counts.bandwidth;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(counts.bandwidth, `每 ${SCHEDULE.bandwidth}ms 一次，90s 应约 45 次，实际新增 ${counts.bandwidth - before}`).toBeGreaterThan(before);
  });

  it('同一 90s 内打印机刷新计数必须继续增长（耗材告警不能停止更新）', async () => {
    const { s, counts } = countingScheduler();
    s.setAutoScan(false);
    const before = counts.printers;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(counts.printers, `每 ${SCHEDULE.printers}ms 一次，90s 应约 6 次，实际新增 ${counts.printers - before}`).toBeGreaterThan(before);
  });

  it('回归守卫：setAutoScan(true) 后全量扫描必须恢复增长', async () => {
    const { s, counts } = countingScheduler();
    s.setAutoScan(false);
    await vi.advanceTimersByTimeAsync(90_000);
    const frozen = counts.full;
    s.setAutoScan(true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(counts.full, `重新开启后又跑了 ${counts.full - frozen} 次`).toBeGreaterThan(frozen);
  });

  it('语义守卫：autoScan=false 时 system.autoScan 为 false，但 rxBps 仍应更新', async () => {
    const s = makeScheduler({ autoScanIntervalSec: 60 });
    let bytes = 1_000;
    const meter = injectMeter(s);
    meter.sample = async () => {
      bytes += 1_000;
      const sample = okSample({ rxBps: bytes, txBps: 0 });
      meter.lastSample = sample;
      return sample;
    };
    s.start();
    await vi.advanceTimersByTimeAsync(5_000);
    s.setAutoScan(false);
    const before = s.buildSnapshot().system.rxBps;
    await vi.advanceTimersByTimeAsync(10_000);
    const after = s.buildSnapshot();
    expect({ autoScan: after.system.autoScan, grew: typeof after.system.rxBps === 'number' && after.system.rxBps !== before }).toEqual({
      autoScan: false,
      grew: true,
    });
  });
});

describe('R-06. 连续缺席观测轮判离线（心跳与扫描统一推进，ARP 在位不计缺席）', () => {
  /** 扫描 1：ARP 在位 + ICMP 通；之后彻底静默。 */
  async function scanOnceThenSilent() {
    const s = makeScheduler();
    io.arpEntries = [HAWK];
    io.pingAlive = new Set([HAWK.ip]);
    await s.runFullScan();
    io.arpEntries = [];
    io.pingAlive = new Set();
    return s;
  }

  it('扫描 1 观测到在位时应判 online', async () => {
    const s = await scanOnceThenSilent();
    expect(deviceOf(s, HAWK.ip)?.state).toBe('online');
  });

  it('缺席 1-3 个心跳轮（15s）仍不得 offline（确认窗口防抖）', async () => {
    const s = await scanOnceThenSilent();
    for (let i = 0; i < HEARTBEAT_PROBE.offlineArpMisses - 1; i += 1) {
      vi.advanceTimersByTime(SCHEDULE.devices);
      await s.heartbeat();
    }
    expect(
      deviceOf(s, HAWK.ip)?.state,
      '确认窗口未满就下离线结论，网络抖动会变成误报',
    ).toBe('online');
  });

  it(`连续缺席 ${HEARTBEAT_PROBE.offlineArpMisses} 个心跳轮（≈20s）后必须判 offline`, async () => {
    const s = await scanOnceThenSilent();
    for (let i = 0; i < HEARTBEAT_PROBE.offlineArpMisses; i += 1) {
      vi.advanceTimersByTime(SCHEDULE.devices);
      await s.heartbeat();
    }
    expect(deviceOf(s, HAWK.ip)?.state).toBe('offline');
  });

  it('ARP 在位但 ping 永远不通：任意轮数都不得 offline（禁 ping 主机，沉默 ≠ 消失）', async () => {
    const s = await scanOnceThenSilent();
    io.arpEntries = [HAWK];
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(SCHEDULE.devices);
      await s.heartbeat();
    }
    expect(deviceOf(s, HAWK.ip)?.state).toBe('online');
  });

  it('缺席设备心跳回包必须复活：缺席计数归零、回到 online', async () => {
    const s = await scanOnceThenSilent();
    for (let i = 0; i < HEARTBEAT_PROBE.offlineArpMisses - 1; i += 1) {
      vi.advanceTimersByTime(SCHEDULE.devices);
      await s.heartbeat();
    }
    io.pingAlive = new Set([HAWK.ip]);
    vi.advanceTimersByTime(SCHEDULE.devices);
    await s.heartbeat();
    expect(deviceOf(s, HAWK.ip)?.state).toBe('online');
  });

  it('pingAlive 心跳轮也要归零：首轮通、之后全无，仍必须在阈值轮后 offline（粘住会永远在线）', async () => {
    const s = await scanOnceThenSilent();
    for (let i = 0; i < HEARTBEAT_PROBE.offlineArpMisses; i += 1) {
      vi.advanceTimersByTime(SCHEDULE.devices);
      await s.heartbeat();
    }
    expect(
      deviceOf(s, HAWK.ip)?.state,
      'pingAlive 粘住 => 缺席计数永远归零 => 设备永远 online',
    ).toBe('offline');
  });

  it('扫描轮与心跳统一账本：3 次心跳缺席 + 1 次扫描缺席 = offline', async () => {
    const s = await scanOnceThenSilent();
    for (let i = 0; i < HEARTBEAT_PROBE.offlineArpMisses - 1; i += 1) {
      vi.advanceTimersByTime(SCHEDULE.devices);
      await s.heartbeat();
    }
    await s.runFullScan();
    expect(deviceOf(s, HAWK.ip)?.state).toBe('offline');
  });

  it('有端口史的静默设备同样必须按阈值 offline（心跳缺席必须失效陈旧端口证据）', async () => {
    const s = await scanOnceThenSilent();
    io.arpEntries = [HAWK];
    io.pingAlive = new Set([HAWK.ip]);
    io.openPorts = new Map([[HAWK.ip, [9100]]]);
    await s.runFullScan(); // 建立端口史：portResponded = true
    io.arpEntries = [];
    io.pingAlive = new Set();
    io.openPorts = new Map();
    for (let i = 0; i < HEARTBEAT_PROBE.offlineArpMisses; i += 1) {
      vi.advanceTimersByTime(SCHEDULE.devices);
      await s.heartbeat();
    }
    expect(
      deviceOf(s, HAWK.ip)?.state,
      'portResponded 不失效 => 有端口史的设备被旧证据钉住永远 online',
    ).toBe('offline');
  });

  it('无任何观测的一轮不得刷新 lastSeen（陈旧探测不得伪装成"刚刚看到"）', async () => {
    const s = await scanOnceThenSilent();
    for (let i = 0; i < HEARTBEAT_PROBE.offlineArpMisses; i += 1) {
      await s.runFullScan();
    }
    const frozen = deviceOf(s, HAWK.ip)?.lastSeen;
    vi.advanceTimersByTime(300_000);
    await s.heartbeat();
    await s.runFullScan();
    expect(
      { lastSeen: deviceOf(s, HAWK.ip)?.lastSeen, frozen },
      '离线设备仍被刷新 lastSeen，会让"最后在线时间"永远显示刚刚',
    ).toEqual({ lastSeen: frozen, frozen });
  });
});

describe('task-026. 实时化：未知滚动发现 + 早推帧 + 暂停语义', () => {
  /** 带 hooks 的调度器：onSnapshot 计数（早推帧断言用）。 */
  function makeHookedScheduler(hosts: string[]) {
    const snapTimes: number[] = [];
    const s = new SchedulerClass(
      {
        prefix: '192.168.2.',
        hosts,
        selfIp: null,
        gateway: null,
        subnetLabel: '192.168.2.0/24',
        autoScanIntervalSec: 60,
        forceDemo: false,
        snmpEnabled: false,
        useMdns: false,
      },
      { onSnapshot: () => snapTimes.push(Date.now()) },
    );
    return { s, snapTimes };
  }

  it('未知 IP 滚动探测：心跳 1 轮内发现新上线的陌生地址并建册', async () => {
    const stranger = '192.168.2.77';
    const { s } = makeHookedScheduler([HAWK.ip, stranger]);
    io.pingAlive = new Set([stranger]); // 陌生地址只回 ping，ARP 里没有
    vi.advanceTimersByTime(SCHEDULE.devices);
    await s.heartbeat();
    const rec = deviceOf(s, stranger);
    expect(rec, '滚动探测 ping 中的未知地址必须立即建册（这就是"新设备 ~10-20s 发现"的机制）').not.toBeNull();
    expect(rec?.state).toBe('online');
    expect(rec?.lastSeen).toBeGreaterThan(0);
  });

  it('心跳发现 ARP 新设备时必须早推一帧（早推 + 常规 = 2 帧；下一轮无新设备只 1 帧）', async () => {
    const { s, snapTimes } = makeHookedScheduler([HAWK.ip]);
    io.arpEntries = [HAWK];
    vi.advanceTimersByTime(SCHEDULE.devices);
    await s.heartbeat();
    expect(
      snapTimes.length,
      '新设备必须立刻可见：ARP 建册后不等本轮 ping 完成就推帧',
    ).toBe(2);
    vi.advanceTimersByTime(SCHEDULE.devices);
    await s.heartbeat();
    expect(snapTimes.length, '无新设备的一轮只推常规 1 帧').toBe(3);
  });

  it('扫描 phaseInitialArp 发现新设备同样早推帧（扫描 10s 期间新设备不必等扫完）', async () => {
    const { s, snapTimes } = makeHookedScheduler([HAWK.ip]);
    io.arpEntries = [HAWK];
    await s.runFullScan();
    expect(snapTimes.length).toBeGreaterThanOrEqual(2);
  });

  it('暂停实时监控后设备状态冻结：快照仍推送（带宽帧），但设备不再被探测改写', async () => {
    const { s } = makeHookedScheduler([HAWK.ip]);
    io.arpEntries = [HAWK];
    io.pingAlive = new Set([HAWK.ip]);
    await s.runFullScan();
    expect(deviceOf(s, HAWK.ip)?.state).toBe('online');
    io.arpEntries = [];
    io.pingAlive = new Set();
    s.setAutoScan(false);
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(SCHEDULE.devices);
      await s.heartbeat();
    }
    expect(
      deviceOf(s, HAWK.ip)?.state,
      '暂停期间缺席计数不得推进（探测停止 = 观测停止，不许用旧观测继续判离线）',
    ).toBe('online');
  });
});

describe('独立协议发现', () => {
  const mdnsHint = (ip = HAWK.ip): MdnsDeviceHint => ({
    ip, name: '客厅平板', service: '_device-info._tcp.local', kind: 'tablet', model: 'iPad13,4',
  });

  it('ARP 和 ICMP 均无响应时，mDNS 自报仍建册并保留型号', async () => {
    const s = makeScheduler();
    io.mdns = [mdnsHint()];
    await s.runFullScan();
    expect(deviceOf(s, HAWK.ip)).toMatchObject({
      state: 'online', kind: 'tablet', displayName: '客厅平板', mac: null,
      quality: { samples: 0, grade: 'unknown' },
    });
    expect(deviceOf(s, HAWK.ip)?.osHint).toContain('iPad13,4');
    expect(io.probedTargets).toContain(HAWK.ip);
    expect(io.discoveryCalls).toBe(1);
  });

  it('WS-Discovery 与 SSDP 可以分别发现摄像头和影音设备', async () => {
    const tv = '192.168.2.10';
    const s = makeScheduler({ hosts: [HAWK.ip, tv] });
    io.wsd = [{ ip: HAWK.ip, kind: 'ipc', xaddr: null }];
    io.ssdp = [{ ip: tv, kind: 'iot', name: '客厅电视', osHint: '投屏/音响 (UPnP)' }];
    await s.runFullScan();
    expect(deviceOf(s, HAWK.ip)).toMatchObject({ kind: 'camera', state: 'online', mac: null });
    expect(deviceOf(s, tv)).toMatchObject({ kind: 'iot', displayName: '客厅电视', state: 'online' });
  });

  it('多协议及 ARP 发现同一个 IP 不生成重复设备，并保留真实 MAC', async () => {
    const s = makeScheduler();
    io.arpEntries = [HAWK];
    io.mdns = [mdnsHint()];
    io.ssdp = [{ ip: HAWK.ip, kind: 'iot', name: '另一个显示名', osHint: 'UPnP' }];
    await s.runFullScan();
    expect(s.buildDevices()).toHaveLength(1);
    expect(deviceOf(s, HAWK.ip)?.mac).toBe(HAWK.mac);
  });

  it('跨网段、广播、组播及无效 IP 的自报不得扩大扫描范围', async () => {
    const s = makeScheduler();
    io.mdns = ['8.8.8.8', '192.168.2.255', '224.0.0.251', '192.168.2.999', 'not-an-ip'].map(mdnsHint);
    io.wsd = [{ ip: '10.0.0.1', kind: 'ipc', xaddr: null }];
    io.ssdp = [{ ip: '127.0.0.1', kind: 'router', name: null, osHint: 'UPnP' }];
    await s.runFullScan();
    expect(s.buildDevices()).toEqual([]);
    expect(io.probedTargets).toEqual([]);
  });

  it('设备在 ping 尚未结束时即可通过协议响应推送到快照', async () => {
    const emitted: string[][] = [];
    const s = makeScheduler({}, {
      onSnapshot: (snapshot) => emitted.push(snapshot.devices.map((d) => d.ip)),
    });
    io.mdns = [mdnsHint()];
    let releasePing!: () => void;
    io.pingGate = new Promise<void>((resolve) => { releasePing = resolve; });
    const scan = s.runFullScan();
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted.some((ips) => ips.includes(HAWK.ip))).toBe(true);
    expect(io.calls.ports).toBe(0);
    releasePing();
    await scan;
  });

  it('旧身份缓存不能续活：连续四轮无观测后离线，lastSeen 不推进', async () => {
    const s = makeScheduler();
    io.mdns = [mdnsHint()];
    await s.runFullScan();
    const lastSeen = deviceOf(s, HAWK.ip)?.lastSeen;
    io.mdns = [];
    for (let i = 0; i < HEARTBEAT_PROBE.offlineArpMisses; i += 1) {
      vi.advanceTimersByTime(SCHEDULE.devices);
      await s.heartbeat();
    }
    expect(deviceOf(s, HAWK.ip)).toMatchObject({ state: 'offline', lastSeen, kind: 'tablet' });
    await s.runFullScan();
    expect(deviceOf(s, HAWK.ip)).toMatchObject({ state: 'offline', lastSeen });
    io.mdns = [mdnsHint()];
    await s.runFullScan();
    expect(deviceOf(s, HAWK.ip)?.state).toBe('online');
    expect(deviceOf(s, HAWK.ip)?.lastSeen).toBeGreaterThan(lastSeen!);
  });

  it('单路发现失败不影响其它协议建册', async () => {
    const s = makeScheduler();
    io.mdnsQuery = async () => { throw new Error('mDNS unavailable'); };
    io.wsd = [{ ip: HAWK.ip, kind: 'nvr', xaddr: null }];
    await s.runFullScan();
    expect(deviceOf(s, HAWK.ip)?.kind).toBe('camera');
  });

  it('慢协议受扫描预算约束，过期结果不会写入下一轮', async () => {
    const s = makeScheduler();
    let deliver!: (hints: MdnsDeviceHint[]) => void;
    io.mdnsQuery = () => new Promise((resolve) => { deliver = resolve; });
    const scan = s.runFullScan();
    await vi.advanceTimersByTimeAsync(SCAN_BUDGET_MS);
    await scan;
    expect(s.lastTimings?.total).toBeLessThanOrEqual(SCAN_BUDGET_MS);
    io.mdnsQuery = null;
    await s.runFullScan();
    deliver([mdnsHint()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.buildDevices()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('没有可用扫描网段时不发组播发现', async () => {
    const s = makeScheduler({ hosts: [], prefix: null });
    await s.runFullScan();
    expect(io.discoveryCalls).toBe(0);
    expect(s.buildDevices()).toEqual([]);
  });

  it.each([135, 139])('RPC/NetBIOS 端口 %i 实际参与探测并进入识别管线', async (port) => {
    const s = makeScheduler();
    io.arpEntries = [HAWK];
    io.openPorts.set(HAWK.ip, [port]);
    await s.runFullScan();
    expect(PROBE_PORTS).toContain(port);
    expect(io.probedPorts).toContain(port);
    expect(deviceOf(s, HAWK.ip)?.kind).toBe('workstation');
    expect(deviceOf(s, HAWK.ip)?.osHint).toContain('RPC/NetBIOS');
  });
});
