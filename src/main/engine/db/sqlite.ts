/**
 * SQLite 持久化（task-018，主存储后端）。
 *
 * 选型：`node:sqlite`（Node ≥22.13 / Electron 45 内置 Node 24，零依赖、零原生编译，
 * 不破坏 electron-builder 打包链路）。引擎层铁律不变：**不 import electron**，
 * 目录由调用方注入（主进程传 `app.getPath('userData')`，测试/检查脚本传临时目录）。
 *
 * 设计要点：
 *  - 连接管理：单例 DatabaseSync（主进程单线程 + 同步 API，天然无并发写竞争），
 *    WAL 模式（读写不互斥）+ busy_timeout 3s（外部工具偶发读库不阻塞应用）。
 *  - 迁移：`PRAGMA user_version` 版本号 + MIGRATIONS 顺序执行，每个迁移整体事务，
 *    失败回滚并向上抛（由本类兜底降级，绝不让应用崩在启动路径上）。
 *  - 旧数据平滑升级：首次建库时若同目录存在旧版 `svesc-state.json`，整体导入后
 *    改名为 `*.migrated`（rename 而非删除，数据可回退）。
 *  - 健壮性：初始化失败降级内存库（app 照常启动，数据不落盘但功能可用）；
 *    运行期写失败走 logger + onWriteError（对接快照 warnings 通道，沿用 H-3 审计模式）。
 *  - 设备实时状态：upsertDeviceStates 事务内逐行 upsert，state 变化时写
 *    device_status_log（重启后历史状态可回溯），日志表有界（1 万条裁最旧）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type DatabaseSync as Db } from 'node:sqlite';
import type { Alarm, Device, ManualPrinterEntry, PrinterManageConfig, WatchTarget } from '../../../shared/types';
import {
  isValidIpv4,
  defaultState,
  normalizeTags,
  type PersistedSettings,
  type PersistedState,
  type PersistStore,
} from '../store';
import { DEVICE_STATUS_LOG_MAX, MIGRATIONS } from './migrations';

export type DbLogger = (level: 'info' | 'warn' | 'error', message: string) => void;

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** 告警 trace 列的兜底解析：损坏 JSON 一律重建为空数组（hydrate 迁移会再补形状）。 */
function parseTrace(raw: string | null): Alarm['trace'] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Alarm['trace']) : [];
  } catch {
    return [];
  }
}

/** device_tags.tags 列的兜底解析（JSON 字符串数组）：损坏一律视为空。 */
function parseTagsJson(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function alarmFromRow(r: Record<string, unknown>): Alarm {
  const raisedAt = Number(r.raised_at ?? 0);
  return {
    id: String(r.id ?? ''),
    severity: (r.severity as Alarm['severity']) ?? 'info',
    code: String(r.code ?? ''),
    targetType: (r.target_type as Alarm['targetType']) ?? 'system',
    targetId: String(r.target_id ?? ''),
    targetName: String(r.target_name ?? ''),
    message: String(r.message ?? ''),
    detail: r.detail === null || r.detail === undefined ? null : String(r.detail),
    raisedAt,
    ackAt: r.ack_at === null || r.ack_at === undefined ? null : Number(r.ack_at),
    ackBy: r.ack_by === null || r.ack_by === undefined ? null : String(r.ack_by),
    resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
    lastRaisedAt: Number(r.last_raised_at ?? raisedAt),
    occurrences: Number(r.occurrences ?? 1) >= 1 ? Number(r.occurrences) : 1,
    trace: parseTrace(r.trace as string | null),
  };
}

export class SqliteStore implements PersistStore {
  readonly filePath: string;
  private db: Db | null = null;
  /** 降级模式：初始化彻底失败（磁盘/迁移都救不回）时为 true，读写走内存兜底。 */
  readonly degraded: boolean;
  private mem = defaultState();
  private settingsCache: PersistedSettings;
  private logger: DbLogger;
  private onWriteError?: (err: Error | null) => void;
  /** 上一次写失败是否已通报（首败才报，恢复时报一次；避免 5s 同步刷屏）。 */
  private writeFailed = false;

  constructor(
    dir: string,
    filename = 'svesc-state.db',
    options: { logger?: DbLogger; onWriteError?: (err: Error | null) => void; legacyJsonPath?: string } = {},
  ) {
    this.filePath = path.join(dir, filename);
    this.logger = options.logger ?? (() => {});
    this.onWriteError = options.onWriteError;
    this.settingsCache = defaultState().settings;
    let opened: Db | null = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      opened = new DatabaseSync(this.filePath);
      this.init(opened, options.legacyJsonPath ?? path.join(dir, 'svesc-state.json'));
      this.db = opened;
      this.degraded = false;
      this.logger('info', `SQLite 就绪（${this.filePath}，schema v${this.userVersion(this.db)}）`);
    } catch (err) {
      // 初始化失败：先关掉半开的句柄，再降级内存库——app 必须能启动
      try {
        opened?.close();
      } catch {
        /* 忽略关闭失败 */
      }
      this.logger('error', `SQLite 初始化失败，已降级为内存模式（本次运行数据不落盘）：${err instanceof Error ? err.message : String(err)}`);
      this.onWriteError?.(err instanceof Error ? err : new Error(String(err)));
      this.db = null;
      this.degraded = true;
    }
  }

  // ———————— 初始化与迁移 ————————

  private userVersion(db: Db | null): number {
    if (!db) return 0;
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  private init(db: Db, legacyJsonPath: string): void {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 3000;');
    db.exec('PRAGMA foreign_keys = ON;');

    // 注意：此处必须用传入的 db 句柄查版本（this.db 要等 init 成功后才赋值）
    const from = this.userVersion(db);
    if (from < LATEST_VERSION) {
      for (const migration of MIGRATIONS) {
        if (migration.version <= from) continue;
        // 每个迁移整体事务：任一语句失败即整体回滚，user_version 不前进
        db.exec('BEGIN;');
        try {
          for (const sql of migration.statements) db.exec(sql);
          db.exec(`PRAGMA user_version = ${migration.version};`);
          db.exec('COMMIT;');
          this.logger('info', `数据库迁移 v${migration.version}：${migration.name}`);
        } catch (err) {
          db.exec('ROLLBACK;');
          throw new Error(`迁移 v${migration.version}（${migration.name}）失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 旧版 JSON 数据平滑导入：仅新库（settings 表为空）且旧文件存在时执行一次
    const hasData = (db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n > 0;
    if (!hasData && fs.existsSync(legacyJsonPath)) {
      this.importLegacyJson(db, legacyJsonPath);
    }

    this.settingsCache = this.readSettings(db);
  }

  /** 旧版 svesc-state.json → SQLite。成功后改名 *.migrated（不删数据，可回退）。 */
  private importLegacyJson(db: Db, legacyPath: string): void {
    try {
      const raw = fs.readFileSync(legacyPath, 'utf8');
      const obj = JSON.parse(raw) as Partial<PersistedState>;
      const legacy = defaultState();
      if (obj.settings && typeof obj.settings === 'object') {
        legacy.settings = { ...legacy.settings, ...obj.settings } as PersistedSettings;
      }
      if (obj.aliases && typeof obj.aliases === 'object') legacy.aliases = obj.aliases;
      if (Array.isArray(obj.knownDeviceKeys)) legacy.knownDeviceKeys = obj.knownDeviceKeys;
      if (obj.firstSeen && typeof obj.firstSeen === 'object') legacy.firstSeen = obj.firstSeen as Record<string, number>;
      if (Array.isArray(obj.alarms)) legacy.alarms = obj.alarms;
      if (obj.printers?.manual) legacy.printers.manual = obj.printers.manual;
      if (obj.printers?.ignored) legacy.printers.ignored = obj.printers.ignored;

      const now = Date.now();
      db.exec('BEGIN;');
      try {
        const putSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
        for (const [k, v] of Object.entries(legacy.settings)) putSetting.run(k, JSON.stringify(v), now);
        const putAlias = db.prepare('INSERT OR REPLACE INTO aliases (key, alias, updated_at) VALUES (?, ?, ?)');
        for (const [k, v] of Object.entries(legacy.aliases)) putAlias.run(k, v, now);
        const putKey = db.prepare('INSERT OR IGNORE INTO known_device_keys (key, added_at) VALUES (?, ?)');
        for (const key of legacy.knownDeviceKeys.slice(-2000)) putKey.run(key, now);
        const putDev = db.prepare(
          'INSERT OR IGNORE INTO devices (ip, mac, hostname, vendor, kind, state, first_seen, last_seen, ip_conflict, updated_at) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, ?, 0, ?)',
        );
        for (const [ip, ts] of Object.entries(legacy.firstSeen)) {
          if (!isValidIpv4(ip) || typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
          // 旧 JSON 只有 firstSeen 表：state 记 'unknown'（下一轮扫描 upsert 即被真实观测覆盖）
          putDev.run(ip, 'unknown', ts, ts, now);
        }
        const putAlarm = db.prepare(
          `INSERT OR REPLACE INTO alarms (id, code, severity, target_type, target_id, target_name, message, detail,
             raised_at, ack_at, ack_by, resolved_at, last_raised_at, occurrences, trace, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const a of legacy.alarms.slice(-500)) {
          if (!a || typeof a !== 'object' || typeof a.id !== 'string' || typeof a.raisedAt !== 'number') continue;
          putAlarm.run(
            a.id, a.code, a.severity, a.targetType, a.targetId, a.targetName, a.message, a.detail ?? null,
            a.raisedAt, a.ackAt ?? null, a.ackBy ?? null, a.resolvedAt ?? null,
            a.lastRaisedAt ?? a.raisedAt, a.occurrences ?? 1, JSON.stringify(a.trace ?? []), now,
          );
        }
        const putManual = db.prepare('INSERT OR REPLACE INTO printers_manual (ip, note, added_at) VALUES (?, ?, ?)');
        for (const m of legacy.printers.manual) {
          if (typeof m?.ip === 'string' && isValidIpv4(m.ip)) putManual.run(m.ip, m.note ?? null, m.addedAt ?? now);
        }
        const putIgnored = db.prepare('INSERT OR IGNORE INTO printers_ignored (printer_id, added_at) VALUES (?, ?)');
        for (const id of legacy.printers.ignored) {
          if (typeof id === 'string') putIgnored.run(id, now);
        }
        db.exec('COMMIT;');
        // 导入成功后旧文件改名保留（数据可回退；userData 目录不受打包层删除保护约束）
        try {
          fs.renameSync(legacyPath, `${legacyPath}.migrated`);
        } catch {
          this.logger('warn', '旧状态文件改名失败（保留原文件；下次启动会重复导入但不丢数据）');
        }
        this.logger('info', `旧版 JSON 状态已导入 SQLite（别名 ${Object.keys(legacy.aliases).length} 条 / 告警 ${legacy.alarms.length} 条 / 设备 ${Object.keys(legacy.firstSeen).length} 台）`);
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
    } catch (err) {
      // 导入失败不阻断启动：旧文件原样保留，下次启动重试
      this.logger('warn', `旧版 JSON 导入失败（保留原文件，下次启动重试）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ———————— 内部工具 ————————

  /** 统一写错误出口：首败通报 + 恢复通报（对齐 JsonStore 的 H-3 模式），异常绝不外抛。 */
  private safe<T>(what: string, fallback: T, fn: () => T): T {
    if (!this.db) return fallback;
    try {
      const out = fn();
      if (this.writeFailed) {
        this.writeFailed = false;
        this.onWriteError?.(null);
        this.logger('info', `SQLite 写入已恢复（${what}）`);
      }
      return out;
    } catch (err) {
      if (!this.writeFailed) {
        this.writeFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger('error', `SQLite 写入失败（${what}）：${msg}`);
        this.onWriteError?.(err instanceof Error ? err : new Error(msg));
      }
      return fallback;
    }
  }

  private readSettings(db: Db): PersistedSettings {
    const d = defaultState().settings;
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const pick = <K extends keyof PersistedSettings>(key: K, fallback: PersistedSettings[K]): PersistedSettings[K] => {
      const raw = map.get(key);
      if (raw === undefined) return fallback;
      try {
        const parsed = JSON.parse(raw) as PersistedSettings[K];
        return typeof parsed === typeof fallback ? parsed : fallback;
      } catch {
        return fallback;
      }
    };
    return {
      autoScan: pick('autoScan', d.autoScan),
      autoScanIntervalSec: pick('autoScanIntervalSec', d.autoScanIntervalSec),
      showVirtualPrinters: pick('showVirtualPrinters', d.showVirtualPrinters),
      snmpEnabled: pick('snmpEnabled', d.snmpEnabled),
      useMdns: pick('useMdns', d.useMdns),
      notifyDesktop: pick('notifyDesktop', d.notifyDesktop),
      closeToTray: pick('closeToTray', d.closeToTray),
      rememberRouterPassword: pick('rememberRouterPassword', d.rememberRouterPassword),
      notifyWebhookUrl: pick('notifyWebhookUrl', d.notifyWebhookUrl),
    };
  }

  // ———————— PersistStore 实现 ————————

  get settings(): PersistedSettings {
    return { ...this.settingsCache };
  }

  /** 兼容引擎 hydrate 路径：组装与 JsonStore.get() 同形状的完整状态。 */
  get(): PersistedState {
    if (!this.db) return { ...this.mem, settings: { ...this.settingsCache } };
    return this.safe('get', { ...this.mem, settings: { ...this.settingsCache } }, () => {
      const db = this.db as Db;
      const aliases: Record<string, string> = {};
      for (const r of db.prepare('SELECT key, alias FROM aliases').all() as { key: string; alias: string }[]) {
        aliases[r.key] = r.alias;
      }
      const knownDeviceKeys = (
        db.prepare('SELECT key FROM known_device_keys ORDER BY added_at ASC').all() as { key: string }[]
      ).map((r) => r.key);
      const firstSeen: Record<string, number> = {};
      for (const r of db.prepare('SELECT ip, first_seen FROM devices').all() as { ip: string; first_seen: number }[]) {
        firstSeen[r.ip] = Number(r.first_seen);
      }
      const alarms = (db.prepare('SELECT * FROM alarms ORDER BY raised_at ASC').all() as Record<string, unknown>[]).map(alarmFromRow);
      const manual = (
        db.prepare('SELECT ip, note, added_at FROM printers_manual ORDER BY added_at ASC').all() as unknown as {
          ip: string;
          note: string | null;
          added_at: number;
        }[]
      ).map((m) => ({ ip: m.ip, note: m.note ?? null, addedAt: Number(m.added_at) }));
      const ignored = (db.prepare('SELECT printer_id FROM printers_ignored').all() as { printer_id: string }[]).map((r) => r.printer_id);
      // task-025：备注 / 标签 / 监控目标
      const deviceNotes: Record<string, string> = {};
      for (const r of db.prepare('SELECT key, note FROM device_notes').all() as { key: string; note: string }[]) {
        deviceNotes[r.key] = r.note;
      }
      const deviceTags: Record<string, string[]> = {};
      for (const r of db.prepare('SELECT key, tags FROM device_tags').all() as { key: string; tags: string }[]) {
        const tags = normalizeTags(parseTagsJson(r.tags));
        if (tags.length > 0) deviceTags[r.key] = tags;
      }
      const watchList: WatchTarget[] = (
        db.prepare('SELECT ip, note, added_at FROM watch_targets ORDER BY added_at ASC').all() as unknown as {
          ip: string;
          note: string | null;
          added_at: number;
        }[]
      )
        .filter((w) => isValidIpv4(w.ip))
        .map((w) => ({ ip: w.ip, note: w.note ?? null, addedAt: Number(w.added_at) }));
      return {
        version: 1,
        aliases,
        alarms,
        knownDeviceKeys,
        firstSeen,
        settings: { ...this.settingsCache },
        printers: { manual, ignored },
        deviceNotes,
        deviceTags,
        watchList,
      } satisfies PersistedState;
    });
  }

  aliasOf(deviceId: string): string | null {
    if (!this.db) return this.mem.aliases[deviceId] ?? null;
    const row = this.safe(
      'aliasOf',
      undefined,
      () => this.db?.prepare('SELECT alias FROM aliases WHERE key = ?').get(deviceId) as { alias: string } | undefined,
    );
    return row ? row.alias : (this.mem.aliases[deviceId] ?? null);
  }

  setAlias(deviceId: string, alias: string | null): void {
    if (!alias || !alias.trim()) {
      delete this.mem.aliases[deviceId];
      this.safe('setAlias(delete)', undefined, () => {
        this.db?.prepare('DELETE FROM aliases WHERE key = ?').run(deviceId);
      });
      return;
    }
    const clean = alias.trim();
    this.mem.aliases[deviceId] = clean;
    this.safe('setAlias', undefined, () => {
      this.db?.prepare('INSERT OR REPLACE INTO aliases (key, alias, updated_at) VALUES (?, ?, ?)').run(deviceId, clean, Date.now());
    });
  }

  // —— 设备备注 / 标签 / 监控目标（task-025，与 JsonStore 同构） ——

  noteOf(deviceId: string): string | null {
    if (!this.db) return this.mem.deviceNotes[deviceId] ?? null;
    const row = this.safe(
      'noteOf',
      undefined,
      () => this.db?.prepare('SELECT note FROM device_notes WHERE key = ?').get(deviceId) as { note: string } | undefined,
    );
    return row ? row.note : (this.mem.deviceNotes[deviceId] ?? null);
  }

  setNote(deviceId: string, note: string | null): void {
    if (!note || !note.trim()) {
      delete this.mem.deviceNotes[deviceId];
      this.safe('setNote(delete)', undefined, () => {
        this.db?.prepare('DELETE FROM device_notes WHERE key = ?').run(deviceId);
      });
      return;
    }
    const clean = note.trim().slice(0, 200);
    this.mem.deviceNotes[deviceId] = clean;
    this.safe('setNote', undefined, () => {
      this.db?.prepare('INSERT OR REPLACE INTO device_notes (key, note, updated_at) VALUES (?, ?, ?)').run(deviceId, clean, Date.now());
    });
  }

  tagsOf(deviceId: string): string[] | null {
    if (!this.db) return this.mem.deviceTags[deviceId] ?? null;
    const row = this.safe(
      'tagsOf',
      undefined,
      () => this.db?.prepare('SELECT tags FROM device_tags WHERE key = ?').get(deviceId) as { tags: string } | undefined,
    );
    if (!row) return this.mem.deviceTags[deviceId] ?? null;
    const tags = normalizeTags(parseTagsJson(row.tags));
    return tags.length > 0 ? tags : null;
  }

  setTags(deviceId: string, tags: string[] | null): void {
    const normalized = normalizeTags(tags);
    if (normalized.length === 0) {
      delete this.mem.deviceTags[deviceId];
      this.safe('setTags(delete)', undefined, () => {
        this.db?.prepare('DELETE FROM device_tags WHERE key = ?').run(deviceId);
      });
      return;
    }
    this.mem.deviceTags[deviceId] = normalized;
    this.safe('setTags', undefined, () => {
      this.db
        ?.prepare('INSERT OR REPLACE INTO device_tags (key, tags, updated_at) VALUES (?, ?, ?)')
        .run(deviceId, JSON.stringify(normalized), Date.now());
    });
  }

  watchTargets(): WatchTarget[] {
    if (!this.db) return this.mem.watchList.map((w) => ({ ...w }));
    const rows = this.safe(
      'watchTargets',
      [] as WatchTarget[],
      () =>
        (
          this.db?.prepare('SELECT ip, note, added_at FROM watch_targets ORDER BY added_at ASC').all() as unknown as {
            ip: string;
            note: string | null;
            added_at: number;
          }[]
        )
          .filter((w) => isValidIpv4(w.ip))
          .map((w) => ({ ip: w.ip, note: w.note ?? null, addedAt: Number(w.added_at) })),
    );
    return rows.map((w) => ({ ...w }));
  }

  addWatchTarget(ip: string, note: string | null): { ok: boolean; error: string | null } {
    const trimmed = String(ip ?? '').trim();
    if (!isValidIpv4(trimmed)) return { ok: false, error: `IP 地址无效：${ip}` };
    const cleanNote = note && note.trim() ? note.trim().slice(0, 40) : null;
    // mem 层幂等（db 不可用时兜底），db 层 upsert
    const memList = this.mem.watchList;
    const existing = memList.find((w) => w.ip === trimmed);
    if (existing) existing.note = cleanNote;
    else memList.push({ ip: trimmed, addedAt: Date.now(), note: cleanNote });
    this.safe('addWatchTarget', undefined, () => {
      this.db
        ?.prepare(
          `INSERT INTO watch_targets (ip, note, added_at) VALUES (?, ?, ?)
           ON CONFLICT(ip) DO UPDATE SET note = excluded.note`,
        )
        .run(trimmed, cleanNote, existing ? existing.addedAt : Date.now());
    });
    return { ok: true, error: null };
  }

  removeWatchTarget(ip: string): { ok: boolean } {
    const trimmed = String(ip ?? '').trim();
    const before = this.mem.watchList.length;
    this.mem.watchList = this.mem.watchList.filter((w) => w.ip !== trimmed);
    this.safe('removeWatchTarget', undefined, () => {
      this.db?.prepare('DELETE FROM watch_targets WHERE ip = ?').run(trimmed);
    });
    return { ok: true };
  }

  setSettings(patch: Partial<PersistedSettings>): void {
    this.settingsCache = { ...this.settingsCache, ...patch };
    this.safe('setSettings', undefined, () => {
      const db = this.db as Db;
      const put = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
      const now = Date.now();
      db.exec('BEGIN;');
      try {
        for (const [k, v] of Object.entries(patch)) put.run(k, JSON.stringify(v), now);
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
    });
  }

  printerManage(): PrinterManageConfig {
    if (!this.db) {
      return { manual: this.mem.printers.manual.map((m) => ({ ...m })), ignored: [...this.mem.printers.ignored] };
    }
    return this.safe(
      'printerManage',
      { manual: [], ignored: [] },
      () => {
        const db = this.db as Db;
        const manual = (
          db.prepare('SELECT ip, note, added_at FROM printers_manual ORDER BY added_at ASC').all() as {
            ip: string;
            note: string | null;
            added_at: number;
          }[]
        ).map((m) => ({ ip: m.ip, note: m.note ?? null, addedAt: Number(m.added_at) }));
        const ignored = (db.prepare('SELECT printer_id FROM printers_ignored').all() as { printer_id: string }[]).map(
          (r) => r.printer_id,
        );
        return { manual, ignored };
      },
    );
  }

  addManualPrinter(ip: string, note: string | null): { ok: boolean; error: string | null } {
    const trimmed = ip.trim();
    if (!isValidIpv4(trimmed)) return { ok: false, error: `IP 地址无效：${ip}` };
    const cleanNote = note && note.trim() ? note.trim().slice(0, 40) : null;
    if (!this.db) {
      const existing = this.mem.printers.manual.find((m) => m.ip === trimmed);
      if (existing) existing.note = cleanNote;
      else this.mem.printers.manual.push({ ip: trimmed, note: cleanNote, addedAt: Date.now() });
      return { ok: true, error: null };
    }
    const res = this.safe('addManualPrinter', null as null | { changes: number; lastInsertRowid: number | bigint }, () =>
      this.db
        ?.prepare(
          'INSERT INTO printers_manual (ip, note, added_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET note = excluded.note',
        )
        .run(trimmed, cleanNote, Date.now()),
    );
    return res === undefined ? { ok: false, error: '数据库写入失败' } : { ok: true, error: null };
  }

  removeManualPrinter(ip: string): { ok: boolean } {
    const trimmed = ip.trim();
    if (!this.db) {
      const before = this.mem.printers.manual.length;
      this.mem.printers.manual = this.mem.printers.manual.filter((m) => m.ip !== trimmed);
      return { ok: true };
    }
    this.safe('removeManualPrinter', undefined, () => {
      this.db?.prepare('DELETE FROM printers_manual WHERE ip = ?').run(trimmed);
    });
    return { ok: true };
  }

  setPrinterIgnored(printerId: string, ignored: boolean): void {
    if (!this.db) {
      const set = new Set(this.mem.printers.ignored);
      if (ignored) set.add(printerId);
      else set.delete(printerId);
      this.mem.printers.ignored = Array.from(set);
      return;
    }
    this.safe('setPrinterIgnored', undefined, () => {
      if (ignored) this.db?.prepare('INSERT OR IGNORE INTO printers_ignored (printer_id, added_at) VALUES (?, ?)').run(printerId, Date.now());
      else this.db?.prepare('DELETE FROM printers_ignored WHERE printer_id = ?').run(printerId);
    });
  }

  /** 告警历史 + 已知设备种整体落账（引擎 stop 时全量兜底；单条实时路径见 upsertAlarm）。 */
  setAlarmHistory(alarms: Alarm[], knownDeviceKeys: string[]): void {
    this.mem.alarms = alarms.slice(-500);
    this.mem.knownDeviceKeys = knownDeviceKeys.slice(-2000);
    this.safe('setAlarmHistory', undefined, () => {
      const db = this.db as Db;
      const now = Date.now();
      const putAlarm = db.prepare(
        `INSERT OR REPLACE INTO alarms (id, code, severity, target_type, target_id, target_name, message, detail,
           raised_at, ack_at, ack_by, resolved_at, last_raised_at, occurrences, trace, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const putKey = db.prepare('INSERT OR REPLACE INTO known_device_keys (key, added_at) VALUES (?, ?)');
      db.exec('BEGIN;');
      try {
        for (const a of alarms.slice(-500)) {
          putAlarm.run(
            a.id, a.code, a.severity, a.targetType, a.targetId, a.targetName, a.message, a.detail ?? null,
            a.raisedAt, a.ackAt ?? null, a.ackBy ?? null, a.resolvedAt ?? null,
            a.lastRaisedAt ?? a.raisedAt, a.occurrences ?? 1, JSON.stringify(Array.isArray(a.trace) ? a.trace : []), now,
          );
        }
        for (const key of knownDeviceKeys.slice(-2000)) putKey.run(key, now);
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
    });
  }

  /** 单条告警实时落库（onAlarm 推送路径）：崩溃不丢新告警。 */
  upsertAlarm(alarm: Alarm): void {
    this.safe('upsertAlarm', undefined, () => {
      this.db
        ?.prepare(
          `INSERT OR REPLACE INTO alarms (id, code, severity, target_type, target_id, target_name, message, detail,
             raised_at, ack_at, ack_by, resolved_at, last_raised_at, occurrences, trace, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          alarm.id, alarm.code, alarm.severity, alarm.targetType, alarm.targetId, alarm.targetName, alarm.message,
          alarm.detail ?? null, alarm.raisedAt, alarm.ackAt ?? null, alarm.ackBy ?? null, alarm.resolvedAt ?? null,
          alarm.lastRaisedAt ?? alarm.raisedAt, alarm.occurrences ?? 1,
          JSON.stringify(Array.isArray(alarm.trace) ? alarm.trace : []), Date.now(),
        );
    });
  }

  setFirstSeen(map: Record<string, number>): void {
    this.mem.firstSeen = { ...map };
    this.safe('setFirstSeen', undefined, () => {
      const db = this.db as Db;
      const now = Date.now();
      const put = db.prepare(
        'INSERT INTO devices (ip, state, first_seen, last_seen, ip_conflict, updated_at) VALUES (?, ?, ?, ?, 0, ?) ' +
          'ON CONFLICT(ip) DO NOTHING',
      );
      db.exec('BEGIN;');
      try {
        for (const [ip, ts] of Object.entries(map)) {
          if (!isValidIpv4(ip) || typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
          put.run(ip, 'unknown', ts, ts, now);
        }
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
    });
  }

  // ———————— 设备实时状态同步（task-018） ————————

  /**
   * 设备状态快照同步（引擎每 15s / 状态变化时调用）。
   * 事务内逐行 upsert；与库中上一次 state 对比，变化（含首次出现）写一条 device_status_log；
   * 演示设备（id 以 sim- 开头）不入库。返回本轮发生状态转移的 IP 数（供调用方诊断日志）。
   */
  upsertDeviceStates(devices: Device[]): number {
    if (!this.db) {
      for (const d of devices) {
        if (d.id.startsWith('sim-')) continue;
        this.mem.firstSeen[d.ip] = d.firstSeen;
      }
      return 0;
    }
    return this.safe('upsertDeviceStates', 0, () => {
      const db = this.db as Db;
      const now = Date.now();
      const upsert = db.prepare(
        `INSERT INTO devices (ip, mac, hostname, vendor, kind, state, first_seen, last_seen, ip_conflict, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET
           mac = excluded.mac, hostname = excluded.hostname, vendor = excluded.vendor, kind = excluded.kind,
           state = excluded.state, last_seen = excluded.last_seen, ip_conflict = excluded.ip_conflict,
           updated_at = excluded.updated_at,
           -- first_seen 只减不增：持久化的"首次接入"绝不能被扫描时钟改写
           first_seen = MIN(devices.first_seen, excluded.first_seen)`,
      );
      const getState = db.prepare('SELECT state FROM devices WHERE ip = ?');
      const insertLog = db.prepare(
        'INSERT INTO device_status_log (ip, state, at, latency_ms, detail) VALUES (?, ?, ?, ?, ?)',
      );
      let transitions = 0;
      db.exec('BEGIN;');
      try {
        for (const d of devices) {
          if (d.id.startsWith('sim-')) continue;
          const prev = getState.get(d.ip) as { state: string } | undefined;
          upsert.run(
            d.ip, d.mac, d.hostname, d.vendor, d.kind, d.state,
            d.firstSeen, d.lastSeen, d.ipConflict ? 1 : 0, now,
          );
          if (!prev || prev.state !== d.state) {
            insertLog.run(
              d.ip, d.state, now,
              d.quality.latencyMs !== null && Number.isFinite(d.quality.latencyMs) ? Math.round(d.quality.latencyMs) : null,
              prev ? null : '首次记录',
            );
            transitions += 1;
          }
        }
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
      if (transitions > 0) this.pruneStatusLog();
      return transitions;
    });
  }

  /** 状态日志有界化：超上限删最旧（低频路径，COUNT 一次成本可忽略）。 */
  private pruneStatusLog(): void {
    if (!this.db) return;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM device_status_log').get() as { n: number };
    if (row.n <= DEVICE_STATUS_LOG_MAX) return;
    this.safe('pruneStatusLog', undefined, () => {
      this.db
        ?.prepare(
          'DELETE FROM device_status_log WHERE id IN (SELECT id FROM device_status_log ORDER BY id ASC LIMIT ?)',
        )
        .run(row.n - DEVICE_STATUS_LOG_MAX);
    });
  }

  /** 设备状态历史（诊断/测试用）：某 IP 最近 limit 条状态记录，时间倒序。 */
  getDeviceStatusHistory(ip: string, limit = 50): { state: string; at: number; latencyMs: number | null }[] {
    if (!this.db) return [];
    return this.safe('getDeviceStatusHistory', [], () => {
      const rows = this.db
        ?.prepare('SELECT state, at, latency_ms FROM device_status_log WHERE ip = ? ORDER BY at DESC, id DESC LIMIT ?')
        .all(ip, limit) as { state: string; at: number; latency_ms: number | null }[];
      return (rows ?? []).map((r) => ({ state: r.state, at: Number(r.at), latencyMs: r.latency_ms === null ? null : Number(r.latency_ms) }));
    });
  }

  // ———————— 生命周期 ————————

  /** node:sqlite 为同步写入（每次写已即时落库）；此处做 WAL checkpoint 归位。 */
  flush(): void {
    this.safe('flush(checkpoint)', undefined, () => {
      this.db?.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    });
  }

  close(): void {
    if (!this.db) return;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      this.db.close();
    } catch (err) {
      this.logger('warn', `SQLite 关闭异常（不影响退出）：${err instanceof Error ? err.message : String(err)}`);
    }
    this.db = null;
  }
}
