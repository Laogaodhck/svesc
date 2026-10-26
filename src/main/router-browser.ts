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
import { BrowserWindow, session as electronSession } from 'electron';
import type { RouterManager } from './engine/router';

/** 隔离的持久化分区：路由器 Cookie 不进应用默认会话，退出登录时整体清空。 */
export const ROUTER_ADMIN_PARTITION = 'persist:router-admin';

/** 会话 Cookie 名称关键词（大小写不敏感子串匹配）。 */
const SESSION_COOKIE_HINTS = ['sysauth', 'session', 'token', 'stok', 'auth', 'userid', 'login'] as const;

/** 清空路由器管理分区的 Cookie（退出登录时由 IPC 层调用；失败不阻断登出）。 */
export async function clearAdminCookies(): Promise<void> {
  try {
    await electronSession.fromPartition(ROUTER_ADMIN_PARTITION).clearStorageData({ storages: ['cookies'] });
  } catch {
    /* Cookie 清理失败不阻断登出：RouterManager 的会话状态已由 logout() 清掉 */
  }
}

/**
 * 分区里是否存在会话 Cookie（关键词命中）。
 *
 * 审查 R-4（联动盲区修复）：不按网关 IP 域过滤——TP-LINK 等固件的防重绑定机制
 * 会把浏览器 302 到本地域名（tplogin.cn），登录后的会话 Cookie 落在该域名而非
 * 网关 IP 下，按 IP 过滤将永远检测不到会话（管理页租约通道随之永不启用）。
 * 分区（persist:router-admin）是路由器管理页专用的，扫描全量 Cookie 是安全的；
 * 判定标准与会话 Cookie 关键词表一致，仅做启发式（UI 文案已声明"Cookie 检测"）。
 */
function hasSessionCookie(): Promise<boolean> {
  const ses = electronSession.fromPartition(ROUTER_ADMIN_PARTITION);
  return ses.cookies
    .get({})
    .then((cookies) =>
      cookies.some((c) => {
        const name = c.name.toLowerCase();
        return SESSION_COOKIE_HINTS.some((kw) => name.includes(kw));
      }),
    )
    .catch(() => false);
}

/**
 * 管理页分区的全部 Cookie 组装成 Cookie 头（task-030 管理页租约实验通道）。
 * 分区专用（只装路由器管理页），全部转发是安全的；空分区返回 null。
 * TP-LINK 等固件登录后 Cookie 落在本地域名（tplogin.cn）而非 IP，这里不按域过滤。
 */
export async function getRouterAdminCookieHeader(): Promise<string | null> {
  try {
    const cookies = await electronSession.fromPartition(ROUTER_ADMIN_PARTITION).cookies.get({});
    if (cookies.length === 0) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return null;
  }
}

/**
 * 检测管理页会话（task-032）：页面内嵌 webview 在 dom-ready / did-navigate 后
 * 经 IPC 调到这里——读分区 Cookie，命中与否**双向**同步 markWebSession。
 *
 * 审查 R-5（状态同步修复）：此前只会置 true 不会置 false——Cookie 过期/在管理页
 * 自行登出后，应用侧"管理页会话"永远保持，UI 显示已登录、实验通道空转。
 * 分区是路由器管理页专用的，"分区里没有会话 Cookie"就是"管理页未登录"的可靠证据，
 * 双向同步成立；判定谓词与建会话时一致（同一套关键词），不存在口径漂移。
 * 返回当前是否检测到会话，渲染层只用于展示，会话真值以 RouterManager 状态为准。
 */
export async function checkRouterWebSession(
  router: RouterManager,
  gatewayIp: string | null,
): Promise<{ session: boolean }> {
  if (!gatewayIp) return { session: false };
  try {
    const hit = await hasSessionCookie();
    router.markWebSession(hit);
    return { session: hit };
  } catch {
    // Cookie 读取失败不算登录失败，webview 下一次导航会再触发
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
