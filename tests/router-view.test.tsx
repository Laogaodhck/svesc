// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouterView } from '../src/renderer/views/RouterView';
import type { LanApi, RouterStatus, SettingsPayload } from '../src/shared/types';
import { T0 } from './fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function settings(rememberRouterPassword = false): SettingsPayload {
  return {
    autoScan: true, autoScanIntervalSec: 60, showVirtualPrinters: false,
    snmpEnabled: false, useMdns: false, closeToTray: true, printerAlerts: false,
    autoUpdate: false, rememberRouterPassword, appVersion: '0.0.0-test',
    launchAtLogin: false, launchAtLoginAvailable: false,
  };
}

function status(overrides: Partial<RouterStatus> = {}): RouterStatus {
  return {
    ts: T0, phase: 'ready',
    identity: { ip: '192.0.2.1', brand: 'openwrt', modelHint: null, upnpFriendlyName: null, adminUrl: 'https://router.invalid/' },
    capabilities: { upnp: false, openwrt: true, managementPage: true },
    wan: { ip: null, totalBytesRx: null, totalBytesTx: null, rxBps: null, txBps: null, connectionStatus: null, uptimeSec: null },
    dhcpLeases: [], wirelessClients: [], wirelessStatus: null, systemBoard: null,
    session: { loggedIn: false, user: null, error: null, kind: null, invalidatedAt: null },
    lastError: null, capabilityNotes: [], ...overrides,
  };
}

function session(kind: NonNullable<RouterStatus['session']['kind']>): RouterStatus['session'] {
  return { loggedIn: true, user: kind === 'web' ? null : 'root', error: null, kind, invalidatedAt: null };
}

function installApi(initial = status()) {
  let listener: Parameters<LanApi['onRouterStatus']>[0] | undefined;
  const off = vi.fn(() => { listener = undefined; });
  const api = {
    settingsGet: vi.fn<LanApi['settingsGet']>().mockResolvedValue(settings()),
    settingsUpdate: vi.fn<LanApi['settingsUpdate']>().mockImplementation(async (patch) => ({ ...settings(), ...patch })),
    routerGetStatus: vi.fn<LanApi['routerGetStatus']>().mockResolvedValue(initial),
    routerRefresh: vi.fn<LanApi['routerRefresh']>().mockResolvedValue(initial),
    routerLogin: vi.fn<LanApi['routerLogin']>().mockResolvedValue({ ok: true, error: null, persisted: false, persistError: null }),
    routerLogout: vi.fn<LanApi['routerLogout']>().mockResolvedValue({ ok: true }),
    routerCheckWebSession: vi.fn<LanApi['routerCheckWebSession']>().mockResolvedValue({ session: false }),
    onRouterStatus: vi.fn<LanApi['onRouterStatus']>().mockImplementation((callback) => {
      listener = callback;
      return off;
    }),
  } satisfies Partial<LanApi>;
  Object.defineProperty(window, 'lanApi', { configurable: true, value: api });
  return { ...api, off, push: (next: RouterStatus) => { listener?.(next); } };
}

async function flush() {
  await act(async () => {});
}

function enterCredentials() {
  fireEvent.change(screen.getByPlaceholderText('用户名（OpenWrt 默认 root）'), { target: { value: ' root ' } });
  const password = screen.getByPlaceholderText<HTMLInputElement>('密码');
  fireEvent.change(password, { target: { value: 'test-only-password' } });
  return password;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('测试禁止触网')));
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => { throw new Error('测试禁止触网'); });
});

afterEach(() => {
  cleanup();
  expect(fetch).not.toHaveBeenCalled();
  expect(XMLHttpRequest.prototype.send).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'lanApi');
});

describe('RouterView 状态读取', () => {
  it('未连接桥时不尝试调用路由器接口', () => {
    render(<RouterView />);
    expect(screen.getByText('未连接主进程')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '账密登录' })).toBeNull();
  });

  it('初始请求未返回时显示 loading，推送后展示探测状态', async () => {
    const api = installApi();
    const pending = deferred<RouterStatus>();
    api.routerGetStatus.mockReturnValue(pending.promise);
    render(<RouterView />);
    expect(screen.getByText('正在探测网关…')).toBeTruthy();
    expect(api.onRouterStatus).toHaveBeenCalledTimes(1);
    act(() => { api.push(status({ phase: 'probing' })); });
    expect(screen.getByText('探测中')).toBeTruthy();
    expect(screen.queryByText('正在探测网关…')).toBeNull();
    await act(async () => { pending.resolve(status({ phase: 'probing' })); });
    expect(api.routerLogin).not.toHaveBeenCalled();
  });

  it('初始探测失败显示原因，重试期间禁用按钮，成功后恢复', async () => {
    const api = installApi();
    api.routerGetStatus.mockRejectedValue(new Error('网关探测 IPC 失败'));
    const retry = deferred<RouterStatus>();
    api.routerRefresh.mockReturnValue(retry.promise);
    render(<RouterView />);
    await flush();
    expect(screen.getByText('网关探测失败')).toBeTruthy();
    expect(screen.getByText('网关探测 IPC 失败')).toBeTruthy();
    expect(screen.queryByText('正在探测网关…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重试' }).disabled).toBe(true);
    await act(async () => { retry.resolve(status()); });
    expect(screen.getByText('未登录')).toBeTruthy();
    expect(screen.queryByText('网关探测失败')).toBeNull();
    expect(api.routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('网关不可达时展示探测原因而非登录表单', async () => {
    installApi(status({ phase: 'unreachable', lastError: '未检测到默认网关' }));
    render(<RouterView />);
    await flush();
    expect(screen.getByText('网关不可达')).toBeTruthy();
    expect(screen.getByText('未检测到默认网关')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '账密登录' })).toBeNull();
  });

  it('手动探测失败保留当前会话并显示错误，下一次推送清除错误', async () => {
    const api = installApi(status({ session: session('ubus') }));
    api.routerRefresh.mockRejectedValue(new Error('刷新探测失败'));
    render(<RouterView />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await flush();
    expect(screen.getByText('刷新探测失败')).toBeTruthy();
    expect(screen.getByText('已登录（root）')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '刷新' }).disabled).toBe(false);
    act(() => { api.push(status({ session: session('ubus'), ts: T0 + 1 })); });
    expect(screen.queryByText('刷新探测失败')).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)('迟到的初始状态 %s 不得覆盖已收到的会话推送', async (outcome) => {
    const api = installApi();
    const pending = deferred<RouterStatus>();
    api.routerGetStatus.mockReturnValue(pending.promise);
    render(<RouterView />);
    act(() => { api.push(status({ session: session('ubus') })); });
    expect(screen.getByText('已登录（root）')).toBeTruthy();
    await act(async () => {
      if (outcome === 'resolve') pending.resolve(status());
      else pending.reject(new Error('迟到的初始探测错误'));
    });
    expect(screen.getByText('已登录（root）')).toBeTruthy();
    expect(screen.queryByText('未登录')).toBeNull();
    expect(screen.queryByText('迟到的初始探测错误')).toBeNull();
  });

  it('刷新迟到的已登录结果不能覆盖会话失效推送', async () => {
    const loggedIn = status({ session: session('ubus') });
    const api = installApi(loggedIn);
    const refresh = deferred<RouterStatus>();
    api.routerRefresh.mockReturnValue(refresh.promise);
    render(<RouterView />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    act(() => api.push(status({ session: { loggedIn: false, user: null, kind: null, error: '会话已失效', invalidatedAt: T0 + 1 } })));
    await act(async () => refresh.resolve(loggedIn));
    expect(screen.getByText('未登录')).toBeTruthy();
    expect(screen.getByText('会话已失效')).toBeTruthy();
    expect(screen.queryByText('已登录（root）')).toBeNull();
  });

  it('发起初始读取前已订阅，读取同步触发的状态推送不会丢失', async () => {
    const api = installApi();
    api.routerGetStatus.mockImplementation(async () => {
      api.push(status({ session: session('basic') }));
      return status();
    });
    render(<RouterView />);
    await flush();
    expect(screen.getByText('Basic 认证（root）')).toBeTruthy();
    expect(api.onRouterStatus.mock.invocationCallOrder[0]).toBeLessThan(api.routerGetStatus.mock.invocationCallOrder[0]);
  });
});

describe('RouterView 会话与账密登录', () => {
  it.each([
    ['ubus', '已登录（root）'],
    ['basic', 'Basic 认证（root）'],
    ['web', '管理页会话（Cookie 检测）'],
  ] as const)('从未登录收到 %s 会话推送后如实展示，再失效时回到未登录', async (kind, label) => {
    const api = installApi();
    render(<RouterView />);
    await flush();
    expect(screen.getByText('未登录')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull();
    act(() => { api.push(status({ session: session(kind) })); });
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '账密登录' }) !== null).toBe(kind !== 'ubus');

    act(() => {
      api.push(status({ session: { loggedIn: false, user: null, kind: null, error: '会话已失效，请重新登录', invalidatedAt: T0 + 1000 } }));
    });
    expect(screen.getByText('未登录')).toBeTruthy();
    expect(screen.getByText('会话已失效，请重新登录')).toBeTruthy();
    expect(screen.queryByText(label)).toBeNull();
    expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull();
    expect(screen.getByRole('button', { name: '账密登录' })).toBeTruthy();
    expect(api.routerLogin).not.toHaveBeenCalled();
    expect(api.routerLogout).not.toHaveBeenCalled();
  });

  it('空账密只提示校验错误，不保存设置或调用登录', async () => {
    const api = installApi();
    render(<RouterView />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '账密登录' }));
    expect(screen.getByText('请输入用户名与密码')).toBeTruthy();
    expect(api.settingsUpdate).not.toHaveBeenCalled();
    expect(api.routerLogin).not.toHaveBeenCalled();
  });

  it.each([false, true])('先等待 remember=%s 设置保存，再登录；成功清空密码但由推送确认会话', async (remember) => {
    const api = installApi();
    const saved = deferred<SettingsPayload>();
    const loggedIn = deferred<Awaited<ReturnType<LanApi['routerLogin']>>>();
    api.settingsUpdate.mockReturnValue(saved.promise);
    api.routerLogin.mockReturnValue(loggedIn.promise);
    render(<RouterView />);
    await flush();
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox', { name: /记住密码/ });
    expect(checkbox.checked).toBe(false);
    if (remember) fireEvent.click(checkbox);
    const password = enterCredentials();
    fireEvent.click(screen.getByRole('button', { name: '账密登录' }));
    expect(api.settingsUpdate).toHaveBeenCalledExactlyOnceWith({ rememberRouterPassword: remember });
    expect(api.routerLogin).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '登录中…' }).disabled).toBe(true);
    expect(checkbox.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '登录中…' }));
    expect(api.settingsUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { saved.resolve(settings(remember)); });
    expect(api.routerLogin).toHaveBeenCalledExactlyOnceWith('root', 'test-only-password');
    await act(async () => { loggedIn.resolve({ ok: true, error: null, persisted: remember, persistError: null }); });
    expect(password.value).toBe('');
    expect(screen.getByText(remember ? '登录成功，凭据已加密保存' : '登录成功（凭据未保存）')).toBeTruthy();
    expect(screen.getByText('未登录')).toBeTruthy();
    act(() => { api.push(status({ session: session(remember ? 'ubus' : 'basic') })); });
    expect(screen.getByText(remember ? '已登录（root）' : 'Basic 认证（root）')).toBeTruthy();
  });

  it.each(['result', 'reject', 'settings'] as const)('登录 %s 失败不得清密码或显示成功，允许重试', async (failure) => {
    const api = installApi();
    if (failure === 'result') api.routerLogin.mockResolvedValue({ ok: false, error: '账密校验失败', persisted: false, persistError: null });
    if (failure === 'reject') api.routerLogin.mockRejectedValue(new Error('账密校验失败'));
    if (failure === 'settings') api.settingsUpdate.mockRejectedValue(new Error('设置保存失败'));
    render(<RouterView />);
    await flush();
    const password = enterCredentials();
    fireEvent.click(screen.getByRole('button', { name: '账密登录' }));
    await flush();
    expect(screen.getByText(failure === 'settings' ? '设置保存失败' : '账密校验失败')).toBeTruthy();
    expect(screen.queryByText(/登录成功/)).toBeNull();
    expect(screen.getByText('未登录')).toBeTruthy();
    expect(password.value).toBe('test-only-password');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '账密登录' }).disabled).toBe(false);
    if (failure === 'settings') expect(api.routerLogin).not.toHaveBeenCalled();
    else expect(api.routerLogin).toHaveBeenCalledTimes(1);
  });
});

describe('RouterView 退出与生命周期', () => {
  it('退出等待期间禁用重复操作，成功提示且推送后回到登录表单', async () => {
    const api = installApi(status({ session: session('ubus') }));
    const pending = deferred<Awaited<ReturnType<LanApi['routerLogout']>>>();
    api.routerLogout.mockReturnValue(pending.promise);
    render(<RouterView />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '退出中…' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '退出中…' }));
    expect(api.routerLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('已退出登录')).toBeNull();
    await act(async () => { pending.resolve({ ok: true }); api.push(status()); });
    expect(screen.getByText('已退出登录')).toBeTruthy();
    expect(screen.getByText('未登录')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull();
    expect(screen.getByRole('button', { name: '账密登录' })).toBeTruthy();
  });

  it.each(['result', 'reject'] as const)('退出 %s 失败保留会话，不假报已退出', async (failure) => {
    const api = installApi(status({ session: session('ubus') }));
    if (failure === 'result') api.routerLogout.mockResolvedValue({ ok: false });
    else api.routerLogout.mockRejectedValue(new Error('退出 IPC 失败'));
    render(<RouterView />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    await flush();
    expect(screen.queryByText('已退出登录')).toBeNull();
    expect(screen.getByText(failure === 'result' ? '退出登录失败' : '退出 IPC 失败')).toBeTruthy();
    expect(screen.getByText('已登录（root）')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '退出登录' }).disabled).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)('卸载取消状态订阅，并忽略迟到的初始请求 %s', async (outcome) => {
    const api = installApi();
    const pending = deferred<RouterStatus>();
    const storedSettings = deferred<SettingsPayload>();
    api.routerGetStatus.mockReturnValue(pending.promise);
    api.settingsGet.mockReturnValue(storedSettings.promise);
    const view = render(<RouterView />);
    const callback = api.onRouterStatus.mock.calls[0][0];
    view.unmount();
    expect(api.off).toHaveBeenCalledTimes(1);
    await act(async () => {
      callback(status({ session: session('ubus') }));
      storedSettings.resolve(settings(true));
      if (outcome === 'resolve') pending.resolve(status());
      else pending.reject(new Error('卸载后的探测错误'));
    });
    expect(view.container.childElementCount).toBe(0);
    expect(api.routerGetStatus).toHaveBeenCalledTimes(1);
    expect(api.routerLogin).not.toHaveBeenCalled();
  });

  it('管理页只是 jsdom 元素：事件仅调用 stub 检测，收起或卸载清除监听', async () => {
    const api = installApi();
    const view = render(<RouterView />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '打开管理页（页面内嵌）' }));
    const webview = view.container.querySelector('webview');
    if (!webview) throw new Error('未渲染管理页元素');
    expect(webview.getAttribute('src')).toBe('https://router.invalid/');
    expect(webview.getAttribute('partition')).toBe('persist:router-admin');
    Object.defineProperty(webview, 'getURL', { value: () => 'https://router.invalid/session' });
    for (const event of ['dom-ready', 'did-navigate', 'did-navigate-in-page']) fireEvent(webview, new Event(event));
    await flush();
    expect(api.routerCheckWebSession).toHaveBeenCalledTimes(3);
    expect(screen.getByText('https://router.invalid/session')).toBeTruthy();
    expect(screen.getByText('未登录')).toBeTruthy();
    act(() => { api.push(status({ session: session('web') })); });
    expect(screen.getByText('管理页会话（Cookie 检测）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起管理页' }));
    for (const event of ['dom-ready', 'did-navigate', 'did-navigate-in-page']) fireEvent(webview, new Event(event));
    expect(api.routerCheckWebSession).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole('button', { name: '打开管理页（页面内嵌）' }));
    const reopened = view.container.querySelector('webview');
    if (!reopened) throw new Error('未重新渲染管理页元素');
    fireEvent(reopened, new Event('dom-ready'));
    await flush();
    expect(api.routerCheckWebSession).toHaveBeenCalledTimes(4);
    view.unmount();
    for (const event of ['dom-ready', 'did-navigate', 'did-navigate-in-page']) fireEvent(reopened, new Event(event));
    expect(api.routerCheckWebSession).toHaveBeenCalledTimes(4);
    expect(api.off).toHaveBeenCalledTimes(1);
  });
});
