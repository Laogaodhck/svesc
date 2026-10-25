/**
 * 管理页指纹探测测试（`src/main/engine/router/detect.ts`）。
 * matchFingerprint 是纯函数，直接覆盖各品牌关键词与未识别分支；
 * detectManagementPage 用注入的 httpx 替身覆盖"重定向落点 URL"行为。
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** url → 应答脚本（status/headers/body/error） */
  routes: new Map<string, { status: number; headers: Record<string, string>; body: string }>(),
}));

vi.mock('../src/main/engine/router/httpx', () => ({
  httpRequest: async (url: string) => {
    const hit = h.routes.get(url);
    if (!hit) return { status: null, body: '', headers: {}, error: 'mock: 未配置路由' };
    return { status: hit.status, body: hit.body, headers: hit.headers, error: null };
  },
}));

import { matchFingerprint, FINGERPRINTS, detectManagementPage } from '../src/main/engine/router/detect';

const LUCI_HTML = '<!doctype html><html><head><title>OpenWrt - LuCI - 概览</title></head><body>…</body></html>';
const TPLINK_HTML = '<!doctype html><html><head><title>TP-LINK 路由器管理界面</title></head><body></body></html>';
const XIAOMI_HTML = '<!doctype html><html><head><title>MiWiFi 小米路由器</title></head><body></body></html>';

describe('matchFingerprint', () => {
  it('OpenWrt / LuCI 命中', () => {
    expect(matchFingerprint(null, LUCI_HTML).brand).toBe('openwrt');
    expect(matchFingerprint(null, LUCI_HTML).hint).toContain('OpenWrt');
  });

  it('TP-Link / 小米命中', () => {
    expect(matchFingerprint(null, TPLINK_HTML).brand).toBe('tplink');
    expect(matchFingerprint(null, XIAOMI_HTML).brand).toBe('xiaomi');
  });

  it('Server 头优先补充线索（大小写不敏感）', () => {
    const res = matchFingerprint('openWRT/23.05 mini_httpd', '<html><title>x</title></html>');
    expect(res.brand).toBe('openwrt');
    expect(res.hint).toBe('openWRT/23.05 mini_httpd');
  });

  it('未知品牌返回 null（不猜 generic）', () => {
    const res = matchFingerprint('nginx', '<html><title>Router</title></html>');
    expect(res.brand).toBeNull();
    expect(res.hint).toBeNull();
  });

  it('指纹表最少覆盖 6 个品牌（契约下限）', () => {
    const brands = new Set(FINGERPRINTS.map((f) => f.brand));
    expect(brands.size).toBeGreaterThanOrEqual(6);
  });
});

describe('detectManagementPage 落点 URL', () => {
  it('302 → /login.html：reachable 且 url 必须是重定向落点（内置浏览器直接打开它）', async () => {
    h.routes.clear();
    h.routes.set('http://10.0.0.1/', { status: 302, headers: { location: '/login.html' }, body: '' });
    h.routes.set('http://10.0.0.1/login.html', { status: 200, headers: {}, body: TPLINK_HTML });

    const res = await detectManagementPage('10.0.0.1');
    expect(res.reachable).toBe(true);
    expect(res.brand).toBe('tplink');
    expect(res.url).toBe('http://10.0.0.1/login.html');
  });

  it('直接 200 → url 为探测地址本身；全部不可达 → url 为 null', async () => {
    h.routes.clear();
    h.routes.set('http://10.0.0.2/', { status: 200, headers: {}, body: LUCI_HTML });
    const ok = await detectManagementPage('10.0.0.2');
    expect(ok.url).toBe('http://10.0.0.2/');
    expect(ok.reachable).toBe(true);

    h.routes.clear();
    const dead = await detectManagementPage('10.0.0.3');
    expect(dead.reachable).toBe(false);
    expect(dead.url).toBeNull();
  });
});
