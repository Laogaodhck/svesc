/**
 * 全面审计修复（2026-10-25）的三项回归锁：
 *
 *  1) alarms：被忽略/删除的打印机其活跃告警必须有收尾路径（否则 critical 永久挂账），
 *     且启动早期"空列表 tick"（printersCollected=false）绝不能触发收尾；
 *  2) JsonStore：落盘失败必须经 onWriteError 通报（err）并在恢复后通报（null）；
 *  3) evaluate 入参契约：printersCollected 缺省（旧调用方）行为不变。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AlarmEngine } from '../src/main/engine/alarms';
import { JsonStore } from '../src/main/engine/store';
import { device, printer, supply, T0 } from './fixtures';

const noReach = new Map<string, boolean | null>();

function offlinePrinter(id: string, ip: string) {
  return printer({
    id,
    name: 'Faulty Printer',
    ip,
    connection: 'network',
    state: 'offline',
    stateDetail: '网络探活失败 9100/631/515',
  });
}

describe('审计：消失打印机的活跃告警收尾', () => {
  it('printersCollected=true 且打印机被移除 → PRINTER_OFFLINE 必须收尾', () => {
    const engine = new AlarmEngine(500, 0);
    const p = offlinePrinter('prn-192.168.2.213', '192.168.2.213');
    const reach = new Map<string, boolean | null>([['prn-192.168.2.213', false]]);
    engine.evaluate({ devices: [], printers: [p], printerReachable: reach, now: T0, printersCollected: true });
    expect(engine.activeAlarms().some((a) => a.code === 'PRINTER_OFFLINE')).toBe(true);

    // 下一轮该打印机被忽略（不出现在列表）：活跃告警必须有 resolve 路径
    const res = engine.evaluate({
      devices: [],
      printers: [],
      printerReachable: new Map(),
      now: T0 + 5000,
      printersCollected: true,
    });
    expect(res.resolved.length).toBe(1);
    expect(engine.activeAlarms()).toHaveLength(0);
    expect(engine.all()[0]?.resolvedAt).toBe(T0 + 5000);
  });

  it('printersCollected 缺省/为 false（启动早期空列表 tick）→ 绝不收尾', () => {
    const engine = new AlarmEngine(500, 0);
    const p = offlinePrinter('prn-192.168.2.213', '192.168.2.213');
    const reach = new Map<string, boolean | null>([['prn-192.168.2.213', false]]);
    engine.evaluate({ devices: [], printers: [p], printerReachable: reach, now: T0, printersCollected: true });

    // 带宽 tick：printers=[] 且未声明"已采集"——把告警清掉就是把"还没数据"当"没有设备"
    const tick = engine.evaluate({ devices: [], printers: [], printerReachable: new Map(), now: T0 + 1000 });
    expect(tick.resolved).toHaveLength(0);
    expect(engine.activeAlarms()).toHaveLength(1);

    const tick2 = engine.evaluate({
      devices: [],
      printers: [],
      printerReachable: new Map(),
      now: T0 + 2000,
      printersCollected: false,
    });
    expect(tick2.resolved).toHaveLength(0);
    expect(engine.activeAlarms()).toHaveLength(1);
  });

  it('同轮仍在列表里的打印机告警不受影响（只收尾消失条目）', () => {
    const engine = new AlarmEngine(500, 0);
    const stay = offlinePrinter('prn-10.1.1.20', '10.1.1.20');
    const gone = offlinePrinter('prn-10.1.1.30', '10.1.1.30');
    const reach = new Map<string, boolean | null>([
      ['prn-10.1.1.20', false],
      ['prn-10.1.1.30', false],
    ]);
    engine.evaluate({ devices: [], printers: [stay, gone], printerReachable: reach, now: T0, printersCollected: true });

    engine.evaluate({
      devices: [],
      printers: [stay],
      printerReachable: new Map([['prn-10.1.1.20', false]]),
      now: T0 + 5000,
      printersCollected: true,
    });
    const active = engine.activeAlarms();
    expect(active).toHaveLength(1);
    expect(active[0]?.targetId).toBe('prn-10.1.1.20');
  });
});

describe('审计：JsonStore 落盘失败可感知 + 重试', () => {
  it('写入失败 → onWriteError(Error)；恢复后 → onWriteError(null)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-store-fail-'));
    // 让"状态文件"路径变成一个目录：writeFileSync 必然失败（EISDIR/EPERM，跨平台）
    const filePath = path.join(dir, 'svesc-state.json');
    mkdirSync(filePath);

    const events: Array<Error | null> = [];
    const store = new JsonStore(dir, 'svesc-state.json', 10, (err) => events.push(err));
    store.setAlias('dev-1', '别名');

    // debounce(10ms) 后的落盘失败必须被通报
    await new Promise((r) => setTimeout(r, 80));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toBeInstanceOf(Error);

    // 排除障碍 → 重试定时器（5s）来不及跑，手动 flush 应成功并通报恢复
    rmSync(filePath, { recursive: true });
    store.flush();
    expect(events[events.length - 1]).toBeNull();
    const raw = JSON.parse(readFileSync(store.filePath, 'utf8')) as { aliases?: Record<string, string> };
    expect(raw.aliases?.['dev-1']).toBe('别名');
  });

  it('耗材告警来源 printersCollected 门控不影响既有 SUPPLY 契约', () => {
    const engine = new AlarmEngine(500, 0);
    const low = printer({
      id: 'prn-1',
      name: 'Low Toner',
      ip: '10.1.1.5',
      connection: 'network',
      state: 'idle',
      consumables: [supply({ label: 'Black', levelPct: 4, source: 'snmp' })],
    });
    const res = engine.evaluate({
      devices: [],
      printers: [low],
      printerReachable: noReach,
      now: T0,
      printersCollected: true,
    });
    expect(res.created.map((a) => a.code)).toContain('SUPPLY_CRITICAL');
  });
});
