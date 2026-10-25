/**
 * 打印机服务：三源合并（spooler 本机队列 + SNMP 网络设备 + mDNS 提示）+ **网络探活覆盖**。
 *
 * 本模块是整个任务的核心正确性点（brief §9.6）：
 *   `192.168.2.213`（Canon MF750C）在 spooler 里是 Normal/Idle/WorkOffline=false，
 *   但 TCP 9100/631/515 全部不可达 → state 必须被覆盖为 'offline' 并产出 PRINTER_OFFLINE 告警。
 *   不做这一步就会出现"打印机在线"的假象。
 *
 * 耗材来源抽象为可插拔的 ConsumableProvider：snmp → ipp → unknown。
 * 无数据时 `consumables: []`，绝不填 0。
 */
import type { Consumable, Device, ManualPrinterEntry, Printer, PrinterState } from '../../../shared/types';
import type { ArpEntry } from '../discovery/arp';
import { findIpByMac } from '../discovery/arp';
import type { ReachabilityResult } from '../discovery/ports';
import { looksLikePrinter, probePrinterEndpoint } from '../discovery/ports';
import type { MdnsPrinter } from './mdns';
import {
  buildStateDetail,
  mapPrinterState,
  modelFromDriver,
  parsePortName,
  toPrintJobs,
  type RawPrinter,
  type SpoolerSnapshot,
} from './spooler';
import {
  OID,
  parseMarkerLifeCount,
  parsePanelText,
  parseSupplies,
  parseSysDescr,
  sanitizeModel,
} from './printer-mib';
import { snmpGet, snmpWalk } from './snmp-client';
import { ippGetAttributes, toConsumables } from './ipp';

/** 耗材来源的统一接口。 */
export interface ConsumableProvider {
  readonly name: 'snmp' | 'ipp' | 'spooler' | 'unknown';
  load(ctx: ConsumableContext): Promise<ConsumableProviderResult>;
  /**
   * 可选：只读地查看上一次 SNMP 采集缓存（用于面板/告警文本）。
   * 声明在接口上而不是靠 `as SnmpConsumableProvider` 强转——按公开接口注入的
   * provider 可以不实现它，调用方必须做能力检测，不得假设存在。
   */
  statusOf?(ip: string): ConsumableProviderResult | null;
}

export interface ConsumableContext {
  ip: string | null;
  name: string;
  /** 便于未来 IPP 直连使用 */
  port?: number | null;
}

export interface ConsumableProviderResult {
  consumables: Consumable[];
  /** 清洗后的型号（≤40 字符，取首个分号前的部分）；通用驱动/无数据为 null */
  model: string | null;
  pageCount: number | null;
  /** 面板/告警文本（SNMP 路径可用） */
  panelText: string | null;
  /** SNMP sysDescr 原文（首行，≤120 字符）：只用于详情排查固件，绝不当作型号显示 */
  sysDescr?: string | null;
  error: string | null;
}

const emptyResult = (error: string | null = null): ConsumableProviderResult => ({
  consumables: [],
  model: null,
  pageCount: null,
  panelText: null,
  sysDescr: null,
  error,
});

interface SnmpCacheEntry {
  at: number;
  result: ConsumableProviderResult;
  positive: boolean;
}

const SNMP_POSITIVE_TTL = 60_000;
const SNMP_NEGATIVE_TTL = 300_000;

/**
 * SNMP 耗材提供者。带正/负缓存：实测本机 161 全部 timeout，
 * 若不缓存，每 15s 就会为每台打印机付 900ms×N 的超时代价。
 */
export class SnmpConsumableProvider implements ConsumableProvider {
  readonly name = 'snmp' as const;
  private cache = new Map<string, SnmpCacheEntry>();

  constructor(
    private readonly community = 'public',
    private readonly timeoutMs?: number,
  ) {}

  async load(ctx: ConsumableContext): Promise<ConsumableProviderResult> {
    if (!ctx.ip) return emptyResult('no-ip');
    const cached = this.cache.get(ctx.ip);
    if (cached) {
      const ttl = cached.positive ? SNMP_POSITIVE_TTL : SNMP_NEGATIVE_TTL;
      if (Date.now() - cached.at < ttl) return cached.result;
    }

    const session = { host: ctx.ip, community: this.community, timeoutMs: this.timeoutMs, retries: 0 };
    const scalars = await snmpGet(session, [OID.sysDescr, OID.sysName]);
    if (!scalars.ok) {
      const result = emptyResult(`snmp: ${scalars.error ?? 'no response'}`);
      this.cache.set(ctx.ip, { at: Date.now(), result, positive: false });
      return result;
    }

    const sysDescr = scalars.varbinds.find((v) => v.oid === OID.sysDescr)?.value ?? null;
    const sysDescrRaw = parseSysDescr(sysDescr);
    // 型号必须是"人能读的一行"：sysDescr 的 `; SS/NC/UI/ME/CC/DF …` 是固件版本，不是型号
    const model = sanitizeModel(sysDescrRaw);

    const supplies = await snmpWalk(session, OID.suppliesTable, { maxSteps: 80 });
    const consumables = supplies.ok ? parseSupplies(supplies.varbinds) : [];

    const lifeCount = await snmpWalk(session, OID.prtMarkerLifeCount, { maxSteps: 16 });
    const pageCount = lifeCount.ok ? parseMarkerLifeCount(lifeCount.varbinds) : null;

    const hr = await snmpWalk(session, OID.hrDeviceStatus, { maxSteps: 8 });
    const panel = await snmpWalk(session, OID.prtConsoleDisplayBufferText, { maxSteps: 8 });
    const hrStatus = hr.ok ? (hr.varbinds[0]?.value ?? null) : null;
    const panelText = panel.ok ? parsePanelText(panel.varbinds) : null;

    const result: ConsumableProviderResult = {
      consumables,
      model,
      pageCount,
      panelText: panelText ?? (hrStatus !== null ? `hrDeviceStatus:${String(hrStatus)}` : null),
      sysDescr: sysDescrRaw,
      error: null,
    };
    this.cache.set(ctx.ip, { at: Date.now(), result, positive: true });
    return result;
  }

  statusOf(ip: string): ConsumableProviderResult | null {
    return this.cache.get(ip)?.result ?? null;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * IPP 耗材提供者（opt-in，P2）。
 * 实测本机两台打印机都拒绝 Get-Printer-Attributes（0x0400/0x0406），
 * 因此默认路径上它会快速返回空；仅在 SNMP 无数据且设备支持 IPP 的现场才有产出。
 * 带负缓存（5min）：避免不支持 IPP 的设备每 15s 付 2.5s×2 的超时代价。
 */
export class IppConsumableProvider implements ConsumableProvider {
  readonly name = 'ipp' as const;
  private cache = new Map<string, { at: number; result: ConsumableProviderResult; positive: boolean }>();

  async load(ctx: ConsumableContext): Promise<ConsumableProviderResult> {
    if (!ctx.ip) return emptyResult('no-ip');
    const cached = this.cache.get(ctx.ip);
    if (cached) {
      const ttl = cached.positive ? 60_000 : 300_000;
      if (Date.now() - cached.at < ttl) return cached.result;
    }
    const res = await ippGetAttributes(ctx.ip);
    if (!res) {
      const result = emptyResult('ipp: no attributes (device does not report)');
      this.cache.set(ctx.ip, { at: Date.now(), result, positive: false });
      return result;
    }
    const make = res.attrs.get('printer-make-and-model')?.values[0];
    const result: ConsumableProviderResult = {
      consumables: toConsumables(res),
      model: typeof make === 'string' ? sanitizeModel(make) : null,
      pageCount: null,
      panelText: null,
      sysDescr: null,
      error: null,
    };
    this.cache.set(ctx.ip, { at: Date.now(), result, positive: true });
    return result;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * 按 snmp → ipp 顺序取第一个有耗材数据的 provider。
 * 一旦拿到耗材就短路，避免在 SNMP 已成功的设备上再多付一次 IPP 超时。
 */
export async function resolveConsumables(
  providers: ConsumableProvider[],
  ctx: ConsumableContext,
): Promise<{ consumables: Consumable[]; model: string | null; pageCount: number | null; sources: string[] }> {
  let consumables: Consumable[] = [];
  let model: string | null = null;
  let pageCount: number | null = null;
  const sources: string[] = [];
  for (const provider of providers) {
    const res = await provider.load(ctx);
    if (model === null && res.model) model = res.model;
    if (pageCount === null && res.pageCount !== null) pageCount = res.pageCount;
    if (res.consumables.length > 0) {
      consumables = res.consumables;
      sources.push(provider.name);
      break;
    }
  }
  return { consumables, model, pageCount, sources };
}

export interface CollectPrintersInput {
  spooler: SpoolerSnapshot;
  arp: Map<string, ArpEntry>;
  devices: Device[];
  /** mDNS 提示（可选）：只用于补齐缺失 IP，不新增来源类型 */
  mdns?: MdnsPrinter[];
  now?: number;
  /** 网络探活注入点（测试可替换） */
  probe?: (ip: string) => Promise<ReachabilityResult>;
  consumableProviders?: ConsumableProvider[];
  /** 关闭 SNMP 采集（例如 engine-check 的快速模式） */
  snmpEnabled?: boolean;
  /**
   * 打印管理页配置（可选）：手动添加的打印机合并进结果；
   * ignored 里的自动发现条目被过滤掉（不显示、不产生告警）。
   */
  manage?: { manual?: ManualPrinterEntry[]; ignored?: string[] };
}

export interface CollectPrintersResult {
  printers: Printer[];
  /** printerId → 网络是否可达；null 表示无 IP 无法探活 */
  reachable: Map<string, boolean | null>;
  ms: number;
  errors: string[];
}

function printerId(ip: string | null, name: string): string {
  return ip ? `prn-${ip}` : `prn-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function findCim(cim: SpoolerSnapshot['cim'], name: string) {
  const target = name.toLowerCase();
  return cim.find((c) => (c.Name ?? '').toLowerCase() === target) ?? null;
}

/** 用 mDNS 结果补齐无 IP 的打印机（名称相似即可，找不到就保持 null）。 */
export function applyMdnsHints(printers: Printer[], mdns: MdnsPrinter[]): void {
  if (mdns.length === 0) return;
  for (const printer of printers) {
    if (printer.ip) continue;
    const base = printer.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const hit = mdns.find((m) => {
      if (!m.ip) return false;
      const n = m.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
      return n.length > 2 && (n.includes(base) || base.includes(n));
    });
    if (hit?.ip) printer.ip = hit.ip;
  }
}

export async function collectPrinters(input: CollectPrintersInput): Promise<CollectPrintersResult> {
  const started = Date.now();
  const now = input.now ?? Date.now();
  const probe = input.probe ?? ((ip: string) => probePrinterEndpoint(ip));
  // 显式按接口类型持有：调用方只依赖 `name/load/statusOf?`，不依赖任何具体类
  const providers: ConsumableProvider[] =
    input.consumableProviders ??
    (input.snmpEnabled === false
      ? [new IppConsumableProvider()]
      : [new SnmpConsumableProvider(), new IppConsumableProvider()]);

  const probeCache = new Map<string, ReachabilityResult>();
  const probeOf = async (ip: string): Promise<ReachabilityResult> => {
    const cached = probeCache.get(ip);
    if (cached) return cached;
    const result = await probe(ip);
    probeCache.set(ip, result);
    return result;
  };

  const reachable = new Map<string, boolean | null>();
  const errors: string[] = [];
  if (input.spooler.errors.printers) errors.push(`printers: ${input.spooler.errors.printers}`);
  if (input.spooler.errors.cim) errors.push(`cim: ${input.spooler.errors.cim}`);
  if (input.spooler.errors.jobs) errors.push(`jobs: ${input.spooler.errors.jobs}`);

  // 按 PrinterName 关联（禁止用 -PrinterName 拼接，见 plan.md §5.3）
  const jobsByPrinter = new Map<string, ReturnType<typeof toPrintJobs>>();
  const jobGroups = new Map<string, SpoolerSnapshot['jobs']>();
  for (const row of input.spooler.jobs) {
    const key = (row.PrinterName ?? '').toLowerCase();
    const list = jobGroups.get(key) ?? [];
    list.push(row);
    jobGroups.set(key, list);
  }
  for (const [key, rows] of jobGroups) jobsByPrinter.set(key, toPrintJobs(rows));

  const printers: Printer[] = [];
  const seenIps = new Set<string>();

  for (const row of input.spooler.printers) {
    const name = row.Name ?? '';
    if (!name) continue;
    const port = parsePortName(row.PortName, name);
    const ip = port.ip ?? findIpByMac(input.arp, port.macInName);
    if (ip) seenIps.add(ip);
    const cim = findCim(input.spooler.cim, name);

    const baseState = mapPrinterState({
      gpStatus: row.PrinterStatus ?? null,
      cimStatus: cim?.PrinterStatus ?? null,
      workOffline: cim?.WorkOffline ?? null,
      detectedErrorState: cim?.DetectedErrorState ?? null,
      jobCount: row.JobCount ?? (jobsByPrinter.get(name.toLowerCase())?.length ?? 0),
    });
    const baseDetail = buildStateDetail(
      row.PrinterStatus ?? null,
      cim?.PrinterStatus ?? null,
      cim?.DetectedErrorState ?? null,
      cim?.WorkOffline ?? null,
    );

    let state: PrinterState = baseState;
    let stateDetail = baseDetail;
    let probeInfo: ReachabilityResult | null = null;

    if (ip) {
      probeInfo = await probeOf(ip);
      if (!probeInfo.reachable) {
        state = 'offline';
        stateDetail = [baseDetail, `网络探活失败 ${probeInfo.triedPorts.join('/')}`]
          .filter(Boolean)
          .join(' · ');
      } else if (baseState === 'offline') {
        // 网络可达但 spooler 报 Offline：保留 spooler 的判定（例如队列被人为离线）
        state = 'offline';
        stateDetail = [baseDetail, `网络可达 ${probeInfo.port}`].filter(Boolean).join(' · ');
      }
      reachable.set(printerId(ip, name), probeInfo.reachable);
    }

    let consumables: Consumable[] = [];
    let model = modelFromDriver(row.DriverName);
    let pageCount: number | null = null;
    let panelText: string | null = null;
    let sysDescrRaw: string | null = null;

    // 网络不可达的打印机不查耗材：既省 900ms×N 的 SNMP 超时，也避免对离线设备"猜"数据
    if (ip && probeInfo?.reachable !== false) {
      const resolved = await resolveConsumables(providers, { ip, name, port: probeInfo?.port ?? null });
      consumables = resolved.consumables;
      if (model === null && resolved.model) model = resolved.model;
      pageCount = resolved.pageCount;
      // statusOf 是接口上的可选能力：未实现（或注入的替身没写）时静默跳过，不能让
      // 一次 TypeError 打断 15s 打印刷新周期
      const snmpProvider = providers.find((p) => p.name === 'snmp');
      const statusOf = snmpProvider?.statusOf;
      const status = typeof statusOf === 'function' ? statusOf.call(snmpProvider, ip) : null;
      panelText = status?.panelText ?? null;
      // sysDescr 原文进详情（前 80 字符）：排查固件版本时必须能看到 SS/NC/UI/ME/CC/DF
      sysDescrRaw = status?.sysDescr ?? null;
    }

    const detailParts = [
      stateDetail,
      sysDescrRaw ? `sysDescr: ${sysDescrRaw.slice(0, 80)}` : null,
      panelText,
    ].filter((part): part is string => Boolean(part));

    printers.push({
      id: printerId(ip, name),
      name,
      alias: null,
      model,
      ip,
      mac: ip ? (input.arp.get(ip)?.mac ?? null) : port.macInName ? port.macInName.toLowerCase().replace(/:/g, '-') : null,
      connection: port.connection,
      state,
      stateDetail: detailParts.join(' · ') || stateDetail,
      isDefault: cim?.Default === true,
      shared: row.Shared === true,
      manual: false,
      pageCount,
      consumables,
      jobs: jobsByPrinter.get(name.toLowerCase()) ?? [],
      source: consumables.length > 0 ? 'both' : 'spooler',
      lastSeen: now,
    });
  }

  // 纯网络打印机（SNMP / 端口发现，spooler 里没有）：从设备列表补进来
  for (const device of input.devices) {
    if (seenIps.has(device.ip)) continue;
    if (!(device.kind === 'printer' || looksLikePrinter(device.openPorts))) continue;
    seenIps.add(device.ip);

    const probeExisting = device.openPorts.some((p) => p === 9100 || p === 631 || p === 515);
    const probeInfo = probeExisting
      ? ({ reachable: true, port: device.openPorts.find((p) => p === 9100 || p === 631 || p === 515) ?? null, triedPorts: [] } satisfies ReachabilityResult)
      : await probeOf(device.ip);

    const resolved = await resolveConsumables(providers, { ip: device.ip, name: device.hostname ?? device.ip });
    // 无 spooler 视角可依，状态只由网络探活决定（探活不通即 offline）
    const state: PrinterState = probeInfo.reachable ? 'idle' : 'offline';

    const id = printerId(device.ip, device.hostname ?? device.ip);
    reachable.set(id, probeInfo.reachable);
    printers.push({
      id,
      name: device.hostname ?? device.displayName ?? (device.vendor ? `${device.vendor} 打印机` : `网络打印机 ${device.ip}`),
      alias: null,
      model: resolved.model,
      ip: device.ip,
      mac: device.mac,
      connection: 'network',
      state,
      stateDetail: probeInfo.reachable ? `端口 ${probeInfo.port ?? '-'} 可达` : `网络探活失败 ${probeInfo.triedPorts.join('/') || '9100/631/515'}`,
      isDefault: false,
      shared: false,
      manual: false,
      pageCount: resolved.pageCount,
      consumables: resolved.consumables,
      jobs: [],
      source: 'snmp',
      lastSeen: now,
    });
  }

  // —— 手动添加的打印机（打印管理页）：自动发现不到也纳入监控，按 IP 去重 ——
  // 探活失败 → 如实 offline（用户需要看到"添加了但设备不响应"，而不是条目消失）。
  // 忽略列表对 manual 条目不生效（删除走 removeManualPrinter）。
  for (const m of input.manage?.manual ?? []) {
    if (printers.some((p) => p.ip === m.ip)) continue;
    const probeInfo = await probeOf(m.ip);
    let consumables: Consumable[] = [];
    let model: string | null = null;
    let pageCount: number | null = null;
    if (probeInfo.reachable) {
      const resolved = await resolveConsumables(providers, { ip: m.ip, name: m.note ?? m.ip });
      consumables = resolved.consumables;
      model = resolved.model;
      pageCount = resolved.pageCount;
    }
    const state: PrinterState = probeInfo.reachable ? 'idle' : 'offline';
    const manualId = printerId(m.ip, m.note ?? m.ip);
    // reachable 必须与发现条目同口径登记：告警引擎按它评估 PRINTER_OFFLINE，
    // 漏登记会让手动打印机的离线永远不产生告警
    reachable.set(manualId, probeInfo.reachable);
    printers.push({
      id: manualId,
      name: m.note ?? `手动打印机 ${m.ip}`,
      alias: null,
      model,
      ip: m.ip,
      mac: input.arp.get(m.ip)?.mac ?? null,
      connection: 'network',
      state,
      stateDetail: probeInfo.reachable
        ? `端口 ${probeInfo.port ?? '-'} 可达（手动添加）`
        : `网络探活失败 ${probeInfo.triedPorts.join('/') || '9100/631/515'}（手动添加）`,
      isDefault: false,
      shared: false,
      manual: true,
      pageCount,
      consumables,
      jobs: [],
      source: consumables.length > 0 ? 'snmp' : 'spooler',
      lastSeen: now,
    });
  }

  applyMdnsHints(printers, input.mdns ?? []);

  // —— 忽略过滤：被忽略的自动发现条目不显示、不产生告警；手动条目不受影响 ——
  const ignoredIds = input.manage?.ignored;
  const filtered = ignoredIds && ignoredIds.length > 0
    ? printers.filter((p) => p.manual || !ignoredIds.includes(p.id))
    : printers;

  filtered.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  return { printers: filtered, reachable, ms: Date.now() - started, errors };
}

/** 打印机是否有故障（SystemStat.printersWithFault 用）。 */
export function hasFault(printer: Printer): boolean {
  return printer.state === 'error' || printer.state === 'offline' || printer.state === 'warning';
}

export type { RawPrinter };
