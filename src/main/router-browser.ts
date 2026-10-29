/**
 * 内置浏览器登录（task-032 重构：不再弹独立窗口，管理页以 <webview> 内嵌在
 * 路由器页面里，挂同一个 persist:router-admin 持久化分区）。
 *
 * 职责边界：引擎层铁律是不 import electron，所以 Cookie 检测这些 electron 侧
 * 胶水都在本模块。RouterManager 只暴露 markWebSession()。
 *
 * 登录判定（诚实性说明）：主进程监视路由器域的会话 Cookie（sysauth/session/token/
 * stok/auth 等关键词），出现即认定"管理页会话已建立"。各品牌 Cookie 名不统一，
 * 这是启发式而非协议级判定——UI 上因此显示"管理页会话（Cookie 检测）"，
 * 且它只解锁管理页会话展示与管理页租约实验通道，绝不解锁 ubus 数据，
 * 不存在"假已登录却拿不到数据被静默"的路径。
 */
import { app, BrowserWindow, session as electronSession } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RouterManager } from './engine/router';

/** 隔离的持久化分区：路由器 Cookie 不进应用默认会话，退出登录时整体清空。 */
export const ROUTER_ADMIN_PARTITION = 'persist:router-admin';

/** 会话 Cookie 名称关键词（大小写不敏感子串匹配）。 */
const SESSION_COOKIE_HINTS = ['sysauth', 'session', 'token', 'stok', 'auth', 'userid', 'login'] as const;

let cookieRevision = 0;
let cookiesUsable = true;
let clearingCookies: Promise<boolean> | null = null;
let bindingGateway: Promise<boolean> | null = null;

export function clearAdminCookies(): Promise<boolean> {
  cookieRevision += 1;
  cookiesUsable = false;
  if (clearingCookies) return clearingCookies;
  const pending = Promise.resolve()
    .then(() => {
      const ses = electronSession.fromPartition(ROUTER_ADMIN_PARTITION);
      // 原生 webview 也会自动附带 Cookie，必须与后台取凭据共用清理闸门。
      ses.webRequest.onBeforeRequest((_details, callback) => {
        callback({ cancel: !cookiesUsable || clearingCookies !== null });
      });
      return ses.clearStorageData({ storages: ['cookies'] });
    })
    .then(() => { cookiesUsable = true; return true; }, () => false)
    .finally(() => { if (clearingCookies === pending) clearingCookies = null; });
  clearingCookies = pending;
  return pending;
}

export async function bindRouterAdminGateway(gateway: string | null): Promise<boolean> {
  if (!gateway) return false;
  if (bindingGateway) {
    await bindingGateway;
    return bindRouterAdminGateway(gateway);
  }
  const file = path.join(app.getPath('userData'), 'router-admin-gateway.json');
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).gateway === gateway) return cookiesUsable && clearingCookies === null;
  } catch { /* 未绑定的持久 Cookie 也不能假定属于当前网关。 */ }
  const pending = (async () => {
    if (!(await clearAdminCookies())) return false;
    try {
      fs.writeFileSync(file, JSON.stringify({ gateway }), { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      cookiesUsable = false;
      return false;
    }
  })();
  bindingGateway = pending;
  try { return await pending; }
  finally { if (bindingGateway === pending) bindingGateway = null; }
}

export async function getRouterAdminCookieHeader(url: string): Promise<string | null> {
  if (clearingCookies || !cookiesUsable) return null;
  const revision = cookieRevision;
  try {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) return null;
    const cookies = await electronSession.fromPartition(ROUTER_ADMIN_PARTITION).cookies.get({ url: target.href });
    if (revision !== cookieRevision || cookies.length === 0) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return null;
  }
}

export async function checkRouterWebSession(
  router: RouterManager,
  gatewayIp: string | null,
): Promise<{ session: boolean }> {
  if (!gatewayIp) {
    router.markWebSession(false);
    return { session: false };
  }
  if (clearingCookies || !cookiesUsable) return { session: false };
  const revision = router.getWebSessionRevision();
  try {
    if (!(await bindRouterAdminGateway(gatewayIp)) || revision !== router.getWebSessionRevision()) return { session: false };
    const cookieGen = cookieRevision;
    const adminUrl = router.getAdminUrl();
    const target = new URL(adminUrl ?? `http://${gatewayIp}/`);
    const brand = router.getStatus().identity?.brand;
    const hosts = new Set([gatewayIp]);
    if (target.hostname === gatewayIp || (brand === 'tplink' && target.hostname === 'tplogin.cn')) hosts.add(target.hostname);
    if (brand === 'tplink') hosts.add('tplogin.cn');
    const ses = electronSession.fromPartition(ROUTER_ADMIN_PARTITION);
    const groups = await Promise.all([...hosts].map((domain) => ses.cookies.get({ domain })));
    if (revision !== router.getWebSessionRevision() || cookieGen !== cookieRevision || clearingCookies) return { session: false };
    const hit = groups.flat().some((cookie) =>
      (!cookie.expirationDate || cookie.expirationDate > Date.now() / 1000) &&
      SESSION_COOKIE_HINTS.some((hint) => cookie.name.toLowerCase().includes(hint)),
    );
    const changed = router.markWebSession(hit);
    if (changed && hit) await router.refresh();
    return { session: hit };
  } catch {
    return { session: false };
  }
}

/** 打印机管理页分区：与路由器分区隔离，互不串 Cookie/登录态（task-024）。 */
const PRINTER_PARTITION = 'persist:printer-admin';
let printerAdminWin: BrowserWindow | null = null;

/**
 * 用内置浏览器打开打印机 Web 管理页（task-024）。
 * 打印机管理页的凭据形态各异（Basic 弹窗/表单/免登录），本模块不做任何登录判定
 * ——Chromium 原生处理 Basic 401 弹窗与表单，窗口只负责展示。
 * 同一时刻只保留一个窗口：重复调用聚焦并导航到目标打印机。
 */
export async function openPrinterAdminWindow(
  ip: string,
): Promise<{ ok: boolean; error: string | null; url: string | null }> {
  const url = `http://${ip}/`;
  if (!printerAdminWin || printerAdminWin.isDestroyed()) {
    printerAdminWin = new BrowserWindow({
      width: 1024,
      height: 720,
      title: `打印机管理页 ${ip}（内置浏览器）`,
      autoHideMenuBar: true,
      webPreferences: {
        // 与 openRouterAdminWindow 同级的浏览器安全基线：只给浏览器能力，不给 Node
        session: electronSession.fromPartition(PRINTER_PARTITION),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    printerAdminWin.on('closed', () => {
      printerAdminWin = null;
    });
  }
  printerAdminWin.focus();
  try {
    await printerAdminWin.loadURL(url);
  } catch (err) {
    // loadURL 失败（打印机不提供 HTTP 管理页等）：窗口留着展示错误页，原因如实带回
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `打印机管理页打开失败：${msg}`, url };
  }
  return { ok: true, error: null, url };
}
