/**
 * electron-updater 适配层（主进程）。
 *
 * 更新源来自打包时生成的 app-update.yml（GitHub Releases，owner/repo 见 electron-builder.yml）。
 * 本文件只做"翻译"：把 electron-updater 的事件/命令接到纯 Node 状态机，
 * 并决定下载完成后是否弹系统通知；业务门控与错误文案在 engine/update-controller.ts。
 */
import { autoUpdater } from 'electron-updater';
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
  /** 退出安装前置位，避免 close-to-tray 拦截 app.quit */
  beforeInstall: () => void;
  onStatus: (status: UpdateStatus) => void;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
}): UpdateService {
  const support = resolveUpdateSupport({
    isPackaged: opts.isPackaged,
    isSmoke: opts.isSmoke,
    env: opts.env,
  });

  const adapter: UpdaterAdapter = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    onCheckingForUpdate: (cb) => autoUpdater.on('checking-for-update', cb),
    onUpdateAvailable: (cb) => autoUpdater.on('update-available', (info) => cb(info.version)),
    onUpdateNotAvailable: (cb) => autoUpdater.on('update-not-available', cb),
    onDownloadProgress: (cb) =>
      autoUpdater.on('download-progress', (progress) =>
        cb({ percent: progress.percent, transferred: progress.transferred, total: progress.total }),
      ),
    onUpdateDownloaded: (cb) => autoUpdater.on('update-downloaded', (info) => cb(info.version)),
    onError: (cb) => autoUpdater.on('error', cb),
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    quitAndInstall: () => {
      opts.beforeInstall();
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
    dispose: () => controller.dispose(),
  };
}
