// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanApi, SettingsPayload, Snapshot, UpdateStatus } from '../src/shared/types';

const feed = vi.hoisted(() => ({ snapshot: null as Snapshot | null }));
vi.mock('../src/renderer/hooks/useLiveFeed', () => ({
  useLiveFeed: () => ({ snapshot: feed.snapshot, apiMissing: false, error: null, progress: null }),
}));
import { App } from '../src/renderer/App';

function status(patch: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    phase: 'downloaded', currentVersion: '0.4.0', availableVersion: '0.4.1', percent: 100,
    transferred: 100, total: 100, error: null, unavailableReason: null,
    supported: true, autoUpdate: true, checkedAt: 1000, ...patch,
  };
}
function installApi() {
  const listeners = new Set<(next: UpdateStatus) => void>();
  const api = {
    settingsGet: vi.fn<LanApi['settingsGet']>().mockRejectedValue(new Error('fixture')),
    settingsUpdate: vi.fn<LanApi['settingsUpdate']>(),
    updateGetStatus: vi.fn<LanApi['updateGetStatus']>().mockResolvedValue(status()),
    onUpdateStatus: vi.fn<LanApi['onUpdateStatus']>().mockImplementation((cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    }),
    updateInstall: vi.fn<LanApi['updateInstall']>().mockResolvedValue({ ok: true, error: null }),
  } satisfies Partial<LanApi>;
  Object.defineProperty(window, 'lanApi', { configurable: true, value: api });
  return { ...api, listeners, push: (s: UpdateStatus) => { for (const cb of listeners) cb(s); } };
}
const flush = async () => { await act(async () => {}); };
afterEach(() => {
  cleanup();
  feed.snapshot = null;
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'lanApi');
  Reflect.deleteProperty(window, '__setView');
});

function printerSettings(showVirtualPrinters = false): SettingsPayload {
  return {
    autoScan: true, autoScanIntervalSec: 60, showVirtualPrinters,
    snmpEnabled: true, useMdns: false, closeToTray: true, printerAlerts: true,
    autoUpdate: true, rememberRouterPassword: true, appVersion: '0.4.0',
    launchAtLogin: false, launchAtLoginAvailable: true,
  };
}

function installPrinterApi(showVirtual = false) {
  const api = installApi();
  let stored = printerSettings(showVirtual);
  api.settingsGet.mockImplementation(async () => stored);
  api.settingsUpdate.mockImplementation(async (patch) => {
    stored = { ...stored, ...patch };
    return stored;
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  feed.snapshot = {
    ts: 1000, subnet: null, dataSource: 'live', devices: [], watches: [], warnings: [],
    printers: [{
      id: 'pdf', name: 'Fixture PDF', queueName: null, alias: null, model: null,
      ip: null, mac: null, connection: 'virtual', state: 'idle', stateDetail: null,
      isDefault: false, shared: false, manual: false, pageCount: null,
      consumables: [], jobs: [], source: 'spooler', lastSeen: 1000,
    }],
    system: {
      totalDevices: 0, online: 0, offline: 0, degraded: 0, printers: 0, printersWithFault: 0,
      rxBps: null, txBps: null, bandwidthHistory: [], lastScanAt: null,
      nextScanInMs: null, autoScan: false, autoScanIntervalSec: 60,
      scan: { active: false, pct: 0, phase: 'idle', scanned: 0, total: 0, startedAt: null },
    },
  };
  return api;
}

const virtualToggle = () => screen.getByRole<HTMLButtonElement>('button', { name: '显示本机虚拟打印机' });

describe('跨页面虚拟打印机设置', () => {
  it('打印机页保存失败保留原状态并提示，重试成功后才隐藏卡片', async () => {
    const api = installPrinterApi(true);
    api.settingsUpdate.mockRejectedValueOnce(new Error('设置写入失败'));
    render(<App />);
    await flush();
    act(() => window.__setView?.('printers'));
    fireEvent.click(virtualToggle());
    await flush();
    expect(virtualToggle().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Fixture PDF')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('设置写入失败');
    fireEvent.click(virtualToggle());
    await flush();
    expect(virtualToggle().getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Fixture PDF')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('保存期间保持原值且不重复提交，成功后显示虚拟卡片', async () => {
    const api = installPrinterApi();
    let resolve!: (s: SettingsPayload) => void;
    api.settingsUpdate.mockReturnValue(new Promise((res) => { resolve = res; }));
    render(<App />);
    await flush();
    act(() => window.__setView?.('printers'));
    fireEvent.click(virtualToggle());
    fireEvent.click(virtualToggle());
    expect(api.settingsUpdate).toHaveBeenCalledOnce();
    expect(virtualToggle().getAttribute('aria-pressed')).toBe('false');
    expect(virtualToggle().disabled).toBe(true);
    await act(async () => resolve(printerSettings(true)));
    expect(virtualToggle().getAttribute('aria-pressed')).toBe('true');
    expect(virtualToggle().disabled).toBe(false);
    expect(screen.getByText('Fixture PDF')).toBeTruthy();
  });

  it('设置页保存成功不被 App 迟到的初始设置覆盖', async () => {
    const api = installPrinterApi();
    let resolve!: (s: SettingsPayload) => void;
    api.settingsGet.mockReturnValueOnce(new Promise((res) => { resolve = res; }));
    render(<App />);
    act(() => window.__setView?.('settings'));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /^显示本机虚拟打印机/ }));
    await flush();
    act(() => window.__setView?.('printers'));
    expect(virtualToggle().getAttribute('aria-pressed')).toBe('true');
    await act(async () => resolve(printerSettings(false)));
    expect(virtualToggle().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Fixture PDF')).toBeTruthy();
  });

  it('打印机页以写入返回值为准，而不是请求值', async () => {
    const api = installPrinterApi();
    api.settingsUpdate.mockResolvedValueOnce(printerSettings(false));
    render(<App />);
    await flush();
    act(() => window.__setView?.('printers'));
    fireEvent.click(virtualToggle());
    await flush();
    expect(api.settingsUpdate).toHaveBeenCalledWith({ showVirtualPrinters: true });
    expect(virtualToggle().getAttribute('aria-pressed')).toBe('false');
  });
});

describe('全局更新横幅', () => {
  it('初始状态迟到不覆盖推送就绪状态', async () => {
    const api = installApi();
    let resolve!: (s: UpdateStatus) => void;
    api.updateGetStatus.mockReturnValue(new Promise((res) => { resolve = res; }));
    render(<App />);
    act(() => api.push(status()));
    await act(async () => resolve(status({ phase: 'idle' })));
    expect(screen.getByRole('button', { name: '重启并安装' })).toBeTruthy();
  });

  it('稍后安装后同版本状态推送不反复打断，下个版本重新提示', async () => {
    const api = installApi();
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '稍后安装' }));
    act(() => api.push(status({ autoUpdate: false })));
    expect(screen.queryByRole('button', { name: '稍后安装' })).toBeNull();
    act(() => api.push(status({ availableVersion: '0.4.2' })));
    expect(screen.getByRole('button', { name: '稍后安装' })).toBeTruthy();
  });

  it('异步安装错误推送可见且可再次尝试', async () => {
    const api = installApi();
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '重启并安装' }));
    await flush();
    act(() => api.push(status({ error: '安装器启动被拒绝' })));
    expect(screen.getByRole('alert').textContent).toContain('安装器启动被拒绝');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /重启并安装|重试安装/ }).disabled).toBe(false);
  });

  it('安装被拒绝不假装成功，展示错误且允许重试', async () => {
    const api = installApi();
    api.updateInstall.mockResolvedValue({ ok: false, error: '安装失败' });
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '重启并安装' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('安装失败');
    expect(api.updateInstall).toHaveBeenCalledOnce();
  });

  it('普通卸载不会触发安装，并取消订阅', async () => {
    const api = installApi();
    const view = render(<App />);
    await flush();
    view.unmount();
    expect(api.listeners.size).toBe(0);
    expect(api.updateInstall).not.toHaveBeenCalled();
  });
});
