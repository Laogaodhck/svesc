/**
 * IPC 路由（唯一与渲染层打交道的出入口）。
 *
 * 全部通道名取自 src/shared/channels.ts，与 plan.md 第 5 节一一对应。
 * 推送优先：每轮快照由引擎主动 send，渲染层不轮询。
 */
import os from 'node:os';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { CH } from '../shared/channels';
import { DIAG } from '../shared/constants';
import type {
  Alarm,
  DiagKind,
  DiagResult,
  RouterStatus,
  ScanProgress,
  Snapshot,
} from '../shared/types';
import type { Engine } from './engine';
import type { RouterManager } from './engine/router';
import { runDiag, readAdapters } from './engine/diag/netdiag';
import { remoteOpen } from './remote-ops';
import { terminalRun } from './terminal';
import { clearCredentials, saveCredentials } from './router-store';
import { clearAdminCookies, openRouterAdminWindow } from './router-browser';

let target: BrowserWindow | null = null;

function send(channel: string, payload: unknown): void {
  if (!target || target.isDestroyed()) return;
  try {
    target.webContents.send(channel, payload);
  } catch {
    /* 窗口正在销毁 */
  }
}

export function registerIpc(win: BrowserWindow, engine: Engine, router: RouterManager): void {
  target = win;

  ipcMain.handle(CH.getSnapshot, (): Snapshot => engine.getSnapshot());
  ipcMain.handle(CH.refresh, async (): Promise<{ started: boolean }> => engine.refresh());
  ipcMain.handle(
    CH.setAutoScan,
    (_event, enabled: boolean, intervalSec?: number): { autoScan: boolean; intervalSec: number } =>
      engine.setAutoScan(Boolean(enabled), intervalSec),
  );
  ipcMain.handle(CH.getDeviceDetail, async (_event, deviceId: string) => engine.getDeviceDetail(String(deviceId)));
  ipcMain.handle(CH.ackAlarm, (_event, alarmId: string): { ok: boolean } => {
    // 确认人由主进程注入（task-015：渲染层不可伪造——权限控制点）；取 OS 用户名，失败兜底
    let ackBy: string | null;
    try {
      ackBy = os.userInfo().username || '未知用户';
    } catch {
      ackBy = '未知用户';
    }
    return { ok: engine.ackAlarm(String(alarmId), ackBy) };
  });
  ipcMain.handle(CH.alarmsClear, (_event, ids: unknown): void => {
    // 清除人由主进程注入（task-021，同 ackBy：渲染层不可伪造）
    let by: string;
    try {
      by = os.userInfo().username || '未知用户';
    } catch {
      by = '未知用户';
    }
    const list = Array.isArray(ids) ? ids.map((v) => String(v)) : [];
    engine.clearAlarms(list, by);
  });
  ipcMain.handle(CH.exportReport, () =>
    // 审计 L6：导出附上路由器状态与打印管理配置（旧实现只有 Snapshot）
    engine.exportReport({ routerStatus: router.getStatus(), printerManage: engine.getPrinterManage() }),
  );
  ipcMain.handle(
    CH.setDeviceAlias,
    (_event, deviceId: string, alias: string | null): { ok: boolean } =>
      engine.setDeviceAlias(String(deviceId), alias == null ? null : String(alias)),
  );

  // —— 路由器管理通道 ——
  ipcMain.handle(CH.routerGetStatus, (): RouterStatus => router.getStatus());
  ipcMain.handle(CH.routerRefresh, async (): Promise<RouterStatus> => router.refresh());
  ipcMain.handle(CH.routerLogin, async (_event, user: string, password: string) => {
    const res = await router.login(String(user), String(password));
    if (res.ok) {
      // task-022 B-1：记住密码开关关闭 → 不落盘（也不清除——清理由 settingsUpdate 负责），
      // 渲染层如实提示"凭据未保存"的原因
      if (!engine.getSettings().rememberRouterPassword) {
        return { ok: true, error: null, persisted: false, persistError: '已关闭「记住密码」，凭据未保存' };
      }
      // 登录成功 → 凭据加密落盘（密钥环不可用时如实带出原因，不静默）
      const saved = await saveCredentials(String(user), String(password));
      return { ok: true, error: null, persisted: saved.ok, persistError: saved.error };
    }
    return { ok: false, error: res.error, persisted: false, persistError: null };
  });
  ipcMain.handle(CH.routerLogout, async (): Promise<{ ok: boolean }> => {
    router.logout();
    clearCredentials();
    await clearAdminCookies();
    return { ok: true };
  });
  ipcMain.handle(CH.routerReboot, async () => router.reboot());
  // 内置浏览器登录：主进程开独立窗口加载管理页（探测到的落点 URL 优先），
  // 登录成功由 Cookie 监视器回调 router.markWebSession(true)。
  ipcMain.handle(CH.routerOpenAdmin, async () =>
    openRouterAdminWindow(router, router.getAdminUrl(), engine.getGatewayIp()),
  );

  // —— 打印管理通道 ——
  ipcMain.handle(CH.printerGetManageConfig, () => engine.getPrinterManage());
  ipcMain.handle(CH.printerAddManual, (_e, ip: string, note: string | null) =>
    engine.addManualPrinter(String(ip), note == null ? null : String(note)),
  );
  ipcMain.handle(CH.printerRemoveManual, (_e, ip: string) => engine.removeManualPrinter(String(ip)));
  ipcMain.handle(CH.printerSetIgnored, (_e, printerId: string, ignored: boolean) =>
    engine.setPrinterIgnored(String(printerId), Boolean(ignored)),
  );
  ipcMain.handle(CH.printerSetAlias, (_e, printerId: string, alias: string | null) =>
    engine.setPrinterAlias(String(printerId), alias == null ? null : String(alias)),
  );

  // —— 设置通道（appVersion 由主进程注入，引擎层不 import electron） ——
  ipcMain.handle(CH.settingsGet, () => ({
    ...engine.getSettings(),
    appVersion: app.getVersion(),
    // 开机自启以 OS 为唯一事实源（task-021）：不进 store/settingsUpdate 白名单，直接读系统注册状态
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    launchAtLoginAvailable: app.isPackaged,
  }));
  ipcMain.handle(CH.settingsUpdate, (_e, patch: Record<string, unknown>) => {
    // 白名单透传：渲染层只允许改这几个字段，其余键直接丢弃
    const allowed = [
      'autoScan',
      'autoScanIntervalSec',
      'showVirtualPrinters',
      'snmpEnabled',
      'useMdns',
      'notifyDesktop',
      'closeToTray',
      'rememberRouterPassword',
    ] as const;
    const clean: Record<string, unknown> = {};
    for (const key of allowed) if (key in patch) clean[key] = patch[key];
    // task-022 B-1：true → false 的翻转即清盘上凭据（rmSync force:true 幂等，文件不存在也安全）
    if (clean.rememberRouterPassword === false && engine.getSettings().rememberRouterPassword === true) {
      clearCredentials();
    }
    return { ...engine.updateSettings(clean), appVersion: app.getVersion() };
  });
  // 开机自启（task-021）：isPackaged 门控（dev 下注册的是 electron.exe 本体）+ 写后回读验证——
  // setLoginItemSettings 会静默失败（系统策略/权限受限），必须回读比对，不能写完就报成功。
  ipcMain.handle(CH.launchAtLoginSet, (_e, on: unknown): { ok: boolean; error: string | null } => {
    if (!app.isPackaged) {
      return { ok: false, error: '开发模式下不可用，请使用安装版开启开机自启' };
    }
    const target = Boolean(on);
    app.setLoginItemSettings({ openAtLogin: target });
    return app.getLoginItemSettings().openAtLogin === target
      ? { ok: true, error: null }
      : { ok: false, error: '设置未生效（可能被系统策略限制）' };
  });

  // —— 网络诊断 / 运行日志 / 远程操作 ——
  ipcMain.handle(CH.diagRun, async (_e, kind: string, target: string): Promise<DiagResult> => {
    const kinds: readonly DiagKind[] = ['ping', 'tracert', 'ports', 'dns'];
    const k = kinds.includes(String(kind) as DiagKind) ? (String(kind) as DiagKind) : null;
    if (!k) {
      return {
        kind: 'ping',
        target: String(target ?? ''),
        startedAt: Date.now(),
        durationMs: 0,
        ok: false,
        summary: '未知诊断类型',
        lines: [],
        error: `未知的诊断类型：${String(kind)}`,
      };
    }
    const t = String(target ?? '');
    const result = await runDiag(k, t); // runDiag 内部已做目标校验，失败返回 ok:false + error
    engine.logs.push(
      result.ok ? 'info' : 'warn',
      'diag',
      `${k} ${t}：${result.error ?? result.summary}`,
    );
    return result;
  });
  ipcMain.handle(CH.diagAdapters, async () => {
    const adapters = await readAdapters();
    if (adapters.length === 0) {
      engine.logs.push('warn', 'diag', '本机网卡读取失败（ipconfig 无输出或执行失败）');
    }
    return adapters;
  });
  ipcMain.handle(CH.logsGetRecent, (_e, limit?: number) => {
    const n = Number(limit);
    const capped = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), DIAG.logRingMax) : 100;
    return engine.logs.list(capped);
  });
  ipcMain.handle(CH.logsExport, () => {
    // 导出固定写入下载目录（引擎层不 import electron，目录由这里注入）
    const res = engine.logs.exportNdjson(app.getPath('downloads'));
    engine.logs.push(
      res.ok ? 'info' : 'error',
      'diag',
      res.ok ? `运行日志已导出：${res.path}` : `运行日志导出失败：${res.error}`,
    );
    return res;
  });
  ipcMain.handle(CH.remoteOpen, async (_e, kind: string, target: string, user?: string) => {
    // task-019：白名单移除 'ssh'——老版本渲染层残留的 ssh 调用在此被拦下并给出迁移说明
    const kinds: readonly string[] = ['rdp', 'share'];
    if (!kinds.includes(String(kind))) {
      const hint = String(kind) === 'ssh' ? '（SSH 入口已移除，可改用「诊断」页端口探测确认 22 端口开放）' : '';
      return { ok: false, error: `未知的远程操作类型：${String(kind)}${hint}` };
    }
    const res = await remoteOpen(String(kind) as 'rdp' | 'share', String(target ?? ''), user);
    engine.logs.push(
      res.ok ? 'info' : 'warn',
      'remote',
      `${String(kind)} ${String(target ?? '')}：${res.error ?? '已发起'}`,
    );
    return res;
  });
  // 内置终端（task-019）：terminalRun 内部完成白名单/字符校验与单飞闸门，
  // 这里只做日志留痕（诊断中心日志页可审计每条命令与耗时）
  ipcMain.handle(CH.terminalRun, async (_e, command: string) => {
    const res = await terminalRun(String(command ?? ''));
    engine.logs.push(
      res.ok ? 'info' : 'warn',
      'terminal',
      `${String(command ?? '').slice(0, 120)}：${res.summary}`,
    );
    return res;
  });
}

/** 把引擎的三类推送接到窗口上（由 index.ts 在 createEngine 的回调里调用）。 */
export function pushSnapshot(snapshot: Snapshot): void {
  send(CH.snapshot, snapshot);
}

export function pushScanProgress(progress: ScanProgress): void {
  send(CH.scanProgress, progress);
}

export function pushAlarm(alarm: Alarm): void {
  send(CH.alarm, alarm);
}

export function pushRouterStatus(status: RouterStatus): void {
  send(CH.routerStatus, status);
}
