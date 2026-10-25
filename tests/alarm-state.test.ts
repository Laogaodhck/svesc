/**
 * task-015：告警三态判定（alarmStateOf）与 ackBy 持久化回归锁。
 *
 *  1) alarmStateOf 是引擎/渲染层/测试三方共用的唯一判定源，这里锁全部分支与边界；
 *  2) JsonStore roundtrip：ackBy 保真 + 升级前旧形状数据（无 ackBy 字段）读回规整为
 *     null 且记录不丢（旧数据兼容是 plan.md 点名的风险）；
 *  3) AlarmEngine.hydrate 直喂旧告警时的 ackBy 迁移兜底。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { alarmStateOf, ALARM_STATE_LABEL } from '../src/shared/alarm-state';
import type { Alarm } from '../src/shared/types';
import { JsonStore } from '../src/main/engine/store';
import { AlarmEngine } from '../src/main/engine/alarms';
import { device, quality } from './fixtures';

const T0 = 1_700_000_000_000;

function alarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    id: 'alm-x',
    severity: 'warning',
    code: 'NET_QUALITY',
    targetType: 'device',
    targetId: 'dev-192.168.2.5',
    targetName: 'test-host',
    message: '网络质量劣化：test-host',
    detail: null,
    raisedAt: T0,
    ackAt: null,
    ackBy: null,
    resolvedAt: null,
    lastRaisedAt: T0,
    occurrences: 1,
    trace: [],
    ...overrides,
  };
}

describe('alarmStateOf 三态判定（task-015 冻结状态机）', () => {
  it('双 null → pending（需要用户处理）', () => {
    expect(alarmStateOf({ ackAt: null, resolvedAt: null })).toBe('pending');
  });

  it('仅 ackAt → acked（用户已处理，等条件恢复）', () => {
    expect(alarmStateOf({ ackAt: T0 + 1, resolvedAt: null })).toBe('acked');
  });

  it('仅 resolvedAt → cleared（未确认直接恢复也清除）', () => {
    expect(alarmStateOf({ ackAt: null, resolvedAt: T0 + 2 })).toBe('cleared');
  });

  it('两者都有 → cleared 优先（cleared 不可逆，确认过不是复活豁免）', () => {
    expect(alarmStateOf({ ackAt: T0 + 1, resolvedAt: T0 + 2 })).toBe('cleared');
  });

  it('状态标签三态齐全（UI 与引擎共用同一份文案）', () => {
    expect(ALARM_STATE_LABEL).toEqual({ pending: '未确认', acked: '已确认', cleared: '已清除' });
  });
});

describe('ackBy 持久化（JsonStore roundtrip）', () => {
  it('写入 ackBy 后重开 store 读回原值', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-alarm-'));
    const store = new JsonStore(dir);
    store.setAlarmHistory([alarm({ ackAt: T0 + 1, ackBy: 'tester' })], []);
    store.flush();

    const reopened = new JsonStore(dir);
    const kept = reopened.get().alarms;
    expect(kept).toHaveLength(1);
    expect(kept[0].ackAt).toBe(T0 + 1);
    expect(kept[0].ackBy, '确认人必须随告警落盘并读回').toBe('tester');
  });

  it('升级前旧形状落盘数据（无 ackBy 字段）读回规整为 null，记录不丢', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-alarm-legacy-'));
    const store = new JsonStore(dir);
    store.flush();
    // 手写"旧版本"状态文件：告警对象故意没有 ackBy 字段
    const legacy = {
      id: 'alm-legacy',
      severity: 'warning',
      code: 'NET_QUALITY',
      targetType: 'device',
      targetId: 'dev-192.168.2.5',
      targetName: 'test-host',
      message: '网络质量劣化：test-host',
      detail: null,
      raisedAt: T0,
      ackAt: T0 + 1,
      resolvedAt: null,
    };
    writeFileSync(
      store.filePath,
      JSON.stringify({
        version: 1,
        aliases: {},
        alarms: [legacy],
        knownDeviceKeys: [],
        settings: { autoScan: true, autoScanIntervalSec: 60 },
        printers: { manual: [], ignored: [] },
      }),
      'utf8',
    );

    const reopened = new JsonStore(dir);
    const kept = reopened.get().alarms;
    expect(kept, '旧数据不能因缺 ackBy 被校验丢弃').toHaveLength(1);
    expect(kept[0].ackBy).toBeNull();
  });
  it('ackBy 为非 string（数字 123）→ 读回 null（校验器规整），记录不丢', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-alarm-badtype-'));
    const store = new JsonStore(dir);
    store.flush();
    // ackBy 是数字：绕过类型系统手写落盘（真实来源是旧版本/手改文件）
    const bad = {
      id: 'alm-badtype',
      severity: 'warning',
      code: 'NET_QUALITY',
      targetType: 'device',
      targetId: 'dev-192.168.2.5',
      targetName: 'test-host',
      message: '网络质量劣化：test-host',
      detail: null,
      raisedAt: T0,
      ackAt: T0 + 1,
      ackBy: 123,
      resolvedAt: null,
    };
    writeFileSync(
      store.filePath,
      JSON.stringify({
        version: 1,
        aliases: {},
        alarms: [bad],
        knownDeviceKeys: [],
        settings: { autoScan: true, autoScanIntervalSec: 60 },
        printers: { manual: [], ignored: [] },
      }),
      'utf8',
    );

    const reopened = new JsonStore(dir);
    const kept = reopened.get().alarms;
    expect(kept, '类型不对只能规整，不能把整条告警丢掉').toHaveLength(1);
    expect(kept[0].ackBy, '非 string 的 ackBy 必须规整为 null（typeof 校验）').toBeNull();
  });
});

describe('ack 链路与条件恢复流转（Tess 增补）', () => {
  it('不传 ackBy（默认参数）→ ackBy 为 null，不编造确认人', () => {
    const engine = new AlarmEngine(500, 0);
    engine.hydrate({ alarms: [alarm()] });
    const id = engine.all()[0].id;
    expect(engine.ack(id, T0 + 5)).toBe(true);
    const after = engine.all()[0];
    expect(after.ackAt).toBe(T0 + 5);
    expect(after.ackBy, '调用方未提供确认人时必须落 null；"未知用户"是 ipc 层的兜底职责，引擎不得代劳').toBeNull();
  });

  it('DEVICE_NEW 事件型：ack 即 resolvedAt=ackAt → alarmStateOf 落 cleared 且不再计入活跃', () => {
    const engine = new AlarmEngine(500, 0);
    const reach = new Map<string, boolean | null>();
    // 首轮只做种：同一设备出现不产生 DEVICE_NEW
    const seed = engine.evaluate({
      devices: [device({ id: 'dev-seed', ip: '192.168.2.90', mac: 'aa-bb-cc-00-00-90' })],
      printers: [],
      printerReachable: reach,
      now: T0,
    });
    expect(seed.created, '首轮做种不刷屏').toHaveLength(0);

    // 第二轮出现新 MAC → 运行期接入，产生 DEVICE_NEW
    const raised = engine.evaluate({
      devices: [device({ id: 'dev-new', ip: '192.168.2.91', mac: 'aa-bb-cc-00-00-91' })],
      printers: [],
      printerReachable: reach,
      now: T0 + 1000,
    });
    expect(raised.created.map((a) => a.code)).toEqual(['DEVICE_NEW']);
    const newAlarm = raised.created[0];
    expect(alarmStateOf(newAlarm)).toBe('pending');

    // 事件型没有"条件消失"：ack 即收尾（resolvedAt=ackAt），落入 cleared
    expect(engine.ack(newAlarm.id, T0 + 2000, 'tester')).toBe(true);
    const after = engine.all().find((a) => a.id === newAlarm.id)!;
    expect(alarmStateOf(after), 'DEVICE_NEW 的 ack 即 cleared（事件型语义）').toBe('cleared');
    expect({ resolvedAt: after.resolvedAt, ackAt: after.ackAt, ackBy: after.ackBy }).toEqual({
      resolvedAt: T0 + 2000,
      ackAt: T0 + 2000,
      ackBy: 'tester',
    });
    expect(engine.activeAlarms().some((a) => a.id === newAlarm.id), '已收尾的事件型告警必须移出活跃表').toBe(false);
    expect(engine.counts().info, '活跃计数不得再计入它').toBe(0);
  });

  it('条件恢复流转：pending → ack → 条件消失 → cleared，ackAt/ackBy 必须保留（历史可追溯）', () => {
    const engine = new AlarmEngine(500, 0);
    const reach = new Map<string, boolean | null>();
    const poor = (): ReturnType<typeof device> =>
      device({ id: 'dev-q', ip: '192.168.2.44', quality: quality({ grade: 'poor', score: 30, latencyMs: 220 }) });
    const recovered = (): ReturnType<typeof device> =>
      device({ id: 'dev-q', ip: '192.168.2.44', quality: quality({ grade: 'excellent' }) });

    // pending：poor 连续 2 轮触发 NET_QUALITY
    engine.evaluate({ devices: [poor()], printers: [], printerReachable: reach, now: T0 });
    const created = engine.evaluate({
      devices: [poor()],
      printers: [],
      printerReachable: reach,
      now: T0 + 5000,
    }).created;
    const netQuality = created.find((a) => a.code === 'NET_QUALITY');
    expect(netQuality, '前置：必须先造出 NET_QUALITY 告警').toBeDefined();
    expect(alarmStateOf(netQuality!)).toBe('pending');

    // ack → acked
    expect(engine.ack(netQuality!.id, T0 + 6000, 'tester')).toBe(true);
    expect(alarmStateOf(engine.all().find((a) => a.id === netQuality!.id)!)).toBe('acked');

    // 条件消失 → 引擎 resolve 路径收尾 → cleared；ack 记录保留
    const res = engine.evaluate({ devices: [recovered()], printers: [], printerReachable: reach, now: T0 + 7000 });
    expect(res.resolved, '条件消失必须由引擎自动 resolve').toContain(netQuality!.id);
    const after = engine.all().find((a) => a.id === netQuality!.id)!;
    expect(alarmStateOf(after), '确认过的告警在条件恢复后同样落 cleared（cleared 不可逆）').toBe('cleared');
    expect(
      { ackAt: after.ackAt, ackBy: after.ackBy, resolvedAt: after.resolvedAt },
      '清除只写 resolvedAt：ackAt/ackBy 是"谁在何时确认过"的历史，绝不能被清零',
    ).toEqual({ ackAt: T0 + 6000, ackBy: 'tester', resolvedAt: T0 + 7000 });
  });
});

describe('AlarmEngine.hydrate 的 ackBy 迁移', () => {
  it('hydrate 直喂无 ackBy 的旧告警 → 规整为 null（store 校验器之外的路径兜底）', () => {
    const engine = new AlarmEngine(500, 0);
    const legacy = alarm() as unknown as Record<string, unknown>;
    delete legacy.ackBy; // 模拟 task-015 升级前的数据形状
    engine.hydrate({ alarms: [legacy as unknown as Alarm] });
    expect(engine.all()).toHaveLength(1);
    expect(engine.all()[0].ackBy).toBeNull();
    expect(engine.counts().warning).toBe(1);
  });

  it('ack 落账：ackAt 与 ackBy 一起写入', () => {
    const engine = new AlarmEngine(500, 0);
    engine.hydrate({ alarms: [alarm()] });
    const id = engine.all()[0].id;
    expect(engine.ack(id, T0 + 5, 'tester')).toBe(true);
    const after = engine.all()[0];
    expect(after.ackAt).toBe(T0 + 5);
    expect(after.ackBy).toBe('tester');
    // 重复 ack 拒绝（既有契约），ackBy 不被二次改写
    expect(engine.ack(id, T0 + 6, 'someone-else')).toBe(false);
    expect(engine.all()[0].ackBy).toBe('tester');
  });
});

describe('手动清除的状态投影（task-021）', () => {
  it('clear 后 alarmStateOf === cleared（判定只看 resolvedAt!==null，手动清除天然落入）', () => {
    const engine = new AlarmEngine(500, 0);
    engine.hydrate({ alarms: [alarm()] });
    const id = engine.all()[0].id;
    expect(engine.clear(id, 'tester')).toBe(true);
    // 判定源唯一：alarmStateOf 不需要知道"是条件恢复还是用户清除"，resolvedAt!==null 即 cleared
    expect(alarmStateOf(engine.all()[0])).toBe('cleared');
  });
});
