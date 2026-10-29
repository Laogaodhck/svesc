/**
 * 更新状态机（纯 Node，不 import electron）。
 *
 * 适配器由主进程注入 electron-updater；本文件只负责：
 *  - 状态迁移（检查/下载/就绪/失败）与推送
 *  - 自动检查定时器（启动延迟 + 固定间隔）
 *  - 安装门控（只有 downloaded 才允许）
 *
 * 失败不抛出到窗口：统一落到 phase='error'，并保留可执行提示。
 */
import type { UpdateStatus } from '../../shared/types';
import { clampPercent, normalizeUpdateError } from './update-policy';

export interface UpdateProgressLike {
  percent: number;
  transferred: number;
  total: number;
}

/** electron-updater 的最小适配面（测试用假实现即可覆盖状态机）。 */
export interface UpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  onCheckingForUpdate(cb: () => void): void;
  onUpdateAvailable(cb: (version: string) => void): void;
  onUpdateNotAvailable(cb: () => void): void;
  onDownloadProgress(cb: (progress: UpdateProgressLike) => void): void;
  onUpdateDownloaded(cb: (version: string) => void): void;
  onError(cb: (err: unknown) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateControllerOptions {
  currentVersion: string;
  supported: boolean;
  unavailableReason: string | null;
  initialAutoUpdate: boolean;
  adapter: UpdaterAdapter;
  onStatus?: (status: UpdateStatus) => void;
  /** 下载完成时的一次性回调（弹通知由主进程决定） */
  onDownloaded?: (version: string) => void;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  now?: () => number;
  /** 启动后首次自动检查延迟（默认 15s，避开启动扫描高峰） */
  firstCheckDelayMs?: number;
  /** 自动检查间隔（默认 6h） */
  intervalMs?: number;
}

export interface UpdateController {
  status(): UpdateStatus;
  /** 立即检查（手动入口无视 autoUpdate 开关）；已有检查/下载在进行时原样返回 */
  check(): Promise<UpdateStatus>;
  /** 重启并安装；仅 phase=downloaded 放行 */
  install(): { ok: boolean; error: string | null };
  setAutoUpdateEnabled(on: boolean): void;
  start(): void;
  dispose(): void;
}

const BUSY_PHASES = new Set<UpdateStatus['phase']>(['checking', 'downloading', 'installing']);

export function createUpdateController(opts: UpdateControllerOptions): UpdateController {
  const now = opts.now ?? Date.now;
  const firstCheckDelayMs = opts.firstCheckDelayMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000;

  let current: UpdateStatus = {
    phase: opts.supported ? 'idle' : 'disabled',
    currentVersion: opts.currentVersion,
    availableVersion: null,
    percent: null,
    transferred: null,
    total: null,
    error: null,
    unavailableReason: opts.unavailableReason,
    supported: opts.supported,
    autoUpdate: opts.initialAutoUpdate,
    checkedAt: null,
  };

  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    opts.onLog?.(level, message);
  };

  const patch = (next: Partial<UpdateStatus>): void => {
    current = { ...current, ...next };
    opts.onStatus?.({ ...current });
  };

  const fail = (err: unknown): void => {
    const message = normalizeUpdateError(err);
    // electron-updater 常同时抛出 promise rejection 与 'error' 事件：同一条不重复记
    if (current.phase === 'error' && current.error === message) return;
    patch({
      phase: 'error',
      error: message,
      percent: null,
      transferred: null,
      total: null,
      checkedAt: now(),
    });
    log('warn', `更新失败：${message}`);
  };

  const adapter = opts.adapter;
  // 只检查 + 后台下载；安装必须由用户点按（未签名包的信任提示留给安装器）
  adapter.autoDownload = true;
  adapter.autoInstallOnAppQuit = false;
  adapter.allowPrerelease = false;
  adapter.allowDowngrade = false;

  adapter.onCheckingForUpdate(() => {
    if (current.phase !== 'checking') {
      patch({ phase: 'checking', error: null, checkedAt: now() });
    }
  });

  adapter.onUpdateAvailable((version) => {
    log('info', `发现新版本 v${version}，开始后台下载`);
    patch({
      phase: 'downloading',
      availableVersion: version,
      percent: 0,
      transferred: 0,
      total: null,
      error: null,
      checkedAt: now(),
    });
  });

  adapter.onUpdateNotAvailable(() => {
    log('info', `已是最新版本（v${current.currentVersion}）`);
    patch({
      phase: 'up-to-date',
      availableVersion: null,
      percent: null,
      transferred: null,
      total: null,
      error: null,
      checkedAt: now(),
    });
  });

  adapter.onDownloadProgress((progress) => {
    // 已就绪/正在安装时迟到的进度事件不能把状态倒退
    if (current.phase === 'downloaded' || current.phase === 'installing') return;
    patch({
      phase: 'downloading',
      percent: clampPercent(progress.percent),
      transferred: Number.isFinite(progress.transferred) ? progress.transferred : null,
      total: Number.isFinite(progress.total) && progress.total > 0 ? progress.total : null,
    });
  });

  adapter.onUpdateDownloaded((version) => {
    patch({
      phase: 'downloaded',
      availableVersion: version,
      percent: 100,
      error: null,
      checkedAt: now(),
    });
    log('info', `更新 v${version} 已下载，等待用户重启安装`);
    opts.onDownloaded?.(version);
  });

  adapter.onError((err) => fail(err));

  const clearTimers = (): void => {
    if (firstTimer !== null) {
      clearTimeout(firstTimer);
      firstTimer = null;
    }
    if (intervalTimer !== null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  };

  const syncTimers = (): void => {
    if (!current.supported || !current.autoUpdate) {
      clearTimers();
      return;
    }
    if (firstTimer !== null || intervalTimer !== null) return;
    firstTimer = setTimeout(() => {
      firstTimer = null;
      // 启动后若已手动检查过，不再补一次
      if (current.checkedAt === null && !BUSY_PHASES.has(current.phase)) void check();
    }, firstCheckDelayMs);
    intervalTimer = setInterval(() => {
      if (!BUSY_PHASES.has(current.phase)) void check();
    }, intervalMs);
  };

  async function check(): Promise<UpdateStatus> {
    if (!current.supported) return { ...current };
    if (BUSY_PHASES.has(current.phase)) return { ...current };
    patch({
      phase: 'checking',
      error: null,
      availableVersion: null,
      percent: null,
      transferred: null,
      total: null,
      checkedAt: now(),
    });
    log('info', `检查更新（当前 v${current.currentVersion}）`);
    try {
      await adapter.checkForUpdates();
    } catch (err) {
      fail(err);
    }
    return { ...current };
  }

  return {
    status: () => ({ ...current }),

    check,

    install(): { ok: boolean; error: string | null } {
      if (!current.supported) {
        return { ok: false, error: current.unavailableReason ?? '当前版本不支持自动更新' };
      }
      if (current.phase !== 'downloaded') {
        return { ok: false, error: '更新尚未下载完成，请等待下载结束' };
      }
      patch({ phase: 'installing', error: null });
      log('info', '退出并安装更新');
      try {
        adapter.quitAndInstall();
        return { ok: true, error: null };
      } catch (err) {
        const message = normalizeUpdateError(err);
        patch({ phase: 'error', error: message });
        log('error', `启动安装失败：${message}`);
        return { ok: false, error: message };
      }
    },

    setAutoUpdateEnabled(on: boolean): void {
      if (current.autoUpdate === on) return;
      patch({ autoUpdate: on });
      syncTimers();
      if (on && current.supported && current.phase === 'idle') void check();
    },

    start(): void {
      if (!current.supported) return;
      syncTimers();
    },

    dispose(): void {
      clearTimers();
    },
  };
}
