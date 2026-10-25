/**
 * R-02 / R-03 / R-04 / R-06 守卫（`scheduler.ts` + `bandwidth` 契约）
 *
 * R-02 采样失败必须是 null 而不是 0（"不知道" ≠ "零流量"）
 * R-03 warnings 去重 / 上限 / 自愈
 * R-04 关闭自动扫描只停"全量扫描"，不得停掉采集（心跳 / 带宽 / 打印机）
 * R-06 静默主机必须撑过 3 个**扫描轮**才判离线，5s 心跳不得推进缺席计数
 *
 * 注入方式：`vi.mock` 替换四个 IO 出口（arp / ping / ports / spooler）+ 结构注入 meter。
 * 全部 fake timers + 注入时钟，不 spawn 进程、不碰网络、不依赖真实 180s。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALARM_THRESHOLDS, SCHEDULE, WINDOW } from '../src/shared/constants';
import { emptyBandwidthStat } from './fixtures';
import type { Scheduler } from '../src/main/engine/scheduler';

// —— 注入状态（vi.hoisted 保证在 vi.mock 工厂之前可用）——
const io = vi.hoisted(() => ({
  arpEntries: [] as Array<{ ip: string; mac: string; iface: string | null }>,
  arpParseWarning: false,
  pingAlive: new Set<string>(),
  openPorts: new Map<string, number[]>(),
  spoolerError: null as string | null,
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
    probeHosts: async (targets: string[]) => {
      io.calls.ports += 1;
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

// task-023：WS-Discovery / SSDP 是新的网络 IO 出口，测试里同样必须替掉（不碰网络）
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

function makeScheduler(overrides: Record<string, unknown> = {}): Scheduler {
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
  });
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

function offlineAlarms(s: Scheduler) {
  return s.alarmEngine.all().filter((a) => a.code === 'DEVICE_OFFLINE');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  io.arpEntries = [];
  io.arpParseWarning = false;
  io.pingAlive = new Set();
  io.openPorts = new Map();
  io.spoolerError = null;
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

describe('R-04. 关闭自动扫描只停全量扫描，不得停掉采集', () => {
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

  it('同一 90s 内心跳计数必须继续增长（设备在线状态不能停止刷新）', async () => {
    const { s, counts } = countingScheduler();
    s.setAutoScan(false);
    const before = counts.heartbeat;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(counts.heartbeat, `每 ${SCHEDULE.devices}ms 一次，90s 应约 18 次，实际新增 ${counts.heartbeat - before}`).toBeGreaterThan(before);
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

describe('R-06. 静默主机必须撑过 3 个扫描轮才离线（心跳不得推进缺席计数）', () => {
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

  it('36 次心跳（180s）不得把设备推进 offline —— 心跳不是扫描轮', async () => {
    const s = await scanOnceThenSilent();
    for (let i = 0; i < 36; i += 1) {
      vi.advanceTimersByTime(SCHEDULE.devices);
      await s.heartbeat();
    }
    expect(
      deviceOf(s, HAWK.ip)?.state,
      '心跳推进了 arpMissStreak：3 次心跳（15s）就判离线，这正是线上"设备突然离线"的形态',
    ).not.toBe('offline');
  });

  it('缺席 1 次、2 次扫描仍不得 offline（ARP 老化有延迟，不得提前下结论）', async () => {
    const s = await scanOnceThenSilent();
    await s.runFullScan();
    await s.runFullScan();
    expect(deviceOf(s, HAWK.ip)?.state).toBe('online');
  });

  it(`缺席 ${ALARM_THRESHOLDS.offlineArpMisses} 次扫描后才必须判 offline`, async () => {
    const s = await scanOnceThenSilent();
    for (let i = 0; i < ALARM_THRESHOLDS.offlineArpMisses; i += 1) {
      await s.runFullScan();
    }
    expect(deviceOf(s, HAWK.ip)?.state).toBe('offline');
  });

  it('真正 offline 之前 DEVICE_OFFLINE 告警条数必须为 0', async () => {
    const s = await scanOnceThenSilent();
    for (let i = 0; i < 36; i += 1) {
      vi.advanceTimersByTime(SCHEDULE.devices);
      await s.heartbeat();
    }
    await s.runFullScan();
    await s.runFullScan();
    expect(offlineAlarms(s), `提前告警会直接违反产品立身规则（ICMP 不通 ≠ 离线）`).toHaveLength(0);
  });

  it(`真正缺席 ${ALARM_THRESHOLDS.offlineArpMisses} 次扫描后 DEVICE_OFFLINE 应为 1 条`, async () => {
    const s = await scanOnceThenSilent();
    for (let i = 0; i < ALARM_THRESHOLDS.offlineArpMisses; i += 1) {
      await s.runFullScan();
    }
    expect(offlineAlarms(s).map((a) => `${a.code}/${a.targetId}`)).toEqual([`DEVICE_OFFLINE/${`dev-${HAWK.ip}`}`]);
  });

  it('pingAlive 每轮扫描重置：首轮 ICMP 通、之后全无，仍必须在第 3 次缺席后 offline（粘住会永远在线）', async () => {
    const s = await scanOnceThenSilent();
    // 首轮 ICMP 通会让 rec.pingAlive=true；若后续轮次不清零，applyArpPresence 每轮都把 streak 归零
    for (let i = 0; i < ALARM_THRESHOLDS.offlineArpMisses; i += 1) {
      await s.runFullScan();
    }
    expect(
      deviceOf(s, HAWK.ip)?.state,
      'pingAlive 粘住 => arpMissStreak 永远归零 => 设备永远 online',
    ).toBe('offline');
  });

  it('无任何观测的一轮不得刷新 lastSeen（陈旧探测不得伪装成"刚刚看到"）', async () => {
    const s = await scanOnceThenSilent();
    for (let i = 0; i < ALARM_THRESHOLDS.offlineArpMisses; i += 1) {
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
