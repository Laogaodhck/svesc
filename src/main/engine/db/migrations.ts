/**
 * SQLite 迁移定义（task-018）。
 *
 * 版本管理基于 `PRAGMA user_version`：
 *  - 新库从 0 开始，按序执行 MIGRATIONS 直到追平最新版本；
 *  - 每个迁移整体包在一个事务里，任何一条 SQL 失败即整体回滚并向上抛出
 *    （由 SqliteStore 统一兜底降级，绝不让应用崩在启动路径上）；
 *  - 旧版本升级 = 在数组末尾追加新迁移，永远不改写历史条目。
 *
 * 字段规约：所有表带时间戳字段（updated_at / added_at / at）；
 * 高频查询路径（设备状态、告警时间线）建索引。
 */

export interface Migration {
  /** 执行完本迁移后的 user_version 值（必须严格递增 +1） */
  version: number;
  name: string;
  statements: string[];
}

/** 设备状态历史上限（超出裁最旧；状态转移是低频事件，1 万条足够回溯）。 */
export const DEVICE_STATUS_LOG_MAX = 10_000;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '初始 schema：设置/别名/已知设备/设备状态/状态日志/告警/打印管理',
    statements: [
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS aliases (
        key TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS known_device_keys (
        key TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS devices (
        ip TEXT PRIMARY KEY,
        mac TEXT,
        hostname TEXT,
        vendor TEXT,
        kind TEXT,
        state TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        ip_conflict INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_devices_state ON devices(state)`,
      `CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen)`,
      `CREATE TABLE IF NOT EXISTS device_status_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL,
        state TEXT NOT NULL,
        at INTEGER NOT NULL,
        latency_ms INTEGER,
        detail TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_status_log_ip_at ON device_status_log(ip, at)`,
      `CREATE TABLE IF NOT EXISTS alarms (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        severity TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_name TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT,
        raised_at INTEGER NOT NULL,
        ack_at INTEGER,
        ack_by TEXT,
        resolved_at INTEGER,
        last_raised_at INTEGER NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 1,
        trace TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_alarms_key ON alarms(code, target_id)`,
      `CREATE INDEX IF NOT EXISTS idx_alarms_raised ON alarms(raised_at)`,
      `CREATE TABLE IF NOT EXISTS printers_manual (
        ip TEXT PRIMARY KEY,
        note TEXT,
        added_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS printers_ignored (
        printer_id TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'task-025：设备备注/标签 + 持续 Ping 监控目标',
    statements: [
      `CREATE TABLE IF NOT EXISTS device_notes (
        key TEXT PRIMARY KEY,
        note TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS device_tags (
        key TEXT PRIMARY KEY,
        tags TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS watch_targets (
        ip TEXT PRIMARY KEY,
        note TEXT,
        added_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 3,
    name: '告警功能移除：DROP alarms / known_device_keys（回滚旧版本会按 v1 重建空表，无数据损失）',
    statements: ['DROP TABLE IF EXISTS alarms', 'DROP INDEX IF EXISTS idx_alarms_key', 'DROP INDEX IF EXISTS idx_alarms_raised', 'DROP TABLE IF EXISTS known_device_keys'],
  },
];
