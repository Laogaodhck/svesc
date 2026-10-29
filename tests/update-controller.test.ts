/**
 * 更新状态机回归锁：检查 → 下载 → 就绪 → 安装，以及失败与自动定时。
 * 使用假适配器，不触达 electron-updater / 网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../src/shared/types';
import {
  createUpdateController,
  type UpdaterAdapter,
  type UpdateProgressLike,
} from '../src/main/engine/update-controller';

class FakeAdapter implements UpdaterAdapter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;

  checks = 0;
  installs = 0;
  reject: unknown = null;
  installError: unknown = null;

  private checkingCb: (() => void) | null = null;
  private availableCb: ((version: string) => void) | null = null;
  private notAvailableCb: (() => void) | null = null;
  private progressCb: ((progress: UpdateProgressLike) => void) | null = null;
  private downloadedCb: ((version: string) => void) | null = null;
  private errorCb: ((err: unknown) => void) | null = null;

  onCheckingForUpdate(cb: () => void): void {
    this.checkingCb = cb;
  }
  onUpdateAvailable(cb: (version: string) => void): void {
    this.availableCb = cb;
  }
  onUpdateNotAvailable(cb: () => void): void {
    this.notAvailableCb = cb;
  }
  onDownloadProgress(cb: (progress: UpdateProgressLike) => void): void {
    this.progressCb = cb;
  }
  onUpdateDownloaded(cb: (version: string) => void): void {
    this.downloadedCb = cb;
  }
  onError(cb: (err: unknown) => void): void {
    this.errorCb = cb;
  }

  checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    if (this.reject !== null) return Promise.reject(this.reject);
    return Promise.resolve({});
  }

  quitAndInstall(): void {
    this.installs += 1;
    if (this.installError !== null) throw this.installError;
  }

  emitAvailable(version: string): void {
    this.availableCb?.(version);
  }
  emitNotAvailable(): void {
    this.notAvailableCb?.();
  }
  emitProgress(progress: UpdateProgressLike): void {
    this.progressCb?.(progress);
  }
  emitDownloaded(version: string): void {
    this.downloadedCb?.(version);
  }
  emitError(err: unknown): void {
    this.errorCb?.(err);
  }
}

function make(overrides: Partial<Parameters<typeof createUpdateController>[0]> = {}) {
  const adapter = new FakeAdapter();
  const statuses: UpdateStatus[] = [];
  const downloaded: string[] = [];
  const logs: string[] = [];
  const controller = createUpdateController({
    currentVersion: '0.4.0',
    supported: true,
    unavailableReason: null,
    initialAutoUpdate: true,
    adapter,
    onStatus: (s) => statuses.push(s),
    onDownloaded: (v) => downloaded.push(v),
    onLog: (_level, message) => logs.push(message),
    now: () => 1_000,
    firstCheckDelayMs: 15_000,
    intervalMs: 60_000,
    ...overrides,
  });
  return { adapter, controller, statuses, downloaded, logs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('更新状态机', () => {
  it('不支持的构建：检查不触网，安装如实拒绝', async () => {
    const { adapter, controller } = make({ supported: false, unavailableReason: '便携版不支持就地更新' });
    expect(controller.status()).toMatchObject({
      phase: 'disabled',
      supported: false,
      unavailableReason: '便携版不支持就地更新',
    });
    await controller.check();
    expect(adapter.checks).toBe(0);
    expect(controller.install()).toEqual({ ok: false, error: '便携版不支持就地更新' });
  });

  it('检查 → 下载 → 就绪；安装必须等下载完成', async () => {
    const { adapter, controller, downloaded } = make();
    void controller.check();
    expect(controller.status().phase).toBe('checking');
    expect(adapter.checks).toBe(1);

    adapter.emitAvailable('0.5.0');
    expect(controller.status()).toMatchObject({
      phase: 'downloading',
      availableVersion: '0.5.0',
      percent: 0,
    });
    expect(controller.install().ok).toBe(false);

    adapter.emitProgress({ percent: 42.34, transferred: 42, total: 100 });
    expect(controller.status()).toMatchObject({ percent: 42.3, transferred: 42, total: 100 });

    adapter.emitDownloaded('0.5.0');
    expect(downloaded).toEqual(['0.5.0']);
    expect(controller.status()).toMatchObject({ phase: 'downloaded', percent: 100 });

    // 迟到的进度事件不能把已就绪状态倒回下载中
    adapter.emitProgress({ percent: 80, transferred: 80, total: 100 });
    expect(controller.status().phase).toBe('downloaded');

    expect(controller.install()).toEqual({ ok: true, error: null });
    expect(adapter.installs).toBe(1);
    expect(controller.status().phase).toBe('installing');
  });

  it('已是最新版本', async () => {
    const { adapter, controller } = make();
    void controller.check();
    adapter.emitNotAvailable();
    expect(controller.status()).toMatchObject({
      phase: 'up-to-date',
      availableVersion: null,
      error: null,
    });
  });

  it('网络失败落到 error，不抛出；同一错误不重复记日志', async () => {
    const { adapter, controller, logs } = make();
    adapter.reject = new Error('net::ERR_INTERNET_DISCONNECTED');
    await expect(controller.check()).resolves.toMatchObject({ phase: 'error' });
    expect(controller.status().error).toContain('网络连接失败');
    adapter.emitError(new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(logs.filter((line) => line.startsWith('更新失败')).length).toBe(1);
  });

  it('安装抛出异常时保留就绪状态，不假装成功', async () => {
    const { adapter, controller } = make();
    void controller.check();
    adapter.emitAvailable('0.5.0');
    adapter.emitDownloaded('0.5.0');
    adapter.installError = new Error('spawn failed');
    expect(controller.install()).toEqual({ ok: false, error: '启动安装失败：spawn failed' });
    expect(controller.status().phase).toBe('downloaded');
  });

  it('就绪后手动与定时检查不能清掉下载结果', async () => {
    vi.useFakeTimers();
    const { adapter, controller } = make();
    controller.start();
    await controller.check();
    adapter.emitDownloaded('0.4.1');
    await controller.check();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(controller.status()).toMatchObject({ phase: 'downloaded', availableVersion: '0.4.1', percent: 100 });
    expect(adapter.checks).toBe(1);
    controller.dispose();
  });

  it('安装通过 error 事件拒绝时不能返回成功，且仍可重试安装', async () => {
    const { adapter, controller } = make();
    await controller.check();
    adapter.emitDownloaded('0.4.1');
    vi.spyOn(adapter, 'quitAndInstall').mockImplementationOnce(() => adapter.emitError(new Error('spawn EPERM')));
    expect(controller.install().ok).toBe(false);
    expect(controller.status()).toMatchObject({ phase: 'downloaded', percent: 100 });
    expect(controller.status().error).toBeTruthy();
    expect(controller.install()).toEqual({ ok: true, error: null });
  });

  it('失败后迟到的进度不得恢复为下载中', async () => {
    const { adapter, controller } = make({ initialAutoUpdate: false });
    await controller.check();
    adapter.emitAvailable('0.4.1');
    adapter.emitError(new Error('net::ERR_CONNECTION_RESET'));
    adapter.emitProgress({ percent: 50, transferred: 50, total: 100 });
    expect(controller.status().phase).toBe('error');
    await controller.check();
    expect(adapter.checks).toBe(2);
  });

  it('dispose 后在飞响应不得推送或重新开启定时器', async () => {
    const onStatus = vi.fn();
    const { adapter, controller } = make({ onStatus });
    await controller.check();
    controller.dispose();
    onStatus.mockClear();
    adapter.emitDownloaded('0.4.1');
    adapter.emitError(new Error('net::ERR_CONNECTION_RESET'));
    controller.setAutoUpdateEnabled(false);
    controller.setAutoUpdateEnabled(true);
    await controller.check();
    expect(onStatus).not.toHaveBeenCalled();
    expect(adapter.checks).toBe(1);
  });

  it('适配器标志强制为“自动下载、退出不静默安装、不收预发布/降级”', () => {
    const { adapter } = make();
    expect(adapter.autoDownload).toBe(true);
    expect(adapter.autoInstallOnAppQuit).toBe(false);
    expect(adapter.allowPrerelease).toBe(false);
    expect(adapter.allowDowngrade).toBe(false);
  });
});

describe('自动检查定时器', () => {
  it('断网按 15/30/60 秒最多重试三次，手动检查重置预算', async () => {
    vi.useFakeTimers();
    const { adapter, controller } = make({ intervalMs: 6 * 60 * 60 * 1000 });
    adapter.reject = new Error('net::ERR_INTERNET_DISCONNECTED');
    controller.start();
    await controller.check();
    for (const [index, delay] of [15_000, 30_000, 60_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(adapter.checks).toBe(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(adapter.checks).toBe(index + 2);
    }
    await vi.advanceTimersByTimeAsync(120_000);
    expect(adapter.checks).toBe(4);
    await controller.check();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(adapter.checks).toBe(6);
    controller.dispose();
  });

  it.each(['sha512 mismatch', 'ENOSPC', 'spawn EPERM', 'net::ERR_CERT_AUTHORITY_INVALID', '404 latest.yml'])(
    '%s 不属于可自动重试的网络故障', async (error) => {
      vi.useFakeTimers();
      const { adapter, controller } = make({ intervalMs: 6 * 60 * 60 * 1000 });
      adapter.reject = new Error(error);
      controller.start();
      await controller.check();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(adapter.checks).toBe(1);
      controller.dispose();
    },
  );

  it.each(['disable', 'dispose'] as const)('%s 取消待执行的网络重试', async (action) => {
    vi.useFakeTimers();
    const { adapter, controller } = make();
    adapter.reject = new Error('ECONNRESET');
    controller.start();
    await controller.check();
    if (action === 'disable') controller.setAutoUpdateEnabled(false);
    else controller.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(adapter.checks).toBe(1);
    controller.dispose();
  });

  it('下载失败在恢复网络后重试，成功就绪后停止重试', async () => {
    vi.useFakeTimers();
    const { adapter, controller } = make();
    controller.start();
    await controller.check();
    adapter.emitAvailable('0.4.1');
    adapter.emitError(new Error('ECONNRESET'));
    await vi.advanceTimersByTimeAsync(15_000);
    adapter.emitAvailable('0.4.1');
    adapter.emitDownloaded('0.4.1');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(adapter.checks).toBe(2);
    expect(controller.status().phase).toBe('downloaded');
    controller.dispose();
  });

  it('启动延迟后检查一次，此后按间隔检查；dispose 停止', async () => {
    vi.useFakeTimers();
    const { adapter, controller } = make();
    controller.start();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(adapter.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.checks).toBe(1);

    adapter.emitNotAvailable();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adapter.checks).toBe(2);

    controller.dispose();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(adapter.checks).toBe(2);
  });

  it('关闭自动检查后不排期；重新开启立即检查一次并恢复间隔', async () => {
    vi.useFakeTimers();
    const { adapter, controller } = make({ initialAutoUpdate: false });
    controller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(adapter.checks).toBe(0);

    controller.setAutoUpdateEnabled(true);
    expect(adapter.checks).toBe(1);
    adapter.emitNotAvailable();

    controller.setAutoUpdateEnabled(false);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(adapter.checks).toBe(1);
  });

  it('下载进行中不重复发起检查', async () => {
    vi.useFakeTimers();
    const { adapter, controller } = make();
    controller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(adapter.checks).toBe(1);
    adapter.emitAvailable('0.5.0');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(adapter.checks).toBe(1);
  });
});
