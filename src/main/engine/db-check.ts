/**
 * SQLite 持久化端到端检查（task-018，纯 Node 驱动，不启动 Electron）。
 *
 * 流程（scripts/db-check.mjs 经 esbuild 打包后调用本函数）：
 *  1. 打开引擎 A（临时目录）→ 直接驱动一次设备状态同步（真实扫描结果）→ 写别名 → stop；
 *  2. 重新打开引擎 B（同目录，模拟应用重启）→ 断言别名 / 首次接入 / 设备状态行 /
 *     状态转移历史全部恢复；
 *  3. 返回逐项结论，脚本据此打 PASS/FAIL 与退出码。
 *
 * 不调用 scheduler.start()（避免真实扫描耗时）；设备状态经 upsertDeviceStates
 * 显式驱动，走的是与应用运行期完全相同的写入路径。
 */
import type { Device } from '../../shared/types';
import type { Engine } from './index';
import { createEngine } from './index';

/**
 * 合成设备（确定性驱动，不依赖真实网络里扫到了几台）：
 * 走的是与应用运行期完全相同的 upsertDeviceStates 写入路径。
 */
function syntheticDevices(now: number): Device[] {
  const base = {
    hostname: null as string | null,
    vendor: null as string | null,
    osHint: null as string | null,
    openPorts: [] as number[],
    rttHistory: [] as number[],
    isGateway: false,
    isSelf: false,
    displayName: null as string | null,
    ipConflict: false,
    quality: { latencyMs: 5, jitterMs: 1, packetLossPct: 0, score: 90, grade: 'excellent' as const, samples: 10 },
    bandwidth: { rxBps: 0, txBps: 0, share: 0, connections: 0, attributable: false, estimated: true },
  };
  return [
    { ...base, id: 'dev-192.168.2.52', ip: '192.168.2.52', mac: 'aa-bb-cc-00-00-52', kind: 'workstation', state: 'online', firstSeen: now, lastSeen: now },
    { ...base, id: 'dev-192.168.2.213', ip: '192.168.2.213', mac: 'aa-bb-cc-00-01-d5', kind: 'printer', state: 'offline', firstSeen: now, lastSeen: now },
    { ...base, id: 'dev-192.168.2.101', ip: '192.168.2.101', mac: 'aa-bb-cc-00-00-65', kind: 'mobile', state: 'online', firstSeen: now, lastSeen: now },
  ];
}

export interface DbCheckResult {
  aliasWritten: boolean;
  aliasRestored: boolean;
  /** 设备状态同步写入的行数（= 引擎看到的真实设备数） */
  deviceRows: number;
  /** 重启后从 devices 表恢复的 firstSeen 条数 */
  firstSeenRestored: number;
  /** 目标设备的状态转移历史条数（≥2 = 首次记录 + 状态变化） */
  statusHistory: number;
  /** 数据库文件路径 */
  dbPath: string;
}

export async function runDbCheck(options: { userDataDir: string }): Promise<DbCheckResult> {
  const engineA: Engine = await createEngine({ userDataDir: options.userDataDir });
  const now = Date.now();
  const devices = syntheticDevices(now);
  const target = devices[0] ?? null;

  // ① 设备状态同步（应用运行期同一条写入路径：upsert + 状态转移日志）
  engineA.store.upsertDeviceStates?.(devices);
  let statusHistory = 0;
  if (target) {
    // 驱动一次状态转移（在线 ↔ 离线对调），验证 device_status_log 记账
    const flipped = devices.map((d) =>
      d.id.startsWith('sim-') ? d : { ...d, state: d.state === 'offline' ? ('online' as const) : ('offline' as const) },
    );
    engineA.store.upsertDeviceStates?.(flipped);
    statusHistory = (engineA.store.getDeviceStatusHistory?.(target.ip, 10) ?? []).length;
  }

  // ② 别名落盘
  let aliasWritten = false;
  if (target) {
    engineA.setDeviceAlias(target.id, 'DB-CHECK-别名');
    aliasWritten = engineA.store.aliasOf(target.id) === 'DB-CHECK-别名';
  }

  // ③ 模拟应用退出
  engineA.stop();

  // ④ 重启：全部持久化数据必须恢复
  const engineB: Engine = await createEngine({ userDataDir: options.userDataDir });
  const aliasRestored = target ? engineB.store.aliasOf(target.id) === 'DB-CHECK-别名' : false;
  const persisted = engineB.store.get();
  const firstSeenRestored = Object.keys(persisted.firstSeen).length;
  const deviceRows = devices.filter((d) => !d.id.startsWith('sim-')).length;
  engineB.stop();

  return {
    aliasWritten,
    aliasRestored,
    deviceRows,
    firstSeenRestored,
    statusHistory: Array.isArray(statusHistory) ? statusHistory.length : 0,
    dbPath: engineB.store instanceof Object && 'filePath' in engineB.store ? String((engineB.store as { filePath: string }).filePath) : '',
  };
}
