// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../src/renderer/views/SettingsView';
import type { LanApi, SettingsPayload, UpdateStatus } from '../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function settings(patch: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    autoScan: true, autoScanIntervalSec: 60, showVirtualPrinters: false,
    snmpEnabled: true, useMdns: false, closeToTray: true, printerAlerts: true,
    autoUpdate: true, rememberRouterPassword: true, appVersion: '0.4.0',
    launchAtLogin: false, launchAtLoginAvailable: true, ...patch,
  };
}
function status(patch: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    phase: 'idle', currentVersion: '0.4.0', availableVersion: null, percent: null,
    transferred: null, total: null, error: null, unavailableReason: null,
    supported: true, autoUpdate: true, checkedAt: null, ...patch,
  };
}
function installApi(initial = status()) {
  let listener: ((next: UpdateStatus) => void) | undefined;
  let stored = settings();
  const off = vi.fn(() => { listener = undefined; });
  const api = {
    settingsGet: vi.fn<LanApi['settingsGet']>().mockImplementation(async () => stored),
    settingsUpdate: vi.fn<LanApi['settingsUpdate']>().mockImplementation(async (patch) => {
      stored = { ...stored, ...patch };
      return stored;
    }),
    setLaunchAtLogin: vi.fn<LanApi['setLaunchAtLogin']>().mockResolvedValue({ ok: true, error: null }),
    updateGetStatus: vi.fn<LanApi['updateGetStatus']>().mockResolvedValue(initial),
    updateCheck: vi.fn<LanApi['updateCheck']>().mockResolvedValue(status({ phase: 'checking' })),
    updateInstall: vi.fn<LanApi['updateInstall']>().mockResolvedValue({ ok: true, error: null }),
    onUpdateStatus: vi.fn<LanApi['onUpdateStatus']>().mockImplementation((cb) => { listener = cb; return off; }),
  } satisfies Partial<LanApi>;
  Object.defineProperty(window, 'lanApi', { configurable: true, value: api });
  return { ...api, off, push: (next: UpdateStatus) => listener?.(next) };
}
const mount = (onShowVirtualChange = vi.fn()) => render(<SettingsView showVirtualPrinters={false} onShowVirtualChange={onShowVirtualChange} />);
const flush = async () => { await act(async () => {}); };
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'lanApi');
});

describe('更新卡片', () => {
  it('跟随推送显示进度、就绪与安装失败，保留重试按钮', async () => {
    const api = installApi();
    mount();
    await flush();
    fireEvent.click(button('检查更新'));
    await flush();
    expect(button('检查中…').disabled).toBe(true);
    act(() => api.push(status({ phase: 'downloading', availableVersion: '0.4.1', percent: 42, transferred: 42, total: 100 })));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    act(() => api.push(status({ phase: 'downloaded', availableVersion: '0.4.1', percent: 100 })));
    expect(screen.queryByRole('progressbar')).toBeNull();
    api.updateInstall.mockResolvedValueOnce({ ok: false, error: '安装器权限不足' });
    fireEvent.click(button('重启并安装'));
    await flush();
    expect(screen.getByText('安装器权限不足')).toBeTruthy();
    expect(button(/重试安装|重启并安装/).disabled).toBe(false);
    fireEvent.click(button(/重试安装|重启并安装/));
    await flush();
    expect(api.updateInstall).toHaveBeenCalledTimes(2);
  });

  it('迟到的初始读取不覆盖已下载推送', async () => {
    const api = installApi();
    const initial = deferred<UpdateStatus>();
    api.updateGetStatus.mockReturnValue(initial.promise);
    mount();
    await flush();
    act(() => api.push(status({ phase: 'downloaded', availableVersion: '0.4.1', percent: 100 })));
    await act(async () => initial.resolve(status()));
    expect(button('重启并安装')).toBeTruthy();
  });

  it('手动检查的迟到响应不覆盖下载就绪', async () => {
    const api = installApi();
    const check = deferred<UpdateStatus>();
    api.updateCheck.mockReturnValue(check.promise);
    mount();
    await flush();
    fireEvent.click(button('检查更新'));
    act(() => api.push(status({ phase: 'downloaded', availableVersion: '0.4.1', percent: 100 })));
    await act(async () => check.resolve(status({ phase: 'checking' })));
    expect(button('重启并安装')).toBeTruthy();
  });

  it('迟到的初始错误不覆盖有效推送', async () => {
    const api = installApi();
    const initial = deferred<UpdateStatus>();
    api.updateGetStatus.mockReturnValue(initial.promise);
    mount();
    await flush();
    act(() => api.push(status({ phase: 'up-to-date' })));
    await act(async () => initial.reject(new Error('过期读取失败')));
    expect(screen.queryByText('过期读取失败')).toBeNull();
    expect(screen.getByText('已是最新版本（v0.4.0）')).toBeTruthy();
  });

  it('下载就绪携带安装失败时仍显示原因', async () => {
    installApi(status({ phase: 'downloaded', availableVersion: '0.4.1', percent: 100, error: '启动安装器失败，请重试' }));
    mount();
    await flush();
    expect(screen.getByText('启动安装器失败，请重试')).toBeTruthy();
    expect(button(/重试安装|重启并安装/).disabled).toBe(false);
  });

  it('网络失败允许手动重试，IPC 拒绝可见且按钮恢复', async () => {
    const api = installApi(status({ phase: 'error', error: '网络连接失败' }));
    api.updateCheck.mockRejectedValueOnce(new Error('IPC 断开'));
    mount();
    await flush();
    expect(screen.getByText('网络连接失败')).toBeTruthy();
    fireEvent.click(button('检查更新'));
    await flush();
    expect(screen.getByText('IPC 断开')).toBeTruthy();
    expect(button('检查更新').disabled).toBe(false);
  });

  it.each(['便携版不支持就地更新', '开发模式不执行更新检查'])('%s 时禁用操作', async (reason) => {
    const api = installApi(status({ phase: 'disabled', supported: false, unavailableReason: reason }));
    mount();
    await flush();
    expect(button('检查更新').disabled).toBe(true);
    expect(button(/自动检查并下载更新/).disabled).toBe(true);
    fireEvent.click(button('检查更新'));
    expect(api.updateCheck).not.toHaveBeenCalled();
  });

  it('卸载后解除订阅并忽略在飞读取', async () => {
    const api = installApi();
    const initial = deferred<UpdateStatus>();
    api.updateGetStatus.mockReturnValue(initial.promise);
    const view = mount();
    await flush();
    view.unmount();
    await act(async () => initial.resolve(status()));
    expect(api.off).toHaveBeenCalledOnce();
  });
});

describe('设置保存与回读', () => {
  it('初次读取失败显示错误，而非永远加载', async () => {
    const api = installApi();
    api.settingsGet.mockRejectedValue(new Error('读取设置失败'));
    mount();
    await flush();
    expect(screen.getByText('读取设置失败')).toBeTruthy();
    expect(screen.queryByText('正在读取设置…')).toBeNull();
  });

  it('虚拟打印机开关等待保存成功后才同步父组件', async () => {
    const api = installApi();
    const save = deferred<SettingsPayload>();
    api.settingsUpdate.mockReturnValue(save.promise);
    const changed = vi.fn();
    mount(changed);
    await flush();
    changed.mockClear();
    fireEvent.click(button(/显示本机虚拟打印机/));
    expect(changed).not.toHaveBeenCalled();
    expect(button(/显示本机虚拟打印机/).disabled).toBe(true);
    await act(async () => save.resolve(settings({ showVirtualPrinters: true })));
    expect(changed).toHaveBeenCalledWith(true);
  });

  it('虚拟打印机保存失败不改变父组件显示状态', async () => {
    const api = installApi();
    api.settingsUpdate.mockRejectedValue(new Error('写入设置失败'));
    const changed = vi.fn();
    mount(changed);
    await flush();
    changed.mockClear();
    fireEvent.click(button(/显示本机虚拟打印机/));
    await flush();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText('写入设置失败')).toBeTruthy();
    expect(button(/显示本机虚拟打印机/).getAttribute('aria-pressed')).toBe('false');
  });

  it('提醒与自动更新开关保存后重新进入仍保持', async () => {
    installApi();
    const view = mount();
    await flush();
    fireEvent.click(button(/打印机异常提醒/));
    await flush();
    fireEvent.click(button(/自动检查并下载更新/));
    await flush();
    view.unmount();
    mount();
    await flush();
    expect(button(/打印机异常提醒/).getAttribute('aria-pressed')).toBe('false');
    expect(button(/自动检查并下载更新/).getAttribute('aria-pressed')).toBe('false');
  });

  it('扫描间隔拒绝非法值，合法值以主进程返回为准', async () => {
    const api = installApi();
    mount();
    await flush();
    const input = screen.getByRole<HTMLInputElement>('spinbutton');
    fireEvent.change(input, { target: { value: '29' } });
    fireEvent.click(button('保存'));
    expect(api.settingsUpdate).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '300' } });
    fireEvent.click(button('保存'));
    await flush();
    expect(api.settingsUpdate).toHaveBeenCalledWith({ autoScanIntervalSec: 300 });
    expect(input.value).toBe('300');
  });

  it('开机自启不采用乐观值，以操作后回读为准', async () => {
    const api = installApi();
    mount();
    await flush();
    fireEvent.click(button(/开机自启/));
    await flush();
    expect(api.setLaunchAtLogin).toHaveBeenCalledWith(true);
    expect(button(/开机自启/).getAttribute('aria-pressed')).toBe('false');
    expect(api.settingsUpdate).not.toHaveBeenCalled();
  });
});
