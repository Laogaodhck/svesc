/**
 * 主进程入口：生命周期、窗口、菜单隐藏、SMOKE 模式分支。
 *
 * 这里是**唯一**允许 import electron 的地方之一（另有 ipc.ts / preload.ts / smoke.ts）。
 * 探测引擎（src/main/engine/**）完全不依赖 Electron，可被 vitest 在纯 Node 下导入测试。
 */
import { app, BrowserWindow, Menu } from 'electron';
import path from 'node:path';
import { createEngine, type Engine } from './engine';
import { RouterManager } from './engine/router';
import { clearPushTarget, pushRouterStatus, pushScanProgress, pushSnapshot, registerIpc, setPushTarget } from './ipc';
import { loadCredentials, saveCredentials, clearCredentials } from './router-store';
import { getRouterAdminCookieHeader } from './router-browser';
import { createTray, destroyTray, isQuitRequested, refreshTray } from './tray';

const isSmoke = process.env.SMOKE === '1';

/**
 * 关闭硬件加速。
 * 原因（本机实测）：在远程桌面/虚拟机会话里 GPU 进程反复崩溃
 * （gpu_process_host.cc: GPU process isn't usable. Goodbye.）导致应用直接 FATAL 退出。
 * 本应用是纯数据表格/曲线 UI，软件合成完全够用，稳定性优先。
 */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let mainWindow: BrowserWindow | null = null;
let engine: Engine | null = null;
let routerManager: RouterManager | null = null;

function rendererEntry(): string {
  // 产物结构：dist/main/index.cjs + dist/renderer/index.html
  return path.join(__dirname, '..', 'renderer', 'index.html');
}

/** 打包态读 extraResources，开发态读项目 build/ 目录。 */
function buildAsset(name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '..', '..', 'build', name);
}

/** 窗口图标（浩玥 logo）：打包态读 extraResources，开发态读项目 build/ 目录。 */
function windowIcon(): string {
  return buildAsset('icon.png');
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0b0f14',
    show: false,
    autoHideMenuBar: true,
    title: 'SVESC · 局域网监控台',
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // task-032：路由器管理页以 <webview> 内嵌在页面（不再弹独立窗口），
      // webview 挂 persist:router-admin 分区，与 Cookie 检测/租约通道共享会话
      webviewTag: true,
      // 监控台需要 2s 级推送：窗口最小化/隐藏时不能被 Chromium 节流，否则快照停更
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => {
    if (!isSmoke) win.show();
  });

  // 关闭到托盘：设置 closeToTray 开启且非退出流程时，点 X 只隐藏窗口。
  // 真退出只走托盘菜单"退出"（markQuitting 置位）；SMOKE 模式直接放行（app.exit 不触发 close）。
  win.on('close', (e) => {
    if (!isSmoke && !isQuitRequested() && engine?.getSettings().closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });

  // 审查 R-6：窗口销毁后解绑推送目标；重建窗口（activate）时 createWindow 重跑
  // 会重新换绑，推送不丢。registerIpc 的 handle 注册不在此重复（重复注册会抛错）。
  win.on('closed', () => clearPushTarget(win));
  setPushTarget(win);

  await win.loadFile(rendererEntry());
  return win;
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null);

  engine = await createEngine({
    userDataDir: app.getPath('userData'),
    exportDir: app.getPath('downloads'),
    onSnapshot: (snapshot) => {
      pushSnapshot(snapshot);
      // 托盘菜单随心跳重建（勾选态保鲜）
      if (!isSmoke) refreshTray();
    },
    onScanProgress: (progress) => pushScanProgress(progress),
  });

  mainWindow = await createWindow();

  // 路由器管理通道：网关 IP 接引擎探测结果；启动即轮询，凭据可从 safeStorage 恢复
  routerManager = new RouterManager({ getGateway: () => engine?.getGatewayIp() ?? null });
  // task-022 B-2：自动重登的凭据提供者——每次调用现读盘上密文（不常驻明文密码），
  // 记住密码已关闭时返回 null（静默停用，不计失败）
  routerManager.setAutoRelogin(async () => {
    if (!engine?.getSettings().rememberRouterPassword) return null;
    return loadCredentials();
  });
  // task-030：管理页租约实验通道的 Cookie 提供者——内置浏览器登录后分区里的
  // 会话 Cookie 每轮现读，登出清空后自动变 null（通道静默跳过）
  routerManager.setWebLeaseProvider(getRouterAdminCookieHeader);
  registerIpc(mainWindow, engine, routerManager);
  routerManager.startPolling((status) => {
    pushRouterStatus(status);
    // task-022 B-2：观测到会话失效（invalidatedAt 粘性）→ 触发自动重登。
    // scheduleRelogin 幂等（挂起定时器/进行中/已恢复/已停用都会跳过），每轮重复调用安全
    if (status.session.invalidatedAt !== null && engine?.getSettings().rememberRouterPassword) {
      routerManager?.scheduleRelogin();
    }
    // task-022 C-1：DHCP 租约灌入设备识别管线做 hostname 回填。
    // 未登录 / web 会话时 dhcpLeases 天然为空数组，不猜数据
    engine?.applyRouterHints({ leaseHostnames: status.dhcpLeases });
  });
  const saved = await loadCredentials();
  if (saved) routerManager.restoreSession(saved.user, saved.password);

  // 系统托盘（SMOKE 秒退场景不创建）
  if (!isSmoke) {
    createTray({
      trayIconPath: buildAsset('tray-icon.png'),
      getWindow: () => mainWindow,
      engine,
    });
  }

  await engine.start();

  if (isSmoke) {
    const { runSmoke } = await import('./smoke');
    const result = await runSmoke(mainWindow, engine, routerManager);
    engine.stop();
    app.exit(result.ok ? 0 : 3);
  }
}

process.on('unhandledRejection', (reason) => {
  // 主进程不允许有未捕获异常；记录后继续运行（探测失败不应打断 UI）
  console.error('[main] unhandledRejection', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException', err);
});

app.whenReady().then(() => {
  bootstrap().catch((err) => {
    console.error('[main] bootstrap failed', err);
    if (isSmoke) app.exit(4);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((err) => console.error('[main] recreate window failed', err));
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 先置位真退出（托盘菜单"退出"之外的 quit 路径也要放行 close），再销毁托盘
  destroyTray();
  engine?.stop();
  routerManager?.stopPolling();
  engine = null;
  routerManager = null;
});
