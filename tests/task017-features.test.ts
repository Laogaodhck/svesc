/**
 * task-017 三功能回归锁：
 *  A. 告警抑制窗口（同因 10 分钟内重开合并，不新建不重复推送）
 *  B. 流转账目 trace（raised/acked/resolved/re-raised 全留痕 + 旧数据迁移重建）
 *  C. IP 地址冲突告警（IP_CONFLICT：arpConflicts 门控 + 条件消失自动收尾）
 *  D. 设备首次接入时间持久化（store roundtrip + scheduler 覆盖表）
 *  E. ARP 同 IP 多 MAC 冲突解析（collectArpConflicts 纯函数）
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AlarmEngine, ALARM_CODES } from '../src/main/engine/alarms';
import { collectArpConflicts } from '../src/main/engine/discovery/arp';
import { JsonStore } from '../src/main/engine/store';
import { Scheduler } from '../src/main/engine/scheduler';
import { device, printer, quality, supply, T0 } from './fixtures';
import type { Alarm } from '../src/shared/types';

const noReach = new Map<string, boolean | null>();

function run(
  engine: AlarmEngine,
  devices: ReturnType<typeof device>[],
  printers: ReturnType<typeof printer>[] = [],
  now = T0,
  arpConflicts: { ip: string; macs: string[] }[] | null = null,
): ReturnType<AlarmEngine['evaluate']> {
  return engine.evaluate({ devices, printers, printerReachable: noReach, arpConflicts, now });
}

const offlineDev = (): ReturnType<typeof device> => device({ id: 'dev-1', ip: '192.168.2.52', state: 'offline' });
const onlineDev = (): ReturnType<typeof device> => device({ id: 'dev-1', ip: '192.168.2.52', state: 'online' });

// ———————— A. 抑制窗口 ————————

describe('A. 抑制窗口：合并重开（task-017）', () => {
  it('窗口内重开：已确认过的告警保留 ack 状态（用户已表态过，抖动不再升级打扰）', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [offlineDev()], [], T0);
    const id = engine.all()[0].id;
    engine.ack(id, T0 + 1000, 'tester');
    run(engine, [onlineDev()], [], T0 + 5000);
    const res = run(engine, [offlineDev()], [], T0 + 8000);
    const alarm = engine.all()[0];
    expect(res.reopened).toHaveLength(1);
    expect({
      ackAt: alarm?.ackAt,
      ackBy: alarm?.ackBy,
      resolvedAt: alarm?.resolvedAt,
      occurrences: alarm?.occurrences,
    }).toEqual({ ackAt: T0 + 1000, ackBy: 'tester', resolvedAt: null, occurrences: 2 });
  });

  it('活跃期间同因再触发不合并也不新建（去重语义不变）', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [offlineDev()], [], T0);
    const res = run(engine, [offlineDev()], [], T0 + 5000);
    expect({ created: res.created.length, reopened: res.reopened.length }).toEqual({ created: 0, reopened: 0 });
    expect(engine.all()).toHaveLength(1);
  });

  it('DEVICE_NEW 是事件型：ack/TTL 收尾后同设备再次出现也不重开（无抖动语义）', () => {
    const engine = new AlarmEngine(500, 0);
    const a = device({ id: 'dev-a', ip: '192.168.2.10', mac: 'aa-aa-aa-00-00-0a' });
    const b = device({ id: 'dev-b', ip: '192.168.2.11', mac: 'bb-bb-bb-00-00-0b' });
    run(engine, [a], [], T0); // 做种
    const raised = run(engine, [a, b], [], T0 + 5000);
    const id = raised.created.find((x) => x.code === 'DEVICE_NEW')?.id ?? '';
    engine.ack(id, T0 + 6000);
    // 设备 b 被移除又重新出现（同一 MAC，仍是已知设备 → 不会有新 DEVICE_NEW）
    run(engine, [a], [], T0 + 7000);
    const res = run(engine, [a, b], [], T0 + 9000);
    expect(res.created.filter((x) => x.code === 'DEVICE_NEW')).toEqual([]);
    expect(res.reopened).toEqual([]);
  });

  it('抑制窗口外重触发：新建记录且 recentByKey 指向新记录（再次抖动合并到新的）', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [offlineDev()], [], T0);
    run(engine, [onlineDev()], [], T0 + 5000);
    run(engine, [offlineDev()], [], T0 + 5000 + 600_001); // 窗口外 → 新建
    run(engine, [onlineDev()], [], T0 + 5000 + 600_002);
    const res = run(engine, [offlineDev()], [], T0 + 5000 + 600_003); // 新记录的窗口内 → 合并到新记录
    expect(res.created).toEqual([]);
    expect(res.reopened).toHaveLength(1);
    const alarms = engine.all();
    expect(alarms).toHaveLength(2);
    expect(alarms.map((a) => a.occurrences)).toEqual([2, 1]); // all() 按 raisedAt 倒序：[新(重开1次), 旧(窗口外新建)]
  });
});

// ———————— B. trace 流转账目 ————————

describe('B. 流转账目 trace（task-017 可追溯）', () => {
  it('完整生命周期：raised → acked(by) → resolved → re-raised 顺序留痕', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [offlineDev()], [], T0);
    const id = engine.all()[0].id;
    engine.ack(id, T0 + 1000, 'tester');
    run(engine, [onlineDev()], [], T0 + 5000);
    run(engine, [offlineDev()], [], T0 + 8000);
    const trace = engine.all()[0].trace;
    expect(trace.map((t) => `${t.type}@${t.at}`)).toEqual([
      `raised@${T0}`,
      `acked@${T0 + 1000}`,
      `resolved@${T0 + 5000}`,
      `re-raised@${T0 + 8000}`,
    ]);
    expect(trace[1].by).toBe('tester');
    expect(trace[0].by).toBeNull();
  });

  it('hydrate 迁移：旧数据（无 trace）从既有时间戳重建流转账目', () => {
    const engine = new AlarmEngine(500, 0);
    const legacy = {
      id: 'alm-old',
      severity: 'critical' as const,
      code: 'DEVICE_OFFLINE',
      targetType: 'device' as const,
      targetId: 'dev-old',
      targetName: '旧设备',
      message: '设备离线：旧设备',
      detail: null,
      raisedAt: T0,
      ackAt: T0 + 1000,
      ackBy: 'alice',
      resolvedAt: null,
      // 故意不带 lastRaisedAt / occurrences / trace（task-017 升级前的形状）
    } as unknown as Alarm;
    engine.hydrate({ alarms: [legacy] });
    const alarm = engine.all()[0];
    expect({ lastRaisedAt: alarm.lastRaisedAt, occurrences: alarm.occurrences }).toEqual({
      lastRaisedAt: T0,
      occurrences: 1,
    });
    expect(alarm.trace.map((t) => `${t.type}@${t.at}:${t.by}`)).toEqual([
      `raised@${T0}:null`,
      `acked@${T0 + 1000}:alice`,
    ]);
  });

  it('trace 有界：超过 ALARM_TRACE_MAX 裁最旧，且绝不丢 raised 首条之后仍完整（裁剪按时间序）', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [offlineDev()], [], T0);
    const id = engine.all()[0].id;
    // 反复抖动 60 次（resolved → re-raised 交替），trace 上限 50
    let now = T0 + 1000;
    for (let i = 0; i < 60; i += 1) {
      run(engine, [onlineDev()], [], now);
      run(engine, [offlineDev()], [], now + 1000);
      now += 2000;
    }
    const alarm = engine.all()[0];
    expect(alarm.trace.length).toBeLessThanOrEqual(50);
    expect(alarm.trace[alarm.trace.length - 1].type).toBe('re-raised');
    expect(alarm.occurrences).toBe(61); // 1 次首发 + 60 次重开
  });
});

// ———————— C. IP_CONFLICT ————————

describe('C. IP 地址冲突告警（task-017 侦测联动）', () => {
  it('同 IP 多 MAC → IP_CONFLICT critical（targetId=dev-<ip>）', () => {
    const engine = new AlarmEngine(500, 0);
    const created = run(engine, [onlineDev()], [], T0, [{ ip: '192.168.2.52', macs: ['aa-aa', 'bb-bb'] }]).created;
    const conflict = created.find((a) => a.code === ALARM_CODES.IP_CONFLICT);
    expect(conflict).toBeDefined();
    expect({ severity: conflict?.severity, targetId: conflict?.targetId, targetType: conflict?.targetType }).toEqual({
      severity: 'critical',
      targetId: 'dev-192.168.2.52',
      targetType: 'device',
    });
    expect(conflict?.message).toContain('192.168.2.52');
    expect(conflict?.detail).toContain('2 个 MAC');
  });

  it('下一轮冲突消失（ARP 有效）→ 自动 resolve；ARP 无效（null）→ 不清理不新增', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [onlineDev()], [], T0, [{ ip: '192.168.2.52', macs: ['aa-aa', 'bb-bb'] }]);
    // ARP 读取失败（null）：冲突告警必须挂账，不能因一次解析失败消失
    run(engine, [onlineDev()], [], T0 + 5000, null);
    expect(engine.activeAlarms().some((a) => a.code === 'IP_CONFLICT')).toBe(true);
    // ARP 有效且无冲突：收尾
    const res = run(engine, [onlineDev()], [], T0 + 8000, []);
    expect(res.resolved).toHaveLength(1);
    expect(engine.activeAlarms().filter((a) => a.code === 'IP_CONFLICT')).toEqual([]);
  });

  it('冲突持续期间不重复新建（同因去重）', () => {
    const engine = new AlarmEngine(500, 0);
    const conflicts = [{ ip: '192.168.2.52', macs: ['aa-aa', 'bb-bb'] }];
    run(engine, [onlineDev()], [], T0, conflicts);
    const res = run(engine, [onlineDev()], [], T0 + 5000, conflicts);
    expect({ created: res.created.length, reopened: res.reopened.length }).toEqual({ created: 0, reopened: 0 });
    expect(engine.counts().critical).toBe(1);
  });
});

// ———————— D. firstSeen 持久化 ————————

describe('D. 设备首次接入时间持久化（task-017）', () => {
  it('JsonStore roundtrip：setFirstSeen → 重开读回原值', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-firstseen-'));
    const store = new JsonStore(dir);
    store.setFirstSeen({ '192.168.2.52': T0, '192.168.2.53': T0 + 1 });
    store.flush();

    const reopened = new JsonStore(dir);
    expect(reopened.get().firstSeen).toEqual({ '192.168.2.52': T0, '192.168.2.53': T0 + 1 });
  });

  it('落盘脏数据（非法 IP key / 非法时间戳）读回时丢弃，合法记录保留', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-firstseen-bad-'));
    const store = new JsonStore(dir);
    store.flush();
    writeFileSync(
      store.filePath,
      JSON.stringify({
        version: 1,
        aliases: {},
        alarms: [],
        knownDeviceKeys: [],
        firstSeen: {
          '192.168.2.52': T0, // 合法
          '999.999.999.999': T0, // 非法 IP
          'not-an-ip': T0, // 非法 key
          '192.168.2.53': -1, // 非法时间戳
          '192.168.2.54': 'abc', // 类型不对
        },
        knownDeviceKeys_note: undefined,
        settings: { autoScan: true, autoScanIntervalSec: 60 },
        printers: { manual: [], ignored: [] },
      }),
      'utf8',
    );
    const reopened = new JsonStore(dir);
    expect(reopened.get().firstSeen).toEqual({ '192.168.2.52': T0 });
  });

  it('旧版本状态文件（无 firstSeen 字段）读回为空表，不报错不丢其它数据', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-firstseen-legacy-'));
    const store = new JsonStore(dir);
    store.flush();
    writeFileSync(
      store.filePath,
      JSON.stringify({
        version: 1,
        aliases: { 'dev-192.168.2.1': '网关' },
        alarms: [],
        knownDeviceKeys: [],
        settings: { autoScan: true, autoScanIntervalSec: 60 },
        printers: { manual: [], ignored: [] },
      }),
      'utf8',
    );
    const reopened = new JsonStore(dir);
    expect(reopened.get().firstSeen).toEqual({});
    expect(reopened.get().aliases['dev-192.168.2.1']).toBe('网关');
  });

  it('Scheduler：hydrateFirstSeen 后新建记录用持久值；未覆盖的 IP 用当前时间', () => {
    const scheduler = new Scheduler({
      prefix: '192.168.2.',
      hosts: [],
      selfIp: null,
      gateway: null,
      subnetLabel: '192.168.2.0/24',
      autoScanIntervalSec: 0,
      forceDemo: false,
      snmpEnabled: true,
      useMdns: false,
    });
    scheduler.hydrateFirstSeen({ '192.168.2.52': T0 });
    const inner = scheduler as unknown as {
      ensureRecord: (ip: string, at: number) => { firstSeen: number };
    };
    expect(inner.ensureRecord('192.168.2.52', T0 + 999_999).firstSeen).toBe(T0);
    expect(inner.ensureRecord('192.168.2.99', T0 + 999_999).firstSeen).toBe(T0 + 999_999);
    expect(scheduler.exportFirstSeen()).toEqual({ '192.168.2.52': T0, '192.168.2.99': T0 + 999_999 });
  });

  it('firstSeen 持久化不破坏既有告警持久化契约（同一份状态文件共存）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-firstseen-compat-'));
    const store = new JsonStore(dir);
    store.setFirstSeen({ '192.168.2.1': T0 });
    store.setAlarmHistory([], ['aa-bb-cc-00-00-01']);
    store.flush();
    const reopened = new JsonStore(dir);
    expect(reopened.get().firstSeen).toEqual({ '192.168.2.1': T0 });
    expect(reopened.get().knownDeviceKeys).toEqual(['aa-bb-cc-00-00-01']);
  });
});

// ———————— E. ARP 冲突解析 ————————

describe('E. collectArpConflicts（同 IP 多 MAC 侦测）', () => {
  it('同 IP 两个不同 MAC → 1 条冲突，macs 保序去重', () => {
    const conflicts = collectArpConflicts([
      { ip: '192.168.2.52', mac: 'aa-aa-aa-aa-aa-aa', iface: '以太网' },
      { ip: '192.168.2.52', mac: 'bb-bb-bb-bb-bb-bb', iface: 'WLAN' },
    ]);
    expect(conflicts).toEqual([{ ip: '192.168.2.52', macs: ['aa-aa-aa-aa-aa-aa', 'bb-bb-bb-bb-bb-bb'] }]);
  });

  it('同 IP 同 MAC 重复行（多网卡同条目）不算冲突', () => {
    const conflicts = collectArpConflicts([
      { ip: '192.168.2.1', mac: 'aa-aa-aa-aa-aa-aa', iface: '以太网' },
      { ip: '192.168.2.1', mac: 'aa-aa-aa-aa-aa-aa', iface: 'WLAN' },
    ]);
    expect(conflicts).toEqual([]);
  });

  it('无冲突时返回空数组；不同 IP 各自独立判定', () => {
    const conflicts = collectArpConflicts([
      { ip: '192.168.2.1', mac: 'aa-aa-aa-aa-aa-aa', iface: null },
      { ip: '192.168.2.2', mac: 'bb-bb-bb-bb-bb-bb', iface: null },
    ]);
    expect(conflicts).toEqual([]);
  });
});

// ———————— 既有语义回归：快照/耗材告警在新 raise 路径下不受影响 ————————

describe('task-017 改造后的既有语义抽查', () => {
  it('耗材阈值告警带 trace 且 occurrences=1（新告警形状完整）', () => {
    const engine = new AlarmEngine(500, 0);
    const created = run(
      engine,
      [],
      [printer({ id: 'prn-1', name: 'MF750C', ip: '192.168.2.213', consumables: [supply({ levelPct: 4 })] })],
    ).created;
    const alarm = created.find((a) => a.code === 'SUPPLY_CRITICAL');
    expect(alarm).toBeDefined();
    expect({ occurrences: alarm?.occurrences, trace: alarm?.trace.map((t) => t.type) }).toEqual({
      occurrences: 1,
      trace: ['raised'],
    });
  });

  it('poor 质量告警恢复后 resolve 留痕（evaluate 闭包内 resolve 走 pushTrace）', () => {
    const engine = new AlarmEngine(500, 0);
    const poor = (): ReturnType<typeof device> =>
      device({ id: 'dev-q', ip: '192.168.2.44', quality: quality({ grade: 'poor', score: 30, latencyMs: 220 }) });
    run(engine, [poor()], [], T0);
    run(engine, [poor()], [], T0 + 5000);
    run(engine, [device({ id: 'dev-q', ip: '192.168.2.44', quality: quality({ grade: 'excellent' }) })], [], T0 + 8000);
    const alarm = engine.all().find((a) => a.code === 'NET_QUALITY');
    expect(alarm?.trace.map((t) => t.type)).toEqual(['raised', 'resolved']);
  });
});
