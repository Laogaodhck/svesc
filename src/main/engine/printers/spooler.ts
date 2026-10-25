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
import type { PrintJob, PrinterState } from '../../../shared/types';
import { parsePsJson, psJsonCommand, runPowerShell } from '../exec';

export interface RawPrinter {
  Name?: string;
  DriverName?: string;
  PortName?: string;
  PrinterStatus?: number;
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

export interface SpoolerSnapshot {
  printers: RawPrinter[];
  cim: RawCimPrinter[];
  jobs: RawPrintJob[];
  errors: { printers: string | null; cim: string | null; jobs: string | null };
  ms: number;
  /** 主源失败、改用 Win32_Printer / Win32_PrintJob 的回退标记 */
  fallbackUsed: boolean;
}

// —— 纯函数区（Tess 可直接断言）——

const RE_PORT_IS_IP = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const RE_PORT_IP_PREFIX = /^IP_(\d{1,3}(?:\.\d{1,3}){3})$/i;
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
 * 从 PortName 解析 IP 与连接类型。
 *  - `192.168.2.170` → 直取
 *  - `IP_192.168.2.213` → 去前缀
 *  - `WSD-<uuid>` → 无 IP（由名称里的 MAC 反查 ARP）
 *  - `PORTPROMPT:` / `SHRFAX:` / `Documents\...pdf` → virtual
 */
export function parsePortName(portName: string | undefined | null, printerName?: string | null): PortInfo {
  const raw = (portName ?? '').trim();
  if (RE_PORT_IS_IP.test(raw)) return { ip: raw, macInName: null, connection: 'network', raw };
  const ipPrefixed = RE_PORT_IP_PREFIX.exec(raw);
  if (ipPrefixed && ipPrefixed[1]) {
    return { ip: ipPrefixed[1], macInName: null, connection: 'network', raw };
  }
  const macMatch = RE_MAC_IN_NAME.exec(printerName ?? '') ?? RE_MAC_IN_NAME.exec(raw);
  const macInName = macMatch?.[1] ?? null;
  if (/^wsd-/i.test(raw) || /^\\\\/i.test(raw)) {
    return { ip: null, macInName, connection: 'network', raw };
  }
  if (/^(usb|dot4|lpt|com)/i.test(raw)) return { ip: null, macInName, connection: 'usb', raw };
  if (/^(portprompt|shrfa|xps|file|nul)/i.test(raw) || /\.(pdf|oxps|xps)$/i.test(raw)) {
    return { ip: null, macInName, connection: 'virtual', raw };
  }
  return { ip: null, macInName, connection: 'unknown', raw };
}

/** 驱动名 → 型号。`Microsoft` 通用驱动不是真实型号 → null。 */
export function modelFromDriver(driverName: string | undefined | null): string | null {
  const d = (driverName ?? '').trim();
  if (!d) return null;
  if (/microsoft/i.test(d)) return null;
  return d;
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

export async function readPrinters(): Promise<{ items: RawPrinter[]; error: string | null }> {
  const res = await runPowerShell(psJsonCommand(PS_GET_PRINTER));
  if (!res.spawnError && res.stdout.trim()) {
    const parsed = parsePsJson<RawPrinter>(res.stdout);
    if (parsed.error === null && parsed.items.length > 0) return { items: parsed.items, error: null };
    if (parsed.error) {
      // 主源 JSON 损坏 → 回退
      const fb = await readPrintersViaCim();
      return { items: fb.items, error: fb.error };
    }
    if (parsed.items.length === 0) return { items: [], error: null };
  }
  return readPrintersViaCim();
}

async function readPrintersViaCim(): Promise<{ items: RawPrinter[]; error: string | null }> {
  const res = await runPowerShell(psJsonCommand(PS_FALLBACK_PRINTER));
  const parsed = parsePsJson<RawPrinter>(res.stdout);
  return { items: parsed.items, error: parsed.error ?? res.spawnError };
}

export async function readCimPrinters(): Promise<{ items: RawCimPrinter[]; error: string | null }> {
  const res = await runPowerShell(psJsonCommand(PS_GET_CIM_PRINTER));
  const parsed = parsePsJson<RawCimPrinter>(res.stdout);
  return { items: parsed.items, error: parsed.error ?? res.spawnError };
}

export async function readPrintJobs(): Promise<{ items: RawPrintJob[]; error: string | null }> {
  let res = await runPowerShell(psJsonCommand(PS_GET_JOBS));
  // 空队列：PowerShell 输出空字符串 → parsePsJson 返回 []（绝不 JSON.parse('')）
  if (!res.spawnError) {
    const parsed = parsePsJson<RawPrintJob>(res.stdout);
    if (parsed.error === null) return { items: parsed.items, error: null };
  }
  // 回退：Win32_PrintJob
  res = await runPowerShell(
    psJsonCommand(
      'Get-CimInstance -ClassName Win32_PrintJob | Select-Object JobId,Name,Document,Owner,JobStatus,TotalPages,PagesPrinted,StartTime',
    ),
  );
  const parsed = parsePsJson<Record<string, unknown>>(res.stdout);
  const items: RawPrintJob[] = parsed.items.map((row) => {
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
  return { items, error: parsed.error ?? res.spawnError };
}

/**
 * 一次采集本机全部 printers + cim 补充 + 全部 jobs。
 * 三次 PowerShell 调用串行（单飞闸门），冷启动主导，实测总计 ≈2.3s。
 */
export async function readSpooler(): Promise<SpoolerSnapshot> {
  const started = Date.now();
  const printers = await readPrinters();
  const cim = await readCimPrinters();
  const jobs = await readPrintJobs();
  const fallbackUsed = cim.error !== null;
  return {
    printers: printers.items,
    cim: cim.items,
    jobs: jobs.items,
    errors: { printers: printers.error, cim: cim.error, jobs: jobs.error },
    ms: Date.now() - started,
    fallbackUsed,
  };
}
