/**
 * 打印操作（task-024）：任务取消/暂停/恢复、打印测试页、设默认打印机。
 *
 * 全部走 Windows 原生通道，无第三方依赖：
 *  - 任务操作：PowerShell PrintJob cmdlet（Remove/Suspend/Resume-PrintJob）
 *  - 测试页：rundll32 printui.dll,PrintUIEntry /k（MUI 程序铁律：不经 PowerShell，走 GBK）
 *  - 设默认：CIM Win32_Printer.SetDefaultPrinter（结构化 JSON 回包，校验 ReturnValue）
 *
 * 安全边界（打印机名来自 spooler/用户输入，必须当不可信字符串处理）：
 *  - PowerShell 单引号参数：`'` → `''`，并拒绝换行/反引号/双引号
 *  - jobId 强制正整数；printui 的 /n 参数用 args 数组分离，绝不拼 shell 字符串
 *  - 一切失败如实返回 { ok:false, error }，绝不吞错
 */
import type { PrintJobAction } from '../../../shared/types';
import { runNative, runPowerShell, psJsonCommand, parsePsJson, type RunResult } from '../exec';

/** 打印操作超时（cmdlet 与 printui 都是秒级操作，5s 足够宽裕） */
export const PRINT_OPS_TIMEOUT_MS = 5000;

export interface PrintOpResult {
  ok: boolean;
  error: string | null;
}

/**
 * PowerShell 单引号字符串转义（纯函数，可单测）。
 * 只处理单引号翻倍；换行/反引号/双引号由 isSafePrinterName 直接拒绝。
 */
export function escapePsSingleQuoted(name: string): string {
  return name.replace(/'/g, "''");
}

/**
 * 打印机名安全校验（纯函数，可单测）：
 * 非空、长度 ≤ 220、无换行/反引号/双引号（这三类字符会破坏各执行路径的引用规则）。
 */
export function isSafePrinterName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 220 &&
    !/[\r\n`"]/.test(name)
  );
}

/** 把 RunResult 转成操作结果：非零退出/超时/启动失败如实带出。 */
function toOpResult(r: RunResult, what: string): PrintOpResult {
  if (r.spawnError) return { ok: false, error: `${what}无法启动：${r.spawnError}` };
  if (r.timedOut) return { ok: false, error: `${what}超时（${PRINT_OPS_TIMEOUT_MS}ms）` };
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(0, 300);
    return {
      ok: false,
      error: detail ? `${what}失败（exit ${r.code}）：${detail}` : `${what}失败（exit ${r.code}）`,
    };
  }
  return { ok: true, error: null };
}

/** 任务操作对应的 cmdlet。 */
const JOB_CMDLET: Record<PrintJobAction, string> = {
  cancel: 'Remove-PrintJob',
  pause: 'Suspend-PrintJob',
  resume: 'Resume-PrintJob',
};

/**
 * 打印任务操作：对指定打印机的指定任务执行取消/暂停/恢复。
 * jobId 强制正整数（spooler 的 Id 就是数字；传非数字直接拒绝，不进命令）。
 */
export async function printJobAction(
  action: PrintJobAction,
  printerName: string,
  jobId: string,
): Promise<PrintOpResult> {
  const what = action === 'cancel' ? '取消任务' : action === 'pause' ? '暂停任务' : '恢复任务';
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: '非法任务 ID' };
  if (!isSafePrinterName(printerName)) return { ok: false, error: '非法打印机名' };
  const esc = escapePsSingleQuoted(printerName);
  const r = await runPowerShell(`${JOB_CMDLET[action]} -PrinterName '${esc}' -Id ${id}`, PRINT_OPS_TIMEOUT_MS);
  return toOpResult(r, what);
}

/**
 * 打印测试页：rundll32 printui.dll,PrintUIEntry /k /n <name>。
 * 名称含双引号直接拒绝（/n 参数无引号保护，args 数组分离下双引号会被 cmd 解析）。
 */
export async function printTestPage(printerName: string): Promise<PrintOpResult> {
  if (!isSafePrinterName(printerName)) return { ok: false, error: '非法打印机名' };
  const r = await runNative(
    'rundll32',
    ['printui.dll,PrintUIEntry', '/k', '/n', printerName],
    'gbk',
    PRINT_OPS_TIMEOUT_MS,
  );
  return toOpResult(r, '打印测试页');
}

/**
 * 设为系统默认打印机：CIM Win32_Printer.SetDefaultPrinter。
 * 回包 JSON 的 ReturnValue 非 0 视为失败（CIM 错误码如实透出）。
 */
export async function setDefaultPrinter(printerName: string): Promise<PrintOpResult> {
  if (!isSafePrinterName(printerName)) return { ok: false, error: '非法打印机名' };
  const esc = escapePsSingleQuoted(printerName);
  const r = await runPowerShell(
    psJsonCommand(
      `Invoke-CimMethod -Query "SELECT * FROM Win32_Printer WHERE Name='${esc}'" -MethodName SetDefaultPrinter`,
    ),
    PRINT_OPS_TIMEOUT_MS,
  );
  const base = toOpResult(r, '设默认打印机');
  if (!base.ok) return base;
  const parsed = parsePsJson<{ ReturnValue?: number }>(r.stdout);
  const rv = parsed.items[0]?.ReturnValue;
  if (typeof rv === 'number' && rv !== 0) {
    return { ok: false, error: `设默认打印机失败（CIM ReturnValue=${rv}）` };
  }
  return { ok: true, error: null };
}
