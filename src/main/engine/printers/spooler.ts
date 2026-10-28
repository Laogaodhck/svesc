/**
 * Windows 打印后台处理程序（spooler）读取。
 *
 * 实测（investigation-report.md §2.6）：Get-Printer / Get-PrintJob / Win32_Printer 全部可读、无权限错误。
 *  - 主源 `Get-Printer | ConvertTo-Json`（765ms，全量一次取回，**内存过滤**）
 *  - `Get-CimInstance Win32_Printer`（859ms）只补 Default / WorkOffline / DetectedErrorState
 *  - `Get-PrintJob`（702ms）空队列时 PowerShell 输出**空字符串** → 必须容错为 []
 *  - `Get-PrinterProperty` 不作耗材来源（实测 SHARP 空、Xerox 仅 FormTrayTable）
 *
 * 安全：打印机名含 `()` `:`，**绝不**拼进 `Get-PrintJob -PrinterName '<name>'`；
 * 一律全量取回 + 内存通过 PrinterName 关联（plan.md §5.3）。
 * 编码：PowerShell + UTF-8 + ConvertTo-Json，按 UTF-8 解码（双通道路径 2）。
 */
import { isIP } from 'node:net';
import type { PrintJob, PrinterState } from '../../../shared/types';
import { parsePsJson, psJsonCommand, runPowerShell, type RunResult } from '../exec';
import { sanitizeModel } from './printer-mib';

export interface RawPrinter {
  Name?: string;
  DriverName?: string;
  PortName?: string;
  PrinterStatus?: number;
  /** CIM 回退的 Win32 状态枚举，不可作为 Get-Printer 状态。 */
  CimStatus?: number;
  Default?: boolean;
  WorkOffline?: boolean;
  DetectedErrorState?: number;
  Shared?: boolean;
  JobCount?: number;
  Type?: number;
  Published?: boolean;
  ShareName?: string;
}

export interface RawCimPrinter {
  Name?: string;
  Default?: boolean;
  WorkOffline?: boolean;
  PrinterStatus?: number;
  DetectedErrorState?: number;
  ExtendedPrinterStatus?: number;
  PortName?: string;
}

export interface RawPrintJob {
  Id?: number;
  PrinterName?: string;
  DocumentName?: string;
  Owner?: string;
  JobStatus?: number | string;
  TotalPages?: number;
  PagesPrinted?: number;
  SubmittedTime?: string | number | null;
}

/** Win32_TCPIPPrinterPort 提供的端口名与实际目标地址。 */
export interface RawPrinterPort {
  Name?: string;
  HostAddress?: string;
}

export interface SpoolerSnapshot {
  printers: RawPrinter[];
  cim: RawCimPrinter[];
  jobs: RawPrintJob[];
  /** 可选以兼容旧快照；未采集与成功采集到空列表不同。 */
  ports?: RawPrinterPort[];
  errors: { printers: string | null; cim: string | null; jobs: string | null; ports?: string | null };
  ms: number;
  /** 主源失败、改用 Win32_Printer / Win32_PrintJob 的回退标记 */
  fallbackUsed: boolean;
}

// —— 纯函数区（Tess 可直接断言）——

const RE_PORT_IP_PREFIX = /^IP_(\d{1,3}(?:\.\d{1,3}){3})(?:_\d+)?$/i;
// 先检查原始 authority，避免 URL 将短地址、八进制、十六进制或转义 hostname 规范化为 IPv4。
const RE_PORT_URL_IP = /^(?:https?|ipps?):\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i;
const RE_MAC_IN_NAME = /\(([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})\)/i;

export interface PortInfo {
  /** 可用的 IPv4；拿不到为 null（不猜） */
  ip: string | null;
  /** 端口名里携带的 MAC（WSD 打印机名称里常见），供反查 ARP */
  macInName: string | null;
  connection: 'network' | 'usb' | 'virtual' | 'unknown';
  raw: string;
}

/**
 * 从 PortName 解析 IPv4 与连接类型；不进行 DNS 查询或网络探测。
 * 支持裸 IPv4、IP_<IPv4>[_重复端口序号]、http(s)/ipp(s) 的明确 IPv4。
 * WSD/UNC 只标识连接类型；虚拟输出和 USB 端口不提供网络地址。
 */
export function parsePortName(portName: string | undefined | null, printerName?: string | null): PortInfo {
  const raw = (portName ?? '').trim();
  if (isIP(raw) === 4) return { ip: raw, macInName: null, connection: 'network', raw };
  const ipPrefixed = RE_PORT_IP_PREFIX.exec(raw)?.[1];
  if (ipPrefixed && isIP(ipPrefixed) === 4) {
    return { ip: ipPrefixed, macInName: null, connection: 'network', raw };
  }
  const urlIp = RE_PORT_URL_IP.exec(raw)?.[1];
  if (urlIp && isIP(urlIp) === 4) {
    try {
      // URL 仅做语法校验（例如端口范围），不解析 hostname 为地址。
      const url = new URL(raw);
      if (url.hostname === urlIp) return { ip: urlIp, macInName: null, connection: 'network', raw };
    } catch {
      // 非法 URL 不产生地址证据。
    }
  }
  const macMatch = RE_MAC_IN_NAME.exec(printerName ?? '') ?? RE_MAC_IN_NAME.exec(raw);
  const macInName = macMatch?.[1] ?? null;
  if (/^(portprompt|shrfa|xps|file|nul)/i.test(raw) || /\.(pdf|oxps|xps)$/i.test(raw)) {
    return { ip: null, macInName, connection: 'virtual', raw };
  }
  if (/^(usb|dot4|lpt|com)/i.test(raw)) return { ip: null, macInName, connection: 'usb', raw };
  if (/^wsd-/i.test(raw) || /^\\\\/i.test(raw)) {
    return { ip: null, macInName, connection: 'network', raw };
  }
  return { ip: null, macInName, connection: 'unknown', raw };
}

/** 实际端口映射优先于端口名中的地址猜测；USB/虚拟端口不升级为网络打印机。 */
export function resolvePrinterPort(row: RawPrinter, ports: readonly RawPrinterPort[] = []): PortInfo {
  const parsed = parsePortName(row.PortName, row.Name);
  if (parsed.connection === 'virtual' || parsed.connection === 'usb') return parsed;
  // 已知虚拟驱动即使绑定了自定义端口，也不能据此变成物理网络设备。
  // 不过滤 Microsoft IPP Class Driver 等可用于真实设备的类驱动。
  if (/\b(?:Microsoft Print to PDF|Microsoft XPS Document Writer|OneNote|Adobe PDF|PDFCreator|CutePDF Writer)\b/i.test(row.DriverName ?? '')) {
    return { ...parsed, ip: null, connection: 'virtual' };
  }
  const port = ports.find((candidate) =>
    Boolean(row.PortName) && candidate.Name === row.PortName &&
    typeof candidate.HostAddress === 'string' && isIP(candidate.HostAddress) === 4,
  );
  return port?.HostAddress ? { ...parsed, ip: port.HostAddress, connection: 'network' } : parsed;
}

/** 驱动名 → 型号。通用驱动及仅打印语言/架构描述不作为具体型号。 */
export function modelFromDriver(driverName: string | undefined | null): string | null {
  const d = (driverName ?? '').trim();
  if (!d || /microsoft|\b(?:universal|generic|class)\b|通用/i.test(d)) return null;
  // 先排除打印语言、版本和位数中的数字，避免 PCL6 / PS3 / x64 冒充型号。
  const identity = d.split(/[\r\n;；]/)[0]?.replace(
    /\b(?:pcl\s*(?:[56](?:e|c)?(?:\s*[/&+]\s*[56](?:e|c)?)?|xl)?|ps\s*[23]?|postscript(?:\s+level)?\s*[23]?|ufr\s*ii|xps|ipp|x(?:64|86)|(?:32|64)[ -]?bit|(?:v(?:er(?:sion)?)?\.?\s*)\d+(?:\.\d+)*)\b/gi,
    '',
  ) ?? '';
  if (!/\d/.test(identity)) return null;
  return sanitizeModel(d);
}

const DETECTED_ERROR_TEXT: Record<number, string> = {
  0: 'Unknown',
  1: 'Other',
  2: 'No Error',
  3: 'Low Paper',
  4: 'No Paper',
  5: 'Low Toner',
  6: 'No Toner',
  7: 'Door Open',
  8: 'Jammed',
  9: 'Offline',
  10: 'Service Requested',
  11: 'Output Bin Full',
};

const GET_PRINTER_STATUS_TEXT: Record<number, string> = {
  0: 'Normal',
  1: 'Paused',
  2: 'Error',
  3: 'Pending',
  4: 'PaperJam',
  5: 'PaperOut',
  6: 'Offline',
  7: 'IOActive',
  8: 'Busy',
  9: 'Printing',
  10: 'Warmup',
  11: 'Stopped',
};

/**
 * 状态映射（实测值，investigation-report.md §3.6）：
 *  - Get-Printer.PrinterStatus: 0 Normal / 1 Paused / 2 Error / 4 PaperJam / 5 PaperOut / 6 Offline
 *  - Win32_Printer.PrinterStatus: 3 Idle / 4 Printing / 7 Offline
 *  - WorkOffline === true → offline
 *  - DetectedErrorState: 3..6 → warning, 7..10 → error, 9 → offline
 *
 * 注意：这里只反映**本机 spooler 视角**。`.213` 在此处是 Normal/Idle/WorkOffline=false，
 * 但网络不可达 → 必须由 printer-service 叠加 TCP 探活覆盖（brief §9.6）。
 */
export function mapPrinterState(input: {
  gpStatus?: number | null;
  cimStatus?: number | null;
  workOffline?: boolean | null;
  detectedErrorState?: number | null;
  jobCount?: number | null;
}): PrinterState {
  const gp = input.gpStatus ?? null;
  const cim = input.cimStatus ?? null;
  const offline = input.workOffline === true;
  const detected = input.detectedErrorState ?? null;

  if (offline) return 'offline';
  if (gp === 6 || cim === 7) return 'offline';
  if (detected === 9) return 'offline';
  if (gp === 2 || gp === 4 || gp === 5) return 'error';
  if (detected !== null && (detected === 7 || detected === 8 || detected === 10)) return 'error';
  if (detected !== null && (detected === 3 || detected === 4 || detected === 5 || detected === 6 || detected === 11)) {
    return 'warning';
  }
  if (gp === 1 || cim === 6) return 'warning';
  if (cim === 4 || gp === 9) return 'printing';
  if ((input.jobCount ?? 0) > 0) return 'printing';
  if (gp === 7 || gp === 8) return 'printing';
  if (gp === 0 || gp === 3 || cim === 3) return 'idle';
  return 'unknown';
}

/** 状态详情文本（给 UI 的 `stateDetail`，可为 null）。 */
export function buildStateDetail(
  gp?: number | null,
  cim?: number | null,
  detected?: number | null,
  workOffline?: boolean | null,
): string | null {
  const parts: string[] = [];
  if (gp !== null && gp !== undefined) parts.push(`spooler=${GET_PRINTER_STATUS_TEXT[gp] ?? gp}`);
  if (cim !== null && cim !== undefined) parts.push(`win32=${cim === 3 ? 'Idle' : cim === 4 ? 'Printing' : cim === 7 ? 'Offline' : cim}`);
  if (workOffline) parts.push('WorkOffline=true');
  if (detected !== null && detected !== undefined && detected > 2) {
    parts.push(`detected=${DETECTED_ERROR_TEXT[detected] ?? detected}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** PowerShell `/Date(1234567890)/` 或 ISO 字符串 → 毫秒时间戳。 */
export function parsePsDate(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const ms = /\/Date\((-?\d+)\)\//.exec(value);
  if (ms && ms[1]) return Number(ms[1]);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Get-PrintJob 行 → 契约 PrintJob[]。 */
export function toPrintJobs(rows: RawPrintJob[]): PrintJob[] {
  return rows.map((row, idx) => ({
    id: row.Id !== undefined ? String(row.Id) : `job-${idx}`,
    documentName: row.DocumentName ?? '(未命名)',
    owner: row.Owner ?? '',
    status: typeof row.JobStatus === 'number' ? `state-${row.JobStatus}` : (row.JobStatus ?? 'unknown'),
    pages: row.TotalPages ?? 0,
    pagesPrinted: row.PagesPrinted ?? 0,
    submittedAt: parsePsDate(row.SubmittedTime),
  }));
}

// —— 取数区（spawn 站点，编码固定 utf8）——

const PS_GET_PRINTER =
  'Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,Shared,JobCount,Type,Published,ShareName';

const PS_GET_CIM_PRINTER =
  'Get-CimInstance -ClassName Win32_Printer | Select-Object Name,Default,WorkOffline,PrinterStatus,DetectedErrorState,ExtendedPrinterStatus,PortName';

const PS_GET_JOBS =
  'Get-PrintJob | Select-Object Id,PrinterName,DocumentName,Owner,JobStatus,TotalPages,PagesPrinted,SubmittedTime';

const PS_FALLBACK_PRINTER =
  'Get-CimInstance -ClassName Win32_Printer | Select-Object Name,DriverName,PortName,PrinterStatus,Shared,JobCount,Default,WorkOffline,DetectedErrorState';

const PS_GET_PRINTER_PORTS =
  'Get-CimInstance -ClassName Win32_TCPIPPrinterPort | Select-Object Name,HostAddress';

interface SpoolerReadResult<T> {
  items: T[];
  error: string | null;
  fallbackUsed?: boolean;
}

function executionError(res: RunResult): string | null {
  if (res.spawnError) return res.spawnError;
  if (res.timedOut) return 'PowerShell timed out';
  if (res.code !== 0) return res.stderr.trim() || `PowerShell exited with code ${res.code ?? 'null'}`;
  // 非终止 PowerShell 错误也可能以 code=0 退出，不能当成成功的空列表。
  return res.stderr.trim() || null;
}

async function readRows<T>(command: string): Promise<SpoolerReadResult<T>> {
  const res = await runPowerShell(psJsonCommand(`$ErrorActionPreference='Stop'; ${command}`));
  const error = executionError(res);
  if (error !== null) return { items: [], error };
  return parsePsJson<T>(res.stdout);
}

export async function readPrinters(): Promise<SpoolerReadResult<RawPrinter>> {
  const primary = await readRows<RawPrinter>(PS_GET_PRINTER);
  if (primary.error === null) return primary;
  const fallback = await readRows<RawPrinter>(PS_FALLBACK_PRINTER);
  return {
    ...fallback,
    items: fallback.items.map(({ PrinterStatus, ...row }) => ({ ...row, CimStatus: PrinterStatus })),
    error: fallback.error === null ? null : `${primary.error}; fallback: ${fallback.error}`,
    fallbackUsed: true,
  };
}

export async function readCimPrinters(): Promise<SpoolerReadResult<RawCimPrinter>> {
  return readRows<RawCimPrinter>(PS_GET_CIM_PRINTER);
}

/** 只读取本机 TCP/IP 端口元数据，不解析 HostAddress 中的 hostname。 */
export async function readPrinterPorts(): Promise<SpoolerReadResult<RawPrinterPort>> {
  return readRows<RawPrinterPort>(PS_GET_PRINTER_PORTS);
}

export async function readPrintJobs(): Promise<SpoolerReadResult<RawPrintJob>> {
  const primary = await readRows<RawPrintJob>(PS_GET_JOBS);
  // 只有执行成功时，空 stdout 才代表空队列。
  if (primary.error === null) return primary;
  const fallback = await readRows<Record<string, unknown>>(
    'Get-CimInstance -ClassName Win32_PrintJob | Select-Object JobId,Name,Document,Owner,JobStatus,TotalPages,PagesPrinted,StartTime',
  );
  const items: RawPrintJob[] = fallback.items.map((row) => {
    const name = typeof row.Name === 'string' ? row.Name : '';
    // Win32_PrintJob.Name 形如 "PrinterName, 12" → 拆出打印机名
    const commaIdx = name.lastIndexOf(',');
    return {
      Id: typeof row.JobId === 'number' ? row.JobId : undefined,
      PrinterName: commaIdx > 0 ? name.slice(0, commaIdx) : name,
      DocumentName: typeof row.Document === 'string' ? row.Document : undefined,
      Owner: typeof row.Owner === 'string' ? row.Owner : undefined,
      JobStatus: typeof row.JobStatus === 'string' ? row.JobStatus : undefined,
      TotalPages: typeof row.TotalPages === 'number' ? row.TotalPages : undefined,
      PagesPrinted: typeof row.PagesPrinted === 'number' ? row.PagesPrinted : undefined,
      SubmittedTime: typeof row.StartTime === 'string' ? row.StartTime : undefined,
    };
  });
  return {
    items,
    error: fallback.error === null ? null : `${primary.error}; fallback: ${fallback.error}`,
    fallbackUsed: true,
  };
}

/**
 * 一次采集本机全部 printers + cim 补充 + 全部 jobs + TCP/IP ports。
 * 四次 PowerShell 调用串行（单飞闸门），失败时保留各来源错误。
 */
export async function readSpooler(): Promise<SpoolerSnapshot> {
  const started = Date.now();
  const printers = await readPrinters();
  const cim = await readCimPrinters();
  const jobs = await readPrintJobs();
  const ports = await readPrinterPorts();
  return {
    printers: printers.items,
    cim: cim.items,
    jobs: jobs.items,
    ports: ports.items,
    errors: { printers: printers.error, cim: cim.error, jobs: jobs.error, ports: ports.error },
    ms: Date.now() - started,
    fallbackUsed: printers.fallbackUsed === true || jobs.fallbackUsed === true,
  };
}
