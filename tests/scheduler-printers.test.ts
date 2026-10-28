import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Scheduler } from '../src/main/engine/scheduler';
import { createEngine } from '../src/main/engine';
import type { ManualPrinterEntry } from '../src/shared/types';
import type { SpoolerSnapshot } from '../src/main/engine/printers/spooler';
import { readSpooler } from '../src/main/engine/printers/spooler';
import { snmpGet } from '../src/main/engine/printers/snmp-client';
import { ippGetAttributes } from '../src/main/engine/printers/ipp';
import { printJobAction, printTestPage, setDefaultPrinter } from '../src/main/engine/printers/print-ops';

vi.mock('../src/main/engine/printers/spooler', async (original) => ({
  ...await original<typeof import('../src/main/engine/printers/spooler')>(), readSpooler: vi.fn(),
}));
vi.mock('../src/main/engine/printers/mdns', () => ({ discoverMdnsPrinters: vi.fn(async () => []) }));
vi.mock('../src/main/engine/printers/snmp-client', () => ({ snmpGet: vi.fn(), snmpWalk: vi.fn() }));
vi.mock('../src/main/engine/printers/ipp', async (original) => ({
  ...await original<typeof import('../src/main/engine/printers/ipp')>(), ippGetAttributes: vi.fn(),
}));
vi.mock('../src/main/engine/discovery/ports', async (original) => ({
  ...await original<typeof import('../src/main/engine/discovery/ports')>(),
  probePrinterEndpoint: vi.fn(async () => ({ reachable: true, port: 9100, triedPorts: [9100] })),
}));
vi.mock('../src/main/engine/discovery/subnet', () => ({ detectSubnet: vi.fn(async () => null) }));
vi.mock('../src/main/engine/printers/print-ops', () => ({
  printJobAction: vi.fn(async () => ({ ok: true, error: null })),
  printTestPage: vi.fn(async () => ({ ok: true, error: null })),
  setDefaultPrinter: vi.fn(async () => ({ ok: true, error: null })),
}));

const blank = (): SpoolerSnapshot => ({ printers: [], cim: [], jobs: [], ports: [], errors: { printers: null, cim: null, jobs: null }, ms: 0, fallbackUsed: false });
const IP = '10.1.1.20';
const manualEntry = { ip: IP, note: null, addedAt: 1 };
function scheduler(getManual = (): ManualPrinterEntry[] => [manualEntry], onSnapshot = vi.fn()) {
  return new Scheduler({ prefix: '10.1.1.', hosts: [IP], selfIp: null, gateway: null, subnetLabel: '10.1.1.0/24', autoScanIntervalSec: 60, forceDemo: false, snmpEnabled: true, useMdns: false },
    { getPrinterManage: () => ({ manual: getManual(), ignored: [] }), onSnapshot });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readSpooler).mockReset().mockResolvedValue(blank());
  vi.mocked(snmpGet).mockResolvedValue({ ok: false, varbinds: [], error: 'timeout' });
  vi.mocked(ippGetAttributes).mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe('打印机刷新调度', () => {
  it('并发周期刷新共享完成结果，不提前返回成功', async () => {
    let release!: (value: SpoolerSnapshot) => void;
    vi.mocked(readSpooler).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const s = scheduler();
    const first = s.refreshPrinters();
    const second = s.refreshPrinters();
    expect(first).toBe(second);
    expect(readSpooler).toHaveBeenCalledOnce();
    release(blank());
    expect(await second).toEqual({ ok: true, error: null });
  });

  it('进行中的手动刷新合并补采，旧帧不发布', async () => {
    let release!: (value: SpoolerSnapshot) => void;
    let manual: ManualPrinterEntry[] = [manualEntry];
    const emit = vi.fn();
    vi.mocked(readSpooler).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const s = scheduler(() => manual, emit);
    const first = s.refreshPrinters();
    manual = [{ ...manualEntry, ip: '10.1.1.21' }];
    const forced = s.refreshPrinters(true);
    s.refreshPrinters(true);
    expect(forced).toBe(first);
    release(blank());
    await forced;
    expect(readSpooler).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledOnce();
    expect(s.buildSnapshot().printers.filter((p) => p.manual).map((p) => p.ip)).toEqual(['10.1.1.21']);
  });

  it('负缓存跨轮有效，手动刷新可绕过缓存，过期后重新查询', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const s = scheduler();
    await s.refreshPrinters();
    await s.refreshPrinters();
    expect(snmpGet).toHaveBeenCalledOnce();
    expect(ippGetAttributes).toHaveBeenCalledOnce();
    await s.refreshPrinters(true);
    expect(snmpGet).toHaveBeenCalledTimes(2);
    expect(ippGetAttributes).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_300_001);
    await s.refreshPrinters();
    expect(snmpGet).toHaveBeenCalledTimes(3);
    expect(ippGetAttributes).toHaveBeenCalledTimes(3);
  });

  it('关闭 SNMP 后下一轮只调用 IPP', async () => {
    const s = scheduler();
    s.setPrinterSources({ snmpEnabled: false });
    await s.refreshPrinters();
    expect(snmpGet).not.toHaveBeenCalled();
    expect(ippGetAttributes).toHaveBeenCalledOnce();
  });

  it('采集错误如实返回，失败后可重试恢复', async () => {
    vi.mocked(readSpooler).mockRejectedValueOnce(new Error('spooler unavailable'));
    const s = scheduler();
    expect(await s.refreshPrinters()).toMatchObject({ ok: false, error: expect.stringContaining('spooler unavailable') });
    expect(await s.refreshPrinters()).toEqual({ ok: true, error: null });
  });

  it('分通道失败保留快照及错误，不宣称全部成功', async () => {
    vi.mocked(readSpooler).mockResolvedValueOnce({ ...blank(), errors: { printers: null, cim: null, jobs: 'denied', ports: 'port lookup failed' } });
    const s = scheduler();
    expect(await s.refreshPrinters()).toEqual({ ok: false, error: 'jobs: denied · ports: port lookup failed' });
    expect(s.buildSnapshot().printers.some((p) => p.ip === IP)).toBe(true);
  });
});

describe('真实队列管理门控', () => {
  it('管理配置变更真正进入引擎刷新，支持添加、备注、忽略恢复与删除', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-printer-config-'));
    const engine = await createEngine({ userDataDir: dir, forceDemo: false });
    try {
      expect(engine.addManualPrinter(IP, '备用')).toMatchObject({ ok: true });
      await engine.printerRefresh();
      expect(engine.getSnapshot().printers).toEqual([expect.objectContaining({ ip: IP, manual: true, name: '备用' })]);
      engine.addManualPrinter(IP, '新备注');
      await engine.printerRefresh();
      expect(engine.getSnapshot().printers[0]?.name).toBe('新备注');
      engine.removeManualPrinter(IP);
      await engine.printerRefresh();
      expect(engine.getSnapshot().printers).toEqual([]);
      vi.mocked(readSpooler).mockResolvedValue({ ...blank(), printers: [{ Name: 'Queue', PortName: 'USB001' }] });
      await engine.printerRefresh();
      const id = engine.getSnapshot().printers[0]!.id;
      engine.setPrinterIgnored(id, true);
      await engine.printerRefresh();
      expect(engine.getSnapshot().printers).toEqual([]);
      engine.setPrinterIgnored(id, false);
      await engine.printerRefresh();
      expect(engine.getSnapshot().printers[0]?.id).toBe(id);
    } finally {
      engine.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('拒绝网络名称/别名/模拟名称/未知任务，允许准确的队列和任务', async () => {
    const spooler = blank();
    spooler.printers = [{ Name: 'Windows queue', PortName: 'USB001', PrinterStatus: 0 }];
    spooler.jobs = [{ Id: 4, PrinterName: 'Windows queue', DocumentName: 'fixture' }];
    vi.mocked(readSpooler).mockResolvedValue(spooler);
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-printer-engine-'));
    const engine = await createEngine({ userDataDir: dir, forceDemo: false });
    try {
      await engine.printerRefresh();
      for (const name of ['alias', '网络打印机 10.1.1.20', 'simulated', '']) {
        expect((await engine.printerPrintTestPage(name)).ok).toBe(false);
        expect((await engine.printerSetDefault(name)).ok).toBe(false);
        expect((await engine.printerJobAction('cancel', name, '4')).ok).toBe(false);
      }
      expect((await engine.printerJobAction('cancel', 'Windows queue', '9')).ok).toBe(false);
      expect(printTestPage).not.toHaveBeenCalled();
      expect(setDefaultPrinter).not.toHaveBeenCalled();
      expect(printJobAction).not.toHaveBeenCalled();
      expect((await engine.printerJobAction('pause', 'Windows queue', '4')).ok).toBe(true);
      expect(printJobAction).toHaveBeenCalledExactlyOnceWith('pause', 'Windows queue', '4');
      await engine.printerRefresh();
    } finally {
      engine.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
