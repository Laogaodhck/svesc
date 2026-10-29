/**
 * 打印机异常提醒判定锁（纯逻辑，无 electron/网络）：
 *  - 首次快照只建基线，不把存量故障刷成弹窗；
 *  - 同一问题不重复通知，问题变化受冷却窗口约束；
 *  - 恢复只在"通知过故障"后发出；
 *  - 演示/虚拟打印机不参与，耗材阈值 ≤10% 且来源未知不算数。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALERT_COOLDOWN_MS,
  PrinterAlertTracker,
  printerIssue,
} from '../src/main/engine/printers/alerts';
import { printer, supply } from './fixtures';

const net = (over: Parameters<typeof printer>[0]) => printer({ connection: 'network', source: 'spooler', ...over });

describe('printerIssue 问题判定', () => {
  it('离线/故障/警告 分别给出中文原因，stateDetail 作为补充', () => {
    expect(printerIssue(net({ id: 'p1', name: 'HP', state: 'offline' }))).toBe('设备离线');
    expect(
      printerIssue(net({ id: 'p2', name: 'HP', state: 'error', stateDetail: 'Paper Jam' })),
    ).toBe('打印机故障（Paper Jam）');
    expect(printerIssue(net({ id: 'p3', name: 'HP', state: 'warning' }))).toBe('打印机警告');
  });

  it('耗材 ≤10%（来源非 unknown）才算不足；未知来源不猜', () => {
    expect(
      printerIssue(net({ id: 'p4', name: 'HP', consumables: [supply({ label: 'Black Toner', levelPct: 8 })] })),
    ).toBe('耗材不足：Black Toner 8%');
    expect(
      printerIssue(
        net({ id: 'p5', name: 'HP', consumables: [supply({ label: 'Cyan', levelPct: 5, source: 'unknown' })] }),
      ),
    ).toBeNull();
    expect(
      printerIssue(net({ id: 'p6', name: 'HP', consumables: [supply({ label: 'Yellow', levelPct: 11 })] })),
    ).toBeNull();
  });

  it('演示数据与虚拟打印机一律不提醒', () => {
    expect(printerIssue(printer({ id: 's1', name: 'demo', state: 'offline', source: 'simulated' }))).toBeNull();
    expect(printerIssue(printer({ id: 's2', name: 'PDF', state: 'error', connection: 'virtual' }))).toBeNull();
  });
});

describe('PrinterAlertTracker 状态转移', () => {
  it('首次快照只建基线：存量故障不通知', () => {
    const tracker = new PrinterAlertTracker();
    const offline = net({ id: 'p1', name: 'HP', state: 'offline' });
    expect(tracker.evaluate([offline], 0)).toEqual([]);
    expect(tracker.evaluate([offline], 1000)).toEqual([]);
  });

  it('正常 → 离线 → 恢复：各通知一次，之后不重复', () => {
    const tracker = new PrinterAlertTracker();
    const online = net({ id: 'p1', name: 'HP', state: 'idle', alias: '前台打印机' });
    tracker.evaluate([online], 0);

    const down = tracker.evaluate([{ ...online, state: 'offline' }], 1000);
    expect(down).toEqual([
      { printerId: 'p1', printerName: '前台打印机', kind: 'fault', state: 'offline', reason: '设备离线' },
    ]);
    expect(tracker.evaluate([{ ...online, state: 'offline' }], 2000)).toEqual([]);

    const back = tracker.evaluate([online], 3000);
    expect(back).toEqual([
      { printerId: 'p1', printerName: '前台打印机', kind: 'recovered', state: 'idle', reason: '已恢复正常' },
    ]);
    expect(tracker.evaluate([online], 4000)).toEqual([]);
  });

  it('冷却窗口内问题变化不重复通知；窗口过后新问题再通知', () => {
    const tracker = new PrinterAlertTracker(60_000);
    const online = net({ id: 'p1', name: 'HP', state: 'idle' });
    tracker.evaluate([online], 0);

    expect(tracker.evaluate([{ ...online, state: 'offline' }], 1_000)).toHaveLength(1);
    expect(tracker.evaluate([{ ...online, state: 'warning' }], 2_000), '冷却期内抑制').toEqual([]);
    expect(tracker.evaluate([{ ...online, state: 'error' }], 61_001)).toHaveLength(1);
  });

  it('恢复提醒只在真正通知过故障后发出（启动时已是故障 → 恢复静默）', () => {
    const tracker = new PrinterAlertTracker();
    const offline = net({ id: 'p1', name: 'HP', state: 'offline' });
    tracker.evaluate([offline], 0);
    expect(tracker.evaluate([{ ...offline, state: 'idle' }], 1000)).toEqual([]);
  });

  it('打印机从快照消失后清账本：重新出现且异常时按新基线重新通知', () => {
    const tracker = new PrinterAlertTracker(0);
    const online = net({ id: 'p1', name: 'HP', state: 'idle' });
    tracker.evaluate([online], 0);
    tracker.evaluate([{ ...online, state: 'offline' }], 1000);
    tracker.evaluate([], 2000);
    // 重新出现时基线已清空 → 首次看到即为基线；下一轮才可能产生通知
    expect(tracker.evaluate([{ ...online, state: 'offline' }], 3000)).toEqual([]);
  });

  it('多台打印机互不干扰，只通知发生变化的那台', () => {
    const tracker = new PrinterAlertTracker();
    const a = net({ id: 'a', name: 'A', state: 'idle' });
    const b = net({ id: 'b', name: 'B', state: 'idle' });
    tracker.evaluate([a, b], 0);
    const alerts = tracker.evaluate([a, { ...b, state: 'offline' }], 1000);
    expect(alerts.map((x) => x.printerId)).toEqual(['b']);
    expect(DEFAULT_ALERT_COOLDOWN_MS).toBeGreaterThan(0);
  });
});
