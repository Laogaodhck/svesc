import type { UpdateStatus } from '../../shared/types';
import { clampPercent, isTransientUpdateError, normalizeUpdateError } from './update-policy';

export interface UpdateProgressLike {
  percent: number;
  transferred: number;
  total: number;
}

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
  onDownloaded?: (version: string) => void;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  now?: () => number;
  firstCheckDelayMs?: number;
  intervalMs?: number;
}

export interface UpdateController {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  install(): { ok: boolean; error: string | null };
  setAutoUpdateEnabled(on: boolean): void;
  start(): void;
  dispose(): void;
}

const CHECK_BLOCKED_PHASES = new Set<UpdateStatus['phase']>(['checking', 'downloading', 'downloaded', 'installing']);
const RETRY_DELAYS = [15_000, 30_000, 60_000];

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
  let disposed = false;
  let started = false;
  let inFlight = false;
  let retryCount = 0;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    if (!disposed) opts.onLog?.(level, message);
  };
  const patch = (next: Partial<UpdateStatus>): void => {
    if (disposed) return;
    current = { ...current, ...next };
    opts.onStatus?.({ ...current });
  };
  const clearRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const scheduleRetry = (err: unknown): void => {
    if (!started || disposed || !current.autoUpdate || retryTimer !== null || !isTransientUpdateError(err)) return;
    const delay = RETRY_DELAYS[retryCount];
    if (delay === undefined) return;
    retryCount += 1;
    log('info', `网络暂不可用，${delay / 1000} 秒后重试更新（${retryCount}/${RETRY_DELAYS.length}）`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void check(true);
    }, delay);
  };
  const fail = (err: unknown): void => {
    if (disposed || !current.supported) return;
    if (current.phase === 'installing' || current.phase === 'downloaded') {
      const message = normalizeUpdateError(err, 'install');
      if (current.phase === 'downloaded' && current.error === message) return;
      patch({ phase: 'downloaded', error: message });
      log('error', `启动安装失败：${message}`);
      return;
    }
    const message = normalizeUpdateError(err);
    // 同一次失败可能同时触发 error 事件和 Promise rejection。
    if (current.phase === 'error' && current.error === message) return;
    patch({ phase: 'error', error: message, percent: null, transferred: null, total: null, checkedAt: now() });
    log('warn', `更新失败：${message}`);
    scheduleRetry(err);
  };

  const adapter = opts.adapter;
  adapter.autoDownload = true;
  adapter.autoInstallOnAppQuit = false;
  adapter.allowPrerelease = false;
  adapter.allowDowngrade = false;

  adapter.onCheckingForUpdate(() => {
    if (disposed || !current.supported || current.phase !== 'checking') return;
    patch({ error: null, checkedAt: now() });
  });
  adapter.onUpdateAvailable((version) => {
    if (disposed || current.phase !== 'checking') return;
    log('info', `发现新版本 v${version}，开始后台下载`);
    patch({ phase: 'downloading', availableVersion: version, percent: 0, transferred: 0, total: null, error: null, checkedAt: now() });
  });
  adapter.onUpdateNotAvailable(() => {
    if (disposed || current.phase !== 'checking') return;
    clearRetry();
    retryCount = 0;
    log('info', `已是最新版本（v${current.currentVersion}）`);
    patch({ phase: 'up-to-date', availableVersion: null, percent: null, transferred: null, total: null, error: null, checkedAt: now() });
  });
  adapter.onDownloadProgress((progress) => {
    if (disposed || current.phase !== 'downloading') return;
    patch({
      percent: clampPercent(progress.percent),
      transferred: Number.isFinite(progress.transferred) ? progress.transferred : null,
      total: Number.isFinite(progress.total) && progress.total > 0 ? progress.total : null,
    });
  });
  adapter.onUpdateDownloaded((version) => {
    if (disposed || (current.phase !== 'checking' && current.phase !== 'downloading')) return;
    clearRetry();
    retryCount = 0;
    patch({ phase: 'downloaded', availableVersion: version, percent: 100, error: null, checkedAt: now() });
    log('info', `更新 v${version} 已下载，等待用户确认安装`);
    opts.onDownloaded?.(version);
  });
  adapter.onError(fail);

  const clearTimers = (): void => {
    if (firstTimer !== null) clearTimeout(firstTimer);
    if (intervalTimer !== null) clearInterval(intervalTimer);
    firstTimer = null;
    intervalTimer = null;
    clearRetry();
  };
  const syncTimers = (): void => {
    if (disposed || !started || !current.supported || !current.autoUpdate) {
      clearTimers();
      return;
    }
    if (firstTimer !== null || intervalTimer !== null) return;
    firstTimer = setTimeout(() => {
      firstTimer = null;
      if (current.checkedAt === null) void check();
    }, firstCheckDelayMs);
    intervalTimer = setInterval(() => {
      if (retryTimer === null) void check();
    }, intervalMs);
  };

  async function check(retry = false): Promise<UpdateStatus> {
    if (disposed || !current.supported || inFlight || CHECK_BLOCKED_PHASES.has(current.phase)) return { ...current };
    clearRetry();
    if (!retry) retryCount = 0;
    inFlight = true;
    patch({ phase: 'checking', error: null, availableVersion: null, percent: null, transferred: null, total: null, checkedAt: now() });
    log('info', `检查更新（当前 v${current.currentVersion}）`);
    try {
      await adapter.checkForUpdates();
    } catch (err) {
      fail(err);
    } finally {
      inFlight = false;
    }
    return { ...current };
  }

  return {
    status: () => ({ ...current }),
    check: () => check(),
    install(): { ok: boolean; error: string | null } {
      if (disposed) return { ok: false, error: '更新服务已停止' };
      if (!current.supported) return { ok: false, error: current.unavailableReason ?? '当前版本不支持自动更新' };
      if (current.phase !== 'downloaded') return { ok: false, error: '更新尚未下载完成，请等待下载结束' };
      patch({ phase: 'installing', error: null });
      log('info', '退出并安装更新');
      try {
        adapter.quitAndInstall();
      } catch (err) {
        fail(err);
      }
      const result = { ...current };
      return result.phase === 'installing'
        ? { ok: true, error: null }
        : { ok: false, error: result.error ?? '启动安装失败' };
    },
    setAutoUpdateEnabled(on: boolean): void {
      if (disposed || current.autoUpdate === on) return;
      patch({ autoUpdate: on });
      syncTimers();
      if (on && current.supported && current.phase === 'idle') void check();
    },
    start(): void {
      if (disposed) return;
      started = true;
      syncTimers();
    },
    dispose(): void {
      disposed = true;
      clearTimers();
    },
  };
}
