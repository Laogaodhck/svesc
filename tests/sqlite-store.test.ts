/**
 * task-018：SQLite 持久化回归锁。
 *
 * 覆盖：设置/别名/告警/首次接入/打印管理 roundtrip、迁移版本管理、
 * 旧版 svesc-state.json 平滑导入、设备状态同步与状态转移日志、
 * first_seen 只减不增、降级内存模式（初始化失败不崩）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/main/engine/db/sqlite';
import { device, T0 } from './fixtures';

const logs: string[] = [];
function makeStore(dir: string): SqliteStore {
  return new SqliteStore(dir, 'svesc-state.db', {
    logger: (level, message) => logs.push(`${level}:${message}`),
  });
}

const freshDir = (): string => mkdtempSync(path.join(tmpdir(), 'svesc-sqlite-'));

describe('SQLite 基础 roundtrip', () => {
  it('设置读写：patch 落库，重开读回', () => {
    const dir = freshDir();
    const store = makeStore(dir);
    store.setSettings({ autoScan: false, autoScanIntervalSec: 120, notifyDesktop: false });
    store.close();

    const reopened = makeStore(dir);
    const s = reopened.settings;
    expect({ autoScan: s.autoScan, interval: s.autoScanIntervalSec, notify: s.notifyDesktop }).toEqual({
      autoScan: false,
      interval: 120,
      notify: false,
    });
    // 未改过的字段保持默认
    expect(s.closeToTray).toBe(true);
    reopened.close();
  });

  it('别名写入/删除 roundtrip；get() 组装完整 PersistedState', () => {
    const dir = freshDir();
    const store = makeStore(dir);
    store.setAlias('dev-192.168.2.52', '财务部-01');
    store.setAlias('prn-192.168.2.213', '前台打印机');
    expect(store.aliasOf('dev-192.168.2.52')).toBe('财务部-01');
    store.setAlias('dev-192.168.2.52', null); // 删除
    expect(store.aliasOf('dev-192.168.2.52')).toBeNull();
    store.close();

    const reopened = makeStore(dir);
    expect(reopened.aliasOf('dev-192.168.2.52')).toBeNull();
    expect(reopened.aliasOf('prn-192.168.2.213')).toBe('前台打印机');
    const state = reopened.get();
    expect(state.aliases).toEqual({ 'prn-192.168.2.213': '前台打印机' });
    reopened.close();
  });

  it('告警历史全量落账 + 单条实时 upsert；重开不丢（trace 保真）', () => {
    const dir = freshDir();
    const store = makeStore(dir);
    const alarm = {
      id: 'alm-x1',
      severity: 'critical' as const,
      code: 'DEVICE_OFFLINE',
      targetType: 'device' as const,
      targetId: 'dev-192.168.2.52',
      targetName: 'test',
      message: '设备离线：test',
      detail: null,
      raisedAt: T0,
      ackAt: T0 + 1,
      ackBy: 'tester',
      resolvedAt: null,
      lastRaisedAt: T0,
      occurrences: 2,
      trace: [{ at: T0, type: 'raised' as const, by: null }],
    };
    store.upsertAlarm(alarm);
    store.setAlarmHistory([{ ...alarm, id: 'alm-x2', occurrences: 1 }], ['aa-bb-cc-00-00-01']);
    store.close();

    const reopened = makeStore(dir);
    const alarms = reopened.get().alarms;
    expect(alarms.map((a) => a.id).sort()).toEqual(['alm-x1', 'alm-x2']);
    const x1 = alarms.find((a) => a.id === 'alm-x1');
    expect({ ackBy: x1?.ackBy, occurrences: x1?.occurrences, trace: x1?.trace }).toEqual({
      ackBy: 'tester',
      occurrences: 2,
      trace: [{ at: T0, type: 'raised', by: null }],
    });
    expect(reopened.get().knownDeviceKeys).toEqual(['aa-bb-cc-00-00-01']);
    reopened.close();
  });

  it('打印管理：手动添加/更新备注/删除/忽略 roundtrip；非法 IP 拒绝', () => {
    const dir = freshDir();
    const store = makeStore(dir);
    expect(store.addManualPrinter('192.168.2.213', 'MF750C')).toEqual({ ok: true, error: null });
    expect(store.addManualPrinter('999.1.2.3', 'x').ok).toBe(false);
    store.addManualPrinter('192.168.2.213', '新备注'); // 同 IP 更新备注
    store.setPrinterIgnored('prn-auto-1', true);
    store.close();

    const reopened = makeStore(dir);
    const cfg = reopened.printerManage();
    expect(cfg.manual).toEqual([{ ip: '192.168.2.213', note: '新备注', addedAt: cfg.manual[0].addedAt }]);
    expect(cfg.ignored).toEqual(['prn-auto-1']);
    reopened.removeManualPrinter('192.168.2.213');
    expect(reopened.printerManage().manual).toEqual([]);
    reopened.close();
  });
});

describe('设备状态同步（task-018）', () => {
  it('upsert + 状态转移日志：首次记录 + 变化各一条；sim- 演示设备不入库', () => {
    const dir = freshDir();
    const store = makeStore(dir);
    const real = device({ id: 'dev-192.168.2.52', ip: '192.168.2.52', state: 'online', firstSeen: T0 });
    const demo = device({ id: 'sim-dev-1', ip: '192.168.2.200', state: 'online', firstSeen: T0 });
    expect(store.upsertDeviceStates([real, demo])).toBe(1); // 1 条"首次记录"，demo 被过滤
    expect(store.upsertDeviceStates([real])).toBe(0); // 状态未变：无转移
    const offline = { ...real, state: 'offline' as const };
    expect(store.upsertDeviceStates([offline])).toBe(1); // online → offline 转移
    store.close();

    const reopened = makeStore(dir);
    const history = reopened.getDeviceStatusHistory('192.168.2.52', 10);
    expect(history.map((h) => h.state)).toEqual(['offline', 'online']); // 时间倒序
    expect(reopened.get().firstSeen['192.168.2.200'], '演示设备绝不能进持久库').toBeUndefined();
    reopened.close();
  });

  it('first_seen 只减不增：扫描时钟的新值不得覆盖持久化的首次接入', () => {
    const dir = freshDir();
    const store = makeStore(dir);
    store.upsertDeviceStates([device({ id: 'dev-1', ip: '192.168.2.52', firstSeen: T0 })]);
    // 重启后扫描时钟重新起算（值更大）：first_seen 必须保留 T0
    store.upsertDeviceStates([device({ id: 'dev-1', ip: '192.168.2.52', firstSeen: T0 + 999_999 })]);
    expect(store.get().firstSeen['192.168.2.52']).toBe(T0);
    store.close();
  });

  it('setFirstSeen 幂等：只补缺，不覆盖已有记录（ON CONFLICT DO NOTHING）', () => {
    const dir = freshDir();
    const store = makeStore(dir);
    store.upsertDeviceStates([device({ id: 'dev-1', ip: '192.168.2.52', firstSeen: T0 })]);
    store.setFirstSeen({ '192.168.2.52': T0 - 5, '192.168.2.99': T0 + 1 });
    const fs1 = store.get().firstSeen;
    expect(fs1['192.168.2.52']).toBe(T0);
    expect(fs1['192.168.2.99']).toBe(T0 + 1);
    store.close();
  });
});

describe('迁移与旧数据升级（task-018）', () => {
  it('新库自动迁移到最新 user_version，重开幂等（不重复执行）', () => {
    const dir = freshDir();
    const store = makeStore(dir);
    expect(store.degraded).toBe(false);
    store.close();
    expect(existsSync(path.join(dir, 'svesc-state.db'))).toBe(true);
    // 重开：迁移已追平，不应有任何报错日志
    logs.length = 0;
    const reopened = makeStore(dir);
    expect(reopened.degraded).toBe(false);
    expect(logs.some((l) => l.startsWith('error'))).toBe(false);
    reopened.close();
  });

  it('旧版 svesc-state.json 平滑导入：数据保真 + 原文件改名 .migrated 保留', () => {
    const dir = freshDir();
    const jsonPath = path.join(dir, 'svesc-state.json');
    writeFileSync(
      jsonPath,
      JSON.stringify({
        version: 1,
        aliases: { 'dev-192.168.2.52': '财务部-01' },
        alarms: [
          {
            id: 'alm-legacy',
            severity: 'warning',
            code: 'SUPPLY_LOW',
            targetType: 'printer',
            targetId: 'prn-1',
            targetName: 'SHARP',
            message: '耗材偏低：SHARP',
            detail: null,
            raisedAt: T0,
            ackAt: null,
            ackBy: null,
            resolvedAt: null,
          },
        ],
        knownDeviceKeys: ['aa-bb-cc-00-00-01'],
        firstSeen: { '192.168.2.52': T0 },
        settings: { autoScan: false, autoScanIntervalSec: 90 },
        printers: { manual: [{ ip: '192.168.2.213', note: null, addedAt: T0 }], ignored: [] },
      }),
      'utf8',
    );
    const store = makeStore(dir);
    const state = store.get();
    expect(state.aliases).toEqual({ 'dev-192.168.2.52': '财务部-01' });
    expect(state.alarms.map((a) => ({ id: a.id, occurrences: a.occurrences }))).toEqual([
      { id: 'alm-legacy', occurrences: 1 }, // 旧数据补形状
    ]);
    expect(state.knownDeviceKeys).toEqual(['aa-bb-cc-00-00-01']);
    expect(state.firstSeen).toEqual({ '192.168.2.52': T0 });
    expect({ autoScan: state.settings.autoScan, interval: state.settings.autoScanIntervalSec }).toEqual({
      autoScan: false,
      interval: 90,
    });
    expect(state.printers.manual).toEqual([{ ip: '192.168.2.213', note: null, addedAt: T0 }]);
    store.close();
    expect(existsSync(`${jsonPath}.migrated`), '旧文件必须改名保留（可回退，不删数据）').toBe(true);
    expect(existsSync(jsonPath)).toBe(false);
  });

  it('迁移中途损坏（伪造高版本库缺表）→ 降级内存模式，读写不抛异常不崩溃', async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    // 伪造 user_version=999 但表不存在：迁移跳过、首查缺表 → 必须降级而不是崩
    const { DatabaseSync } = await import('node:sqlite');
    const fake = new DatabaseSync(path.join(dir, 'svesc-state.db'));
    fake.exec('PRAGMA user_version = 999;');
    fake.close();

    const store = makeStore(dir);
    expect(store.degraded).toBe(true);
    expect(() => store.setAlias('dev-x', '别名')).not.toThrow();
    expect(() => store.get()).not.toThrow();
    expect(() => store.upsertDeviceStates([device({ id: 'dev-1', ip: '192.168.2.52' })])).not.toThrow();
    expect(store.aliasOf('dev-x')).toBe('别名'); // 内存兜底仍可用（本会话内）
    store.close();
  });
});
