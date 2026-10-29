import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updater, notify } = vi.hoisted(() => ({
  updater: {
    autoDownload: false, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true,
    logger: null as unknown,
    on: vi.fn(), removeListener: vi.fn(),
    checkForUpdates: vi.fn(), quitAndInstall: vi.fn(),
  },
  notify: vi.fn(),
}));
vi.mock('electron-updater', () => ({ autoUpdater: updater }));
vi.mock('../src/main/notify', () => ({ showUpdateReady: notify }));
import { createUpdateService } from '../src/main/updater';

let events: EventEmitter;
beforeEach(() => {
  vi.clearAllMocks();
  events = new EventEmitter();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = true;
  updater.allowDowngrade = true;
  updater.on.mockImplementation((name: string, cb: (...args: unknown[]) => void) => events.on(name, cb));
  updater.removeListener.mockImplementation((name: string, cb: (...args: unknown[]) => void) => events.removeListener(name, cb));
  updater.checkForUpdates.mockResolvedValue(null);
});
function service() {
  return createUpdateService({
    isPackaged: true, isSmoke: false, env: {}, currentVersion: '0.4.0',
    getAutoUpdate: () => false, showWindow: vi.fn(),
    onStatus: vi.fn(), onLog: vi.fn(),
  });
}

describe('真实更新器适配边界', () => {
  it('将安全策略写入 electron-updater 本身，而不是适配器副本', () => {
    const sut = service();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    sut.dispose();
  });

  it('dispose 移除自己注册的监听，不影响其他订阅者', () => {
    const other = vi.fn();
    events.on('update-downloaded', other);
    const sut = service();
    sut.dispose();
    events.emit('update-downloaded', { version: '0.4.1' });
    expect(other).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(events.listenerCount('error')).toBe(0);
  });

  it('等待自动下载 Promise，拒绝会进入错误状态而非未处理拒绝', async () => {
    let rejectDownload: (err: Error) => void = () => undefined;
    const downloadPromise = new Promise<string[]>((_resolve, reject) => { rejectDownload = reject; });
    updater.checkForUpdates.mockImplementation(async () => {
      events.emit('update-available', { version: '0.4.1' });
      return { downloadPromise };
    });
    const sut = service();
    sut.check();
    await Promise.resolve();
    rejectDownload(new Error('net::ERR_CONNECTION_RESET'));
    await vi.waitFor(() => expect(sut.status().phase).toBe('error'));
    expect(sut.status().error).toContain('网络连接失败');
    sut.dispose();
  });
});
