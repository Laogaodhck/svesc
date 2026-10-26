/**
 * 扫描编排 + 分频调度 + 快照组装。
 *
 * 实测耗时账（investigation-report.md §9.4）：
 *   1. `arp -a`              83-90ms   → 建立"在位集合"
 *   2. 254 × ping -n 1 -w 800 @64     → ≈6.0s
 *   3. 再读 `arp -a`          → 新出现的 ARP 条目也算在线（能捞到禁 ping 但发过 ARP 的主机）
 *   4. 端口探测只对候选设备（ARP 在位 ∪ ping 存活）→ 9100/631/515 / 445/3389 / 80/443
 *   5. 总预算 10s，超预算用已得结果出快照（保证 UI 1s 内有反馈）
 *
 * 状态判定严格按 plan.md §5.1 的 6 级优先级：ARP 在位 = 在线，**ICMP 超时绝不判离线**。
 */
import type {
  BandwidthPoint,
  DataSource,
  Device,
  DeviceDetail,
  NetQuality,
  Printer,
  RouterHints,
  ScanProgress,
  Snapshot,
  SystemStat,
  WarningEntry,
  WatchStatus,
  WatchTarget,
} from '../../shared/types';
import {
  CONCURRENCY,
  DEMO_DEVICE_THRESHOLD,
  HEARTBEAT_PROBE,
  PROBE_PORTS,
  PORT_SERVICE,
  QUALITY_SAMPLE,
  SCAN_BUDGET_MS,
  SCHEDULE,
  TIMEOUTS,
  WATCH,
  WINDOW,
} from '../../shared/constants';
import { WatchManager } from './watch';
import { readArp, type ArpEntry, type ArpScanResult } from './discovery/arp';
import { pingSweep, pingQuality } from './discovery/ping';
import { probeHosts } from './discovery/ports';
import { inferFingerprint } from './discovery/fingerprint';
import { lookupVendor, isRandomizedMac } from './discovery/oui';
import { ReverseDnsCache } from './discovery';
import { discoverMdnsDevices, type MdnsDeviceHint } from './discovery/mdns-devices';
import { discoverCamerasWsdiscovery, type WsdCameraHint } from './discovery/wsdiscovery';
import { discoverSsdpDevices, type SsdpDeviceHint } from './discovery/ssdp-devices';
import { discoverHttpFingerprints, type HttpFingerprintHint } from './discovery/http-fingerprint';
import {
  discoverOnvifDevices,
  ONVIF_MAX_TARGETS,
  ONVIF_PORTS,
  type OnvifHint,
  type OnvifProbeTarget,
} from './discovery/onvif-http';
import { queryNetbiosNames, NBTSTAT_MAX_HOSTS } from './discovery/netbios';
import { QualityTracker } from './network/monitor';
import { isDegraded } from './network/quality';
import { BandwidthMeter, readConnections, type BandwidthSample } from './network/bandwidth';
import { readSpooler } from './printers/spooler';
import { collectPrinters, hasFault } from './printers/printer-service';
import { discoverMdnsPrinters } from './printers/mdns';
import { Simulator } from './simulator';

export interface SchedulerConfig {
  /** /24 前缀，如 `192.168.2.`；无可用网段时为 null（引擎降级为 demo） */
  prefix: string | null;
  /** 扫描目标（.1-.254） */
  hosts: string[];
  selfIp: string | null;
  gateway: string | null;
  /** 网段展示串，如 192.168.2.0/24 */
  subnetLabel: string | null;
  autoScanIntervalSec: number;
  /** LAN_DEMO=1 强制演示数据源 */
  forceDemo: boolean;
  snmpEnabled: boolean;
  useMdns: boolean;
}

export interface SchedulerHooks {
  onSnapshot?: (snapshot: Snapshot) => void;
  onScanProgress?: (progress: ScanProgress) => void;
  nextRequestId?: () => number;
  /** 打印管理页配置提供者（手动打印机 + 忽略列表）；未注入 = 无管理配置 */
  getPrinterManage?: () => { manual: { ip: string; note: string | null; addedAt: number }[]; ignored: string[] };
}

export interface ScanTimings {
  arp1: number;
  ping: number;
  arp2: number;
  ports: number;
  hostnames: number;
  total: number;
  pingAlive: number;
  arpEntries: number;
  candidates: number;
}

/** 单轮扫描的共享上下文：五个 phase 方法经由它传递观测结果与预算（M3 重构）。 */
interface ScanCtx {
  startedAt: number;
  deadline: number;
  timings: ScanTimings;
  /** phase 2 填充：本轮 ICMP 存活的 IP */
  alive: Set<string>;
  /** phase 3 填充：本轮第二次 ARP 的在位视图（过预算时为现有 arp 缓存） */
  arp2Entries: Map<string, ArpEntry>;
  /** phaseComputeTargets 填充：端口探测候选 */
  probeTargets: string[];
}

interface DeviceRecord {
  ip: string;
  mac: string | null;
  firstSeen: number;
  lastSeen: number;  ttl: number | null;
  openPorts: number[];
  hostname: string | null;
  arpMissStreak: number;
  arpPresent: boolean;
  pingAlive: boolean;
  portResponded: boolean;
  history: { ts: number; rtt: number | null; rxBps: number; txBps: number }[];
}

const idleProgress = (): ScanProgress => ({
  active: false,
  pct: 100,
  phase: 'idle',
  scanned: 0,
  total: 0,
  startedAt: null,
});

/**
 * 引擎侧降级信息收集器（R-03，纯逻辑、无 IO，可被单测直接驱动）：
 *  - 同 `source + message` 只保留 1 条，`at` 刷新为最后一次出现
 *  - 上限 `WINDOW.warnings`（20），超出裁最旧
 *  - `clearSource` 让"条件恢复"自然消失（某源本轮没再报，它的旧条目就不该挂在快照上）
 */
export class WarningLog {
  private entries = new Map<string, WarningEntry>();

  push(source: WarningEntry['source'], message: string, at: number = Date.now()): void {
    this.entries.set(`${source}:${message}`, { source, message, at });
    this.trim();
  }

  /** 某数据源本轮恢复正常：它之前写的条目全部消失。 */
  clearSource(source: WarningEntry['source']): void {
    for (const [key, entry] of Array.from(this.entries)) {
      if (entry.source === source) this.entries.delete(key);
    }
  }

  /** 按 `at` 升序的快照副本（超上限保留最新 20 条）。 */
  list(): WarningEntry[] {
    const all = Array.from(this.entries.values()).sort((a, b) => a.at - b.at);
    return all.slice(-WINDOW.warnings);
  }

  private trim(): void {
    while (this.entries.size > WINDOW.warnings) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.entries.delete(oldestKey);
    }
  }
}

/**
 * 纯函数：plan.md §5.1 的 6 级优先级状态判定。
 * 第 6 条（质量退化）覆盖第 1-4 条的 online；第 5 条是**唯一**判离线路径。
 */
export function resolveLinkState(input: {
  isSelf: boolean;
  isGateway: boolean;
  arpPresent: boolean;
  pingAlive: boolean;
  portResponded: boolean;
  arpMissStreak: number;
  quality: NetQuality;
}): 'online' | 'offline' | 'degraded' {
  const degraded = isDegraded(input.quality);
  if (input.isSelf) return degraded ? 'degraded' : 'online';
  if (input.isGateway) return degraded ? 'degraded' : 'online';
  if (input.arpPresent || input.portResponded || input.pingAlive) {
    return degraded ? 'degraded' : 'online';
  }
  if (input.arpMissStreak >= HEARTBEAT_PROBE.offlineArpMisses) return 'offline';
  // ARP 老化有延迟：缺席不足 3 轮时不下离线结论
  return 'online';
}

export class Scheduler {
  private records = new Map<string, DeviceRecord>();
  private arp = new Map<string, ArpEntry>();
  /** 最近一轮有效 ARP 读取解析出的同 IP 多 MAC 冲突（task-017，联动设备列表 ipConflict 徽标）。 */
  private lastArpConflicts: { ip: string; macs: string[] }[] | null = null;
  /** 持久化恢复的首次接入时间覆盖表（key = IP）：新建记录时优先采用，跨重启保留"真正第一次"。 */
  private firstSeenOverrides = new Map<string, number>();
  private tracker = new QualityTracker();
  private meter: BandwidthMeter;
  private dns: ReverseDnsCache;
  /** mDNS 自报类型提示（task-020）：ip → {name, kind}，phaseFingerprint 每轮刷新。 */
  private mdnsHints = new Map<string, MdnsDeviceHint>();
  /** task-023：WS-Discovery 摄像头自报（ip → ipc/nvr）。 */
  private wsdiscoveryHints = new Map<string, WsdCameraHint>();
  /** task-023：SSDP 设备自报（ip → kind/osHint/name）。 */
  private ssdpHints = new Map<string, SsdpDeviceHint>();
  /** task-027：HTTP 管理页指纹（ip → kind/osHint）。 */
  private httpHints = new Map<string, HttpFingerprintHint>();
  /** task-028：ONVIF 设备服务自报（ip → osHint），摄像头的 HTTP 通道补强。 */
  private onvifHints = new Map<string, OnvifHint>();
  /** HTTP 管理页探测轮转游标：候选多于一轮配额（6）时均匀覆盖。 */
  private httpCursor = 0;
  /** ONVIF 探测轮转游标（与 HTTP 指纹各用一套，避免互相挤占覆盖）。 */
  private onvifCursor = 0;
  /**
   * 路由器通道提示（task-022 C-1）：DHCP 租约 hostname 回填。
   * 内存态不持久化；主进程在路由器状态推送回调里每轮重灌，未登录时为空数组（不猜）。
   */
  private routerHints: RouterHints = { leaseHostnames: [] };
  /** NetBIOS 采集轮转游标：无主机名候选多于一轮配额时均匀覆盖。 */
  private nbtstatCursor = 0;
  private simulator = new Simulator();
  private printers: Printer[] = [];
  private printerReachable = new Map<string, boolean | null>();
  private progress: ScanProgress = idleProgress();
  private timers: NodeJS.Timeout[] = [];
  /** 全量扫描定时器单独持有：关闭实时监控时只停它；心跳定时器继续挂着（heartbeat 按开关早退） */
  private scanTimer: NodeJS.Timeout | null = null;
  /** 引擎侧降级信息：key = `${source}:${message}`，同源同文案只保留 1 条 */
  private warningLog = new WarningLog();
  private lastScanAt: number | null = null;
  private lastSnapshot: Snapshot | null = null;
  private scanInFlight = false;
  private heartbeatInFlight = false;
  private qualityInFlight = false;
  private printersInFlight = false;
  /** 首次 refreshPrinters 成功后置 true。 */
  private printersCollected = false;
  private bandwidthInFlight = false;
  private autoScan: boolean;
  private heartbeatCursor = 0;
  /** 未知 IP 滚动探测游标（task-026）：在 cfg.hosts 上轮转，254 个地址 ≈ 4 轮心跳覆盖完 */
  private unknownCursor = 0;
  private running = false;
  /** 持续 Ping 监控（task-025）：独立 5s 轮询，变迁直接推新快照 */
  private watches: WatchManager;
  /** 总带宽历史环（task-025，60 点；失败轮为 null 点，曲线断开呈现） */
  private bandwidthHistory: BandwidthPoint[] = [];

  lastTimings: ScanTimings | null = null;

  constructor(
    private readonly cfg: SchedulerConfig,
    private readonly hooks: SchedulerHooks = {},
  ) {
    this.meter = new BandwidthMeter(cfg.prefix, cfg.selfIp);
    this.dns = new ReverseDnsCache();
    this.autoScan = cfg.autoScanIntervalSec > 0;
    // task-025：监控目标宕机/恢复变迁 → 立即推帧（WatchesView 状态实时刷新）
    this.watches = new WatchManager({
      intervalMs: WATCH.intervalMs,
      windowSize: WATCH.windowSize,
      pingTimeoutMs: WATCH.pingTimeoutMs,
      onTransition: () => this.emitSnapshotNow(),
      onError: (message) => this.replaceWarnings('system', [message]),
    });
  }

  /** 引擎门面：监控目标增删（持久化由调用方负责落 store，这里只改运行态）。 */
  watchAdd(ip: string, note: string | null): { ok: boolean; error: string | null } {
    const result = this.watches.add(ip, note);
    if (result.ok) this.emitSnapshotNow();
    return result;
  }

  watchRemove(ip: string): { ok: boolean } {
    const existed = this.watches.list().some((t) => t.ip === ip);
    const result = this.watches.remove(ip);
    if (existed) this.emitSnapshotNow();
    return result;
  }

  watchStatus(): WatchStatus[] {
    return this.watches.status();
  }

  /** 启动前恢复持久化目标列表。 */
  hydrateWatches(targets: WatchTarget[]): void {
    this.watches.hydrate(targets);
  }

  /** 引擎门面通道：把非周期任务来源的故障（如 store 落盘失败）写进快照 warnings 并推送。 */
  reportEngineWarning(source: WarningEntry['source'], messages: string[]): void {
    this.replaceWarnings(source, messages);
    this.emitSnapshot();
  }

  /** 引擎门面通道：配置类变更（如设备别名）后立即推送一帧快照（不重扫）。 */
  emitSnapshotNow(): void {
    this.emitSnapshot();
  }

  /** 灌入路由器通道提示（task-022 C-1，由 Engine 门面转发；内存态，不持久化）。 */
  setRouterHints(hints: RouterHints): void {
    this.routerHints = hints;
  }

  /**
   * 按 MAC 查 DHCP 租约自报的 hostname（task-022 C-1）。
   * 找不到 / 租约 hostname 为空 → null。MAC 归一化小写后比对，吸收大小写书写差异。
   */
  private leaseHostnameByMac(mac: string | null): string | null {
    if (mac === null) return null;
    const key = mac.toLowerCase();
    for (const lease of this.routerHints.leaseHostnames) {
      if (lease.mac.toLowerCase() === key && lease.hostname !== null && lease.hostname.trim() !== '') {
        return lease.hostname.trim();
      }
    }
    return null;
  }

  get snapshotCached(): Snapshot | null {
    return this.lastSnapshot;
  }

  setAutoScan(enabled: boolean, intervalSec?: number): { autoScan: boolean; intervalSec: number } {
    this.autoScan = enabled;
    if (intervalSec !== undefined && intervalSec > 0) this.cfg.autoScanIntervalSec = intervalSec;
    // 只重挂扫描定时器：心跳定时器继续挂着（heartbeat 首行按 autoScan 早退），
    // 带宽/打印机/质量采样等本机观测不受开关影响
    if (this.running) this.installScanTimer();
    this.emitSnapshot();
    return { autoScan: this.autoScan, intervalSec: this.cfg.autoScanIntervalSec };
  }

  /**
   * 打印机采集源开关（设置页运行时可改）：cfg 是可变对象，
   * refreshPrinters 每轮读取，无需重启引擎——下一轮打印机刷新（15s 内）即生效。
   */
  setPrinterSources(opts: { snmpEnabled?: boolean; useMdns?: boolean }): { snmpEnabled: boolean; useMdns: boolean } {
    if (opts.snmpEnabled !== undefined) this.cfg.snmpEnabled = opts.snmpEnabled;
    if (opts.useMdns !== undefined) this.cfg.useMdns = opts.useMdns;
    return { snmpEnabled: this.cfg.snmpEnabled, useMdns: this.cfg.useMdns };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // 首轮扫描完成后立刻补一轮质量采样（否则要等 15s 定时器才拿到第一组样本）
    void this.runFullScan()
      .then(() => this.sampleQuality())
      .catch(() => {
        /* runFullScan 内部已兜底；此处防 unhandled rejection */
      });
    this.installTimers();
    // task-025：持续 Ping 监控独立定时器（与观测类定时器同生命周期）
    this.watches.start();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    this.watches.stop();
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /**
   * `autoScan`（实时监控开关，task-026 改语义）控制两类**主动探测**：5s 心跳（heartbeat 首行早退）
   * 与定时全量扫描；带宽 / 打印机 / 质量采样 / 持续 Ping 属于本机观测，关闭后仍继续
   * （快照不冻结，但设备列表与状态停留在暂停时刻——诚实呈现"暂停"而非伪造活性）。
   */
  private installTimers(): void {
    this.timers.push(setInterval(() => void this.sampleBandwidth(), SCHEDULE.bandwidth));
    this.timers.push(setInterval(() => void this.heartbeat(), SCHEDULE.devices));
    this.timers.push(setInterval(() => void this.sampleQuality(), QUALITY_SAMPLE.intervalMs));
    this.timers.push(setInterval(() => void this.refreshPrinters(), SCHEDULE.printers));
    this.installScanTimer();
  }

  private installScanTimer(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.autoScan) this.scanTimer = setInterval(() => void this.runFullScan(), SCHEDULE.fullScan);
  }

  // —— 单步任务 ——

  async sampleBandwidth(): Promise<void> {
    if (this.bandwidthInFlight) return;
    this.bandwidthInFlight = true;
    try {
      const sample = await this.meter.sample();
      // R-02：采样失败必须可感知（快照里 rxBps/txBps 会是 null，绝不兜成 0）
      this.replaceWarnings('bandwidth', sample.error ? [`带宽采样失败：${sample.error}`] : []);
      // task-025：总带宽历史环（60 点）。失败轮入 null 点（曲线断开，诚实呈现）；
      // 尚无差分基线（intervalMs=0）不入点——那是"还没开始计量"，不是 0 也不是失败
      if (sample.error) {
        this.pushBandwidthPoint({ ts: sample.at, rxBps: null, txBps: null });
      } else if (sample.intervalMs > 0) {
        this.pushBandwidthPoint({ ts: sample.at, rxBps: sample.rxBps, txBps: sample.txBps });
      }
      this.emitSnapshot();
    } catch (err) {
      this.replaceWarnings('bandwidth', [`带宽采样失败：${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      this.bandwidthInFlight = false;
    }
  }

  /** 总带宽历史环推入（60 点 ≈ 2 分钟，与快照 UI 曲线一致）。 */
  private pushBandwidthPoint(point: BandwidthPoint): void {
    this.bandwidthHistory.push(point);
    if (this.bandwidthHistory.length > 60) this.bandwidthHistory.splice(0, this.bandwidthHistory.length - 60);
  }

  /**
   * 5s 心跳（task-026 实时化）：重读 ARP（85ms）+ 三集合合并探测——
   * 缺席确认（无 ARP 的在册记录优先重探）∪ 在线全量（不再轮转 32）∪ 未知 IP 滚动（≈20s 覆盖全网）。
   * ARP 里冒出新设备时早推一帧（<100ms 可见，不必等本轮 ping 完成）。
   * 离线判定在此加速：连续 `HEARTBEAT_PROBE.offlineArpMisses` 轮「无 ARP 且 ping 失败」→ offline（≈20s）。
   */
  async heartbeat(): Promise<void> {
    // 实时监控关闭 = 暂停实时探测：心跳完全不跑（设备状态冻结，诚实呈现"暂停"）；
    // 带宽 / 质量 / 打印机 / 持续 Ping 属于本机观测，不受影响
    if (!this.autoScan) return;
    if (this.heartbeatInFlight || this.scanInFlight) return;
    this.heartbeatInFlight = true;
    try {
      const arpResult = await readArp(this.cfg.prefix);
      this.replaceWarnings('discovery', this.arpWarnings(arpResult));
      if (!this.arpReadUsable(arpResult)) {
        // 读失败沿用上一轮视图（一次解析失败 ≠ 全网消失，与扫描 phaseInitialArp 同语义）：
        // 本轮没有有效观测，缺席计数不推进、pingAlive 不清零，只如实推一帧
        this.emitSnapshot();
        return;
      }
      this.lastArpConflicts = arpResult.conflicts ?? [];
      // R-06① 同语义：本轮"ICMP 存活"先全量归零，只有本轮真的回包才置 true。
      // 心跳现在每轮探测全部在线设备 + 缺席设备，不清零则陈旧 pingAlive 会把静默设备永远粘成在线。
      for (const rec of this.records.values()) rec.pingAlive = false;
      // 早推帧：ARP 里冒出的新设备立刻可见（本轮 ping 完成后还有常规推帧）
      if (this.mergeArp(arpResult.entries) > 0) this.emitSnapshot();
      const targets = this.pickHeartbeatTargets();
      if (targets.length > 0) {
        const sweep = await pingSweep(targets, { concurrency: CONCURRENCY.pingSweep, timeoutMs: TIMEOUTS.ping });
        for (const [ip, result] of sweep.results) {
          // 未知 IP 被滚动探测 ping 中：立即建册（新设备由此进入快照）
          const rec = result.alive ? this.ensureRecord(ip, Date.now()) : this.records.get(ip);
          if (!rec) continue;
          rec.pingAlive = result.alive;
          rec.ttl = result.ttl ?? rec.ttl;
          // 扫描阶段的 ping 只用于"存活判定"，**不写入质量窗口**（见 sampleQuality 的说明）
          if (result.alive) rec.lastSeen = Date.now();
          this.pushHistory(rec, result.alive ? result.rttMs : null);
        }
      }
      this.applyArpPresence();
      // 缺席设备（本轮无 ARP 且 ping 失败）：陈旧的端口响应证据同步失效——
      // TCP 回包的前提是 ARP 在位，缺席即旧证据作废；否则打印机等"有端口史"的
      // 设备会被 portResponded 钉住，加速判定对它们永远不生效
      for (const rec of this.records.values()) {
        if (!rec.arpPresent && !rec.pingAlive) rec.portResponded = false;
      }
      this.emitSnapshot();
    } catch (err) {
      // 审计修复：pingSweep worker 的 spawn 失败等异常此前会打掉整轮心跳且无人感知
      //（void 调用 → unhandled rejection，快照静默停更）。与 sampleBandwidth /
      // refreshPrinters 对齐：失败写 warnings，周期任务不允许静默失联。
      this.replaceWarnings('discovery', [`心跳轮异常：${err instanceof Error ? err.message : String(err)}`]);
      this.emitSnapshot();
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  /**
   * 心跳探测目标（task-026）：三集合去重合并，单次 pingSweep（最坏 208 目标 @64 并发 ≈ 2.4s）。
   *   1) 缺席确认：无 ARP 条目的在册记录——缺席第 1 轮就进确认队列（按缺席轮数降序，≤absentProbeCap）
   *   2) 在线全量：arpPresent||pingAlive，超 onlineCap 用游标轮转（未探到的靠 ARP 在位兜底不误判）
   *   3) 未知滚动：cfg.hosts − 在册记录，unknownCursor 轮转 ≤unknownPerRound（254 ÷ 64 ≈ 4 轮 ≈ 20s 全覆盖）
   */
  private pickHeartbeatTargets(): string[] {
    const targets = new Set<string>();
    for (const rec of Array.from(this.records.values())
      .filter((r) => !r.arpPresent)
      .sort((a, b) => b.arpMissStreak - a.arpMissStreak)
      .slice(0, HEARTBEAT_PROBE.absentProbeCap)) {
      targets.add(rec.ip);
    }
    const present = Array.from(this.records.values()).filter((r) => r.arpPresent || r.pingAlive);
    const onlineN = Math.min(HEARTBEAT_PROBE.onlineCap, present.length);
    for (let i = 0; i < onlineN; i += 1) {
      const rec = present[(this.heartbeatCursor + i) % present.length];
      if (rec) targets.add(rec.ip);
    }
    if (present.length > 0) {
      this.heartbeatCursor = (this.heartbeatCursor + onlineN) % present.length;
    }
    if (this.cfg.hosts.length > 0) {
      const unknownN = Math.min(HEARTBEAT_PROBE.unknownPerRound, this.cfg.hosts.length);
      for (let i = 0; i < unknownN; i += 1) {
        const ip = this.cfg.hosts[(this.unknownCursor + i) % this.cfg.hosts.length];
        if (ip && !this.records.has(ip)) targets.add(ip);
      }
      this.unknownCursor = (this.unknownCursor + unknownN) % this.cfg.hosts.length;
    }
    return Array.from(targets);
  }

  /**
   * 质量采样（15s）：只对 ARP 在位/存活主机做 `ping -n 4`，结果写入质量窗口。
   *
   * **为什么扫描/心跳的 ping 不进质量窗口**：单次 `ping -n 1` 只有"回复/超时"两种结果，
   * 一旦窗口里混入非回复样本，丢包率会被算成 25%/33%（`.23`、`.176` 启动期假 degraded 的根因），
   * 而扫描 ping 的语义是"存活判定"而非"质量测量"。因此质量窗口的唯一数据源是这里的批量采样。
   */
  async sampleQuality(): Promise<void> {
    if (this.qualityInFlight || this.scanInFlight) return;
    this.qualityInFlight = true;
    try {
      const targets = this.pickQualityTargets(QUALITY_SAMPLE.targetsPerRound);
      if (targets.length === 0) return;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const idx = cursor;
          cursor += 1;
          const ip = targets[idx];
          if (!ip) return;
          try {
            const res = await pingQuality(ip, QUALITY_SAMPLE.packetCount);
            // 解析失败（既无丢包率也无 RTT）不写窗口：宁可 unknown，也不伪造样本
            if (res.lossPct === null && res.rtts.length === 0) continue;
            const reportedLost =
              res.lossPct === null ? 0 : Math.round((res.lossPct / 100) * QUALITY_SAMPLE.packetCount);
            const lost = Math.max(0, Math.min(QUALITY_SAMPLE.packetCount - res.rtts.length, reportedLost));
            this.tracker.recordBatch(ip, res.rtts, lost);
          } catch {
            /* 单台采样失败不影响其余设备 */
          }
        }
      };
      const workers = Array.from(
        { length: Math.min(QUALITY_SAMPLE.concurrency, targets.length) },
        () => worker(),
      );
      await Promise.all(workers);
      // 这是真正的"质量轮次"，允许推进 poor 连续计数
      this.emitSnapshot();
    } finally {
      this.qualityInFlight = false;
    }
  }

  /** 优先采样样本最少的设备（各台均匀填满窗口，避免只有前几台有质量数据）。 */
  private pickQualityTargets(limit: number): string[] {
    return Array.from(this.records.values())
      .filter((r) => r.arpPresent || r.pingAlive)
      .sort((a, b) => this.tracker.samples(a.ip).length - this.tracker.samples(b.ip).length)
      .slice(0, Math.max(0, limit))
      .map((r) => r.ip);
  }

  async refreshPrinters(): Promise<void> {
    if (this.printersInFlight) return;
    this.printersInFlight = true;
    try {
      const spooler = await readSpooler();
      const mdns = this.cfg.useMdns ? await discoverMdnsPrinters() : [];
      const devices = this.buildDevices();
      const result = await collectPrinters({
        spooler,
        arp: this.arp,
        devices,
        mdns,
        snmpEnabled: this.cfg.snmpEnabled,
        manage: this.hooks.getPrinterManage?.(),
      });
      this.printers = result.printers;
      this.printerReachable = result.reachable;
      // 首轮打印机采集完成
      this.printersCollected = true;
      // R-03②：collectPrinters 的 errors 以前被调用方丢弃，Get-Printer 失败在界面上就是"没有打印机"
      this.replaceWarnings('printers', result.errors);
      this.emitSnapshot();
    } catch (err) {
      // spooler 全失败也不能让整个引擎崩：保留上一轮结果，但必须让用户看见
      this.replaceWarnings('printers', [
        `打印机采集失败：${err instanceof Error ? err.message : String(err)}`,
      ]);
      this.emitSnapshot();
    } finally {
      this.printersInFlight = false;
    }
  }

  /** 手动刷新：立即出一次快照（<1s 有反馈），随后后台跑完整扫描。 */
  async refresh(): Promise<{ started: boolean }> {
    // 审计修复：扫描进行中不再虚报"已启动"——旧实现会覆写 progress 为 starting
    // 并恒返 started:true，交互反馈失真。进行中直接如实返回 false。
    if (this.scanInFlight) return { started: false };
    this.progress = { active: true, pct: 1, phase: 'starting', scanned: 0, total: this.cfg.hosts.length, startedAt: Date.now() };
    this.emitProgress();
    this.emitSnapshot();
    void this.runFullScan().catch(() => {
      /* runFullScan 内部已兜底（catch 写 warnings）；此处防 unhandled rejection */
    });
    return { started: true };
  }

  /**
   * 单轮完整扫描（engine-check 与定时任务共用）。
   *
   * 审计 M3：五个 phase 抽成独立方法，编排函数只保留顺序与 try/catch/finally。
   * 共享状态收进 ScanCtx，延迟预算（deadline）语义逐行保留——
   * scripts/engine-check.mjs 与 soak 是这次重写的回归护栏。
   */
  async runFullScan(): Promise<void> {
    if (this.scanInFlight) return;
    this.scanInFlight = true;
    const startedAt = Date.now();
    const timings: ScanTimings = {
      arp1: 0,
      ping: 0,
      arp2: 0,
      ports: 0,
      hostnames: 0,
      total: 0,
      pingAlive: 0,
      arpEntries: 0,
      candidates: 0,
    };
    const ctx: ScanCtx = {
      startedAt,
      deadline: startedAt + SCAN_BUDGET_MS,
      timings,
      alive: new Set(),
      arp2Entries: new Map(),
      probeTargets: [],
    };
    this.progress = { active: true, pct: 2, phase: 'arp', scanned: 0, total: this.cfg.hosts.length, startedAt };
    this.emitProgress();

    try {
      // R-06①：本轮"ICMP 存活"归零，只有本轮真的回包才置 true
      for (const rec of this.records.values()) rec.pingAlive = false;
      await this.phaseInitialArp(ctx);
      await this.phasePingSweep(ctx);
      await this.phaseSecondArp(ctx);
      this.phaseComputeTargets(ctx);
      await this.phasePorts(ctx);
      await this.phaseFingerprint(ctx);
      this.applyArpPresence(ctx.arp2Entries);
      this.updatePortResponders();
    } catch (err) {
      // 单轮扫描失败不得抛到主进程；R-03：但也不许静默，至少让快照带一条 discovery 告警
      this.replaceWarnings('discovery', [`扫描轮异常：${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      this.scanInFlight = false;
      timings.total = Date.now() - startedAt;
      this.lastTimings = timings;
      this.lastScanAt = Date.now();
      this.progress = { ...idleProgress(), pct: 100 };
      this.emitProgress();
      await this.safeRefreshPrintersIfNeeded();
      this.emitSnapshot();
    }
  }

  /** phase 1：初始 ARP，建立在位集合。读失败沿用上一轮视图（一次解析失败 ≠ 全网消失）。 */
  private async phaseInitialArp(ctx: ScanCtx): Promise<void> {
    const t0 = Date.now();
    const arp1 = this.cfg.hosts.length > 0 ? await readArp(this.cfg.prefix) : null;
    ctx.timings.arp1 = Date.now() - t0;
    const arp1Entries: Map<string, ArpEntry> =
      arp1 && this.arpReadUsable(arp1) ? arp1.entries : this.arp;
    if (arp1 && this.arpReadUsable(arp1)) this.lastArpConflicts = arp1.conflicts ?? [];
    // task-026：ARP 里冒出新设备 → 早推一帧（扫描还要 10s，新设备不必等）
    if (this.mergeArp(arp1Entries) > 0) this.emitSnapshot();
    ctx.timings.arpEntries = arp1Entries.size;
  }

  /** phase 2：全量子网 ping（并发 64），填充 ctx.alive。 */
  private async phasePingSweep(ctx: ScanCtx): Promise<void> {
    if (this.cfg.hosts.length === 0) return;
    this.progress = { ...this.progress, pct: 10, phase: 'ping', scanned: 0, total: this.cfg.hosts.length };
    this.emitProgress();
    const t0 = Date.now();
    const sweep = await pingSweep(this.cfg.hosts, {
      concurrency: CONCURRENCY.pingSweep,
      timeoutMs: TIMEOUTS.ping,
      deadline: ctx.deadline,
      onProgress: (done, total) => {
        this.progress = {
          ...this.progress,
          pct: Math.min(62, 10 + Math.round((done / Math.max(total, 1)) * 52)),
          scanned: done,
          total,
        };
        this.emitProgress();
      },
    });
    ctx.timings.ping = Date.now() - t0;
    for (const [ip, result] of sweep.results) {
      if (!result.alive) continue;
      ctx.alive.add(ip);
      const rec = this.ensureRecord(ip, ctx.startedAt);
      rec.pingAlive = true;
      rec.ttl = result.ttl ?? rec.ttl;
      rec.lastSeen = ctx.startedAt;
      // 存活判定结果不写入质量窗口；质量样本只来自 sampleQuality 的 `ping -n 4`
    }
    ctx.timings.pingAlive = ctx.alive.size;
  }

  /** phase 3：再读 ARP（发过 ARP 但禁 ping 的设备也算在线）；过预算则跳过。 */
  private async phaseSecondArp(ctx: ScanCtx): Promise<void> {
    this.progress = { ...this.progress, pct: 66, phase: 'arp2' };
    this.emitProgress();
    if (Date.now() < ctx.deadline) {
      const t0 = Date.now();
      const arp2 = await readArp(this.cfg.prefix);
      ctx.timings.arp2 = Date.now() - t0;
      // 读失败沿用上一轮视图：一次解析失败不能当成"全网设备都消失了"
      ctx.arp2Entries = this.arpReadUsable(arp2) ? arp2.entries : this.arp;
      if (this.arpReadUsable(arp2)) this.lastArpConflicts = arp2.conflicts ?? [];
      this.mergeArp(ctx.arp2Entries);
      // R-03①：解析出 0 条但文本里明明有表格行时，必须让界面知道"读失败"而不是"网段空"
      this.replaceWarnings('discovery', this.arpWarnings(arp2));
    } else {
      // 已过预算：arp2 只是增量证据，arp1 的在位集合已够出快照。
      // 不再读 arp -a —— 一旦它撞上 2s 超时线，回退的 Get-NetNeighbor
      // 能把这一阶段拖到 ~10s（B-1 根因之一），而预算已经用完了。
      ctx.timings.arp2 = 0;
      ctx.arp2Entries = this.arp;
      this.mergeArp(ctx.arp2Entries);
    }
  }

  /** phase 4 前置：汇总端口探测候选（ARP 在位 ∪ ICMP 存活 ∪ 有端口史的在册记录）。 */
  private phaseComputeTargets(ctx: ScanCtx): void {
    const candidates = new Set<string>([...ctx.arp2Entries.keys(), ...ctx.alive]);
    for (const ip of this.records.keys()) candidates.add(ip);
    ctx.probeTargets = Array.from(candidates).filter((ip) => {
      if (ctx.arp2Entries.has(ip) || ctx.alive.has(ip)) return true;
      const rec = this.records.get(ip);
      return rec ? rec.openPorts.length > 0 && rec.arpMissStreak < HEARTBEAT_PROBE.offlineArpMisses : false;
    });
    ctx.timings.candidates = ctx.probeTargets.length;
  }

  /** phase 4：端口探测（吃预算：超时即中止，未探到的设备靠 arpMissStreak 缓冲，下一轮补全）。 */
  private async phasePorts(ctx: ScanCtx): Promise<void> {
    if (ctx.probeTargets.length === 0 || Date.now() >= ctx.deadline) return;
    this.progress = { ...this.progress, pct: 72, phase: 'ports', scanned: 0, total: ctx.probeTargets.length };
    this.emitProgress();
    // 重置本轮要探测的设备的"端口响应"标记，避免历史残留导致永远判在线
    for (const ip of ctx.probeTargets) {
      const rec = this.records.get(ip);
      if (rec) rec.portResponded = false;
    }
    const t0 = Date.now();
    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), Math.max(0, ctx.deadline - Date.now()));
    const ports = await probeHosts(ctx.probeTargets, PROBE_PORTS, 24, {
      timeoutMs: TIMEOUTS.portConnect,
      signal: abort.signal,
    });
    clearTimeout(abortTimer);
    ctx.timings.ports = Date.now() - t0;
    for (const [ip, openPorts] of ports) {
      const rec = this.ensureRecord(ip, ctx.startedAt);
      rec.openPorts = openPorts;
      if (openPorts.length > 0) {
        rec.portResponded = true;
        rec.lastSeen = ctx.startedAt; // 端口回包是本轮真实观测
      }
    }
  }

  /** phase 5：指纹（主机名反向 DNS + mDNS 类型侦测 + NetBIOS 名采集，共享剩余预算）。 */
  private async phaseFingerprint(ctx: ScanCtx): Promise<void> {
    this.progress = { ...this.progress, pct: 88, phase: 'fingerprint' };
    this.emitProgress();
    const t0 = Date.now();
    const needHostname = ctx.probeTargets.filter((ip) => !this.records.get(ip)?.hostname);
    const budgetLeft = ctx.deadline - Date.now();
    if ((needHostname.length > 0 || ctx.probeTargets.length > 0) && budgetLeft > 0) {
      await Promise.race([
        Promise.all([this.resolveHostnames(needHostname), this.augmentDeviceIdentity(ctx)]),
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(300, budgetLeft))),
      ]);
    }
    ctx.timings.hostnames = Date.now() - t0;
  }

  /**
   * 设备身份增强（task-020/023/027/028，全部为尽力而为的增强路径）：
   *  ① mDNS 类型侦测（1s 窗口）：自报服务 → iot/mobile/tablet/printer/camera 提示；
   *  ② WS-Discovery 摄像头自报（1.2s 窗口，task-023）：组播 + 本轮存活 IP 单播补探；
   *  ③ SSDP 设备自报（1.5s 窗口，task-023）：UPnP deviceType → router/ap/camera/printer/iot；
   *  ④ ONVIF 设备服务探测（task-028）：POST /onvif/device_service 拿自报厂商/型号；
   *  ⑤ NetBIOS 名采集（≤16 台/轮，轮转覆盖）：回填 hostname，进入既有主机名指纹管线；
   *  ⑥ HTTP 管理页指纹（task-027）：已探明 80/8080 开放的候选 ≤6 台/轮，GET / 抓
   *     title/Server 头 → 厂商型号自报分类。
   * ①~⑥ 并行（总耗时≈最长一路而非相加，保住 phaseFingerprint 预算）；
   * 任何一步失败静默跳过，绝不拖垮扫描。
   */
  private async augmentDeviceIdentity(ctx: ScanCtx): Promise<void> {
    // WS-Discovery 单播补探：只打本轮 ICMP 存活的主机，每台 1 包，最多 32 台。
    // 组播被交换机/AP 过滤时，这条路径是摄像头唯一还可能应答的通道。
    const wsUnicast = ctx.probeTargets.slice(0, 32);
    const [mdnsHints, wsdHints, ssdpHints, onvifHints, httpHints, _nbt] = await Promise.all([
      discoverMdnsDevices().catch(() => [] as MdnsDeviceHint[]),
      discoverCamerasWsdiscovery(undefined, wsUnicast).catch(() => [] as WsdCameraHint[]),
      discoverSsdpDevices().catch(() => [] as SsdpDeviceHint[]),
      this.probeOnvifDevices().catch(() => [] as OnvifHint[]),
      this.probeHttpFingerprints().catch(() => [] as HttpFingerprintHint[]),
      this.queryNetbiosNamesForCandidates().catch(() => undefined),
    ]);
    for (const hint of mdnsHints) this.mdnsHints.set(hint.ip, hint);
    for (const hint of wsdHints) this.wsdiscoveryHints.set(hint.ip, hint);
    for (const hint of ssdpHints) this.ssdpHints.set(hint.ip, hint);
    for (const hint of onvifHints) this.onvifHints.set(hint.ip, hint);
    for (const hint of httpHints) this.httpHints.set(hint.ip, hint);
  }

  /**
   * ONVIF 设备服务探测（task-028）：候选 = 已探明 80/8080/8899/8000 开放的记录，
   * 轮转游标每轮最多 6 台。失败静默——增强路径，绝不拖垮扫描。
   */
  private async probeOnvifDevices(): Promise<OnvifHint[]> {
    const candidates: OnvifProbeTarget[] = [];
    for (const r of this.records.values()) {
      const port = ONVIF_PORTS.find((p) => r.openPorts.includes(p));
      if (port !== undefined) candidates.push({ ip: r.ip, port });
    }
    candidates.sort((a, b) => ipToNumber(a.ip) - ipToNumber(b.ip));
    if (candidates.length === 0) return [];
    const n = Math.min(ONVIF_MAX_TARGETS, candidates.length);
    const slice: OnvifProbeTarget[] = [];
    for (let i = 0; i < n; i += 1) {
      slice.push(candidates[(this.onvifCursor + i) % candidates.length]);
    }
    this.onvifCursor = (this.onvifCursor + n) % candidates.length;
    return discoverOnvifDevices(slice);
  }

  /**
   * HTTP 管理页指纹探测（task-027）：候选 = 已探明 80/8080 开放的记录，
   * 轮转游标每轮最多 6 台（discoverHttpFingerprints 内部同样有上限，双保险）。
   * 失败静默——增强路径，绝不拖垮扫描。
   */
  private async probeHttpFingerprints(): Promise<HttpFingerprintHint[]> {
    const candidates: { ip: string; port: 80 | 8080 }[] = [];
    for (const r of this.records.values()) {
      if (r.openPorts.includes(80)) candidates.push({ ip: r.ip, port: 80 });
      else if (r.openPorts.includes(8080)) candidates.push({ ip: r.ip, port: 8080 });
    }
    candidates.sort((a, b) => ipToNumber(a.ip) - ipToNumber(b.ip));
    if (candidates.length === 0) return [];
    const n = Math.min(6, candidates.length);
    const slice: { ip: string; port: 80 | 8080 }[] = [];
    for (let i = 0; i < n; i += 1) {
      slice.push(candidates[(this.httpCursor + i) % candidates.length]);
    }
    this.httpCursor = (this.httpCursor + n) % candidates.length;
    return discoverHttpFingerprints(slice);
  }

  /** nbtstat 名采集（≤16 台/轮，轮转覆盖；失败静默）。独立方法便于与侦测窗口并行。 */
  private async queryNetbiosNamesForCandidates(): Promise<void> {
    try {
      const candidates = Array.from(this.records.values())
        .filter((r) => r.arpPresent && !r.hostname)
        .sort((a, b) => ipToNumber(a.ip) - ipToNumber(b.ip));
      if (candidates.length > 0) {
        const n = Math.min(NBTSTAT_MAX_HOSTS, candidates.length);
        const slice: string[] = [];
        for (let i = 0; i < n; i += 1) {
          slice.push(candidates[(this.nbtstatCursor + i) % candidates.length].ip);
        }
        this.nbtstatCursor = (this.nbtstatCursor + n) % candidates.length;
        const names = await queryNetbiosNames(slice);
        for (const [ip, name] of names) {
          const rec = this.records.get(ip);
          if (rec && !rec.hostname) rec.hostname = name;
        }
      }
    } catch {
      /* 增强路径失败静默 */
    }
  }

  /** 首次扫描或打印机为空时补一次 spooler 采集（60s 内不重复）。 */
  private lastPrinterRefreshAt = 0;
  private async safeRefreshPrintersIfNeeded(): Promise<void> {
    if (this.printersInFlight) return;
    if (Date.now() - this.lastPrinterRefreshAt < 10_000 && this.printers.length > 0) return;
    this.lastPrinterRefreshAt = Date.now();
    await this.refreshPrinters();
  }

  private async resolveHostnames(ips: string[]): Promise<void> {
    try {
      const map = await this.dns.lookupMany(ips);
      for (const [ip, hostname] of map) {
        if (!hostname) continue;
        const rec = this.records.get(ip);
        if (rec) rec.hostname = hostname;
      }
    } catch {
      /* 反查失败不影响主流程 */
    }
  }

  /** mergeArp：覆盖在位视图 + 建册，返回**新建记录数**（task-026：>0 时调用方早推一帧）。 */
  private mergeArp(entries: Map<string, ArpEntry>): number {
    // 最新一轮 ARP 快照即"当前在位视图"（覆盖而非累加，否则设备永远无法判离线）
    this.arp = new Map(entries);
    let created = 0;
    for (const [ip, entry] of entries) {
      const existed = this.records.has(ip);
      const rec = this.ensureRecord(ip, Date.now());
      rec.mac = entry.mac;
      rec.arpPresent = true;
      if (!existed) created += 1;
    }
    return created;
  }

  /**
   * 依据本轮观测刷新 `arpPresent` 与缺席计数（task-026：心跳与扫描轮**统一推进**缺席）。
   *
   * - 缺席计数两处调用均推进：心跳（5s）与扫描轮各计 1 轮，连续
   *   `HEARTBEAT_PROBE.offlineArpMisses`（4）轮「无 ARP 且 ping 失败」→ offline ≈ 20s。
   *   心跳只在 ARP 读取可用时调用本方法——缺席必须基于真实观测，读失败沿用上一轮视图不推进。
   * - `lastSeen` 只在本轮真的观测到（ARP 在位 / 本轮 ping 回包）时推进：
   *   陈旧的 `portResponded` 不得给设备续命（心跳侧对缺席设备另有显式失效逻辑）。
   */
  private applyArpPresence(latest?: Map<string, ArpEntry>): void {
    const now = Date.now();
    for (const rec of this.records.values()) {
      const present = latest ? latest.has(rec.ip) : this.arpPresentIn(rec.ip);
      rec.arpPresent = present;
      if (present || rec.pingAlive) {
        rec.arpMissStreak = 0;
        rec.lastSeen = now;
      } else {
        rec.arpMissStreak += 1;
      }
    }
  }

  private arpPresentIn(ip: string): boolean {
    return this.arp.has(ip);
  }

  private updatePortResponders(): void {
    for (const rec of this.records.values()) {
      if (rec.openPorts.length > 0) rec.portResponded = true;
    }
  }

  private ensureRecord(ip: string, at: number): DeviceRecord {
    let rec = this.records.get(ip);
    if (!rec) {
      rec = {
        ip,
        mac: null,
        // 持久化过"首次接入"的 IP 用历史值：重启不得把 firstSeen 重置成本次扫描时间
        firstSeen: this.firstSeenOverrides.get(ip) ?? at,
        lastSeen: at,
        ttl: null,
        openPorts: [],
        hostname: null,
        arpMissStreak: 0,
        arpPresent: false,
        pingAlive: false,
        portResponded: false,
        history: [],
      };
      this.records.set(ip, rec);
    }
    return rec;
  }

  private pushHistory(rec: DeviceRecord, rtt: number | null): void {
    const stat = this.meter.statFor(rec.ip);
    rec.history.push({ ts: Date.now(), rtt, rxBps: stat.rxBps, txBps: stat.txBps });
    if (rec.history.length > WINDOW.rttHistory) {
      rec.history.splice(0, rec.history.length - WINDOW.rttHistory);
    }
  }

  // —— 降级信息（R-03：静默失败必须可感知） ——

  /**
   * 用某个数据源"本轮"的结果整体替换它的告警集合：
   * 同源同文案只留 1 条（at 刷新），本轮不再出现的条件自然消失。
   */
  private replaceWarnings(source: WarningEntry['source'], messages: string[]): void {
    this.warningLog.clearSource(source);
    for (const message of messages) this.warningLog.push(source, message);
  }

  /** ARP 读取结果是否可用：解析失败或告警态回退上一轮视图（一次解析失败 ≠ 全网设备消失）。 */
  private arpReadUsable(result: ArpScanResult | null): boolean {
    if (!result) return false;
    if (result.error) return false;
    return !result.parseWarning;
  }

  /** ARP 读取的降级文案：`parseWarning` 此前在生产侧没有任何消费点。 */
  private arpWarnings(result: ArpScanResult): string[] {
    if (!result.parseWarning) return [];
    const detail = result.error ? `，${result.error}` : '';
    return [`ARP 表解析异常（source=${result.source}${detail}）`];
  }

  /** 快照里的 warnings：按 at 升序，超上限保留最新 20 条。 */
  private snapshotWarnings(sample: BandwidthSample | null): WarningEntry[] {
    const list = this.warningLog.list();
    // 采样失败但没有任何人写过 warning 时补一条，保证"没采到"绝不静默
    if (sample?.error && !list.some((w) => w.source === 'bandwidth')) {
      list.push({ source: 'bandwidth', message: `带宽采样失败：${sample.error}`, at: sample.at });
    }
    return list;
  }

  // —— 快照组装 ——

  buildDevices(): Device[] {
    const devices: Device[] = [];
    // 侦测联动：最近一轮有效 ARP 解析出的冲突 IP 集合（null = 尚无有效读取，一律 false）
    const conflictIps = new Set(
      (this.lastArpConflicts ?? []).map((c) => c.ip),
    );
    for (const rec of this.records.values()) {
      const isSelf = this.cfg.selfIp !== null && rec.ip === this.cfg.selfIp;
      const isGateway = this.cfg.gateway !== null && rec.ip === this.cfg.gateway;
      // task-029：网关 MAC（同源 MAC 提示用），网关记录未就绪时为 null
      const gatewayMac = this.cfg.gateway !== null ? this.records.get(this.cfg.gateway)?.mac ?? null : null;
      const quality = this.tracker.quality(rec.ip);
      // task-020：mDNS 自报类型（上轮 phaseFingerprint 采集）作为指纹输入；
      // mDNS 实例名（如"客厅的 Chromecast"）在无主机名时兜底显示名
      const mdnsHint = this.mdnsHints.get(rec.ip) ?? null;
      // task-023：WS-Discovery / SSDP 自报身份（上轮 phaseFingerprint 采集）
      const wsdHint = this.wsdiscoveryHints.get(rec.ip) ?? null;
      const ssdpHint = this.ssdpHints.get(rec.ip) ?? null;
      // task-027：HTTP 管理页指纹（上轮 phaseFingerprint 采集）
      const httpHint = this.httpHints.get(rec.ip) ?? null;
      // task-028：ONVIF 设备服务自报（上轮 phaseFingerprint 采集）
      const onvifHint = this.onvifHints.get(rec.ip) ?? null;
      // task-022 C-1：设备自身 hostname 为空时用 DHCP 租约自报回填（单点回填，
      // 同时服务指纹管线与展示）。不覆盖 rDNS/mDNS 已有值，不 mutate 记录。
      const leaseHostname = rec.hostname === null ? this.leaseHostnameByMac(rec.mac) : null;
      const effectiveHostname = rec.hostname ?? leaseHostname;
      // task-023：OUI 查不到时，本地管理位 MAC（安卓 10+/iOS 14+ 默认随机化）给出诚实
      // 标签——绝不猜厂商
      const lookedUpVendor = lookupVendor(rec.mac);
      const vendor =
        lookedUpVendor ?? (rec.mac !== null && isRandomizedMac(rec.mac) ? '随机 MAC（厂商不可判）' : null);
      const fingerprint = inferFingerprint({
        openPorts: rec.openPorts,
        hostname: effectiveHostname,
        vendor,
        ttl: rec.ttl,
        mac: rec.mac,
        gatewayMac,
        isGateway,
        mdnsKind: mdnsHint?.kind ?? null,
        mdnsOsHint: mdnsHint?.model ?? null,
        wsdiscoveryKind: wsdHint?.kind ?? null,
        onvifKind: onvifHint ? 'camera' : null,
        ssdpKind: ssdpHint?.kind ?? null,
        ssdpOsHint: ssdpHint?.osHint ?? null,
        httpKind: httpHint?.kind ?? null,
        httpOsHint: httpHint?.osHint ?? null,
      });
      const state = resolveLinkState({
        isSelf,
        isGateway,
        arpPresent: rec.arpPresent,
        pingAlive: rec.pingAlive,
        portResponded: rec.portResponded,
        arpMissStreak: rec.arpMissStreak,
        quality,
      });
      devices.push({
        id: `dev-${rec.ip}`,
        ip: rec.ip,
        mac: rec.mac,
        hostname: effectiveHostname,
        vendor,
        osHint: fingerprint.osHint,
        kind: fingerprint.kind,
        state,
        firstSeen: rec.firstSeen,
        lastSeen: rec.lastSeen,
        openPorts: rec.openPorts,
        quality,
        bandwidth: this.meter.statFor(rec.ip),
        rttHistory: this.tracker.history(rec.ip),
        isGateway,
        isSelf,
        displayName: effectiveHostname ?? mdnsHint?.name ?? ssdpHint?.name ?? null,
        ipConflict: conflictIps.has(rec.ip),
      });
    }
    devices.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      if (a.isGateway !== b.isGateway) return a.isGateway ? -1 : 1;
      return ipToNumber(a.ip) - ipToNumber(b.ip);
    });
    return devices;
  }

  private composeDevicesAndPrinters(
    realDevices: Device[],
    realPrinters: Printer[],
  ): { devices: Device[]; printers: Printer[]; dataSource: DataSource } {
    // 首轮扫描完成前不切演示数据：否则真实网段上启动的前 10 秒会挂满假设备与"演示数据"角标
    const scannedOnce = this.lastScanAt !== null;
    const needDemo =
      this.cfg.forceDemo || (scannedOnce && realDevices.length < DEMO_DEVICE_THRESHOLD);
    if (!needDemo) {
      return { devices: realDevices, printers: realPrinters, dataSource: 'live' };
    }
    const world = this.simulator.tick();
    return {
      devices: [...realDevices, ...world.devices],
      printers: [...realPrinters, ...world.printers],
      dataSource: realDevices.length > 0 ? 'mixed' : 'demo',
    };
  }

  /**
   * 组装快照。
   */
  buildSnapshot(): Snapshot {
    const now = Date.now();
    const realDevices = this.buildDevices();

    const composed = this.composeDevicesAndPrinters(realDevices, this.printers);
    const sample = this.meter.lastSample;
    // 只有"采到了且有差分基线"才算知道：未采样/解析失败/首次基线一律 null（≠ 0 流量）
    const bandwidth =
      sample !== null && sample.error === null && sample.intervalMs > 0 ? sample : null;

    const system: SystemStat = {
      totalDevices: composed.devices.length,
      online: composed.devices.filter((d) => d.state === 'online').length,
      offline: composed.devices.filter((d) => d.state === 'offline').length,
      degraded: composed.devices.filter((d) => d.state === 'degraded').length,
      printers: composed.printers.length,
      printersWithFault: composed.printers.filter(hasFault).length,
      // R-02：绝不把"没采到"写成 0
      rxBps: bandwidth?.rxBps ?? null,
      txBps: bandwidth?.txBps ?? null,
      // task-025：总带宽历史环（副本，防渲染层直接改引擎内存）
      bandwidthHistory: this.bandwidthHistory.map((p) => ({ ...p })),
      scan: this.progress,
      // lastScanAt / nextScanInMs / autoScanIntervalSec 在 task-026 后语义为"深度扫描"：
      // 端口/指纹/主机名采集仍靠全量扫描，活性判定已由 5s 心跳实时覆盖
      lastScanAt: this.lastScanAt,
      nextScanInMs: this.nextScanInMs(now),
      autoScan: this.autoScan,
      autoScanIntervalSec: this.cfg.autoScanIntervalSec,
    };

    const snapshot: Snapshot = {
      ts: now,
      subnet: this.cfg.subnetLabel,
      dataSource: composed.dataSource,
      devices: composed.devices,
      printers: composed.printers,
      system,
      // task-025：持续 Ping 监控状态（无目标时为空数组）
      watches: this.watches.status(),
      warnings: this.snapshotWarnings(sample),
    };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  private nextScanInMs(now: number): number | null {
    if (!this.autoScan || this.lastScanAt === null) return this.autoScan ? this.cfg.autoScanIntervalSec * 1000 : null;
    return Math.max(0, this.lastScanAt + this.cfg.autoScanIntervalSec * 1000 - now);
  }

  private emitSnapshot(): void {
    try {
      const snapshot = this.buildSnapshot();
      this.hooks.onSnapshot?.(snapshot);
      // 组装恢复正常 → 清掉上一次的组装失败告警
      this.replaceWarnings('system', []);
    } catch (err) {
      // R-03③：以前这里是空 catch，界面只会"停住不动"，没人知道快照已经组装不出来
      this.replaceWarnings('system', [
        `快照组装失败：${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
  }

  private emitProgress(): void {
    this.hooks.onScanProgress?.({ ...this.progress });
  }

  /** 详情抽屉：端口列表用最近一轮扫描结果；连接表现读 netstat -ano（83ms）。 */
  async getDeviceDetail(deviceId: string): Promise<DeviceDetail | null> {
    const devices = this.buildDevices();
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return null;

    const ports = PROBE_PORTS.map((port) => ({
      port,
      service: PORT_SERVICE[port] ?? 'unknown',
      open: device.openPorts.includes(port),
    }));

    let connections: DeviceDetail['connections'] = [];
    try {
      const rows = await readConnections();
      connections = rows
        .filter((row) => row.remoteIp === device.ip)
        .map((row) => ({
          remoteIp: row.remoteIp,
          remotePort: row.remotePort,
          state: row.state,
          proto: row.proto,
        }));
    } catch {
      connections = [];
    }

    const rec = this.records.get(device.ip);
    const history = (rec?.history ?? []).map((h) => ({
      ts: h.ts,
      rtt: h.rtt,
      rxBps: h.rxBps,
      txBps: h.txBps,
    }));

    return { device, ports, connections, history };
  }

  /**
   * 恢复持久化的设备首次接入表（task-017，引擎启动时、start() 之前调用）。
   * 新建设备记录时优先采用持久值，避免"重启 = 首次接入时间归零"。
   */
  hydrateFirstSeen(map: Record<string, number>): void {
    this.firstSeenOverrides = new Map(Object.entries(map));
  }

  /** 导出当前所有设备记录的首次接入时间（引擎退出时落盘）。 */
  exportFirstSeen(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const rec of this.records.values()) out[rec.ip] = rec.firstSeen;
    return out;
  }
}

export function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return 0;
  return ((parts[0] as number) * 256 ** 3) + ((parts[1] as number) * 256 ** 2) + ((parts[2] as number) * 256) + (parts[3] as number);
}
