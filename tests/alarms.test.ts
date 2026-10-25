/**
 * D. 告警引擎（`src/main/engine/alarms.ts`）
 *
 * 断言依据：plan.md §5.1「告警规则同步修订」+ brief-tess §1.D + 队长追加的 DEVICE_NEW 新规格。
 * 全部用注入的 devices/printers 驱动，不启动扫描、不碰网络。
 */
import { describe, expect, it, vi } from 'vitest';
import { AlarmEngine, dedupeKey } from '../src/main/engine/alarms';
import { computeQuality } from '../src/main/engine/network/quality';
import { device, printer, quality, supply, T0 } from './fixtures';

const noReach = new Map<string, boolean | null>();

function run(
  engine: AlarmEngine,
  devices: ReturnType<typeof device>[],
  printers: ReturnType<typeof printer>[] = [],
  now = T0,
  reach: Map<string, boolean | null> = noReach,
): ReturnType<AlarmEngine['evaluate']> {
  return engine.evaluate({ devices, printers, printerReachable: reach, now });
}

describe('D. 去重键', () => {
  it('dedupeKey 应为 `${code}:${targetId}`', () => {
    expect(dedupeKey('DEVICE_OFFLINE', 'dev-192.168.2.52')).toBe('DEVICE_OFFLINE:dev-192.168.2.52');
  });
});

describe('D. 设备离线', () => {
  it('同一设备连续两轮离线只应产生 1 条 DEVICE_OFFLINE（同因去重）', () => {
    const engine = new AlarmEngine(500, 0);
    const dev = device({ id: 'dev-1', ip: '192.168.2.52', state: 'offline' });
    const first = run(engine, [dev], [], T0);
    const second = run(engine, [dev], [], T0 + 5000);
    expect({ firstCreated: first.created.length, secondCreated: second.created.length }).toEqual({
      firstCreated: 1,
      secondCreated: 0,
    });
  });

  it('设备恢复后原告警应置 resolvedAt 并计入 resolved', () => {
    const engine = new AlarmEngine(500, 0);
    const offline = device({ id: 'dev-1', ip: '192.168.2.52', state: 'offline' });
    const online = device({ id: 'dev-1', ip: '192.168.2.52', state: 'online' });
    run(engine, [offline], [], T0);
    const res = run(engine, [online], [], T0 + 5000);
    const alarm = engine.all()[0];
    expect({ resolvedCount: res.resolved.length, resolvedAt: alarm?.resolvedAt }).toEqual({
      resolvedCount: 1,
      resolvedAt: T0 + 5000,
    });
  });

  it('恢复后抑制窗口内（<10min）再次离线：合并重开原记录（occurrences+1 / trace 记 re-raised），不新建', () => {
    const engine = new AlarmEngine(500, 0);
    const offline = device({ id: 'dev-1', ip: '192.168.2.52', state: 'offline' });
    const online = device({ id: 'dev-1', ip: '192.168.2.52', state: 'online' });
    run(engine, [offline], [], T0);
    run(engine, [online], [], T0 + 5000);
    const res = run(engine, [offline], [], T0 + 10000);
    expect(res.created, '窗口内重开不算新告警（不重复推送）').toEqual([]);
    expect(res.reopened.map((a) => a.code)).toEqual(['DEVICE_OFFLINE']);
    const alarm = engine.all()[0];
    expect({
      total: engine.all().length,
      occurrences: alarm?.occurrences,
      resolvedAt: alarm?.resolvedAt,
      lastRaisedAt: alarm?.lastRaisedAt,
      traceTypes: alarm?.trace.map((t) => t.type),
    }).toEqual({
      total: 1,
      occurrences: 2,
      resolvedAt: null,
      lastRaisedAt: T0 + 10000,
      traceTypes: ['raised', 'resolved', 're-raised'],
    });
  });

  it('恢复后抑制窗口外（≥10min）再次离线：照常新建（历史事实不吞）', () => {
    const engine = new AlarmEngine(500, 0);
    const offline = device({ id: 'dev-1', ip: '192.168.2.52', state: 'offline' });
    const online = device({ id: 'dev-1', ip: '192.168.2.52', state: 'online' });
    run(engine, [offline], [], T0);
    run(engine, [online], [], T0 + 5000);
    const res = run(engine, [offline], [], T0 + 5000 + 600_001);
    expect(res.created.map((a) => a.code)).toEqual(['DEVICE_OFFLINE']);
    expect(res.reopened).toEqual([]);
    expect(engine.all()).toHaveLength(2);
  });

  it('本机（isSelf）离线不应产生告警（自己永远在线，属采集异常）', () => {
    const engine = new AlarmEngine(500, 0);
    const self = device({ id: 'dev-self', ip: '192.168.2.179', state: 'offline', isSelf: true });
    expect(run(engine, [self]).created).toHaveLength(0);
  });
});

describe('D. 耗材阈值', () => {
  const withSupply = (levelPct: number | null): ReturnType<typeof printer> =>
    printer({ id: 'prn-1', name: 'MF750C', ip: '192.168.2.213', consumables: [supply({ levelPct })] });

  it('耗材 10%（阈值边界）应产生 SUPPLY_LOW（warning）', () => {
    const engine = new AlarmEngine(500, 0);
    const created = run(engine, [], [withSupply(10)]).created;
    expect(
      created.map((a) => `${a.code}/${a.severity}`),
      'brief-max1 §alarms：耗材 ≤10% → warning SUPPLY_LOW（Tess 任务书里的"12%"与 brief-max1 冲突，以 brief-max1 + constants.ALARM_THRESHOLDS 为准）',
    ).toEqual(['SUPPLY_LOW/warning']);
  });

  it('耗材 12% 不应告警（阈值是 10%，不是 15%）', () => {
    const engine = new AlarmEngine(500, 0);
    const created = run(engine, [], [withSupply(12)]).created.filter((a) => a.code.startsWith('SUPPLY'));
    expect(created, '12% 仍高于告警阈值；若此处产生告警说明阈值被改成了 >12%').toEqual([]);
  });

  it('耗材 8% 应产生 SUPPLY_LOW（warning）', () => {
    const engine = new AlarmEngine(500, 0);
    expect(run(engine, [], [withSupply(8)]).created.map((a) => a.code)).toEqual(['SUPPLY_LOW']);
  });

  it('耗材 4% 应升级为 SUPPLY_CRITICAL（critical）', () => {
    const engine = new AlarmEngine(500, 0);
    const created = run(engine, [], [withSupply(4)]).created;
    expect(created.map((a) => `${a.code}/${a.severity}`)).toEqual(['SUPPLY_CRITICAL/critical']);
  });

  it('耗材 levelPct=null 时不得产生任何耗材告警（不报告 ≠ 耗尽）', () => {
    const engine = new AlarmEngine(500, 0);
    const created = run(engine, [], [withSupply(null)]).created.filter((a) => a.code.startsWith('SUPPLY'));
    expect(created, 'Xerox 的 13 条 null 耗材就是这种场景').toEqual([]);
  });

  it('同一打印机连续两轮 4% 只应产生 1 条 SUPPLY_CRITICAL', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [], [withSupply(4)], T0);
    const second = run(engine, [], [withSupply(4)], T0 + 15000);
    expect(second.created).toHaveLength(0);
  });
});

describe('D. 打印机离线 / 故障', () => {
  it('spooler 报 Normal 但 TCP 探活不可达时应产生 PRINTER_OFFLINE critical（.213 场景）', () => {
    const engine = new AlarmEngine(500, 0);
    const p = printer({
      id: 'prn-192.168.2.213',
      name: 'MF750C Series',
      ip: '192.168.2.213',
      state: 'idle',
      stateDetail: 'spooler=Normal · win32=Idle',
    });
    const created = run(engine, [], [p], T0, new Map([['prn-192.168.2.213', false]])).created;
    expect(created.map((a) => `${a.code}/${a.severity}`)).toEqual(['PRINTER_OFFLINE/critical']);
  });

  it('ip 为 null 时即使 reachable=false 也不得产生 PRINTER_OFFLINE（不猜）', () => {
    const engine = new AlarmEngine(500, 0);
    const p = printer({ id: 'prn-wsd', name: 'Canon G3030 series', ip: null });
    const created = run(engine, [], [p], T0, new Map([['prn-wsd', false]])).created;
    expect(created.filter((a) => a.code === 'PRINTER_OFFLINE')).toEqual([]);
  });

  it('打印机 state=error 应产生 PRINTER_ERROR critical', () => {
    const engine = new AlarmEngine(500, 0);
    const p = printer({ id: 'prn-2', name: 'SHARP MX-B4621R', ip: '192.168.2.170', state: 'error' });
    expect(run(engine, [], [p]).created.map((a) => a.code)).toEqual(['PRINTER_ERROR']);
  });
});

describe('D. 网络质量（poor 连续 2 轮）', () => {
  const poor = (): ReturnType<typeof device> =>
    device({ id: 'dev-q', ip: '192.168.2.44', quality: quality({ grade: 'poor', score: 30, latencyMs: 220 }) });

  it('poor 仅 1 轮时不得告警（避免单次抖动刷屏）', () => {
    const engine = new AlarmEngine(500, 0);
    expect(run(engine, [poor()], [], T0).created.filter((a) => a.code === 'NET_QUALITY')).toEqual([]);
  });

  it('poor 连续 2 轮应产生 1 条 NET_QUALITY warning', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [poor()], [], T0);
    const created = run(engine, [poor()], [], T0 + 5000).created;
    expect(created.map((a) => `${a.code}/${a.severity}`)).toEqual(['NET_QUALITY/warning']);
  });

  it('samples<8 且 score<50 时不得产生 NET_QUALITY（跨模块：grade 置信门与告警门同源）', () => {
    const engine = new AlarmEngine(500, 0);
    // 用真实公式算出的质量：4 个样本、400ms、全丢包 → score 0；置信门应把它判成 unknown
    const q = computeQuality({ latencyMs: 400, jitterMs: 0, packetLossPct: 100, samples: 4 });
    const dev = device({ id: 'dev-q4', ip: '192.168.2.45', quality: q });
    run(engine, [dev], [], T0);
    const created = run(engine, [dev], [], T0 + 5000).created;
    expect(
      created.filter((a) => a.code === 'NET_QUALITY'),
      `实得 quality=${JSON.stringify(q)}；单批次就能报"网络劣化"等于把闪变放进告警历史`,
    ).toEqual([]);
  });

  it('同一链路在 samples=8 时应产生 NET_QUALITY（对照：证明上一条不是永久关闭）', () => {
    const engine = new AlarmEngine(500, 0);
    const q = computeQuality({ latencyMs: 400, jitterMs: 0, packetLossPct: 100, samples: 8 });
    const dev = device({ id: 'dev-q8', ip: '192.168.2.46', quality: q });
    run(engine, [dev], [], T0);
    const created = run(engine, [dev], [], T0 + 5000).created;
    expect(created.map((a) => `${a.code}/${a.severity}`), `实得 quality=${JSON.stringify(q)}`).toEqual([
      'NET_QUALITY/warning',
    ]);
  });
});

describe('D. 历史上限与严重级计数', () => {
  const bulkOffline = (n: number): ReturnType<typeof device>[] =>
    Array.from({ length: n }, (_, i) => {
      const hi = Math.floor(i / 256);
      const lo = i % 256;
      return device({
        id: `dev-${i}`,
        ip: `192.168.${hi}.${lo}`,
        mac: `aa-bb-cc-${hi.toString(16).padStart(2, '0')}-${lo.toString(16).padStart(2, '0')}-ff`,
        state: 'offline',
      });
    });

  function overflowEngine(): AlarmEngine {
    const engine = new AlarmEngine(500, 0);
    const offline = bulkOffline(520);
    run(engine, offline, [], T0);
    // 全部恢复 → 520 条历史，全部非活跃，触发裁剪
    run(
      engine,
      offline.map((d) => ({ ...d, state: 'online' as const })),
      [],
      T0 + 5000,
    );
    return engine;
  }

  it('历史超过 500 条时应裁剪到 500 条', () => {
    expect(overflowEngine().all()).toHaveLength(500);
  });

  it('裁剪应丢弃最旧的告警', () => {
    const alarms = overflowEngine().all();
    expect(alarms.some((a) => a.targetId === 'dev-0'), '最早产生的 dev-0 告警应被裁掉').toBe(false);
  });

  it('裁剪应保留最新的告警', () => {
    const alarms = overflowEngine().all();
    expect(alarms.some((a) => a.targetId === 'dev-519'), '最后产生的 dev-519 告警必须保留').toBe(true);
  });

  it('alarmCounts 应与实际活跃告警逐级一致', () => {
    const engine = new AlarmEngine(500, 0);
    run(
      engine,
      [device({ id: 'dev-off', ip: '192.168.2.52', state: 'offline' })],
      [printer({ id: 'prn-low', name: 'SHARP', ip: '192.168.2.170', consumables: [supply({ levelPct: 8 })] })],
    );
    const active = engine.activeAlarms();
    const derived = {
      critical: active.filter((a) => a.severity === 'critical').length,
      warning: active.filter((a) => a.severity === 'warning').length,
      info: active.filter((a) => a.severity === 'info').length,
    };
    expect(engine.counts(), `活跃告警：${active.map((a) => a.code).join(',')}`).toEqual(derived);
  });

  it('ack 未确认的活跃告警应返回 true 并写入 ackAt', () => {
    const engine = new AlarmEngine(500, 0);
    const created = run(engine, [device({ id: 'dev-off', ip: '192.168.2.52', state: 'offline' })], [], T0).created;
    const id = created[0]?.id ?? '';
    expect({ ok: engine.ack(id, T0 + 1000), ackAt: engine.all()[0]?.ackAt }).toEqual({
      ok: true,
      ackAt: T0 + 1000,
    });
  });
});

/**
 * ack 的"DEVICE_NEW 即收尾"是**特例**，不得外溢到普通告警。
 * 若有人为了"让 ack 更彻底"把这段逻辑泛化到所有 code，离线/耗材告警会被 ack 直接吞掉：
 * 故障还在、列表却空了 —— 运维最忌讳的假恢复。
 */
describe('D. ack 特例不得外溢（只有 DEVICE_NEW 才 ack 即收尾）', () => {
  const offlineOnly = () => [device({ id: 'dev-off', ip: '192.168.2.52', state: 'offline' as const })];

  it('DEVICE_OFFLINE 被 ack 后：只写 ackAt，不得置 resolvedAt，也不得移出 active', () => {
    const engine = new AlarmEngine(500, 0);
    const id = run(engine, offlineOnly(), [], T0).created[0]?.id ?? '';
    engine.ack(id, T0 + 1000);
    expect({
      ackAt: engine.all()[0]?.ackAt,
      resolvedAt: engine.all()[0]?.resolvedAt,
      stillActive: engine.activeAlarms().some((a) => a.id === id),
    }).toEqual({ ackAt: T0 + 1000, resolvedAt: null, stillActive: true });
  });

  it('DEVICE_OFFLINE 被 ack 后仍计入 counts().critical（故障未消失前列表不许空）', () => {
    const engine = new AlarmEngine(500, 0);
    const id = run(engine, offlineOnly(), [], T0).created[0]?.id ?? '';
    engine.ack(id, T0 + 1000);
    expect(engine.counts(), '设备仍然离线，critical 必须还是 1').toEqual({
      critical: 1,
      warning: 0,
      info: 0,
    });
  });

  it('ack 不得阻断恢复路径：设备恢复 online 后仍应写 resolvedAt，且保留 ackAt 痕迹', () => {
    const engine = new AlarmEngine(500, 0);
    const id = run(engine, offlineOnly(), [], T0).created[0]?.id ?? '';
    engine.ack(id, T0 + 1000);
    run(engine, [device({ id: 'dev-off', ip: '192.168.2.52', state: 'online' })], [], T0 + 5000);
    const alarm = engine.all().find((a) => a.id === id);
    expect({ resolvedAt: alarm?.resolvedAt, ackAt: alarm?.ackAt }).toEqual({
      resolvedAt: T0 + 5000,
      ackAt: T0 + 1000,
    });
  });

  it('SUPPLY_LOW 被 ack 后同样必须留在 active（特例不得外溢到第二类告警）', () => {
    const engine = new AlarmEngine(500, 0);
    const id =
      run(
        engine,
        [],
        [printer({ id: 'prn-low', name: 'SHARP', ip: '192.168.2.170', consumables: [supply({ levelPct: 8 })] })],
        T0,
      ).created[0]?.id ?? '';
    engine.ack(id, T0 + 1000);
    expect({
      code: engine.all()[0]?.code,
      resolvedAt: engine.all()[0]?.resolvedAt,
      stillActive: engine.activeAlarms().some((a) => a.id === id),
    }).toEqual({ code: 'SUPPLY_LOW', resolvedAt: null, stillActive: true });
  });

  it('对照组：DEVICE_NEW 被 ack 后必须立即 resolved 并移出 active（特例本身不得消失）', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [device({ id: 'dev-a', ip: '192.168.2.10', mac: 'aa-aa-aa-00-00-0a' })], [], T0);
    const created = run(
      engine,
      [
        device({ id: 'dev-a', ip: '192.168.2.10', mac: 'aa-aa-aa-00-00-0a' }),
        device({ id: 'dev-b', ip: '192.168.2.11', mac: 'bb-bb-bb-00-00-0b' }),
      ],
      [],
      T0 + 3000,
    ).created;
    const id = created.find((a) => a.code === 'DEVICE_NEW')?.id ?? '';
    engine.ack(id, T0 + 4000);
    const alarm = engine.all().find((a) => a.id === id);
    expect({
      resolvedAt: alarm?.resolvedAt,
      stillActive: engine.activeAlarms().some((a) => a.id === id),
    }).toEqual({ resolvedAt: T0 + 4000, stillActive: false });
  });
});

/**
 * 上游新规格（队长 2026-10-25 追加）：DEVICE_NEW 是"运行期接入新设备"的事件，
 * 产生后必须保持 active 直到 ack 或 TTL 10 分钟 —— 不允许下一轮同毫秒批量 resolvedAt。
 */
describe('D. DEVICE_NEW 语义（上游新规格）', () => {
  const devA = (): ReturnType<typeof device> => device({ id: 'dev-a', ip: '192.168.2.10', mac: 'aa-aa-aa-00-00-0a' });
  const devB = (): ReturnType<typeof device> => device({ id: 'dev-b', ip: '192.168.2.11', mac: 'bb-bb-bb-00-00-0b' });

  it('首轮 seed 不得产生 DEVICE_NEW（否则每次启动刷十几条 info 噪音）', () => {
    const engine = new AlarmEngine(500, 0);
    const created = run(engine, [devA(), devB()], [], T0).created;
    expect(created.filter((a) => a.code === 'DEVICE_NEW')).toEqual([]);
  });

  it('第二轮起出现的新 MAC 应产生 1 条 DEVICE_NEW（已种子的设备不重复）', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [devA()], [], T0);
    const devC = device({ id: 'dev-c', ip: '192.168.2.12', mac: 'cc-cc-cc-00-00-0c' });
    const created = run(engine, [devA(), devC], [], T0 + 5000).created;
    expect(created.map((a) => `${a.code}:${a.targetId}`)).toEqual(['DEVICE_NEW:dev-c']);
  });

  it('DEVICE_NEW 产生后的下一轮不得自动恢复（须保持 active 直到 ack 或 TTL）', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [devA()], [], T0);
    run(engine, [devA(), devB()], [], T0 + 5000);
    run(engine, [devA(), devB()], [], T0 + 10000);
    const alarm = engine.all().find((a) => a.code === 'DEVICE_NEW' && a.targetId === 'dev-b');
    expect(
      alarm?.resolvedAt,
      '新规格：DEVICE_NEW 不得在下一轮被同毫秒 resolvedAt（events 型告警也要能被用户看到）',
    ).toBeNull();
  });

  it('DEVICE_NEW 产生后 alarmCounts.info 应为 1（不得出现 19 条 info 全 resolved 却 info=0）', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [devA()], [], T0);
    run(engine, [devA(), devB()], [], T0 + 5000);
    run(engine, [devA(), devB()], [], T0 + 10000);
    expect(engine.counts().info, `活跃告警：${engine.activeAlarms().map((a) => a.code).join(',')}`).toBe(1);
  });

  it('DEVICE_NEW 被 ack 后应立即收尾（ack 是除 TTL 外的唯一出口）', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [devA()], [], T0);
    const created = run(engine, [devA(), devB()], [], T0 + 5000).created;
    const id = created.find((a) => a.code === 'DEVICE_NEW')?.id ?? '';
    engine.ack(id, T0 + 6000);
    expect({ info: engine.counts().info, resolvedAt: engine.all().find((a) => a.id === id)?.resolvedAt }).toEqual({
      info: 0,
      resolvedAt: T0 + 6000,
    });
  });

  it('DEVICE_NEW 满 TTL 10 分钟后应自动收尾（不得无限挂 info）', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [devA()], [], T0);
    run(engine, [devA(), devB()], [], T0 + 5000);
    run(engine, [devA(), devB()], [], T0 + 5000 + 600_001);
    const alarm = engine.all().find((a) => a.code === 'DEVICE_NEW' && a.targetId === 'dev-b');
    expect(alarm?.resolvedAt, 'TTL 到期必须收尾，否则 info 会永久占位').toBe(T0 + 5000 + 600_000);
  });

  it('devices 为空的一轮不得消耗首轮 seed（启动时带宽 tick 会先调一次 evaluate）', () => {
    const engine = new AlarmEngine(500, 0);
    run(engine, [], [], T0); // 2s 带宽 tick：devices 还没扫出来
    const created = run(engine, [devA(), devB()], [], T0 + 2000).created;
    expect(
      created.filter((a) => a.code === 'DEVICE_NEW'),
      '若空列表就置 seeded=true，扫描完成后整表设备会被误判成"新接入"（线上 19 条 info 的真正根因）',
    ).toEqual([]);
  });

  it('hydrate 恢复的已知设备不得再产生 DEVICE_NEW（重启不刷屏）', () => {
    const engine = new AlarmEngine(500, 0);
    engine.hydrate({ knownDeviceKeys: [devA().mac as string, devB().mac as string] });
    expect(run(engine, [devA(), devB()], [], T0).created.filter((a) => a.code === 'DEVICE_NEW')).toEqual([]);
  });

  it('hydrate 应丢弃旧版"同毫秒已恢复"的 DEVICE_NEW 垃圾记录', () => {
    const engine = new AlarmEngine(500, 0);
    const legacy = {
      id: 'alm-legacy',
      severity: 'info' as const,
      code: 'DEVICE_NEW',
      targetType: 'device' as const,
      targetId: 'dev-old',
      targetName: '旧设备',
      message: '新设备接入：旧设备',
      detail: null,
      raisedAt: T0,
      ackAt: null,
      ackBy: null,
      resolvedAt: T0, // 旧版 hydrate 的产物：与 raisedAt 同一毫秒
      lastRaisedAt: T0,
      occurrences: 1,
      trace: [],
    };
    engine.hydrate({ alarms: [legacy] });
    expect(engine.all(), '这类记录在 UI 上永远显示"已恢复"，无信息量').toEqual([]);
  });

  it('hydrate 应让未 ack 未超 TTL 的 DEVICE_NEW 继续 active（重启不丢事件）', () => {
    const engine = new AlarmEngine(500, 0);
    const raisedAt = Date.now() - 5 * 60_000;
    engine.hydrate({
      alarms: [
        {
          id: 'alm-fresh',
          severity: 'info',
          code: 'DEVICE_NEW',
          targetType: 'device',
          targetId: 'dev-fresh',
          targetName: '新设备',
          message: '新设备接入：新设备',
          detail: null,
          raisedAt,
          ackAt: null,
          ackBy: null,
          resolvedAt: null,
          lastRaisedAt: raisedAt,
          occurrences: 1,
          trace: [],
        },
      ],
    });
    expect(engine.counts().info).toBe(1);
  });
});

/**
 * task-021 F1：用户手动清除（语义 A）与冷静期。
 *
 * 冷静期是"清了又弹"缺陷的防线，必须证明三件事：
 *  1. 窗口内（10 分钟）同因再触发**完全静默**——不新建、不重开、不推送；
 *  2. 拦截必须发生在抑制窗口判定**之前**——否则"合并重开"会把刚清掉的记录拉回来；
 *  3. 窗口过后条件仍满足 → 产生**全新告警**（新 id、独立 trace），不复活旧记录，
 *     不丢"问题还在要提醒"的诚实性。
 *
 * 测试难点：clear() 内部用真实 Date.now()，而 evaluate 的 now 由测试注入——
 * 用假时钟（vi.setSystemTime）钉住 clear 时刻，使两条时间轴同轴可比。
 */
describe('D. 手动清除与冷静期（task-021 F1）', () => {
  const offlineOnly = () => [device({ id: 'dev-off', ip: '192.168.2.52', state: 'offline' as const })];
  const offline = () => [device({ id: 'dev-off', ip: '192.168.2.52', state: 'offline' as const })];
  const online = () => [device({ id: 'dev-off', ip: '192.168.2.52', state: 'online' as const })];

  /** 在假时钟 at 上执行 clear（钉住 clear 内部的 Date.now()，与 evaluate 的注入 now 同轴） */
  function clearAt(engine: AlarmEngine, id: string, at: number, by = 'tester'): boolean {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at);
      return engine.clear(id, by);
    } finally {
      vi.useRealTimers();
    }
  }

  it('clear：置 resolvedAt、trace 记 cleared-by-user（含操作人）、移出 active、返回 true', () => {
    const engine = new AlarmEngine(500, 0);
    const id = run(engine, offlineOnly(), [], T0).created[0]?.id ?? '';
    expect(clearAt(engine, id, T0 + 1000)).toBe(true);
    const alarm = engine.all().find((a) => a.id === id)!;
    expect({
      resolvedAt: alarm.resolvedAt,
      clearedTrace: alarm.trace.find((t) => t.type === 'cleared-by-user'),
      activeLeft: engine.activeAlarms().length,
      critical: engine.counts().critical,
    }).toEqual({
      resolvedAt: T0 + 1000,
      clearedTrace: { at: T0 + 1000, type: 'cleared-by-user', by: 'tester' },
      activeLeft: 0,
      critical: 0,
    });
  });

  it('clear 防御：重复 clear / 不存在的 id / 已自动 cleared 的都返回 false，且重复 clear 不追加 trace', () => {
    const engine = new AlarmEngine(500, 0);
    const offlineDev = device({ id: 'dev-a', ip: '192.168.2.60', state: 'offline' });
    const onlineDev = device({ id: 'dev-a', ip: '192.168.2.60', state: 'online' });
    run(engine, [offlineDev], [], T0);
    run(engine, [onlineDev], [], T0 + 5000); // 条件恢复 → 自动 cleared
    const autoCleared = engine.all().find((a) => a.targetId === 'dev-a')!;
    expect(autoCleared.resolvedAt).not.toBeNull();
    expect(engine.clear(autoCleared.id, 'tester'), '已 cleared（自动恢复）的记录不得再 clear').toBe(false);
    expect(engine.clear('alm-no-such', 'tester'), '不存在的 id 不得凭空成功').toBe(false);

    // 活跃告警：clear 成功后重复 clear 必须 false 且不得追加 trace
    const res = run(engine, [offlineDev], [], T0 + 700_000); // 抑制窗口外，重新产生
    const id = res.created[0]?.id ?? '';
    expect(clearAt(engine, id, T0 + 700_500)).toBe(true);
    const traceLen = engine.all().find((a) => a.id === id)?.trace.length ?? 0;
    expect(engine.clear(id, 'someone-else'), '重复 clear 必须 false').toBe(false);
    expect(engine.all().find((a) => a.id === id)?.trace.length, '重复 clear 不得追加 trace').toBe(traceLen);
  });

  it('clearMany：混合成功/失败返回成功数；全失败返回 0', () => {
    const engine = new AlarmEngine(500, 0);
    run(
      engine,
      [
        device({ id: 'dev-x', ip: '192.168.2.70', state: 'offline' }),
        device({ id: 'dev-y', ip: '192.168.2.71', state: 'offline' }),
      ],
      [],
      T0,
    );
    const ids = engine.all().map((a) => a.id);
    expect(ids).toHaveLength(2);
    expect(engine.clearMany([ids[0], ids[1], 'alm-ghost'], 'tester'), '2 条成功 + 1 条不存在 → 返回 2').toBe(2);
    expect(engine.clearMany(ids, 'tester'), '第二次全失败（都已 cleared）→ 返回 0').toBe(0);
  });

  it('冷静期窗口内（<10min）：手动清除后条件仍满足 → evaluate 完全静默（不新建/不重开/occurrences 不变）', () => {
    const engine = new AlarmEngine(500, 0);
    const id = run(engine, offlineOnly(), [], T0).created[0]?.id ?? '';
    expect(clearAt(engine, id, T0 + 1000)).toBe(true);

    const res = run(engine, offline(), [], T0 + 6000); // 条件仍满足，距清除仅 5s
    expect(
      { created: res.created, reopened: res.reopened, resolved: res.resolved },
      '冷静期内必须完全静默——"清了又弹"是最差体验',
    ).toEqual({ created: [], reopened: [], resolved: [] });

    const alarm = engine.all().find((a) => a.id === id)!;
    expect({
      total: engine.all().length,
      occurrences: alarm.occurrences,
      resolvedAt: alarm.resolvedAt,
      traceTypes: alarm.trace.map((t) => t.type),
      activeLeft: engine.activeAlarms().length,
    }).toEqual({
      total: 1,
      occurrences: 1,
      resolvedAt: T0 + 1000,
      traceTypes: ['raised', 'cleared-by-user'], // 无 re-raised：不得走抑制窗口合并重开
      activeLeft: 0,
    });
  });

  it('冷静期先于抑制窗口：清除后窗口内条件消失又复现，不得走"合并重开"把刚清掉的记录拉回来', () => {
    const engine = new AlarmEngine(500, 0);
    const id = run(engine, offlineOnly(), [], T0).created[0]?.id ?? '';
    expect(clearAt(engine, id, T0 + 1000)).toBe(true);

    run(engine, online(), [], T0 + 2000); // 条件消失（active 已空，resolve 无副作用）
    const res = run(engine, offline(), [], T0 + 3000); // 条件复现，仍在窗口内

    expect({ created: res.created, reopened: res.reopened }).toEqual({ created: [], reopened: [] });
    const alarm = engine.all().find((a) => a.id === id)!;
    expect(alarm.resolvedAt, '旧记录不得被合并重开拉回（resolvedAt 必须保持清除时刻）').toBe(T0 + 1000);
    expect(alarm.occurrences, '重开合并会 occurrences+1，静默路径不得碰它').toBe(1);
    expect(alarm.trace.map((t) => t.type), 'trace 不得出现 re-raised').toEqual(['raised', 'cleared-by-user']);
  });

  it('窗口过后条件仍满足 → 产生全新告警（新 id、独立 trace），不复活旧记录', () => {
    const engine = new AlarmEngine(500, 0);
    const id = run(engine, offlineOnly(), [], T0).created[0]?.id ?? '';
    expect(clearAt(engine, id, T0 + 1000)).toBe(true);

    const res = run(engine, offline(), [], T0 + 1000 + 600_001); // 距清除 ≥10min
    expect(res.created, '窗口外必须重新提醒（"问题还在"的诚实性）').toHaveLength(1);
    expect(res.reopened).toEqual([]);
    const fresh = res.created[0]!;
    expect(fresh.id, '必须是全新记录而非复活旧记录').not.toBe(id);
    expect({ occurrences: fresh.occurrences, traceTypes: fresh.trace.map((t) => t.type) }).toEqual({
      occurrences: 1,
      traceTypes: ['raised'],
    });

    // 旧记录保持 cleared 原样
    const old = engine.all().find((a) => a.id === id)!;
    expect({
      resolvedAt: old.resolvedAt,
      occurrences: old.occurrences,
      traceTypes: old.trace.map((t) => t.type),
    }).toEqual({
      resolvedAt: T0 + 1000,
      occurrences: 1,
      traceTypes: ['raised', 'cleared-by-user'],
    });
    expect(engine.all()).toHaveLength(2);
  });

  it('trace 审计：clear 与 ack 的 trace 共存且顺序正确（raised → acked → cleared-by-user）', () => {
    const engine = new AlarmEngine(500, 0);
    const id = run(engine, offlineOnly(), [], T0).created[0]?.id ?? '';
    expect(engine.ack(id, T0 + 500, 'alice')).toBe(true);
    expect(clearAt(engine, id, T0 + 1000, 'bob')).toBe(true);
    const alarm = engine.all().find((a) => a.id === id)!;
    expect(alarm.trace).toEqual([
      { at: T0, type: 'raised', by: null },
      { at: T0 + 500, type: 'acked', by: 'alice' },
      { at: T0 + 1000, type: 'cleared-by-user', by: 'bob' },
    ]);
  });
});
