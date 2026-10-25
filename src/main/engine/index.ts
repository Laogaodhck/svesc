/**
 * 引擎门面（唯一被主进程 ipc.ts / scripts/engine-check.mjs 使用的入口）。
 *
 * 分层铁律：本文件及其下所有引擎文件**不 import electron**。
 * 需要 Electron 能力的东西（userData 目录、下载目录）全部由调用方注入。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Alarm, AppSettings, DeviceDetail, PrinterManageConfig, RouterHints, ScanProgress, SettingsPayload, Snapshot } from '../../shared/types';
import { SCHEDULE } from '../../shared/constants';
import { detectSubnet } from './discovery/subnet';
import { NetLog } from './diag/netlog';
import { Scheduler } from './scheduler';
import { type PersistStore } from './store';
import { SqliteStore } from './db/sqlite';

export interface EngineOptions {
  /** 持久化目录（主进程传 app.getPath('userData')；engine-check 传临时目录） */
  userDataDir: string;
  /** 报告导出目录（主进程传 app.getPath('downloads')） */
  exportDir?: string;
  /** 强制演示数据源（LAN_DEMO=1） */
  forceDemo?: boolean;
  snmpEnabled?: boolean;
  useMdns?: boolean;
  autoScanIntervalSec?: number;
  onSnapshot?: (snapshot: Snapshot) => void;
  onScanProgress?: (progress: ScanProgress) => void;
  onAlarm?: (alarm: Alarm) => void;
}

export interface Engine {
  start(): Promise<void>;
  stop(): void;
  getSnapshot(): Snapshot;
  refresh(): Promise<{ started: boolean }>;
  setAutoScan(enabled: boolean, intervalSec?: number): { autoScan: boolean; intervalSec: number };
  getDeviceDetail(deviceId: string): Promise<DeviceDetail | null>;
  ackAlarm(alarmId: string, ackBy?: string | null): boolean;
  /** 用户手动清除（task-021 语义 A）；by 由主进程注入 */
  clearAlarm(alarmId: string, by: string): boolean;
  /** 批量手动清除，返回成功条数 */
  clearAlarms(alarmIds: string[], by: string): number;
  exportReport(extras?: Record<string, unknown>): { ok: boolean; path: string | null; error?: string };
  getGatewayIp(): string | null;
  /** 灌入路由器通道提示（task-022 C-1：DHCP 租约 hostname 回填设备识别），内存态不持久化 */
  applyRouterHints(hints: RouterHints): void;
  // —— 别名（设备与打印机共用一张表，key = id）——
  setDeviceAlias(deviceId: string, alias: string | null): { ok: boolean };
  setPrinterAlias(printerId: string, alias: string | null): { ok: boolean };
  // —— 打印管理页 ——
  getPrinterManage(): PrinterManageConfig;
  addManualPrinter(ip: string, note: string | null): { ok: boolean; error: string | null };
  removeManualPrinter(ip: string): { ok: boolean };
  setPrinterIgnored(printerId: string, ignored: boolean): { ok: boolean };
  // —— 设置页 ——
  getSettings(): AppSettings;
  updateSettings(patch: Partial<AppSettings>): AppSettings;
  // —— 运行日志（诊断中心日志页数据源；诊断/告警/存储异常统一入环） ——
  readonly logs: NetLog;
  readonly scheduler: Scheduler;
  /** 持久化后端（task-018 起：SQLite 主存储；接口与 JsonStore 同构，可互换） */
  readonly store: PersistStore;
  readonly subnetLabel: string | null;
}

export async function createEngine(options: EngineOptions): Promise<Engine> {
  const subnet = await detectSubnet();
  // 运行日志先建：SQLite 初始化/迁移的成败都要入环（诊断中心日志页可见）
  const netlog = new NetLog();

  // store 在 scheduler 之前创建：落盘失败回调经闭包转发给（稍后创建的）scheduler。
  // task-018：主存储切换为 SQLite（node:sqlite，零依赖）；接口与 JsonStore 同构，
  // 初始化失败时内部自动降级内存模式，绝不崩在启动路径上。
  let reportStoreError: ((err: Error | null) => void) | null = null;
  const store: PersistStore = new SqliteStore(options.userDataDir, 'svesc-state.db', {
    logger: (level, message) => netlog.push(level, 'store', message),
    onWriteError: (err) => reportStoreError?.(err),
  });

  const autoScanIntervalSec =
    options.autoScanIntervalSec ?? store.settings.autoScanIntervalSec ?? 60;

  netlog.push('info', 'engine', `引擎初始化（网段 ${subnet ? subnet.cidr : '未知'}）`);

  // 设备实时状态同步的节流账本（task-018）：状态变化立即写库；无变化 15s 全量对账
  let lastDeviceSyncAt = 0;
  const lastKnownStates = new Map<string, string>();

  const scheduler = new Scheduler(
    {
      prefix: subnet?.prefix ?? null,
      hosts: subnet?.hosts ?? [],
      selfIp: subnet?.address ?? null,
      gateway: subnet?.gateway ?? null,
      subnetLabel: subnet ? subnet.cidr : null,
      autoScanIntervalSec,
      forceDemo: options.forceDemo ?? process.env.LAN_DEMO === '1',
      // 持久化设置优先于启动参数（用户在设置页改过就以用户为准）
      snmpEnabled: store.settings.snmpEnabled ?? options.snmpEnabled ?? true,
      useMdns: store.settings.useMdns ?? options.useMdns ?? false,
    },
    {
      onSnapshot: (snapshot) => {
        // 设备状态持久化（task-018）：每帧快照比对状态，变化即写；
        // 无变化也定期全量对账（last_seen 推进 + 兜底），节流 3 个心跳周期
        if (store.upsertDeviceStates) {
          const now = Date.now();
          let changed = false;
          for (const d of snapshot.devices) {
            if (d.id.startsWith('sim-')) continue;
            const prev = lastKnownStates.get(d.ip);
            if (prev !== d.state) {
              changed = true;
              lastKnownStates.set(d.ip, d.state);
            }
          }
          if (changed || now - lastDeviceSyncAt >= SCHEDULE.devices * 3) {
            const transitions = (store.upsertDeviceStates?.(snapshot.devices) ?? 0);
            lastDeviceSyncAt = now;
            if (transitions > 0) {
              netlog.push('info', 'store', `设备状态同步：${transitions} 台状态转移已写入 SQLite`);
            }
          }
        }
        const withAliases = applyAliases(snapshot, store);
        options.onSnapshot?.(withAliases);
      },
      onScanProgress: options.onScanProgress,
      onAlarm: (alarm) => {
        // 告警入环（日志页可见）；severity 映射：critical→error，其余→warn
        netlog.push(
          alarm.severity === 'critical' ? 'error' : 'warn',
          'alarm',
          `${alarm.code} · ${alarm.targetName}：${alarm.message}`,
        );
        // 告警实时落库（task-018）：崩溃不丢新告警；新设备接入同步固化 firstSeen
        store.upsertAlarm?.(alarm);
        if (alarm.code === 'DEVICE_NEW') store.setFirstSeen(scheduler.exportFirstSeen());
        options.onAlarm?.(alarm);
      },
    },
  );

  // 恢复告警历史与已知设备种（避免重启后 DEVICE_NEW 全量刷屏）
  const persisted = store.get();
  scheduler.hydrateAlarmState({
    alarms: persisted.alarms,
    knownDeviceKeys: persisted.knownDeviceKeys,
  });
  // 恢复设备首次接入表（task-017：重启不得把 firstSeen 重置成本次扫描时间）
  scheduler.hydrateFirstSeen(persisted.firstSeen);

  // store 落盘失败 → 快照 warnings（审计 H-3：别名/告警历史/打印管理配置静默丢盘不可接受）
  reportStoreError = (err) => {
    netlog.push(
      err ? 'error' : 'info',
      'store',
      err ? `持久化写入失败：${err.message}（每 5s 自动重试）` : '持久化写入已恢复',
    );
    scheduler.reportEngineWarning(
      'store',
      err ? [`持久化写入失败：${err.message}（每 5s 自动重试）`] : ['持久化写入已恢复'],
    );
  };

  let stopped = false;
  const gatewayIp: string | null = subnet?.gateway ?? null;

  const engine: Engine = {
    subnetLabel: subnet ? subnet.cidr : null,
    scheduler,
    store,
    logs: netlog,
    /** 路由器管理通道用：网关 IP（未知为 null，由 RouterManager 诚实降级） */
    getGatewayIp(): string | null {
      return gatewayIp;
    },
    applyRouterHints(hints: RouterHints): void {
      scheduler.setRouterHints(hints);
      // 提示只影响下一次 buildDevices 的快照组装：立即推一帧让回填马上可见
      scheduler.emitSnapshotNow();
    },
    // —— 打印管理页：配置变更落盘后立即触发一轮打印机刷新（刷新内部会推快照） ——
    getPrinterManage(): PrinterManageConfig {
      return store.printerManage();
    },
    addManualPrinter(ip: string, note: string | null) {
      const res = store.addManualPrinter(ip, note);
      if (res.ok) void scheduler.refreshPrinters();
      return res;
    },
    removeManualPrinter(ip: string) {
      const res = store.removeManualPrinter(ip);
      if (res.ok) void scheduler.refreshPrinters();
      return res;
    },
    setPrinterIgnored(printerId: string, ignored: boolean) {
      store.setPrinterIgnored(printerId, ignored);
      void scheduler.refreshPrinters();
      return { ok: true };
    },
    setPrinterAlias(printerId: string, alias: string | null) {
      store.setAlias(printerId, alias);
      // 别名在 applyAliases 里对每帧快照生效，推一帧立即生效（不重扫）
      scheduler.emitSnapshotNow();
      return { ok: true };
    },
    setDeviceAlias(deviceId: string, alias: string | null) {
      store.setAlias(deviceId, alias);
      scheduler.emitSnapshotNow();
      return { ok: true };
    },
    // —— 设置页：落盘 + 运行时立即生效（autoScan 重挂定时器，打印机源下一轮刷新生效） ——
    getSettings(): AppSettings {
      const s = store.settings;
      return {
        autoScan: s.autoScan,
        autoScanIntervalSec: s.autoScanIntervalSec,
        showVirtualPrinters: s.showVirtualPrinters,
        snmpEnabled: s.snmpEnabled,
        useMdns: s.useMdns,
        notifyDesktop: s.notifyDesktop,
        closeToTray: s.closeToTray,
        rememberRouterPassword: s.rememberRouterPassword,
      };
    },
    updateSettings(patch: Partial<AppSettings>): AppSettings {
      store.setSettings(patch);
      if (patch.autoScan !== undefined || patch.autoScanIntervalSec !== undefined) {
        scheduler.setAutoScan(store.settings.autoScan, store.settings.autoScanIntervalSec);
      }
      if (patch.snmpEnabled !== undefined || patch.useMdns !== undefined) {
        scheduler.setPrinterSources({
          snmpEnabled: store.settings.snmpEnabled,
          useMdns: store.settings.useMdns,
        });
      }
      return this.getSettings();
    },
    async start(): Promise<void> {
      if (stopped) return;
      scheduler.start();
    },
    stop(): void {
      stopped = true;
      scheduler.stop();
      const alarmState = scheduler.exportAlarmState();
      store.setAlarmHistory(alarmState.alarms, alarmState.knownDeviceKeys);
      // 首次接入表随退出落盘（task-017）
      store.setFirstSeen(scheduler.exportFirstSeen());
      // SQLite：写路径本身即时落库，flush 做 WAL checkpoint 归位；随后安全关闭连接
      store.flush();
      if (store instanceof SqliteStore) store.close();
    },
    getSnapshot(): Snapshot {
      const cached = scheduler.snapshotCached;
      return cached ? applyAliases(cached, store) : applyAliases(scheduler.buildSnapshot(), store);
    },
    refresh(): Promise<{ started: boolean }> {
      return scheduler.refresh();
    },
    setAutoScan(enabled: boolean, intervalSec?: number) {
      const result = scheduler.setAutoScan(enabled, intervalSec);
      store.setSettings({ autoScan: result.autoScan, autoScanIntervalSec: result.intervalSec });
      return result;
    },
    getDeviceDetail(deviceId: string): Promise<DeviceDetail | null> {
      return scheduler.getDeviceDetail(deviceId);
    },
    ackAlarm(alarmId: string, ackBy?: string | null): boolean {
      return scheduler.ackAlarm(alarmId, ackBy);
    },
    clearAlarm(alarmId: string, by: string): boolean {
      return scheduler.clearAlarm(alarmId, by);
    },
    clearAlarms(alarmIds: string[], by: string): number {
      return scheduler.clearAlarms(alarmIds, by);
    },
    /**
     * 导出报告。extras（可选）由主进程合入路由器状态与打印管理配置——
     * 审计 L6：旧实现只导 Snapshot，路由器会话与管理配置拿不到。
     */
    exportReport(extras?: Record<string, unknown>) {
      const dir = options.exportDir ?? options.userDataDir;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const filename = `svesc-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        const target = path.join(dir, filename);
        const payload = { ...engine.getSnapshot(), ...(extras ?? {}) };
        fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
        return { ok: true, path: target };
      } catch (err) {
        return { ok: false, path: null, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  return engine;
}

function applyAliases(snapshot: Snapshot, store: PersistStore): Snapshot {
  if (Object.keys(store.get().aliases).length === 0) return snapshot;
  return {
    ...snapshot,
    devices: snapshot.devices.map((device) => {
      const alias = store.aliasOf(device.id);
      return alias ? { ...device, displayName: alias } : device;
    }),
    // 打印机别名走同一张表（key = printer id，如 prn-192.168.2.213），
    // 别名只改显示，不改 name（告警 targetName 保持原点名，便于对账）
    printers: snapshot.printers.map((printer) => {
      const alias = store.aliasOf(printer.id);
      return alias ? { ...printer, alias } : printer;
    }),
  };
}

export { JsonStore } from './store';
export { SqliteStore } from './db/sqlite';
export { Scheduler, resolveLinkState } from './scheduler';
export { AlarmEngine, ALARM_CODES, dedupeKey } from './alarms';
export { Simulator, mulberry32 } from './simulator';
