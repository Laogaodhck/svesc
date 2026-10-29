import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ALERT_COOLDOWN_MS,
  DEFAULT_ALERT_REPEAT_MS,
  OFFLINE_CONFIRM_MS,
  PrinterAlertTracker,
  printerIssue,
  type PrinterAlert,
} from '../src/main/engine/printers/alerts';
import { showPrinterAlert } from '../src/main/notify';
import type { Printer } from '../src/shared/types';
import { printer, supply, T0 } from './fixtures';

const notification = vi.hoisted(() => ({
  supported: true,
  create: vi.fn<(options: { title: string; body: string; silent: boolean }) => void>(),
  show: vi.fn(),
  on: vi.fn(),
}));
vi.mock('electron', () => ({
  Notification: class {
    static isSupported() { return notification.supported; }
    constructor(options: { title: string; body: string; silent: boolean }) { notification.create(options); }
    on = notification.on;
    show = notification.show;
  },
}));

const sample = (over: Partial<Printer> = {}) => printer({ id: 'p1', name: 'HP', lastSeen: Date.now(), ...over });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('printerIssue 问题判定', () => {
  it('离线/故障/警告分别给出中文原因，stateDetail 作为补充', () => {
    expect(printerIssue(sample({ state: 'offline' }))).toBe('设备离线');
    expect(printerIssue(sample({ state: 'error', stateDetail: 'Paper Jam' }))).toBe('打印机故障（Paper Jam）');
    expect(printerIssue(sample({ state: 'warning' }))).toBe('打印机警告');
  });

  it('耗材 ≤10% 且来源已知才算不足，状态与耗材可同时提醒', () => {
    expect(printerIssue(sample({ consumables: [supply({ levelPct: 10 })] }))).toBe('耗材不足：Black Toner 10%');
    expect(printerIssue(sample({ consumables: [supply({ levelPct: 5, source: 'unknown' })] }))).toBeNull();
    expect(printerIssue(sample({ consumables: [supply({ levelPct: null }), supply({ levelPct: 11 })] }))).toBeNull();
    expect(printerIssue(sample({ state: 'offline', consumables: [supply({ levelPct: 8 })] })))
      .toBe('设备离线 · 耗材不足：Black Toner 8%');
  });

  it('演示数据与虚拟打印机不产生问题', () => {
    expect(printerIssue(sample({ state: 'offline', source: 'simulated' }))).toBeNull();
    expect(printerIssue(sample({ id: 'sim-1', state: 'offline' }))).toBeNull();
    expect(printerIssue(sample({ state: 'error', connection: 'virtual' }))).toBeNull();
  });
});

describe('PrinterAlertTracker 运行期时间线', () => {
  let tracker: PrinterAlertTracker;
  const notify = vi.fn(() => true);
  const observe = (printers: Printer[]) => tracker.evaluate(printers, Date.now(), notify);
  const since = (p = sample()) => tracker.project([p])[0]?.firstObservedAt;

  beforeEach(() => {
    tracker = new PrinterAlertTracker();
    notify.mockReset().mockReturnValue(true);
  });

  it('离线持续30秒后仍须新采集样本确认；早于阈值的新样本与旧心跳不能确认', () => {
    observe([sample()]);
    vi.advanceTimersByTime(1000);
    const firstDown = sample({ state: 'offline', alias: '前台打印机' });
    expect(observe([firstDown])).toEqual([]);
    expect(since()).toBe(T0 + 1000);
    vi.advanceTimersByTime(OFFLINE_CONFIRM_MS - 1);
    const early = sample({ ...firstDown, lastSeen: Date.now() });
    expect(observe([early])).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(observe([early])).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(observe([firstDown])).toEqual([]);
    expect(observe([sample({ ...firstDown, lastSeen: Date.now() })])).toEqual([{
      printerId: 'p1', printerName: '前台打印机', kind: 'fault', state: 'offline', reason: '设备离线', firstObservedAt: T0 + 1000,
    }]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('短暂离线恢复静默；已通知故障的恢复仅一次，下一episode重新计时', () => {
    observe([sample()]);
    vi.advanceTimersByTime(1);
    observe([sample({ state: 'offline' })]);
    vi.advanceTimersByTime(OFFLINE_CONFIRM_MS - 1);
    expect(observe([sample()])).toEqual([]);
    expect(since()).toBeNull();
    vi.advanceTimersByTime(1);
    const startedAt = Date.now();
    expect(observe([sample({ state: 'error' })])[0]?.firstObservedAt).toBe(startedAt);
    vi.advanceTimersByTime(1);
    expect(observe([sample()])[0]).toMatchObject({ kind: 'recovered', firstObservedAt: startedAt });
    expect(since()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(observe([sample()])).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(observe([sample({ state: 'error' })])[0]?.firstObservedAt).toBe(Date.now());
  });

  it.each(['offline', 'error', 'warning'] as const)('启动/新增存量%s静默建基线，30分钟后提醒且不倒推设备起点', (state) => {
    observe([]);
    const existing = sample({ state, lastSeen: T0 - 60_000 });
    expect(observe([existing])).toEqual([]);
    expect(since()).toBe(T0);
    vi.advanceTimersByTime(DEFAULT_ALERT_REPEAT_MS - 1);
    expect(observe([sample({ state })])).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(observe([sample({ state })])[0]).toMatchObject({ kind: 'fault', firstObservedAt: T0 });
    vi.advanceTimersByTime(DEFAULT_ALERT_REPEAT_MS);
    expect(observe([sample({ state })])).toHaveLength(1);
  });

  it('同一问题每30分钟复提醒；心跳不以旧故障样本补发', () => {
    observe([sample()]);
    vi.advanceTimersByTime(1);
    const fault = sample({ state: 'error' });
    expect(observe([fault])).toHaveLength(1);
    vi.advanceTimersByTime(DEFAULT_ALERT_REPEAT_MS - 1);
    expect(observe([sample({ state: 'error' })])).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(observe([fault])).toEqual([]);
    expect(observe([sample({ state: 'error' })])).toHaveLength(1);
    expect(since()).toBe(T0 + 1);
    vi.advanceTimersByTime(DEFAULT_ALERT_REPEAT_MS);
    expect(observe([sample({ state: 'error' })])).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it('问题变化冷却10分钟，冷却后稳定新问题仍会提醒；首次观察不重置', () => {
    observe([sample()]);
    vi.advanceTimersByTime(1);
    observe([sample({ state: 'warning' })]);
    vi.advanceTimersByTime(1000);
    expect(observe([sample({ state: 'error' })])).toEqual([]);
    vi.advanceTimersByTime(DEFAULT_ALERT_COOLDOWN_MS - 1001);
    expect(observe([sample({ state: 'error' })])).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(observe([sample({ state: 'error' })])[0]).toMatchObject({ reason: '打印机故障', firstObservedAt: T0 + 1 });
  });

  it('故障转离线同样需30秒去抖，首次观察沿用同一episode', () => {
    observe([sample()]);
    vi.advanceTimersByTime(1);
    observe([sample({ state: 'error' })]);
    vi.advanceTimersByTime(DEFAULT_ALERT_COOLDOWN_MS);
    expect(observe([sample({ state: 'offline' })])).toEqual([]);
    vi.advanceTimersByTime(OFFLINE_CONFIRM_MS);
    expect(observe([sample({ state: 'offline' })])[0]?.firstObservedAt).toBe(T0 + 1);
  });

  it('未知不是恢复，也不能确认离线持续；重获离线样本需再次等待30秒', () => {
    observe([sample()]);
    vi.advanceTimersByTime(1);
    observe([sample({ state: 'error' })]);
    vi.advanceTimersByTime(DEFAULT_ALERT_REPEAT_MS);
    expect(observe([sample({ state: 'unknown' })])).toEqual([]);
    expect(since()).toBe(T0 + 1);
    vi.advanceTimersByTime(1);
    expect(observe([sample({ state: 'offline' })])).toEqual([]);
    vi.advanceTimersByTime(OFFLINE_CONFIRM_MS);
    expect(observe([sample({ state: 'offline' })])).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(observe([sample()])[0]?.kind).toBe('recovered');
  });

  it('通知关闭或发送失败不记为已通知；恢复不会产生伪通知', () => {
    observe([sample()]);
    notify.mockReturnValue(false);
    vi.advanceTimersByTime(1);
    expect(observe([sample({ state: 'error' })])).toEqual([]);
    expect(since()).toBe(T0 + 1);
    vi.advanceTimersByTime(1);
    expect(observe([sample()])).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    observe([sample({ state: 'error' })]);
    notify.mockReturnValue(true);
    vi.advanceTimersByTime(1);
    expect(observe([sample({ state: 'error' })])).toHaveLength(1);
    expect(since()).toBe(T0 + 3);
  });

  it('没有通知出口时只观察；恢复清除时间，不补发恢复', () => {
    tracker.evaluate([sample()]);
    vi.advanceTimersByTime(1);
    tracker.evaluate([sample({ state: 'error' })]);
    expect(since()).toBe(T0 + 1);
    vi.advanceTimersByTime(1);
    expect(observe([sample()])).toEqual([]);
    expect(since()).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('已通知后在关闭期间恢复会清账，重开不补恢复', () => {
    observe([sample()]);
    vi.advanceTimersByTime(1);
    observe([sample({ state: 'error' })]);
    notify.mockReturnValue(false);
    vi.advanceTimersByTime(1);
    expect(observe([sample()])).toEqual([]);
    notify.mockReturnValue(true);
    vi.advanceTimersByTime(1);
    expect(observe([sample()])).toEqual([]);
    expect(since()).toBeNull();
  });

  it.each([
    { source: 'simulated' as const },
    { connection: 'virtual' as const },
    null,
  ])('演示/虚拟/忽略或移除清账，不当成恢复；重新出现建新基线 %j', (excluded) => {
    observe([sample()]);
    vi.advanceTimersByTime(1);
    observe([sample({ state: 'error' })]);
    vi.advanceTimersByTime(1);
    expect(observe(excluded ? [sample(excluded)] : [])).toEqual([]);
    expect(since()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(observe([sample({ state: 'error' })])).toEqual([]);
    expect(since()).toBe(T0 + 3);
    vi.advanceTimersByTime(1);
    expect(observe([sample()])).toEqual([]);
  });

  it('旧样本改状态不确认为新故障或恢复，投影不推进观察且不修改输入', () => {
    const online = sample();
    observe([online]);
    vi.advanceTimersByTime(1);
    const down = sample({ state: 'error' });
    expect(since(down)).toBeNull();
    expect(observe([{ ...online, state: 'error' }])).toEqual([]);
    expect(since()).toBeNull();
    observe([down]);
    vi.advanceTimersByTime(DEFAULT_ALERT_REPEAT_MS);
    expect(since(down)).toBe(T0 + 1);
    expect(since(down)).toBe(T0 + 1);
    expect(down.firstObservedAt).toBeUndefined();
    expect(observe([online])).toEqual([]);
    expect(since()).toBe(T0 + 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('多台打印机独立，新出现异常不影响已监控条目提醒', () => {
    observe([sample()]);
    vi.advanceTimersByTime(1);
    const alerts = observe([sample({ state: 'error' }), sample({ id: 'p2', state: 'error' })]);
    expect(alerts.map((a) => a.printerId)).toEqual(['p1']);
    expect(tracker.project([sample({ id: 'p2' })])[0]?.firstObservedAt).toBe(T0 + 1);
  });
});

describe('打印机系统通知出口（Electron mock）', () => {
  const alert: PrinterAlert = { printerId: 'p1', printerName: '前台', kind: 'fault', state: 'error', reason: '打印机故障', firstObservedAt: T0 };
  beforeEach(() => {
    notification.supported = true;
    notification.create.mockClear();
    notification.show.mockClear();
    notification.on.mockClear();
  });

  it('不支持系统通知时返回false，不构造通知', () => {
    notification.supported = false;
    expect(showPrinterAlert(alert, vi.fn())).toBe(false);
    expect(notification.create).not.toHaveBeenCalled();
    expect(notification.show).not.toHaveBeenCalled();
  });

  it('通知标明本次运行首次发现时间、不是设备故障起点，并绑定点击回调', () => {
    const click = vi.fn();
    expect(showPrinterAlert(alert, click)).toBe(true);
    expect(notification.create).toHaveBeenCalledWith({
      title: '打印机异常：前台', silent: false,
      body: `打印机故障\n本次运行首次发现异常：${new Date(T0).toLocaleString('zh-CN', { hour12: false })}（非真实故障起点）`,
    });
    expect(notification.on).toHaveBeenCalledWith('click', click);
    expect(notification.show).toHaveBeenCalledTimes(1);
    expect(showPrinterAlert({ ...alert, kind: 'recovered', reason: '已恢复正常', state: 'idle' }, click)).toBe(true);
    expect(notification.create.mock.lastCall?.[0]).toMatchObject({ title: '打印机已恢复：前台', silent: true });
  });
});
