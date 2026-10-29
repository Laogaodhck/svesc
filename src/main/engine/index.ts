/**
 * 引擎门面（唯一被主进程 ipc.ts / scripts/engine-check.mjs 使用的入口）。
 *
 * 分层铁律：本文件及其下所有引擎文件**不 import electron**。
 * 需要 Electron 能力的东西（userData 目录、下载目录）全部由调用方注入。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  AppSettings,
  DeviceDetail,
  PrinterManageConfig,
  PrintJobAction,
  RouterHints,
  ScanProgress,
  SettingsPayload,
  Snapshot,
  WatchStatus,
} from '../../shared/types';
import { SCHEDULE } from '../../shared/constants';
import { detectSubnet } from './discovery/subnet';
import { NetLog } from './diag/netlog';
import { Scheduler } from './scheduler';
import { isValidIpv4, type PersistStore, type PersistedSettings } from './store';
import { SqliteStore } from './db/sqlite';
import { printJobAction, printTestPage, setDefaultPrinter } from './printers/print-ops';
import { PrinterAlertTracker, type PrinterAlert } from './printers/alerts';
import { hasFault } from './printers/printer-service';
import { sendMagicPacket } from './wol';
import { buildHtmlReport } from './report-html';

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
  /** 返回 true 表示已提交系统通知；无出口或返回 false 不记作已通知。 */
  onPrinterAlert?: (alert: PrinterAlert) => boolean;
  onScanProgress?: (progress: ScanProgress) => void;
}

export interface Engine {
  start(): Promise<void>;
  stop(): void;
  getSnapshot(): Snapshot;
  refresh(): Promise<{ started: boolean }>;
  setAutoScan(enabled: boolean, intervalSec?: number): { autoScan: boolean; intervalSec: number };
  getDeviceDetail(deviceId: string): Promise<DeviceDetail | null>;
  /** 导出报告（task-025：format 缺省 json，新增 html 自包含报告） */
  exportReport(format?: 'json' | 'html', extras?: Record<string, unknown>): { ok: boolean; path: string | null; error?: string };
  getGatewayIp(): string | null;
  /** 灌入路由器通道提示（task-022 C-1：DHCP 租约 hostname 回填设备识别），内存态不持久化 */
  applyRouterHints(hints: RouterHints): void;
  // —— 别名（设备与打印机共用一张表，key = id）——
  setDeviceAlias(deviceId: string, alias: string | null): { ok: boolean };
  setPrinterAlias(printerId: string, alias: string | null): { ok: boolean };
  // —— 设备注注 / 标签（task-025）——
  deviceSetNote(deviceId: string, note: string | null): { ok: boolean };
  deviceSetTags(deviceId: string, tags: string[] | null): { ok: boolean };
  // —— WOL 网络唤醒（task-025：发送成功 ≠ 设备一定唤醒，UDP 无确认）——
  deviceWake(deviceId: string): Promise<{ ok: boolean; error: string | null }>;
  // —— 持续 Ping 监控（task-025）——
  watchList(): WatchStatus[];
  watchAdd(ip: string, note: string | null): { ok: boolean; error: string | null };
  watchRemove(ip: string): { ok: boolean };
  // —— 配置导入导出（task-025）——
  configExport(): { ok: boolean; path: string | null; error?: string };
  configImport(json: string): { ok: boolean; imported: string[]; skipped: string[]; error: string | null };
  // —— 打印管理页 ——
  getPrinterManage(): PrinterManageConfig;
  printerRefresh(): Promise<{ ok: boolean; error: string | null }>;
  addManualPrinter(ip: string, note: string | null): { ok: boolean; error: string | null };
  removeManualPrinter(ip: string): { ok: boolean };
  setPrinterIgnored(printerId: string, ignored: boolean): { ok: boolean };
  // —— 打印操作（task-024：任务取消/暂停/恢复、测试页、设默认）——
  printerJobAction(action: PrintJobAction, printerName: string, jobId: string): Promise<{ ok: boolean; error: string | null }>;
  printerPrintTestPage(printerName: string): Promise<{ ok: boolean; error: string | null }>;
  printerSetDefault(printerName: string): Promise<{ ok: boolean; error: string | null }>;
  // —— 设置页 ——
  getSettings(): AppSettings;
  updateSettings(patch: Partial<AppSettings>): AppSettings;
  // —— 运行日志（诊断中心日志页数据源；诊断/存储异常统一入环） ——
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
  const printerAlerts = new PrinterAlertTracker();
  const prepareSnapshot = (snapshot: Snapshot): Snapshot => {
    const withMeta = applyDeviceMeta(snapshot, store);
    if (withMeta.printers.length === 0) return withMeta;
    const manage = store.printerManage();
    // 配置修改立即屏蔽旧缓存条目，不等待异步采集完成才清理提醒账本。
    const printers = withMeta.printers.filter((printer) => printer.manual
      ? manage.manual.some((entry) => entry.ip === printer.ip)
      : !manage.ignored.includes(printer.id));
    return {
      ...withMeta,
      printers,
      system: { ...withMeta.system, printers: printers.length, printersWithFault: printers.filter(hasFault).length },
    };
  };
  const projectPrinterAlerts = (snapshot: Snapshot): Snapshot => ({
    ...snapshot,
    printers: printerAlerts.project(snapshot.printers),
  });
  const notifyPrinter = (alert: PrinterAlert): boolean => {
    if (!store.settings.printerAlerts || !options.onPrinterAlert) return false;
    try {
      return options.onPrinterAlert(alert);
    } catch (err) {
      netlog.push('error', 'printers', `打印机通知发送失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

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
        const prepared = prepareSnapshot(snapshot);
        printerAlerts.evaluate(prepared.printers, Date.now(), notifyPrinter);
        options.onSnapshot?.(projectPrinterAlerts(prepared));
      },
      onScanProgress: options.onScanProgress,
      getPrinterManage: () => store.printerManage(),
    },
  );

  // 恢复设备首次接入表（task-017：重启不得把 firstSeen 重置成本次扫描时间）
  const persisted = store.get();
  scheduler.hydrateFirstSeen(persisted.firstSeen);
  // 恢复持续 Ping 监控目标（task-025）
  scheduler.hydrateWatches(store.watchTargets());

  // store 落盘失败 → 快照 warnings（审计 H-3：别名/打印管理配置静默丢盘不可接受）
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

  // —— 配置导入导出（task-025）：settings + 用户元数据 + 监控目标 + 打印管理 + firstSeen ——
  const exportConfigFile = (): { ok: boolean; path: string | null; error?: string } => {
    const dir = options.exportDir ?? options.userDataDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `svesc-config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      const state = store.get();
      fs.writeFileSync(
        target,
        JSON.stringify(
          {
            app: 'svesc',
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            settings: store.settings,
            aliases: state.aliases,
            deviceNotes: state.deviceNotes ?? {},
            deviceTags: state.deviceTags ?? {},
            watchList: store.watchTargets(),
            printerManage: store.printerManage(),
            firstSeen: state.firstSeen,
          },
          null,
          2,
        ),
        'utf8',
      );
      netlog.push('info', 'config', `配置已导出：${target}`);
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, path: null, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** settings 白名单（key → 期望类型；autoScanIntervalSec 另有 30-3600 范围校验）。 */
  const CONFIG_SETTINGS_TYPES: Record<string, 'boolean' | 'number' | 'string'> = {
    autoScan: 'boolean',
    autoScanIntervalSec: 'number',
    showVirtualPrinters: 'boolean',
    snmpEnabled: 'boolean',
    useMdns: 'boolean',
    closeToTray: 'boolean',
    printerAlerts: 'boolean',
    autoUpdate: 'boolean',
    rememberRouterPassword: 'boolean',
  };

  const importConfigJson = (text: string): { ok: boolean; imported: string[]; skipped: string[]; error: string | null } => {
    const imported: string[] = [];
    const skipped: string[] = [];
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, imported, skipped, error: '配置文件不是有效的 JSON 对象' };
      }
      obj = parsed as Record<string, unknown>;
    } catch (err) {
      return { ok: false, imported, skipped, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` };
    }
    if (obj.schemaVersion !== 1) {
      return { ok: false, imported, skipped, error: `不支持的配置版本：${String(obj.schemaVersion)}（当前支持 1）` };
    }
    /** 逐键合并一个 map 形状的区段；非法值跳过计入 skipped，绝不整包失败。 */
    const applyMap = (section: unknown, name: string, apply: (key: string, value: unknown) => boolean): void => {
      if (section === undefined) return;
      if (section && typeof section === 'object' && !Array.isArray(section)) {
        let applied = false;
        for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
          if (apply(key, value)) applied = true;
          else skipped.push(`${name}.${key}`);
        }
        if (applied) imported.push(name);
      } else {
        skipped.push(name);
      }
    };
    // settings：白名单 + 类型校验
    if (obj.settings !== undefined) {
      if (obj.settings && typeof obj.settings === 'object' && !Array.isArray(obj.settings)) {
        const patch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj.settings as Record<string, unknown>)) {
          const expected = CONFIG_SETTINGS_TYPES[key];
          if (!expected || typeof value !== expected) {
            skipped.push(`settings.${key}`);
            continue;
          }
          if (key === 'autoScanIntervalSec' && ((value as number) < 30 || (value as number) > 3600)) {
            skipped.push('settings.autoScanIntervalSec');
            continue;
          }
          patch[key] = value;
        }
        if (Object.keys(patch).length > 0) {
          store.setSettings(patch as Partial<PersistedSettings>);
          imported.push('settings');
        }
      } else {
        skipped.push('settings');
      }
    }
    applyMap(obj.aliases, 'aliases', (k, v) => {
      if (typeof v !== 'string' || !v.trim()) return false;
      store.setAlias(k, v.trim());
      return true;
    });
    applyMap(obj.deviceNotes, 'deviceNotes', (k, v) => {
      if (typeof v !== 'string' || !v.trim()) return false;
      store.setNote(k, v);
      return true;
    });
    applyMap(obj.deviceTags, 'deviceTags', (k, v) => {
      if (!Array.isArray(v)) return false;
      store.setTags(k, v as string[]);
      return true;
    });
    // watchList：逐条校验 IP
    if (obj.watchList !== undefined) {
      if (Array.isArray(obj.watchList)) {
        let applied = false;
        for (const entry of obj.watchList) {
          const w = entry as { ip?: unknown; note?: unknown };
          if (typeof w.ip === 'string' && isValidIpv4(w.ip)) {
            store.addWatchTarget(w.ip, typeof w.note === 'string' ? w.note : null);
            applied = true;
          } else {
            skipped.push(`watchList.${String(typeof w.ip === 'string' ? w.ip : '<invalid>')}`);
          }
        }
        if (applied) imported.push('watchList');
      } else {
        skipped.push('watchList');
      }
    }
    // printerManage：manual 逐条 + ignored 逐条
    if (obj.printerManage !== undefined) {
      const pm = obj.printerManage as { manual?: unknown; ignored?: unknown } | null;
      if (pm && typeof pm === 'object' && !Array.isArray(pm)) {
        if (Array.isArray(pm.manual)) {
          for (const m of pm.manual) {
            const e = m as { ip?: unknown; note?: unknown };
            if (typeof e.ip === 'string') store.addManualPrinter(e.ip, typeof e.note === 'string' ? e.note : null);
            else skipped.push('printerManage.manual');
          }
        }
        if (Array.isArray(pm.ignored)) {
          for (const id of pm.ignored) {
            if (typeof id === 'string') store.setPrinterIgnored(id, true);
            else skipped.push('printerManage.ignored');
          }
        }
        imported.push('printerManage');
      } else {
        skipped.push('printerManage');
      }
    }
    // firstSeen：逐条合并（文件值覆盖本地同 key 记录）
    applyMap(obj.firstSeen, 'firstSeen', (k, v) => {
      if (!isValidIpv4(k) || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return false;
      const merged = { ...store.get().firstSeen, [k]: v };
      store.setFirstSeen(merged);
      return true;
    });
    // 运行时生效：autoScan 定时器 / 打印机源开关 / 监控目标 / 快照立即重推
    scheduler.setAutoScan(store.settings.autoScan, store.settings.autoScanIntervalSec);
    scheduler.setPrinterSources({ snmpEnabled: store.settings.snmpEnabled, useMdns: store.settings.useMdns });
    scheduler.hydrateWatches(store.watchTargets());
    void scheduler.refreshPrinters(true);
    scheduler.emitSnapshotNow();
    netlog.push('info', 'config', `配置导入完成：生效 ${imported.length} 项，跳过 ${skipped.length} 项`);
    return { ok: true, imported, skipped, error: null };
  };

  const queueForOperation = (name: string) => scheduler.buildSnapshot().printers.find((p) =>
    p.queueName === name && p.source !== 'simulated' && !p.id.startsWith('sim-'),
  );

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
      // 每轮都更新租期；有效名称投影变化才推帧，避免重复缓存吞掉续租或 IP 变化。
      if (scheduler.setRouterHints(hints)) scheduler.emitSnapshotNow();
    },
    // —— 打印管理页：配置变更落盘后立即触发一轮打印机刷新（刷新内部会推快照） ——
    getPrinterManage(): PrinterManageConfig {
      return store.printerManage();
    },
    printerRefresh() {
      return scheduler.refreshPrinters(true);
    },
    addManualPrinter(ip: string, note: string | null) {
      const res = store.addManualPrinter(ip, note);
      if (res.ok) void scheduler.refreshPrinters(true);
      return res;
    },
    removeManualPrinter(ip: string) {
      const res = store.removeManualPrinter(ip);
      if (res.ok) {
        scheduler.emitSnapshotNow();
        void scheduler.refreshPrinters(true);
      }
      return res;
    },
    setPrinterIgnored(printerId: string, ignored: boolean) {
      store.setPrinterIgnored(printerId, ignored);
      scheduler.emitSnapshotNow();
      void scheduler.refreshPrinters(true);
      return { ok: true };
    },
    setPrinterAlias(printerId: string, alias: string | null) {
      store.setAlias(printerId, alias);
      // 别名/备注/标签在 applyDeviceMeta 里对每帧快照生效，推一帧立即生效（不重扫）
      scheduler.emitSnapshotNow();
      return { ok: true };
    },
    // —— 打印操作（task-024）：留痕入日志环；成功后刷新打印机快照让队列/默认态立即可见 ——
    async printerJobAction(action, printerName, jobId) {
      const queue = queueForOperation(printerName);
      if (!queue) return { ok: false, error: '未找到可操作的真实 Windows 打印队列' };
      if (!queue.jobs.some((job) => job.id === jobId)) return { ok: false, error: '该任务已不在当前队列，请刷新后重试' };
      const res = await printJobAction(action, printerName, jobId);
      netlog.push(res.ok ? 'info' : 'error', 'printer', `任务${action} ${printerName}#${jobId}：${res.ok ? '成功' : res.error}`);
      if (res.ok) void scheduler.refreshPrinters(true);
      return res;
    },
    async printerPrintTestPage(printerName) {
      if (!queueForOperation(printerName)) return { ok: false, error: '未找到可操作的真实 Windows 打印队列' };
      const res = await printTestPage(printerName);
      netlog.push(res.ok ? 'info' : 'error', 'printer', `打印测试页 ${printerName}：${res.ok ? '已发送' : res.error}`);
      if (res.ok) void scheduler.refreshPrinters(true);
      return res;
    },
    async printerSetDefault(printerName) {
      if (!queueForOperation(printerName)) return { ok: false, error: '未找到可操作的真实 Windows 打印队列' };
      const res = await setDefaultPrinter(printerName);
      netlog.push(res.ok ? 'info' : 'error', 'printer', `设默认打印机 ${printerName}：${res.ok ? '成功' : res.error}`);
      if (res.ok) void scheduler.refreshPrinters(true);
      return res;
    },
    setDeviceAlias(deviceId: string, alias: string | null) {
      store.setAlias(deviceId, alias);
      scheduler.emitSnapshotNow();
      return { ok: true };
    },
    // —— 设备注注 / 标签（task-025）：落盘后立即推帧（applyDeviceMeta 对每帧快照生效） ——
    deviceSetNote(deviceId: string, note: string | null) {
      store.setNote(deviceId, note);
      scheduler.emitSnapshotNow();
      return { ok: true };
    },
    deviceSetTags(deviceId: string, tags: string[] | null) {
      store.setTags(deviceId, tags);
      scheduler.emitSnapshotNow();
      return { ok: true };
    },
    // —— WOL（task-025）：诚实错误优先（未知 MAC / 本机 / 网关 / 跨网段都直接拒绝） ——
    async deviceWake(deviceId: string) {
      const device = scheduler.buildDevices().find((d) => d.id === deviceId);
      if (!device) return { ok: false, error: `设备不存在：${deviceId}` };
      if (device.id.startsWith('sim-')) {
        return { ok: false, error: '演示设备不参与 WOL（发送了也没有真实主机接收）' };
      }
      if (device.mac === null) return { ok: false, error: '未知 MAC，无法构造唤醒包' };
      if (device.isSelf) return { ok: false, error: '目标设备是本机，无需唤醒' };
      if (device.isGateway) return { ok: false, error: '目标设备是网关（保持在线），拒绝唤醒' };
      if (subnet?.prefix && !device.ip.startsWith(subnet.prefix)) {
        return { ok: false, error: `目标 ${device.ip} 不在当前网段（${subnet.cidr}），广播唤醒包无法可靠到达` };
      }
      const res = await sendMagicPacket(device.mac);
      netlog.push(
        res.ok ? 'info' : 'error',
        'wol',
        res.ok
          ? `唤醒包已发送至 ${device.mac}（${device.ip}）· 发送成功 ≠ 设备一定唤醒，请观察其状态回转`
          : `唤醒失败：${res.error}`,
      );
      return res;
    },
    // —— 持续 Ping 监控（task-025）：store 为配置事实源，scheduler 为运行态 ——
    watchList(): WatchStatus[] {
      return scheduler.watchStatus();
    },
    watchAdd(ip: string, note: string | null) {
      const persisted = store.addWatchTarget(ip, note);
      if (!persisted.ok) return persisted;
      scheduler.hydrateWatches(store.watchTargets());
      const runtime = scheduler.watchAdd(ip, note);
      return runtime.ok ? persisted : runtime;
    },
    watchRemove(ip: string) {
      const persisted = store.removeWatchTarget(ip);
      scheduler.hydrateWatches(store.watchTargets());
      scheduler.watchRemove(ip);
      return persisted;
    },
    // —— 配置导入导出（task-025）——
    configExport() {
      return exportConfigFile();
    },
    configImport(json: string) {
      return importConfigJson(json);
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
        closeToTray: s.closeToTray,
        printerAlerts: s.printerAlerts,
        autoUpdate: s.autoUpdate,
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
      // 首次接入表随退出落盘（task-017）
      store.setFirstSeen(scheduler.exportFirstSeen());
      // SQLite：写路径本身即时落库，flush 做 WAL checkpoint 归位；随后安全关闭连接
      store.flush();
      if (store instanceof SqliteStore) store.close();
    },
    getSnapshot(): Snapshot {
      const cached = scheduler.snapshotCached;
      return projectPrinterAlerts(prepareSnapshot(cached ?? scheduler.buildSnapshot()));
    },
    refresh(): Promise<{ started: boolean }> {
      return scheduler.refresh();
    },
    setAutoScan(enabled: boolean, intervalSec?: number) {
      const result = scheduler.setAutoScan(enabled, intervalSec);
      store.setSettings({ autoScan: result.autoScan, autoScanIntervalSec: result.intervalSec });
      return result;
    },
    async getDeviceDetail(deviceId: string): Promise<DeviceDetail | null> {
      const detail = await scheduler.getDeviceDetail(deviceId);
      if (!detail) return null;
      // 跨重启的在线历史只存在于支持状态日志的后端（SQLite）；JSON/降级后端如实给空数组
      return {
        ...detail,
        statusHistory: store.getDeviceStatusHistory?.(detail.device.ip, 50) ?? [],
      };
    },
    /**
     * 导出报告。extras（可选）由主进程合入路由器状态与打印管理配置——
     * 审计 L6：旧实现只导 Snapshot，路由器会话与管理配置拿不到。
     * task-025：format='html' 产出自包含巡检报告（所有动态文本已转义）。
     */
    exportReport(format: 'json' | 'html' = 'json', extras?: Record<string, unknown>) {
      const dir = options.exportDir ?? options.userDataDir;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const ext = format === 'html' ? 'html' : 'json';
        const filename = `svesc-report-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
        const target = path.join(dir, filename);
        if (format === 'html') {
          fs.writeFileSync(target, buildHtmlReport(engine.getSnapshot(), extras), 'utf8');
        } else {
          const payload = { ...engine.getSnapshot(), ...(extras ?? {}) };
          fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
        }
        return { ok: true, path: target };
      } catch (err) {
        return { ok: false, path: null, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  return engine;
}

/**
 * 快照出引擎前的最后一步：注入用户元数据（task-025 起 = 别名 + 备注 + 标签）。
 * 别名只改显示不改 name（告警 targetName 保持原点名，便于对账）；
 * 备注/标签未设置时不加字段（undefined），避免快照体积无谓膨胀。
 */
function applyDeviceMeta(snapshot: Snapshot, store: PersistStore): Snapshot {
  const state = store.get();
  const hasAliases = Object.keys(state.aliases).length > 0;
  const hasNotes = Object.keys(state.deviceNotes ?? {}).length > 0;
  const hasTags = Object.keys(state.deviceTags ?? {}).length > 0;
  if (!hasAliases && !hasNotes && !hasTags) return snapshot;
  return {
    ...snapshot,
    devices: snapshot.devices.map((device) => {
      const alias = store.aliasOf(device.id);
      const note = store.noteOf(device.id);
      const tags = store.tagsOf(device.id);
      if (!alias && !note && (!tags || tags.length === 0)) return device;
      return {
        ...device,
        displayName: alias ?? device.displayName,
        note: note ?? null,
        tags: tags ?? [],
      };
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
export { Simulator, mulberry32 } from './simulator';
