/**
 * electron-updater 适配层（主进程）。
 *
 * 更新源来自打包时生成的 app-update.yml（GitHub Releases，owner/repo 见 electron-builder.yml）。
 * 本文件只做"翻译"：把 electron-updater 的事件/命令接到纯 Node 状态机，
 * 并决定下载完成后是否弹系统通知；业务门控与错误文案在 engine/update-controller.ts。
 */
import { autoUpdater } from 'electron-updater';
import type { AppUpdaterEvents } from 'electron-updater/out/AppUpdater';
import type { UpdateStatus } from '../shared/types';
import { createUpdateController, type UpdaterAdapter } from './engine/update-controller';
import { resolveUpdateSupport } from './engine/update-policy';
import { showUpdateReady } from './notify';

export interface UpdateService {
  status(): UpdateStatus;
  /** 立即检查并后台下载；结果经 onStatus 推送，不阻塞调用方 */
  check(): void;
  install(): { ok: boolean; error: string | null };
  setAutoUpdateEnabled(on: boolean): void;
  start(): void;
  dispose(): void;
}

export function createUpdateService(opts: {
  isPackaged: boolean;
  isSmoke: boolean;
  env: NodeJS.ProcessEnv;
  currentVersion: string;
  getAutoUpdate: () => boolean;
  /** 通知点击时把主窗口带到前台 */
  showWindow: () => void;
  onStatus: (status: UpdateStatus) => void;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
}): UpdateService {
  const support = resolveUpdateSupport({
    isPackaged: opts.isPackaged,
    isSmoke: opts.isSmoke,
    env: opts.env,
  });

  const subscriptions: (() => void)[] = [];
  const subscribe = <K extends keyof AppUpdaterEvents>(event: K, cb: AppUpdaterEvents[K]): void => {
    autoUpdater.on(event, cb);
    subscriptions.push(() => autoUpdater.removeListener(event, cb));
  };

  const adapter: UpdaterAdapter = {
    get autoDownload() { return autoUpdater.autoDownload; },
    set autoDownload(value) { autoUpdater.autoDownload = value; },
    get autoInstallOnAppQuit() { return autoUpdater.autoInstallOnAppQuit; },
    set autoInstallOnAppQuit(value) { autoUpdater.autoInstallOnAppQuit = value; },
    get allowPrerelease() { return autoUpdater.allowPrerelease; },
    set allowPrerelease(value) { autoUpdater.allowPrerelease = value; },
    get allowDowngrade() { return autoUpdater.allowDowngrade; },
    set allowDowngrade(value) { autoUpdater.allowDowngrade = value; },
    onCheckingForUpdate: (cb) => subscribe('checking-for-update', cb),
    onUpdateAvailable: (cb) => subscribe('update-available', (info: { version: string }) => cb(info.version)),
    onUpdateNotAvailable: (cb) => subscribe('update-not-available', cb),
    onDownloadProgress: (cb) => subscribe('download-progress', cb),
    onUpdateDownloaded: (cb) => subscribe('update-downloaded', (info: { version: string }) => cb(info.version)),
    onError: (cb) => subscribe('error', cb),
    checkForUpdates: async () => {
      const result = await autoUpdater.checkForUpdates();
      await result?.downloadPromise;
    },
    quitAndInstall: () => {
      // 显示安装器界面（未签名包依赖用户确认 SmartScreen），安装后重新启动
      autoUpdater.quitAndInstall(false, true);
    },
  };

  autoUpdater.logger = {
    info: (message?: unknown) => opts.onLog('info', String(message ?? '')),
    warn: (message?: unknown) => opts.onLog('warn', String(message ?? '')),
    error: (message?: unknown) => opts.onLog('error', String(message ?? '')),
    debug: () => undefined,
  };

  const controller = createUpdateController({
    currentVersion: opts.currentVersion,
    supported: support.supported,
    unavailableReason: support.reason,
    initialAutoUpdate: opts.getAutoUpdate(),
    adapter,
    onStatus: opts.onStatus,
    onDownloaded: (version) => {
      showUpdateReady(version, opts.showWindow);
    },
    onLog: opts.onLog,
  });

  return {
    status: () => controller.status(),
    check: () => {
      void controller.check();
    },
    install: () => controller.install(),
    setAutoUpdateEnabled: (on) => controller.setAutoUpdateEnabled(on),
    start: () => controller.start(),
    dispose: () => {
      controller.dispose();
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    },
  };
}
