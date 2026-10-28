/**
 * P0：打印机状态覆盖逻辑（`src/main/engine/printers/printer-service.ts` · `collectPrinters`）
 *
 * 这是整个产品的核心正确性点（brief §9.6）：`192.168.2.213` 在 spooler 里是
 * Normal/Idle/WorkOffline=false（"假在线"），**必须**由 TCP 探活覆盖为 offline。
 * 探活与耗材 provider 都是注入点，因此无需真机、无需网络。
 */
import { describe, expect, it, vi } from 'vitest';
import { collectPrinters, type ConsumableProvider } from '../src/main/engine/printers/printer-service';
import type { RawCimPrinter, RawPrinter, SpoolerSnapshot } from '../src/main/engine/printers/spooler';
import type { ReachabilityResult } from '../src/main/engine/discovery/ports';
import { T0, supply, device } from './fixtures';

function snapshot(printers: RawPrinter[], cim: RawCimPrinter[] = []): SpoolerSnapshot {
  return {
    printers,
    cim,
    jobs: [],
    errors: { printers: null, cim: null, jobs: null },
    ms: 0,
    fallbackUsed: false,
  };
}

/** `.213` 的真实形状：spooler 一切正常，但 9100/631/515 全不通。 */
const UNREACHABLE: ReachabilityResult = { reachable: false, port: null, triedPorts: [9100, 631, 515] };
const REACHABLE_9100: ReachabilityResult = { reachable: true, port: 9100, triedPorts: [9100] };

const MF750C: RawPrinter = {
  Name: 'MF750C Series',
  DriverName: 'Canon Generic Plus PCL6',
  PortName: 'IP_192.168.2.213',
  PrinterStatus: 0,
};
const MF750C_CIM: RawCimPrinter = {
  Name: 'MF750C Series',
  WorkOffline: false,
  PrinterStatus: 3,
  DetectedErrorState: 0,
};

async function collect(probe: (ip: string) => Promise<ReachabilityResult>, providers: ConsumableProvider[] = []) {
  return collectPrinters({
    spooler: snapshot([MF750C], [MF750C_CIM]),
    arp: new Map(),
    devices: [],
    probe,
    consumableProviders: providers,
    now: T0,
  });
}

describe('P0. .213 假在线：探活必须覆盖 spooler 的判定', () => {
  it('spooler Normal/Idle + 探活全不通 → state 必须是 offline', async () => {
    const res = await collect(async () => UNREACHABLE);
    expect(res.printers[0]?.state, '不做覆盖就会出现"打印机在线"的假象（Canon MF750C 的真实故障）').toBe(
      'offline',
    );
  });

  it('stateDetail 必须同时保留 spooler 视角与探活视角（运维定位用）', async () => {
    const res = await collect(async () => UNREACHABLE);
    expect(
      res.printers[0]?.stateDetail,
      '只写"离线"无法区分"队列被人为离线"与"网络不通"',
    ).toBe('spooler=Normal · win32=Idle · 网络探活失败 9100/631/515');
  });

  it('reachable 表应记录该打印机 ip 不可达（供状态联动消费）', async () => {
    const res = await collect(async () => UNREACHABLE);
    expect(res.reachable.get(res.printers[0]!.id)).toBe(false);
  });

  it('反例：探活 9100 可达时不得覆盖 spooler 的 idle 判定', async () => {
    const res = await collect(async () => REACHABLE_9100);
    expect(res.printers[0]?.state, '误覆盖会把本来正常的打印机全标成离线').toBe('idle');
  });
});

describe('P0. ip 为 null 的虚拟打印机', () => {
  const virtual = snapshot(
    [{ Name: 'Microsoft Print to PDF', PortName: 'PORTPROMPT:', PrinterStatus: 0 }],
    [{ Name: 'Microsoft Print to PDF', WorkOffline: false, PrinterStatus: 3 }],
  );

  it('不得对无 IP 的打印机发起探活（虚拟打印机不能当网络打印机打）', async () => {
    let calls = 0;
    await collectPrinters({
      spooler: virtual,
      arp: new Map(),
      devices: [],
      probe: async () => {
        calls += 1;
        return UNREACHABLE;
      },
      consumableProviders: [],
      now: T0,
    });
    expect(calls, `实际探活 ${calls} 次`).toBe(0);
  });

  it('不得被判为 offline（否则 5 台虚拟打印机全变离线）', async () => {
    const res = await collectPrinters({
      spooler: virtual,
      arp: new Map(),
      devices: [],
      probe: async () => UNREACHABLE,
      consumableProviders: [],
      now: T0,
    });
    expect(res.printers[0]?.state).toBe('idle');
  });
});

describe('P0. 耗材采集的前置条件', () => {
  function countingProvider(): { provider: ConsumableProvider; calls: () => number } {
    let calls = 0;
    return {
      provider: {
        name: 'snmp',
        load: async () => {
          calls += 1;
          return { consumables: [supply({ levelPct: 42 })], model: 'MF750C', pageCount: 12, panelText: null, error: null };
        },
      },
      calls: () => calls,
    };
  }

  it('网络不可达时不得去查耗材（省 900ms×N 超时，也不对离线设备猜数据）', async () => {
    const c = countingProvider();
    await collect(async () => UNREACHABLE, [c.provider]);
    expect(c.calls(), '离线设备仍去 SNMP walk 会拖垮 15s 打印周期').toBe(0);
  });

  it('网络可达时应确实查一次耗材（注入的 snmp provider 必须能被按接口调用）', async () => {
    const c = countingProvider();
    await collect(async () => REACHABLE_9100, [c.provider]);
    expect(c.calls(), 'provider 遵循 ConsumableProvider 接口时不得因 statusOf 缺失而崩溃').toBe(1);
  });

  it('网络可达时应确实查一次耗材（ipp provider 对照，不依赖 snmp 专属方法）', async () => {
    let calls = 0;
    const ipp: ConsumableProvider = {
      name: 'ipp',
      load: async () => {
        calls += 1;
        return { consumables: [supply({ levelPct: 30, source: 'ipp' })], model: null, pageCount: null, panelText: null, error: null };
      },
    };
    await collect(async () => REACHABLE_9100, [ipp]);
    expect(calls).toBe(1);
  });

  it('实现了 statusOf 的 provider 应把面板文本追加进 stateDetail（生产路径不变）', async () => {
    const snmp: ConsumableProvider = {
      name: 'snmp',
      load: async () => ({ consumables: [], model: null, pageCount: null, panelText: null, error: null }),
      statusOf: () => ({
        consumables: [],
        model: null,
        pageCount: null,
        panelText: 'Toner Low · Load Paper',
        error: null,
      }),
    };
    const res = await collect(async () => REACHABLE_9100, [snmp]);
    expect(res.printers[0]?.stateDetail, '注入 statusOf 后仍应合并面板文本，不能因改成可选能力而丢功能').toBe(
      'spooler=Normal · win32=Idle · Toner Low · Load Paper',
    );
  });
});

describe('型号清洗（sanitizeModel）与 sysDescr 的接入点', () => {
  /** 真机 Xerox sysDescr 形态：型号 + 一串固件版本，只有分号前是人能读的型号。 */
  const XEROX_RAWSYSDESCR = 'Xerox AltaLink C8055; SS 103.002.042.33200; NC 103.003.032.33200';
  const XEROX_MODEL = 'Xerox AltaLink C8055';

  /** 微软通用类驱动 → modelFromDriver 返回 null，此时才轮到 provider 的型号。 */
  const CLASS_DRIVER: RawPrinter = {
    Name: 'AltaLink C8055',
    DriverName: 'Microsoft IPP Class Driver',
    PortName: 'IP_192.168.2.50',
    PrinterStatus: 0,
  };

  function providerWith(result: Partial<Awaited<ReturnType<ConsumableProvider['load']>>>): ConsumableProvider {
    const full = {
      consumables: [],
      model: null,
      pageCount: null,
      panelText: null,
      error: null,
      ...result,
    };
    return { name: 'snmp', load: async () => full, statusOf: () => full };
  }

  async function collectFor(providers: ConsumableProvider[]) {
    return collectPrinters({
      spooler: snapshot([CLASS_DRIVER]),
      arp: new Map(),
      devices: [],
      probe: async () => REACHABLE_9100,
      consumableProviders: providers,
      now: T0,
    });
  }

  it('spooler driver 是微软通用类驱动时，应采用 provider 清洗后的型号', async () => {
    const res = await collectFor([providerWith({ model: XEROX_MODEL })]);
    expect(res.printers[0]?.model, '通用驱动给不出型号时必须回落到 SNMP 采集的型号').toBe(XEROX_MODEL);
  });

  it('型号里不得含固件版本串（模型层必须已清洗，UI 不该再兜底）', async () => {
    const res = await collectFor([providerWith({ model: XEROX_MODEL })]);
    expect(res.printers[0]?.model).not.toMatch(/SS\s*103|103\.002/);
  });

  it('厂商通用驱动不能覆盖设备自报型号', async () => {
    const res = await collect(async () => REACHABLE_9100, [providerWith({ model: 'Canon MF750C' })]);
    expect(res.printers[0]?.model).toBe('Canon MF750C');
  });

  it('sysDescr 原文应进入 stateDetail（排查固件版本时必须看得到 SS/NC）', async () => {
    const res = await collectFor([providerWith({ sysDescr: XEROX_RAWSYSDESCR })]);
    expect(res.printers[0]?.stateDetail).toContain(`sysDescr: ${XEROX_RAWSYSDESCR.slice(0, 80)}`);
  });

  it('sysDescr 进详情时只取前 80 字符（整串固件不得撑爆详情面板）', async () => {
    const long = `${XEROX_RAWSYSDESCR}; UI 103.004.032.33200; ME 103.005.032.33200; DF 103.006.032.33200`;
    expect(long.length, '这条用例要求原文确实超过 80 字符').toBeGreaterThan(80);
    const res = await collectFor([providerWith({ sysDescr: long })]);
    expect(res.printers[0]?.stateDetail).toContain(`sysDescr: ${long.slice(0, 80)}`);
    expect(res.printers[0]?.stateDetail).not.toContain(long.slice(80));
  });

  it('没有 sysDescr 时 stateDetail 不得出现空的 "sysDescr: " 占位', async () => {
    const res = await collectFor([providerWith({})]);
    expect(res.printers[0]?.stateDetail).not.toContain('sysDescr');
  });

  it('型号与 sysDescr 是两个字段：型号保持干净的同时详情保留原文', async () => {
    const res = await collectFor([providerWith({ model: XEROX_MODEL, sysDescr: XEROX_RAWSYSDESCR })]);
    const printer = res.printers[0];
    expect({ model: printer?.model, hasFirmwareInDetail: printer?.stateDetail.includes('SS 103.002') }).toEqual({
      model: XEROX_MODEL,
      hasFirmwareInDetail: true,
    });
  });
});

const MDNS = { name: '前台彩色打印机', ip: '10.1.1.40', port: 631, service: '_ipp._tcp.local', model: 'Canon MF750C; Firmware 1.0' };
const baseInput = () => ({ spooler: snapshot([]), arp: new Map(), devices: [], consumableProviders: [], now: T0 });

describe('打印机多源身份与实时状态', () => {
  it('mDNS 可独立发现并保留 TXT 型号，不伪造系统队列或 SNMP 来源', async () => {
    const probe = vi.fn(async () => REACHABLE_9100);
    const res = await collectPrinters({ ...baseInput(), mdns: [MDNS], probe });
    expect(res.printers).toHaveLength(1);
    expect(res.printers[0]).toMatchObject({ ip: MDNS.ip, name: MDNS.name, model: 'Canon MF750C', source: 'mdns', queueName: null, state: 'unknown' });
    expect(probe).toHaveBeenCalledExactlyOnceWith(MDNS.ip);
  });

  it('WSD 唯一同名先补 IP，再探活/登记 ID/采耗材', async () => {
    const provider: ConsumableProvider = { name: 'ipp', load: vi.fn(async () => ({ consumables: [], model: 'Canon MF750C', pageCount: null, panelText: 'media-jam-error', state: 'error', error: null })) };
    const res = await collectPrinters({ ...baseInput(),
      spooler: snapshot([{ Name: MDNS.name, PortName: 'WSD-abc', PrinterStatus: 0 }]),
      mdns: [MDNS], probe: async () => REACHABLE_9100, consumableProviders: [provider],
    });
    expect(res.printers).toHaveLength(1);
    expect(res.printers[0]).toMatchObject({ id: `prn-queue-${encodeURIComponent(MDNS.name)}`, ip: MDNS.ip, model: 'Canon MF750C', state: 'error', queueName: MDNS.name });
    expect(res.reachable.get(res.printers[0]!.id)).toBe(true);
    expect(provider.load).toHaveBeenCalledOnce();
  });

  it('同名多个 IP、空名称和子串不绑定 WSD 队列', async () => {
    for (const name of [MDNS.name, '前台', '!!!']) {
      const res = await collectPrinters({ ...baseInput(),
        spooler: snapshot([{ Name: name, PortName: 'WSD-abc' }]),
        mdns: [MDNS, { ...MDNS, ip: '10.1.1.41' }], probe: async () => UNREACHABLE,
      });
      expect(res.printers.find((p) => p.queueName === name)?.ip).toBeNull();
    }
  });

  it('mDNS 不把同名 USB/虚拟队列变成网络打印机', async () => {
    for (const port of ['USB001', 'PORTPROMPT:']) {
      const res = await collectPrinters({ ...baseInput(), spooler: snapshot([{ Name: MDNS.name, PortName: port }]), mdns: [MDNS], probe: async () => UNREACHABLE });
      expect(res.printers.find((p) => p.queueName === MDNS.name)?.ip).toBeNull();
    }
  });

  it('无效地址、范围外地址与非打印服务不进入候选', async () => {
    const probe = vi.fn(async () => REACHABLE_9100);
    const res = await collectPrinters({ ...baseInput(), discoveryHosts: [MDNS.ip], probe,
      mdns: [{ ...MDNS, ip: '999.1.2.3' }, { ...MDNS, ip: '10.2.2.40' }, { ...MDNS, service: '_http._tcp.local' }],
    });
    expect(res.printers).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('同 IP 多服务不重复采集/建卡', async () => {
    const probe = vi.fn(async () => REACHABLE_9100);
    const res = await collectPrinters({ ...baseInput(), mdns: [MDNS, { ...MDNS, service: '_pdl-datastream._tcp.local', port: 9100 }], probe });
    expect(res.printers).toHaveLength(1);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('历史端口不能证明本轮在线，离线网络条目不查耗材', async () => {
    const load = vi.fn(async () => ({ consumables: [], model: null, pageCount: null, panelText: null, error: null }));
    const probe = vi.fn(async () => UNREACHABLE);
    const res = await collectPrinters({ ...baseInput(), devices: [device({ id: `dev-${MDNS.ip}`, ip: MDNS.ip, kind: 'printer', openPorts: [9100] })], probe, consumableProviders: [{ name: 'snmp', load }] });
    expect(probe).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(res.printers[0]).toMatchObject({ state: 'offline', source: 'probe', queueName: null, consumables: [] });
  });

  it('同 IP 多个本机队列保留任务归属、唯一 ID，网络请求仅一次', async () => {
    const spooler = snapshot([{ Name: '彩色队列', PortName: MDNS.ip }, { Name: '黑白队列', PortName: MDNS.ip }]);
    spooler.jobs = [{ Id: 1, PrinterName: '彩色队列', DocumentName: '彩色文档' }, { Id: 1, PrinterName: '黑白队列', DocumentName: '黑白文档' }];
    const probe = vi.fn(async () => REACHABLE_9100);
    const load = vi.fn(async () => ({ consumables: [], model: null, pageCount: null, panelText: null, error: null }));
    const res = await collectPrinters({ ...baseInput(), spooler, probe, consumableProviders: [{ name: 'ipp', load }] });
    expect(new Set(res.printers.map((p) => p.id)).size).toBe(2);
    expect(res.printers.find((p) => p.queueName === '彩色队列')?.jobs[0]?.documentName).toBe('彩色文档');
    expect(res.printers.find((p) => p.queueName === '黑白队列')?.jobs[0]?.documentName).toBe('黑白文档');
    expect(probe).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });

  it('队列换序、同 IP 队列移除和地址变化不改变身份或串用忽略配置', async () => {
    const first = { Name: '彩色队列', PortName: MDNS.ip };
    const second = { Name: '黑白队列', PortName: MDNS.ip };
    const run = (rows: RawPrinter[], ignored: string[] = []) => collectPrinters({ ...baseInput(), spooler: snapshot(rows), probe: async () => REACHABLE_9100, manage: { manual: [], ignored } });
    const initial = await run([first, second]);
    const ids = Object.fromEntries(initial.printers.map((p) => [p.queueName, p.id]));
    const reversed = await run([second, first]);
    expect(Object.fromEntries(reversed.printers.map((p) => [p.queueName, p.id]))).toEqual(ids);
    const remaining = await run([second], [ids['彩色队列']!]);
    expect(remaining.printers[0]?.id).toBe(ids['黑白队列']);
    const moved = await run([{ ...second, PortName: '10.1.1.55' }]);
    expect(moved.printers[0]?.id).toBe(ids['黑白队列']);
  });

  it.each([[3, 'idle'], [4, 'printing'], [7, 'offline']] as const)('CIM 回退状态 %i 使用自身枚举，补采缺失仍保留默认标记', async (CimStatus, state) => {
    const res = await collectPrinters({ ...baseInput(), spooler: snapshot([{ Name: 'CIM queue', PortName: 'USB001', CimStatus, Default: true }]) });
    expect(res.printers[0]).toMatchObject({ state, isDefault: true, stateDetail: expect.stringContaining('win32=') });
    expect(res.printers[0]?.stateDetail).not.toContain('spooler=');
  });

  it('CIM 补采失败时仍使用回退行的离线与错误字段', async () => {
    const res = await collectPrinters({ ...baseInput(), spooler: snapshot([
      { Name: 'Offline queue', PortName: 'USB001', CimStatus: 3, WorkOffline: true },
      { Name: 'Jammed queue', PortName: 'USB002', CimStatus: 3, DetectedErrorState: 8 },
    ]) });
    expect(res.printers.find((p) => p.name === 'Offline queue')?.state).toBe('offline');
    expect(res.printers.find((p) => p.name === 'Jammed queue')?.state).toBe('error');
  });

  it('中文无 IP 队列 ID 不碰撞', async () => {
    const res = await collectPrinters({ ...baseInput(), spooler: snapshot([{ Name: '前台打印机', PortName: 'USB001' }, { Name: '仓库打印机', PortName: 'USB002' }]) });
    expect(new Set(res.printers.map((p) => p.id)).size).toBe(2);
  });

  it('手动监控与自动识别合并后仍不受忽略影响', async () => {
    const res = await collectPrinters({ ...baseInput(), mdns: [MDNS], probe: async () => UNREACHABLE,
      manage: { manual: [{ ip: MDNS.ip, note: null, addedAt: T0 }], ignored: [`prn-${MDNS.ip}`] },
    });
    expect(res.printers).toHaveLength(1);
    expect(res.printers[0]).toMatchObject({ manual: true, state: 'offline', model: 'Canon MF750C' });
  });

  it('仅 IPP 成功不冒充 SNMP，且状态由协议决定', async () => {
    const res = await collectPrinters({ ...baseInput(), mdns: [MDNS], probe: async () => REACHABLE_9100,
      consumableProviders: [{ name: 'ipp', load: async () => ({ consumables: [], model: null, pageCount: null, panelText: 'toner-low-warning', state: 'warning', error: null }) }],
    });
    expect(res.printers[0]).toMatchObject({ source: 'ipp', state: 'warning', stateDetail: expect.stringContaining('toner-low') });
  });

  it('单一耗材来源抛错后继续降级，不让整轮消失', async () => {
    const res = await collectPrinters({ ...baseInput(), mdns: [MDNS], probe: async () => REACHABLE_9100,
      consumableProviders: [{ name: 'snmp', load: async () => { throw new Error('transport failed'); } },
        { name: 'ipp', load: async () => ({ consumables: [], model: 'Canon MF750C', pageCount: null, panelText: null, state: 'idle', error: null }) }],
    });
    expect(res.printers[0]).toMatchObject({ source: 'ipp', state: 'idle', model: 'Canon MF750C' });
  });
});
