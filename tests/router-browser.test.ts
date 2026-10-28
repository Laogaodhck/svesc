import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestCookie = { name: string; value: string; domain: string; path: string; secure: boolean; expirationDate?: number };
type RequestGuard = (details: unknown, callback: (response: { cancel: boolean }) => void) => void;
const h = vi.hoisted(() => ({
  cookies: [] as TestCookie[],
  gate: null as Promise<void> | null,
  readStarted: null as (() => void) | null,
  fail: false,
  get: vi.fn(),
  clear: vi.fn(),
  clearGate: null as Promise<void> | null,
  metadata: '',
  requestGuard: null as RequestGuard | null,
}));

vi.mock('electron', () => ({
  app: { getPath: () => 'test-user-data' },
  BrowserWindow: class {},
  session: { fromPartition: () => ({
    cookies: { get: h.get }, clearStorageData: h.clear,
    webRequest: { onBeforeRequest: (guard: RequestGuard) => { h.requestGuard = guard; } },
  }) },
}));
vi.mock('node:fs', () => ({
  readFileSync: () => h.metadata,
  writeFileSync: (_file: string, data: string) => { h.metadata = data; },
}));

import { RouterManager } from '../src/main/engine/router';
import { bindRouterAdminGateway, checkRouterWebSession, clearAdminCookies, getRouterAdminCookieHeader } from '../src/main/router-browser';
import type { RouterBrand } from '../src/shared/types';

const GW = '192.168.2.1';
function cookie(overrides: Partial<TestCookie> = {}): TestCookie {
  return { name: 'session', value: 'test-value', domain: GW, path: '/', secure: false, ...overrides };
}

function manager(brand: RouterBrand | null = null, adminUrl = `http://${GW}/`): RouterManager {
  const router = new RouterManager({ getGateway: () => GW });
  const originalStatus = router.getStatus.bind(router);
  vi.spyOn(router, 'getAdminUrl').mockReturnValue(adminUrl);
  vi.spyOn(router, 'getStatus').mockImplementation(() => ({
    ...originalStatus(),
    identity: { ip: GW, brand, adminUrl, modelHint: null, upnpFriendlyName: null },
  }));
  vi.spyOn(router, 'refresh').mockImplementation(async () => router.getStatus());
  return router;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  h.cookies = [];
  h.gate = null;
  h.readStarted = null;
  h.fail = false;
  h.clearGate = null;
  h.metadata = JSON.stringify({ gateway: GW });
  h.clear.mockReset();
  h.clear.mockImplementation(async () => {
    if (h.clearGate) await h.clearGate;
    h.cookies = [];
  });
  await clearAdminCookies();
  h.clear.mockClear();
  h.get.mockReset();
  h.get.mockImplementation(async (filter: { url?: string; domain?: string }) => {
    if (h.fail) throw new Error('cookie-read-failed');
    const url = filter.url ? new URL(filter.url) : null;
    const selected = h.cookies.filter((item) => {
      const domain = item.domain.replace(/^\./, '');
      if (filter.domain) return domain === filter.domain;
      if (!url || url.hostname !== domain) return false;
      return (!item.secure || url.protocol === 'https:') &&
        (url.pathname === item.path || url.pathname.startsWith(item.path.endsWith('/') ? item.path : `${item.path}/`));
    });
    h.readStarted?.();
    if (h.gate) await h.gate;
    return selected;
  });
});

describe('管理页 Cookie 隔离与会话同步', () => {
  it('Cookie 按具体 URL 筛选，不混入其它域、路径或 HTTPS 专用 Cookie', async () => {
    h.cookies = [cookie(), cookie({ name: 'other', domain: '192.168.3.1' }), cookie({ name: 'secure', secure: true }), cookie({ name: 'admin', path: '/admin' })];
    expect(await getRouterAdminCookieHeader(`http://${GW}/dhcp.htm`)).toBe('session=test-value');
    expect(h.get).toHaveBeenLastCalledWith({ url: `http://${GW}/dhcp.htm` });
    expect(await getRouterAdminCookieHeader(`https://${GW}/admin/dhcp.htm`)).toBe('session=test-value; secure=test-value; admin=test-value');
    expect(await getRouterAdminCookieHeader('file:///local')).toBeNull();
  });

  it('其它网关 Cookie 不会建立当前路由器会话', async () => {
    h.cookies = [cookie({ domain: '192.168.3.1' })];
    const router = manager();
    expect(await checkRouterWebSession(router, GW)).toEqual({ session: false });
    expect(router.hasWebSession()).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('已识别 TP-LINK 的域名 Cookie 可检测，其他品牌不得借用', async () => {
    h.cookies = [cookie({ domain: 'tplogin.cn', path: '/admin' })];
    const tplink = manager('tplink', 'http://tplogin.cn/login');
    expect(await checkRouterWebSession(tplink, GW)).toEqual({ session: true });
    expect(tplink.hasWebSession()).toBe(true);
    expect(tplink.refresh).toHaveBeenCalledTimes(1);
    const asus = manager('asus');
    expect(await checkRouterWebSession(asus, GW)).toEqual({ session: false });
    expect(asus.hasWebSession()).toBe(false);
  });

  it('Cookie 新建仅触发一次立即刷新，删除或过期立即清除 web 会话', async () => {
    const router = manager();
    h.cookies = [cookie()];
    await checkRouterWebSession(router, GW);
    await checkRouterWebSession(router, GW);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    h.cookies = [cookie({ expirationDate: Date.now() / 1000 - 1 })];
    expect(await checkRouterWebSession(router, GW)).toEqual({ session: false });
    expect(router.hasWebSession()).toBe(false);
    h.cookies = [cookie()];
    await checkRouterWebSession(router, GW);
    h.cookies = [];
    await checkRouterWebSession(router, GW);
    expect(router.hasWebSession()).toBe(false);
  });

  it('Cookie 读取在飞时 logout，迟到结果不能重新登录', async () => {
    const router = manager();
    h.cookies = [cookie()];
    const gate = Promise.withResolvers<void>();
    h.gate = gate.promise;
    const entered = Promise.withResolvers<void>();
    h.readStarted = entered.resolve;
    const pending = checkRouterWebSession(router, GW);
    await entered.promise;
    router.logout();
    gate.resolve();
    expect(await pending).toEqual({ session: false });
    expect(router.hasWebSession()).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('Cookie 读取期间网关变化，旧网关检查结果不得用于新网关', async () => {
    let gateway: string | null = GW;
    const router = new RouterManager({ getGateway: () => gateway });
    vi.spyOn(router, 'refresh').mockImplementation(async () => router.getStatus());
    h.cookies = [cookie()];
    const gate = Promise.withResolvers<void>();
    h.gate = gate.promise;
    const entered = Promise.withResolvers<void>();
    h.readStarted = entered.resolve;
    const pending = checkRouterWebSession(router, GW);
    await entered.promise;
    gateway = '192.168.3.1';
    gate.resolve();
    expect(await pending).toEqual({ session: false });
    expect(router.hasWebSession()).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('Cookie 读取异常不误判登出，也不向请求头输出异常信息', async () => {
    const router = manager();
    router.markWebSession(true);
    h.fail = true;
    expect(await getRouterAdminCookieHeader(`http://${GW}/`)).toBeNull();
    expect(await checkRouterWebSession(router, GW)).toEqual({ session: false });
    expect(router.hasWebSession()).toBe(true);
  });

  it('切换网关或缺少持久绑定时清理旧 Cookie，不复用 tplogin.cn 会话', async () => {
    h.cookies = [cookie({ domain: 'tplogin.cn' })];
    expect(await bindRouterAdminGateway(GW)).toBe(true);
    expect(h.clear).not.toHaveBeenCalled();
    expect(await bindRouterAdminGateway('192.168.3.1')).toBe(true);
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.cookies).toEqual([]);
    expect(JSON.parse(h.metadata).gateway).toBe('192.168.3.1');
    h.cookies = [cookie({ domain: 'tplogin.cn' })];
    h.metadata = '';
    expect(await bindRouterAdminGateway(GW)).toBe(true);
    expect(h.cookies).toEqual([]);
  });

  it('清理 Cookie 期间的新检测不能恢复会话，也不能读取请求凭据', async () => {
    const router = manager();
    router.markWebSession(true);
    h.cookies = [cookie()];
    const gate = Promise.withResolvers<void>();
    h.clearGate = gate.promise;
    router.logout();
    const clearing = clearAdminCookies();
    expect(await checkRouterWebSession(router, GW)).toEqual({ session: false });
    expect(await getRouterAdminCookieHeader(`http://${GW}/`)).toBeNull();
    gate.resolve();
    expect(await clearing).toBe(true);
    expect(router.hasWebSession()).toBe(false);
  });

  it('Cookie 清理失败则阻断凭据读取与自动会话恢复，重试成功才解锁', async () => {
    h.cookies = [cookie()];
    h.clear.mockRejectedValueOnce(new Error('clear-failed'));
    expect(await clearAdminCookies()).toBe(false);
    expect(await getRouterAdminCookieHeader(`http://${GW}/`)).toBeNull();
    expect(await checkRouterWebSession(manager(), GW)).toEqual({ session: false });
    expect(await clearAdminCookies()).toBe(true);
    expect(h.cookies).toEqual([]);
  });

  it('绑定失败或正在清理时，也阻断 webview 原生请求，清理成功后恢复', async () => {
    h.cookies = [cookie({ domain: 'tplogin.cn' })];
    h.clear.mockRejectedValueOnce(new Error('clear-failed'));
    expect(await bindRouterAdminGateway('192.168.3.1')).toBe(false);
    expect(h.requestGuard).not.toBeNull();
    const callback = vi.fn();
    h.requestGuard?.({ url: 'http://tplogin.cn/' }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
    const gate = Promise.withResolvers<void>();
    h.clearGate = gate.promise;
    const clearing = clearAdminCookies();
    h.requestGuard?.({ url: 'http://tplogin.cn/' }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
    gate.resolve();
    expect(await clearing).toBe(true);
    h.requestGuard?.({ url: 'http://tplogin.cn/' }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: false });
    expect(h.cookies).toEqual([]);
  });

  it('Cookie 头读取在飞时清理，旧凭据不得返回', async () => {
    h.cookies = [cookie()];
    const gate = Promise.withResolvers<void>();
    h.gate = gate.promise;
    const header = getRouterAdminCookieHeader(`http://${GW}/`);
    await clearAdminCookies();
    gate.resolve();
    expect(await header).toBeNull();
  });

  it('网关不可用时清除管理页会话', async () => {
    const router = manager();
    router.markWebSession(true);
    expect(await checkRouterWebSession(router, null)).toEqual({ session: false });
    expect(router.hasWebSession()).toBe(false);
  });
});
