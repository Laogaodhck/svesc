/**
 * 设置功能回归锁：
 *  1) JsonStore.settings 新字段（showVirtualPrinters/snmpEnabled/useMdns）round-trip，
 *     旧版本文件（缺字段）读取时必须得到安全默认值；
 *  2) Scheduler.setPrinterSources 运行时改 cfg（下一轮打印机刷新即生效，无需重启）；
 *  3) 设置页的持久化语义：引擎 updateSettings 落盘 + 立即应用（此处锁 store 层）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore, defaultState } from '../src/main/engine/store';
import { Scheduler } from '../src/main/engine/scheduler';

function baseCfg() {
  return {
    prefix: null,
    hosts: [] as string[],
    selfIp: null,
    gateway: null,
    subnetLabel: null,
    autoScanIntervalSec: 60,
    forceDemo: false,
    snmpEnabled: true,
    useMdns: false,
  };
}

describe('JsonStore.settings 扩展字段', () => {
  it('round-trip：新字段写入后重开必须读回', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-settings-'));
    const store = new JsonStore(dir);
    store.setSettings({ showVirtualPrinters: true, snmpEnabled: false, useMdns: true });
    store.flush();

    const reopened = new JsonStore(dir);
    expect(reopened.settings).toMatchObject({
      showVirtualPrinters: true,
      snmpEnabled: false,
      useMdns: true,
    });
  });

  it('旧版本文件缺新字段 → 安全默认值（false/true/false），不崩启动路径', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-settings-legacy-'));
    const store = new JsonStore(dir);
    store.flush();
    const filePath = store.filePath;
    // 手写"旧版本"状态文件：settings 只有旧有的两个字段
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, aliases: {}, settings: { autoScan: true, autoScanIntervalSec: 60 } }),
      'utf8',
    );

    const reopened = new JsonStore(dir);
    expect(reopened.settings).toEqual({
      autoScan: true,
      autoScanIntervalSec: 60,
      showVirtualPrinters: false,
      snmpEnabled: true,
      useMdns: false,
      closeToTray: true,
      printerAlerts: true,
      rememberRouterPassword: true,
    });
  });

  it('defaultState 契约：与设置页首次展示一致', () => {
    expect(defaultState().settings).toEqual({
      autoScan: true,
      autoScanIntervalSec: 60,
      showVirtualPrinters: false,
      snmpEnabled: true,
      useMdns: false,
      closeToTray: true,
      printerAlerts: true,
      rememberRouterPassword: true,
    });
  });
});

describe('Scheduler.setPrinterSources 运行时开关', () => {
  it('改 cfg 立即可读（refreshPrinters 每轮读取，无需重启引擎）', () => {
    const scheduler = new Scheduler(baseCfg());
    expect(scheduler.setPrinterSources({ snmpEnabled: false })).toEqual({ snmpEnabled: false, useMdns: false });
    expect(scheduler.setPrinterSources({ useMdns: true })).toEqual({ snmpEnabled: false, useMdns: true });
    // 未指定的字段不受影响
    expect(scheduler.setPrinterSources({})).toEqual({ snmpEnabled: false, useMdns: true });
  });

  it('autoScan 间隔经 setAutoScan 仍照常工作（设置页复用既有通道）', () => {
    const scheduler = new Scheduler(baseCfg());
    const res = scheduler.setAutoScan(true, 300);
    expect(res).toEqual({ autoScan: true, intervalSec: 300 });
  });
});
