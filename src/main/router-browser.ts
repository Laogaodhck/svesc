/**
 * 内置浏览器登录：独立 BrowserWindow 打开路由器管理页，用户在真实页面上完成登录。
 *
 * 职责边界：引擎层铁律是不 import electron，所以浏览器窗口、Cookie 监视这些
 * electron 侧胶水都在本模块。RouterManager 只暴露 markWebSession() / getAdminUrl()。
 *
 * 登录判定（诚实性说明）：主进程监视路由器域的会话 Cookie（sysauth/session/token/
 * stok/auth 等关键词），出现即认定"管理页会话已建立"。各品牌 Cookie 名不统一，
 * 这是启发式而非协议级判定——UI 上因此显示"管理页会话（Cookie 检测）"，
 * 且它只解锁"打开管理页"的会话展示，绝不解锁 ubus 数据（DHCP/无线），
 * 不存在"假已登录却拿不到数据被静默"的路径。
 */
import { BrowserWindow, session as electronSession } from 'electron';
import type { RouterManager } from './engine/router';

/** 隔离的持久化分区：路由器 Cookie 不进应用默认会话，退出登录时整体清空。 */
const PARTITION = 'persist:router-admin';

/** 会话 Cookie 名称关键词（大小写不敏感子串匹配）。 */
const SESSION_COOKIE_HINTS = ['sysauth', 'session', 'token', 'stok', 'auth', 'userid', 'login'] as const;

let adminWin: BrowserWindow | null = null;

export function isAdminWindowOpen(): boolean {
  return adminWin !== null && !adminWin.isDestroyed();
}

/** 清空路由器管理分区的 Cookie（退出登录时由 IPC 层调用；失败不阻断登出）。 */
export async function clearAdminCookies(): Promise<void> {
  try {
    await electronSession.fromPartition(PARTITION).clearStorageData({ storages: ['cookies'] });
  } catch {
    /* Cookie 清理失败不阻断登出：RouterManager 的会话状态已由 logout() 清掉 */
  }
}

/** 路由器域（网关 IP）当前是否存在会话 Cookie。 */
async function hasSessionCookie(gatewayIp: string): Promise<boolean> {
  const ses = electronSession.fromPartition(PARTITION);
  const cookies = await ses.cookies.get({ url: `http://${gatewayIp}/` });
  const httpsCookies = await ses.cookies.get({ url: `https://${gatewayIp}/` });
  const all = [...cookies, ...httpsCookies];
  return all.some((c) => {
    const name = c.name.toLowerCase();
    return SESSION_COOKIE_HINTS.some((kw) => name.includes(kw));
  });
}

/**
 * 打开（或聚焦已存在的）路由器管理页窗口。
 * adminUrl 来自管理页指纹探测的重定向落点；探测不出时兜底 `http://网关/`。
 */
export async function openRouterAdminWindow(
  router: RouterManager,
  adminUrl: string | null,
  gatewayIp: string | null,
): Promise<{ ok: boolean; error: string | null; url: string | null }> {
  if (!gatewayIp) {
    return { ok: false, error: '网关地址未知，请先完成一次局域网扫描', url: null };
  }
  const url = adminUrl ?? `http://${gatewayIp}/`;

  if (adminWin && !adminWin.isDestroyed()) {
    adminWin.focus();
    // 窗口已开着：Cookie 可能已经就位，补一次判定
    if (await hasSessionCookie(gatewayIp)) router.markWebSession(true);
    return { ok: true, error: null, url };
  }

  const ses = electronSession.fromPartition(PARTITION);
  adminWin = new BrowserWindow({
    width: 1024,
    height: 720,
    title: '路由器管理页（内置浏览器）',
    autoHideMenuBar: true,
    webPreferences: {
      // 访问的是局域网路由器的真实管理页：只给它浏览器能力，
      // 不给 Node（nodeIntegration:false + sandbox:true + 无 preload）。
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const checkAndMark = async (): Promise<void> => {
    if (!adminWin || adminWin.isDestroyed()) return;
    try {
      if (await hasSessionCookie(gatewayIp)) router.markWebSession(true);
    } catch {
      /* Cookie 读取失败不算登录失败，等下一次导航再判 */
    }
  };

  // 每次主框架导航后检查一次 Cookie（登录成功大多伴随 302 → 首页 + Set-Cookie）
  adminWin.webContents.on('did-navigate', () => void checkAndMark());
  adminWin.webContents.on('did-navigate-in-page', () => void checkAndMark());
  // Cookie 的 explicit 写入（Set-Cookie）也检查，覆盖"登录后不跳转"的固件
  ses.cookies.on('changed', (_event, cookie, cause) => {
    if (cause !== 'explicit') return;
    if (!adminWin || adminWin.isDestroyed()) return;
    if (cookie.domain?.includes(gatewayIp)) void checkAndMark();
  });

  adminWin.on('closed', () => {
    adminWin = null;
    // 不在此处清 webSessionActive：Cookie 仍在分区里持久存在，会话真实有效；
    // 只有用户点"退出登录"（清 Cookie + logout）才会作废会话。
  });

  try {
    await adminWin.loadURL(url);
  } catch (err) {
    // loadURL 失败（ERR_CONNECTION_REFUSED 等）：窗口留着让用户看到错误页，
    // 但把原因如实带回给渲染层
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `管理页打开失败：${msg}`, url };
  }
  return { ok: true, error: null, url };
}
