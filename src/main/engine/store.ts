/**
 * JSON 持久化：别名、告警历史、设置。
 *
 * **不 import electron** —— 目录由调用方注入（`app.getPath('userData')`），
 * 这样引擎层可以在纯 Node 下被测试与 engine-check 驱动。
 * 写入 300ms debounce；文件损坏自动重建，绝不让应用崩在启动路径上。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ManualPrinterEntry, PrinterManageConfig, WatchTarget } from '../../shared/types';

export interface PersistedSettings {
  autoScan: boolean;
  autoScanIntervalSec: number;
  /** 打印机页是否显示本机虚拟打印机（审计后从会话态升级为持久化） */
  showVirtualPrinters: boolean;
  /** SNMP 耗材采集开关（设置页运行时可改，下一轮打印机刷新生效） */
  snmpEnabled: boolean;
  /** mDNS 打印机发现开关（增强路径，默认关闭） */
  useMdns: boolean;
  /** 点关闭按钮时最小化到托盘（默认开启；托盘菜单"退出"始终真退出） */
  closeToTray: boolean;
  /** 打印机异常/恢复的系统通知（默认开启；被忽略与演示打印机不参与） */
  printerAlerts: boolean;
  /** 是否记住路由器登录凭据（task-022 B-1，默认 true；关闭即清盘上凭据并停用自动重登） */
  rememberRouterPassword: boolean;
}

export interface PersistedState {
  version: number;
  aliases: Record<string, string>;
  /** 设备首次接入时间（key = IP，unix ms）。跨重启保留"真正第一次见到它"的时刻。 */
  firstSeen: Record<string, number>;
  settings: PersistedSettings;
  /** 打印管理页配置：手动添加的打印机 + 被忽略的自动发现条目 */
  printers: { manual: ManualPrinterEntry[]; ignored: string[] };
  /** 设备备注（key = deviceId，task-025） */
  deviceNotes: Record<string, string>;
  /** 设备标签（key = deviceId，task-025；已归一化） */
  deviceTags: Record<string, string[]>;
  /** 持续 Ping 监控目标（task-025） */
  watchList: WatchTarget[];
}

export const STORE_VERSION = 1;

/**
 * 持久化后端的统一接口（task-018）：JsonStore（JSON 文件，兼容/降级/测试用）
 * 与 SqliteStore（SQLite 主存储）都实现它。引擎门面只面向本接口编程，
 * 切换存储后端不改任何业务代码。
 */
export interface PersistStore {
  readonly settings: PersistedSettings;
  get(): PersistedState;
  aliasOf(deviceId: string): string | null;
  setAlias(deviceId: string, alias: string | null): void;
  setSettings(patch: Partial<PersistedSettings>): void;
  printerManage(): PrinterManageConfig;
  addManualPrinter(ip: string, note: string | null): { ok: boolean; error: string | null };
  removeManualPrinter(ip: string): { ok: boolean };
  setPrinterIgnored(printerId: string, ignored: boolean): void;
  setFirstSeen(map: Record<string, number>): void;
  // —— 设备备注 / 标签 / 监控目标（task-025，SqliteStore 与 JsonStore 同构实现） ——
  noteOf(deviceId: string): string | null;
  setNote(deviceId: string, note: string | null): void;
  tagsOf(deviceId: string): string[] | null;
  setTags(deviceId: string, tags: string[] | null): void;
  watchTargets(): WatchTarget[];
  addWatchTarget(ip: string, note: string | null): { ok: boolean; error: string | null };
  removeWatchTarget(ip: string): { ok: boolean };
  /** 退出前同步落盘（SQLite 为 WAL checkpoint + no-op）。 */
  flush(): void;
  /** 设备实时状态同步（task-018 SQLite 扩展；JSON 后端无此能力，可选实现）。 */
  upsertDeviceStates?(devices: import('../../shared/types').Device[]): void;
  /** 设备状态历史查询（诊断/测试用，task-018）。 */
  getDeviceStatusHistory?(ip: string, limit?: number): { state: string; at: number; latencyMs: number | null }[];
}

/** 标签归一化（task-025）：trim、去空、去重、每标签 ≤24 字符、≤8 个。接受未知来源数组（导入/磁盘脏数据）。 */
export function normalizeTags(tags: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().slice(0, 24);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

export const defaultState = (): PersistedState => ({
  version: STORE_VERSION,
  aliases: {},
  firstSeen: {},
  settings: { autoScan: true, autoScanIntervalSec: 60, showVirtualPrinters: false, snmpEnabled: true, useMdns: false, closeToTray: true, printerAlerts: true, rememberRouterPassword: true },
  printers: { manual: [], ignored: [] },
  deviceNotes: {},
  deviceTags: {},
  watchList: [],
});

/** 严格 IPv4 校验（每段 0-255，不接受前导零溢出写法由 Number 转换兜底）。 */
export function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

export class JsonStore implements PersistStore {
  readonly filePath: string;
  private state: PersistedState;
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  /** 上一次 flushSync 是否失败（首次失败才通报，避免每 5s 刷屏）。 */
  private writeFailed = false;

  constructor(
    dir: string,
    filename = 'svesc-state.json',
    private readonly debounceMs = 300,
    /** 落盘失败回调（引擎层用它把故障写进快照 warnings——审计 H-3：静默丢盘不可接受）。err=null 表示恢复。 */
    private readonly onWriteError?: (err: Error | null) => void,
  ) {
    this.filePath = path.join(dir, filename);
    this.state = this.readFromDisk(dir);
  }

  private readFromDisk(dir: string): PersistedState {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 目录不可建时仍返回默认状态，不抛 */
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return defaultState();
      const obj = parsed as Partial<PersistedState>;
      return {
        version: STORE_VERSION,
        aliases: obj.aliases && typeof obj.aliases === 'object' ? obj.aliases : {},
        // firstSeen 规整：只接受合法 IPv4 key + 有限正数时间戳，脏数据直接丢弃
        firstSeen: (() => {
          const raw = obj.firstSeen;
          if (!raw || typeof raw !== 'object') return {};
          const out: Record<string, number> = {};
          for (const [ip, ts] of Object.entries(raw as Record<string, unknown>)) {
            if (!isValidIpv4(ip)) continue;
            if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
            out[ip] = ts;
          }
          return out;
        })(),
        settings: {
          autoScan: obj.settings?.autoScan ?? true,
          autoScanIntervalSec: obj.settings?.autoScanIntervalSec ?? 60,
          showVirtualPrinters: obj.settings?.showVirtualPrinters ?? false,
          snmpEnabled: obj.settings?.snmpEnabled ?? true,
          useMdns: obj.settings?.useMdns ?? false,
          closeToTray: obj.settings?.closeToTray ?? true,
          printerAlerts: obj.settings?.printerAlerts ?? true,
          rememberRouterPassword: obj.settings?.rememberRouterPassword ?? true,
        },
        // task-025：备注/标签/监控目标（形状脏数据直接丢弃，不猜）
        deviceNotes: (() => {
          const raw = obj.deviceNotes;
          if (!raw || typeof raw !== 'object') return {};
          const out: Record<string, string> = {};
          for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, 200);
          }
          return out;
        })(),
        deviceTags: (() => {
          const raw = obj.deviceTags;
          if (!raw || typeof raw !== 'object') return {};
          const out: Record<string, string[]> = {};
          for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (Array.isArray(value)) {
              const tags = normalizeTags(value as unknown[]);
              if (tags.length > 0) out[key] = tags;
            }
          }
          return out;
        })(),
        watchList: Array.isArray(obj.watchList)
          ? obj.watchList
              .filter(
                (w): w is WatchTarget =>
                  typeof w === 'object' && w !== null && isValidIpv4((w as WatchTarget).ip),
              )
              .map((w) => ({
                ip: w.ip,
                addedAt: typeof w.addedAt === 'number' && w.addedAt > 0 ? w.addedAt : Date.now(),
                note: typeof w.note === 'string' && w.note.trim() ? w.note.trim().slice(0, 40) : null,
              }))
          : [],
        printers: {
          manual: Array.isArray(obj.printers?.manual)
            ? obj.printers.manual.filter(
                (m): m is ManualPrinterEntry =>
                  typeof m === 'object' && m !== null && typeof (m as ManualPrinterEntry).ip === 'string',
              )
            : [],
          ignored: Array.isArray(obj.printers?.ignored)
            ? obj.printers.ignored.filter((id): id is string => typeof id === 'string')
            : [],
        },
      };
    } catch (err) {
      // 文件不存在 = 首次运行，静默用默认状态；其它（损坏 JSON / 权限）必须留痕——
      // 旧别名/告警历史被静默丢弃会让用户以为数据凭空消失。
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        console.error('[svesc-store] 状态文件读取失败，已用默认配置重建：', err);
      }
      return defaultState();
    }
  }

  get(): PersistedState {
    return this.state;
  }

  get settings(): PersistedSettings {
    return this.state.settings;
  }

  aliasOf(deviceId: string): string | null {
    return this.state.aliases[deviceId] ?? null;
  }

  setAlias(deviceId: string, alias: string | null): void {
    if (alias && alias.trim()) this.state.aliases[deviceId] = alias.trim();
    else delete this.state.aliases[deviceId];
    this.save();
  }

  setSettings(patch: Partial<PersistedSettings>): void {
    this.state.settings = { ...this.state.settings, ...patch };
    this.save();
  }

  /** 打印管理页配置（返回副本，调用方改动不影响内部状态）。 */
  printerManage(): PrinterManageConfig {
    return {
      manual: this.state.printers.manual.map((m) => ({ ...m })),
      ignored: [...this.state.printers.ignored],
    };
  }

  /**
   * 手动添加网络打印机。同 IP 已存在 → 更新备注（幂等，不报错）。
   * IP 非法 → { ok:false, error }，绝不落盘脏数据。
   */
  addManualPrinter(ip: string, note: string | null): { ok: boolean; error: string | null } {
    const trimmed = ip.trim();
    if (!isValidIpv4(trimmed)) return { ok: false, error: `IP 地址无效：${ip}` };
    const cleanNote = note && note.trim() ? note.trim().slice(0, 40) : null;
    const existing = this.state.printers.manual.find((m) => m.ip === trimmed);
    if (existing) {
      existing.note = cleanNote;
    } else {
      this.state.printers.manual.push({ ip: trimmed, note: cleanNote, addedAt: Date.now() });
    }
    this.save();
    return { ok: true, error: null };
  }

  removeManualPrinter(ip: string): { ok: boolean } {
    const trimmed = ip.trim();
    const before = this.state.printers.manual.length;
    this.state.printers.manual = this.state.printers.manual.filter((m) => m.ip !== trimmed);
    if (this.state.printers.manual.length !== before) this.save();
    return { ok: true };
  }

  /** 忽略/恢复自动发现的打印机。忽略列表与手动条目互不相干（手动用删除）。 */
  setPrinterIgnored(printerId: string, ignored: boolean): void {
    const set = new Set(this.state.printers.ignored);
    if (ignored) set.add(printerId);
    else set.delete(printerId);
    this.state.printers.ignored = Array.from(set);
    this.save();
  }

  /** 引擎退出时整体覆盖设备首次接入表（scheduler.exportFirstSeen 的产物）。 */
  setFirstSeen(map: Record<string, number>): void {
    this.state.firstSeen = map;
    this.save();
  }

  // —— 设备备注 / 标签 / 监控目标（task-025） ——

  noteOf(deviceId: string): string | null {
    return this.state.deviceNotes[deviceId] ?? null;
  }

  setNote(deviceId: string, note: string | null): void {
    if (note && note.trim()) this.state.deviceNotes[deviceId] = note.trim().slice(0, 200);
    else delete this.state.deviceNotes[deviceId];
    this.save();
  }

  tagsOf(deviceId: string): string[] | null {
    return this.state.deviceTags[deviceId] ?? null;
  }

  setTags(deviceId: string, tags: string[] | null): void {
    const normalized = normalizeTags(tags as readonly unknown[]);
    if (normalized.length > 0) this.state.deviceTags[deviceId] = normalized;
    else delete this.state.deviceTags[deviceId];
    this.save();
  }

  watchTargets(): WatchTarget[] {
    return this.state.watchList.map((w) => ({ ...w }));
  }

  addWatchTarget(ip: string, note: string | null): { ok: boolean; error: string | null } {
    const trimmed = String(ip ?? '').trim();
    if (!isValidIpv4(trimmed)) return { ok: false, error: `IP 地址无效：${ip}` };
    const cleanNote = note && note.trim() ? note.trim().slice(0, 40) : null;
    const existing = this.state.watchList.find((w) => w.ip === trimmed);
    if (existing) existing.note = cleanNote;
    else this.state.watchList.push({ ip: trimmed, addedAt: Date.now(), note: cleanNote });
    this.save();
    return { ok: true, error: null };
  }

  removeWatchTarget(ip: string): { ok: boolean } {
    const trimmed = String(ip ?? '').trim();
    const before = this.state.watchList.length;
    this.state.watchList = this.state.watchList.filter((w) => w.ip !== trimmed);
    if (this.state.watchList.length !== before) this.save();
    return { ok: true };
  }

  /** debounce 落盘。 */
  save(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSync();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** 立即落盘（退出前调用）。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.flushSync();
  }

  private flushSync(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
      this.dirty = false;
      // 恢复成功：清失败标记、通报恢复、清重试定时器
      if (this.writeFailed) {
        this.writeFailed = false;
        this.onWriteError?.(null);
      }
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    } catch (err) {
      // 审计修复（H-3）：磁盘满 / 权限不足时旧实现完全静默——若此后再无写操作，
      // dirty 数据永不落盘且用户全程不可知。现在：首次失败经 onWriteError 写进
      // 快照 warnings，并挂 5s 周期重试直到成功。
      if (!this.writeFailed) {
        this.writeFailed = true;
        this.onWriteError?.(err instanceof Error ? err : new Error(String(err)));
      }
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.flushSync();
        }, 5000);
        this.retryTimer.unref?.();
      }
    }
  }
}
