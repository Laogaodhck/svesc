/**
 * 打印管理页三层断言（手动添加 / 忽略 / 别名）：
 *
 *  1) JsonStore：IP 校验、同 IP 幂等更新备注、忽略列表、落盘 round-trip；
 *  2) collectPrinters：手动打印机合并进监控（探活失败也保留并如实 offline）、
 *     按 IP 去重（手动 ≠ 重复条目）、忽略过滤（手动条目不受忽略影响）；
 *  3) 引擎门面 applyAliases 的打印机投影经由 store.aliasOf，本文件只锁 store 层。
 *
 * probe 与耗材 provider 全部注入，不碰真实网络。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectPrinters, type ConsumableProvider } from '../src/main/engine/printers/printer-service';
import { isValidIpv4, JsonStore } from '../src/main/engine/store';
import type { ReachabilityResult } from '../src/main/engine/discovery/ports';
import type { SpoolerSnapshot } from '../src/main/engine/printers/spooler';
import { device as deviceFixture, T0 } from './fixtures';

const REACHABLE: ReachabilityResult = { reachable: true, port: 9100, triedPorts: [9100] };
const UNREACHABLE: ReachabilityResult = { reachable: false, port: null, triedPorts: [9100, 631, 515] };

function emptySpooler(): SpoolerSnapshot {
  return { printers: [], cim: [], jobs: [], errors: { printers: null, cim: null, jobs: null }, ms: 0, fallbackUsed: false };
}

// ---------- 1) JsonStore ----------

describe('JsonStore 打印管理配置', () => {
  it('isValidIpv4：合法/非法边界', () => {
    expect(isValidIpv4('192.168.2.213')).toBe(true);
    expect(isValidIpv4('10.0.0.1')).toBe(true);
    expect(isValidIpv4('256.1.1.1')).toBe(false);
    expect(isValidIpv4('1.2.3')).toBe(false);
    expect(isValidIpv4('a.b.c.d')).toBe(false);
    expect(isValidIpv4('')).toBe(false);
  });

  it('addManualPrinter：非法 IP 拒绝且不落盘；同 IP 幂等更新备注', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-store-'));
    const store = new JsonStore(dir);

    const bad = store.addManualPrinter('999.1.2.3', null);
    expect(bad.ok).toBe(false);
    expect(store.printerManage().manual).toHaveLength(0);

    expect(store.addManualPrinter('192.168.2.50', '前台 HP').ok).toBe(true);
    expect(store.addManualPrinter('192.168.2.50', '前台彩色机').ok).toBe(true);
    const manual = store.printerManage().manual;
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ ip: '192.168.2.50', note: '前台彩色机' });
  });

  it('removeManualPrinter 与 setPrinterIgnored 各司其职', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-store-'));
    const store = new JsonStore(dir);
    store.addManualPrinter('192.168.2.50', null);
    store.setPrinterIgnored('prn-192.168.2.213', true);
    store.setPrinterIgnored('prn-192.168.2.213', true); // 重复忽略不产生重复 id
    expect(store.printerManage().ignored).toEqual(['prn-192.168.2.213']);

    store.setPrinterIgnored('prn-192.168.2.213', false);
    expect(store.printerManage().ignored).toEqual([]);

    store.removeManualPrinter('192.168.2.50');
    expect(store.printerManage().manual).toHaveLength(0);
    // 删除不存在的 IP 也是幂等 ok
    expect(store.removeManualPrinter('192.168.2.50').ok).toBe(true);
  });

  it('落盘 round-trip：flush 后重新打开必须读回 manual / ignored / 别名', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-store-'));
    const store = new JsonStore(dir);
    store.addManualPrinter('192.168.2.51', '仓库打印机');
    store.setPrinterIgnored('prn-192.168.2.99', true);
    store.setAlias('prn-192.168.2.51', '仓库彩色机');
    store.flush();

    // 文件确实是 JSON 落盘（不是内存假象）
    const raw = JSON.parse(readFileSync(store.filePath, 'utf8')) as { printers?: { manual?: unknown[] } };
    expect(Array.isArray(raw.printers?.manual)).toBe(true);

    const reopened = new JsonStore(dir);
    expect(reopened.printerManage().manual[0]).toMatchObject({ ip: '192.168.2.51', note: '仓库打印机' });
    expect(reopened.printerManage().ignored).toEqual(['prn-192.168.2.99']);
    expect(reopened.aliasOf('prn-192.168.2.51')).toBe('仓库彩色机');
  });

  it('损坏文件 → 默认 printers 配置重建，不崩启动路径', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-store-'));
    const store = new JsonStore(dir);
    store.addManualPrinter('192.168.2.52', null);
    store.flush();
    writeFileSync(store.filePath, '{ not valid json', 'utf8');

    const reopened = new JsonStore(dir);
    expect(reopened.printerManage()).toEqual({ manual: [], ignored: [] });
  });
});

// ---------- 2) collectPrinters 管理合并 ----------

const noopProvider: ConsumableProvider = {
  name: 'unknown',
  async load() {
    return { consumables: [], model: null, pageCount: null, panelText: null, sysDescr: null, error: null };
  },
};

describe('collectPrinters 手动打印机合并', () => {
  it('自动发现不到的手动条目也进监控；探活失败如实 offline 且标注"手动添加"', async () => {
    const res = await collectPrinters({
      spooler: emptySpooler(),
      arp: new Map(),
      devices: [],
      probe: async () => UNREACHABLE,
      consumableProviders: [noopProvider],
      manage: { manual: [{ ip: '192.168.2.77', note: '前台打印机', addedAt: T0 }] },
      now: T0,
    });
    expect(res.printers).toHaveLength(1);
    const p = res.printers[0]!;
    expect(p.manual).toBe(true);
    expect(p.ip).toBe('192.168.2.77');
    expect(p.name).toBe('前台打印机');
    expect(p.state).toBe('offline');
    expect(p.stateDetail).toContain('手动添加');
    expect(res.reachable.get(p.id)).toBe(false);
  });

  it('按 IP 去重：手动 IP 已被自动发现时不产生重复条目（manual 不覆盖发现结果）', async () => {
    const res = await collectPrinters({
      spooler: emptySpooler(),
      arp: new Map(),
      devices: [
        deviceFixture({
          id: 'dev-1',
          ip: '10.1.1.9',
          hostname: 'hp-office',
          vendor: 'HP',
          kind: 'printer',
          openPorts: [9100],
        }),
      ],
      probe: async () => REACHABLE,
      consumableProviders: [noopProvider],
      manage: { manual: [{ ip: '10.1.1.9', note: '手动重名', addedAt: T0 }] },
      now: T0,
    });
    const ips = res.printers.map((p) => p.ip);
    expect(ips.filter((v) => v === '10.1.1.9')).toHaveLength(1);
    // 保留的是自动发现条目（manual=false），不是手动替身
    expect(res.printers.find((p) => p.ip === '10.1.1.9')?.manual).toBe(false);
  });

  it('忽略过滤：被忽略的发现条目消失；手动条目不受忽略影响', async () => {
    const spooler = emptySpooler();
    spooler.printers.push({ Name: 'Neighbor Printer', PortName: 'IP_10.1.1.20', PrinterStatus: 0 });
    const res = await collectPrinters({
      spooler,
      arp: new Map(),
      devices: [],
      probe: async (ip) => (ip === '10.1.1.20' ? UNREACHABLE : REACHABLE),
      consumableProviders: [noopProvider],
      manage: {
        manual: [{ ip: '10.1.1.30', note: null, addedAt: T0 }],
        ignored: ['prn-10.1.1.20'],
      },
      now: T0,
    });
    expect(res.printers.map((p) => p.ip).sort()).toEqual(['10.1.1.30']);
    expect(res.printers[0]?.manual).toBe(true);
  });

  it('无备注的手动条目用默认命名，有 ARP 记录时带出 MAC', async () => {
    const res = await collectPrinters({
      spooler: emptySpooler(),
      arp: new Map([['10.1.1.40', { ip: '10.1.1.40', mac: 'aa-bb-cc-11-22-33', iface: null }]]),
      devices: [],
      probe: async () => REACHABLE,
      consumableProviders: [noopProvider],
      manage: { manual: [{ ip: '10.1.1.40', note: null, addedAt: T0 }] },
      now: T0,
    });
    const p = res.printers[0]!;
    expect(p.name).toBe('手动打印机 10.1.1.40');
    expect(p.mac).toBe('aa-bb-cc-11-22-33');
    expect(p.state).toBe('idle');
  });
});
