import { isIP } from 'node:net';
import type { Consumable, Device, ManualPrinterEntry, Printer, PrinterState } from '../../../shared/types';
import type { ArpEntry } from '../discovery/arp';
import { findIpByMac } from '../discovery/arp';
import type { ReachabilityResult } from '../discovery/ports';
import { looksLikePrinter, probePrinterEndpoint } from '../discovery/ports';
import type { MdnsPrinter } from './mdns';
import {
  buildStateDetail, mapPrinterState, modelFromDriver, resolvePrinterPort, toPrintJobs,
  type SpoolerSnapshot,
} from './spooler';
import { OID, parseMarkerLifeCount, parsePanelText, parseSupplies, parseSysDescr, sanitizeModel } from './printer-mib';
import { snmpGet, snmpWalk } from './snmp-client';
import { ippGetAttributes, toConsumables, toPrinterState } from './ipp';

export interface ConsumableProvider {
  readonly name: 'snmp' | 'ipp' | 'spooler' | 'unknown';
  load(ctx: ConsumableContext): Promise<ConsumableProviderResult>;
  statusOf?(ip: string): ConsumableProviderResult | null;
}

export interface ConsumableContext {
  ip: string | null;
  name: string;
  port?: number | null;
}

export interface ConsumableProviderResult {
  consumables: Consumable[];
  model: string | null;
  pageCount: number | null;
  panelText: string | null;
  sysDescr?: string | null;
  state?: PrinterState;
  error: string | null;
}

const emptyResult = (error: string | null = null): ConsumableProviderResult => ({
  consumables: [], model: null, pageCount: null, panelText: null, sysDescr: null, error,
});

interface CacheEntry {
  at: number;
  result: ConsumableProviderResult;
  positive: boolean;
}

const SNMP_POSITIVE_TTL = 60_000;
const NEGATIVE_TTL = 300_000;

export class SnmpConsumableProvider implements ConsumableProvider {
  readonly name = 'snmp' as const;
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly community = 'public', private readonly timeoutMs?: number) {}

  async load(ctx: ConsumableContext): Promise<ConsumableProviderResult> {
    if (!ctx.ip) return emptyResult('no-ip');
    const cached = this.cache.get(ctx.ip);
    if (cached && Date.now() - cached.at < (cached.positive ? SNMP_POSITIVE_TTL : NEGATIVE_TTL)) {
      return cached.result;
    }
    if (this.cache.size >= 512) this.cache.clear();
    const session = { host: ctx.ip, community: this.community, timeoutMs: this.timeoutMs, retries: 0 };
    const scalars = await snmpGet(session, [OID.sysDescr, OID.sysName]);
    if (!scalars.ok) {
      const result = emptyResult(`snmp: ${scalars.error ?? 'no response'}`);
      this.cache.set(ctx.ip, { at: Date.now(), result, positive: false });
      return result;
    }
    const sysDescrRaw = parseSysDescr(scalars.varbinds.find((v) => v.oid === OID.sysDescr)?.value ?? null);
    const supplies = await snmpWalk(session, OID.suppliesTable, { maxSteps: 80 });
    const lifeCount = await snmpWalk(session, OID.prtMarkerLifeCount, { maxSteps: 16 });
    const hr = await snmpWalk(session, OID.hrDeviceStatus, { maxSteps: 8 });
    const panel = await snmpWalk(session, OID.prtConsoleDisplayBufferText, { maxSteps: 8 });
    const hrStatus = hr.ok ? (hr.varbinds[0]?.value ?? null) : null;
    const result: ConsumableProviderResult = {
      consumables: supplies.ok ? parseSupplies(supplies.varbinds) : [],
      model: sanitizeModel(sysDescrRaw),
      pageCount: lifeCount.ok ? parseMarkerLifeCount(lifeCount.varbinds) : null,
      panelText: (panel.ok ? parsePanelText(panel.varbinds) : null) ?? (hrStatus !== null ? `hrDeviceStatus:${String(hrStatus)}` : null),
      sysDescr: sysDescrRaw,
      error: null,
    };
    this.cache.set(ctx.ip, { at: Date.now(), result, positive: true });
    return result;
  }

  statusOf(ip: string): ConsumableProviderResult | null {
    return this.cache.get(ip)?.result ?? null;
  }

  clear(): void { this.cache.clear(); }
}

export class IppConsumableProvider implements ConsumableProvider {
  readonly name = 'ipp' as const;
  private cache = new Map<string, CacheEntry>();

  async load(ctx: ConsumableContext): Promise<ConsumableProviderResult> {
    if (!ctx.ip) return emptyResult('no-ip');
    const cached = this.cache.get(ctx.ip);
    if (cached && Date.now() - cached.at < (cached.positive ? 15_000 : NEGATIVE_TTL)) return cached.result;
    if (this.cache.size >= 512) this.cache.clear();
    const res = await ippGetAttributes(ctx.ip);
    if (!res) {
      const result = emptyResult('ipp: no attributes');
      this.cache.set(ctx.ip, { at: Date.now(), result, positive: false });
      return result;
    }
    const make = res.attrs.get('printer-make-and-model')?.values[0];
    const status = toPrinterState(res);
    const result: ConsumableProviderResult = {
      consumables: toConsumables(res),
      model: typeof make === 'string' ? sanitizeModel(make) : null,
      pageCount: null, panelText: status.detail, state: status.state, sysDescr: null, error: null,
    };
    this.cache.set(ctx.ip, { at: Date.now(), result, positive: true });
    return result;
  }

  clear(): void { this.cache.clear(); }
}

interface ResolvedPrinter extends ConsumableProviderResult { sources: string[] }

export async function resolveConsumables(providers: ConsumableProvider[], ctx: ConsumableContext): Promise<ResolvedPrinter> {
  const result: ResolvedPrinter = { ...emptyResult(), sources: [] };
  for (const provider of providers) {
    let res: ConsumableProviderResult;
    try {
      res = await provider.load(ctx);
    } catch {
      continue;
    }
    if (res.error) continue;
    if (provider.name !== 'unknown') result.sources.push(provider.name);
    result.model ??= res.model;
    result.pageCount ??= res.pageCount;
    result.panelText ??= res.panelText;
    result.sysDescr ??= res.sysDescr;
    if (res.state && res.state !== 'unknown') result.state = res.state;
    if (res.consumables.length > 0) {
      result.consumables = res.consumables;
      break;
    }
  }
  return result;
}

export interface CollectPrintersInput {
  spooler: SpoolerSnapshot;
  arp: Map<string, ArpEntry>;
  devices: Device[];
  mdns?: MdnsPrinter[];
  discoveryHosts?: readonly string[];
  now?: number;
  probe?: (ip: string) => Promise<ReachabilityResult>;
  consumableProviders?: ConsumableProvider[];
  snmpEnabled?: boolean;
  manage?: { manual?: ManualPrinterEntry[]; ignored?: string[] };
}

export interface CollectPrintersResult {
  printers: Printer[];
  reachable: Map<string, boolean | null>;
  ms: number;
  errors: string[];
}

function printerId(ip: string | null, name: string): string {
  return ip ? `prn-${ip}` : `prn-${encodeURIComponent(name.toLowerCase())}`;
}

function normalizedName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function matchingMdns(name: string, mdns: MdnsPrinter[]): MdnsPrinter | null {
  const key = normalizedName(name);
  if (key.length < 3) return null;
  const matches = mdns.filter((m) => m.ip && normalizedName(m.name) === key);
  return new Set(matches.map((m) => m.ip)).size === 1 ? matches[0] ?? null : null;
}

function mergeState(base: PrinterState, reported?: PrinterState): PrinterState {
  if (base === 'offline' || base === 'error') return base;
  if (reported === 'error' || reported === 'offline') return reported;
  if (base === 'warning' || reported === 'warning') return 'warning';
  if (base === 'printing' || reported === 'printing') return 'printing';
  return reported && reported !== 'unknown' ? reported : base;
}

function networkSource(resolved: ResolvedPrinter, mdns: boolean): Printer['source'] {
  if (resolved.sources.includes('snmp')) return 'snmp';
  if (resolved.sources.includes('ipp')) return 'ipp';
  return mdns ? 'mdns' : 'probe';
}

export async function collectPrinters(input: CollectPrintersInput): Promise<CollectPrintersResult> {
  const started = Date.now();
  const now = input.now ?? started;
  const allowed = input.discoveryHosts ? new Set(input.discoveryHosts) : null;
  const mdns = (input.mdns ?? []).filter((m) => m.ip && isIP(m.ip) === 4 && (!allowed || allowed.has(m.ip))
    && ['_ipp._tcp.local', '_pdl-datastream._tcp.local'].includes(m.service.toLowerCase().replace(/\.$/, '')));
  const hintsByIp = new Map<string, MdnsPrinter>();
  for (const hint of mdns) {
    if (!hint.ip) continue;
    const previous = hintsByIp.get(hint.ip);
    if (!previous || (!previous.model && hint.model)) hintsByIp.set(hint.ip, hint);
  }
  const providers: ConsumableProvider[] = input.consumableProviders ?? (input.snmpEnabled === false
    ? [new IppConsumableProvider()] : [new SnmpConsumableProvider(), new IppConsumableProvider()]);
  const probeCache = new Map<string, Promise<ReachabilityResult>>();
  const probeOf = (ip: string): Promise<ReachabilityResult> => {
    let pending = probeCache.get(ip);
    if (!pending) {
      const advertised = hintsByIp.get(ip)?.port;
      const ports = advertised && Number.isInteger(advertised) && advertised > 0 && advertised <= 65535
        ? [...new Set([advertised, 9100, 631, 515])] : [9100, 631, 515];
      pending = input.probe ? input.probe(ip) : probePrinterEndpoint(ip, ports);
      probeCache.set(ip, pending);
    }
    return pending;
  };
  const telemetryCache = new Map<string, Promise<ResolvedPrinter>>();
  const telemetryOf = (ip: string, name: string): Promise<ResolvedPrinter> => {
    let pending = telemetryCache.get(ip);
    if (!pending) {
      pending = resolveConsumables(providers, { ip, name });
      telemetryCache.set(ip, pending);
    }
    return pending;
  };
  const reachable = new Map<string, boolean | null>();
  const errors = Object.entries(input.spooler.errors).filter(([, error]) => error).map(([source, error]) => `${source}: ${error}`);
  const jobsByPrinter = new Map<string, SpoolerSnapshot['jobs']>();
  for (const job of input.spooler.jobs) {
    const key = (job.PrinterName ?? '').toLowerCase();
    const jobs = jobsByPrinter.get(key) ?? [];
    jobs.push(job);
    jobsByPrinter.set(key, jobs);
  }
  const manual = new Map((input.manage?.manual ?? []).map((entry) => [entry.ip, entry]));
  const printers: Printer[] = [];
  const seenIps = new Set<string>();
  const seenNames = new Set<string>();
  const ignored = new Set(input.manage?.ignored ?? []);

  for (const row of input.spooler.printers) {
    const name = row.Name ?? '';
    if (!name || seenNames.has(name.toLowerCase())) continue;
    seenNames.add(name.toLowerCase());
    const cim = input.spooler.cim.find((c) => c.Name?.toLowerCase() === name.toLowerCase());
    const port = resolvePrinterPort({ ...row, PortName: row.PortName ?? cim?.PortName }, input.spooler.ports);
    const network = port.connection !== 'usb' && port.connection !== 'virtual';
    const ip = network ? port.ip ?? findIpByMac(input.arp, port.macInName) ?? matchingMdns(name, mdns)?.ip ?? null : null;
    const hint = ip ? hintsByIp.get(ip) : undefined;
    if (ip) seenIps.add(ip);
    const id = `prn-queue-${encodeURIComponent(name.toLowerCase())}`;
    const isManual = ip !== null && manual.has(ip);
    if (!isManual && ignored.has(id)) continue;
    const jobs = toPrintJobs(jobsByPrinter.get(name.toLowerCase()) ?? []);
    const cimStatus = cim?.PrinterStatus ?? row.CimStatus;
    const workOffline = cim?.WorkOffline ?? row.WorkOffline;
    const detectedErrorState = cim?.DetectedErrorState ?? row.DetectedErrorState;
    let state = mapPrinterState({ gpStatus: row.PrinterStatus, cimStatus,
      workOffline, detectedErrorState, jobCount: row.JobCount ?? jobs.length });
    const details = [buildStateDetail(row.PrinterStatus, cimStatus, detectedErrorState, workOffline)];
    const probe = ip ? await probeOf(ip) : null;
    reachable.set(id, probe?.reachable ?? null);
    let resolved: ResolvedPrinter = { ...emptyResult(), sources: [] };
    if (probe && ip) {
      if (!probe.reachable) {
        state = 'offline';
        details.push(`网络探活失败 ${probe.triedPorts.join('/')}`);
      } else {
        resolved = await telemetryOf(ip, name);
        if (state === 'offline') details.push(`网络可达 ${probe.port}`);
        state = mergeState(state, resolved.state);
      }
    }
    const snmp = probe?.reachable && ip ? providers.find((p) => p.name === 'snmp')?.statusOf?.(ip) : null;
    const sysDescr = resolved.sysDescr ?? snmp?.sysDescr;
    if (sysDescr) details.push(`sysDescr: ${sysDescr.slice(0, 80)}`);
    details.push(resolved.panelText ?? snmp?.panelText ?? null);
    printers.push({
      id, name, queueName: name, alias: null,
      model: modelFromDriver(row.DriverName) ?? resolved.model ?? sanitizeModel(hint?.model),
      ip, mac: ip ? input.arp.get(ip)?.mac ?? null : port.macInName?.toLowerCase().replace(/:/g, '-') ?? null,
      connection: ip ? 'network' : port.connection, state, stateDetail: details.filter(Boolean).join(' · ') || null,
      isDefault: (cim?.Default ?? row.Default) === true, shared: row.Shared === true, manual: isManual,
      pageCount: resolved.pageCount, consumables: resolved.consumables, jobs,
      source: resolved.sources.length > 0 ? 'both' : 'spooler', lastSeen: now,
    });
  }

  const candidates = new Map<string, { name: string; mac: string | null }>();
  for (const device of input.devices) {
    if (device.id.startsWith('sim-') || isIP(device.ip) !== 4) continue;
    if (device.kind === 'printer' || looksLikePrinter(device.openPorts)) {
      candidates.set(device.ip, { name: device.hostname ?? device.displayName ?? `${device.vendor ?? '网络'} 打印机 ${device.ip}`, mac: device.mac });
    }
  }
  for (const [ip, hint] of hintsByIp) {
    if (!candidates.has(ip)) candidates.set(ip, { name: hint.name, mac: input.arp.get(ip)?.mac ?? null });
  }
  for (const [ip, entry] of manual) {
    if (!candidates.has(ip)) candidates.set(ip, { name: entry.note ?? `手动打印机 ${ip}`, mac: input.arp.get(ip)?.mac ?? null });
  }
  for (const [ip, candidate] of candidates) {
    if (seenIps.has(ip)) continue;
    const id = printerId(ip, candidate.name);
    const isManual = manual.has(ip);
    if (!isManual && ignored.has(id)) continue;
    const probe = await probeOf(ip);
    const resolved = probe.reachable ? await telemetryOf(ip, candidate.name) : { ...emptyResult(), sources: [] };
    const hint = hintsByIp.get(ip);
    const detail = probe.reachable ? `端口 ${probe.port ?? '-'} 可达` : `网络探活失败 ${probe.triedPorts.join('/') || '9100/631/515'}`;
    reachable.set(id, probe.reachable);
    printers.push({
      id, name: candidate.name, queueName: null, alias: null,
      model: resolved.model ?? sanitizeModel(hint?.model), ip, mac: candidate.mac, connection: 'network',
      state: probe.reachable ? mergeState('unknown', resolved.state) : 'offline',
      stateDetail: [detail + (isManual ? '（手动添加）' : ''), resolved.panelText].filter(Boolean).join(' · '),
      isDefault: false, shared: false, manual: isManual, pageCount: resolved.pageCount,
      consumables: resolved.consumables, jobs: [], source: networkSource(resolved, !!hint),
      lastSeen: now,
    });
  }
  printers.sort((a, b) => a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return { printers, reachable, ms: Date.now() - started, errors };
}

export function hasFault(printer: Printer): boolean {
  return printer.state === 'error' || printer.state === 'offline' || printer.state === 'warning';
}
