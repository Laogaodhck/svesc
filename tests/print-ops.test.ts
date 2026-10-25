/**
 * 打印操作测试（task-024，src/main/engine/printers/print-ops.ts）。
 *
 * mock 策略：只替换 IO 出口 runPowerShell / runNative（exec 其余纯函数用真实实现），
 * 校验命令拼装、参数安全（转义/拒绝注入字符）与失败如实透出。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../src/main/engine/exec';
import { runNative, runPowerShell } from '../src/main/engine/exec';
import {
  escapePsSingleQuoted,
  isSafePrinterName,
  PRINT_OPS_TIMEOUT_MS,
  printJobAction,
  printTestPage,
  setDefaultPrinter,
} from '../src/main/engine/printers/print-ops';

vi.mock('../src/main/engine/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/exec')>();
  return { ...actual, runPowerShell: vi.fn(), runNative: vi.fn() };
});

const psMock = vi.mocked(runPowerShell);
const nativeMock = vi.mocked(runNative);

function okRun(partial: Partial<RunResult> = {}): RunResult {
  return {
    cmd: 'mock',
    args: [],
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    spawnError: null,
    ms: 12,
    ...partial,
  };
}

beforeEach(() => {
  psMock.mockReset();
  nativeMock.mockReset();
});

describe('引用规则纯函数', () => {
  it('escapePsSingleQuoted 单引号翻倍，其余不动', () => {
    expect(escapePsSingleQuoted('HP LaserJet')).toBe('HP LaserJet');
    expect(escapePsSingleQuoted("Bob's Printer")).toBe("Bob''s Printer");
  });

  it('isSafePrinterName 拒绝空串/超长/换行/反引号/双引号', () => {
    expect(isSafePrinterName('HP LaserJet')).toBe(true);
    expect(isSafePrinterName('')).toBe(false);
    expect(isSafePrinterName('x'.repeat(221))).toBe(false);
    expect(isSafePrinterName('a\nb')).toBe(false);
    expect(isSafePrinterName('a\rb')).toBe(false);
    expect(isSafePrinterName('a`b')).toBe(false);
    expect(isSafePrinterName('a"b')).toBe(false);
  });
});

describe('printJobAction（任务取消/暂停/恢复）', () => {
  it('cancel → Remove-PrintJob，打印机名单引号转义', async () => {
    psMock.mockResolvedValueOnce(okRun());
    const res = await printJobAction('cancel', "Bob's Printer", '42');
    expect(res).toEqual({ ok: true, error: null });
    expect(psMock).toHaveBeenCalledTimes(1);
    const [code, timeout] = psMock.mock.calls[0];
    expect(code).toBe("Remove-PrintJob -PrinterName 'Bob''s Printer' -Id 42");
    expect(timeout).toBe(PRINT_OPS_TIMEOUT_MS);
  });

  it('pause/resume 映射 Suspend/Resume-PrintJob', async () => {
    psMock.mockResolvedValue(okRun());
    await printJobAction('pause', 'HP', '1');
    await printJobAction('resume', 'HP', '2');
    expect(psMock.mock.calls[0][0]).toContain('Suspend-PrintJob -PrinterName');
    expect(psMock.mock.calls[1][0]).toContain('Resume-PrintJob -PrinterName');
  });

  it('非法 jobId（非数字/0/负数/小数/空）→ 不进命令', async () => {
    for (const bad of ['abc', '0', '-3', '2.5', '']) {
      const res = await printJobAction('cancel', 'HP', bad);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('非法任务 ID');
    }
    expect(psMock).not.toHaveBeenCalled();
  });

  it('非法打印机名 → 不进命令', async () => {
    const res = await printJobAction('cancel', 'a"b', '1');
    expect(res).toEqual({ ok: false, error: '非法打印机名' });
    expect(psMock).not.toHaveBeenCalled();
  });

  it('非零退出 → stderr 摘要如实透出', async () => {
    psMock.mockResolvedValueOnce(okRun({ code: 1, stderr: 'No such job on printer' }));
    const res = await printJobAction('cancel', 'HP', '7');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('exit 1');
    expect(res.error).toContain('No such job');
  });

  it('超时与启动失败分别透出', async () => {
    psMock.mockResolvedValueOnce(okRun({ timedOut: true }));
    expect((await printJobAction('cancel', 'HP', '7')).error).toContain('超时');
    psMock.mockResolvedValueOnce(okRun({ spawnError: 'ENOENT' }));
    expect((await printJobAction('cancel', 'HP', '7')).error).toContain('ENOENT');
  });
});

describe('printTestPage（rundll32 printui）', () => {
  it('走 rundll32 /k /n，GBK 编码，args 数组分离不拼 shell', async () => {
    nativeMock.mockResolvedValueOnce(okRun());
    const res = await printTestPage('HP LaserJet');
    expect(res).toEqual({ ok: true, error: null });
    expect(nativeMock).toHaveBeenCalledTimes(1);
    const [cmd, args, enc, timeout] = nativeMock.mock.calls[0];
    expect(cmd).toBe('rundll32');
    expect(args).toEqual(['printui.dll,PrintUIEntry', '/k', '/n', 'HP LaserJet']);
    expect(enc).toBe('gbk');
    expect(timeout).toBe(PRINT_OPS_TIMEOUT_MS);
  });

  it('非法打印机名 → 不启动进程', async () => {
    const res = await printTestPage('a`b');
    expect(res).toEqual({ ok: false, error: '非法打印机名' });
    expect(nativeMock).not.toHaveBeenCalled();
  });

  it('printui 非零退出 → 失败透出', async () => {
    nativeMock.mockResolvedValueOnce(okRun({ code: 2, stderr: 'Operation failed' }));
    const res = await printTestPage('HP');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('exit 2');
  });
});

describe('setDefaultPrinter（CIM）', () => {
  it('ReturnValue=0 → ok；命令带 CIM 查询与单引号转义', async () => {
    psMock.mockResolvedValueOnce(okRun({ stdout: '{"ReturnValue":0}' }));
    const res = await setDefaultPrinter("Bob's Printer");
    expect(res).toEqual({ ok: true, error: null });
    const [code] = psMock.mock.calls[0];
    expect(code).toContain('Invoke-CimMethod');
    expect(code).toContain("Name='Bob''s Printer'");
    expect(code).toContain('ConvertTo-Json');
  });

  it('ReturnValue 非 0 → CIM 错误码如实透出', async () => {
    psMock.mockResolvedValueOnce(okRun({ stdout: '{"ReturnValue":1801}' }));
    const res = await setDefaultPrinter('HP');
    expect(res).toEqual({ ok: false, error: '设默认打印机失败（CIM ReturnValue=1801）' });
  });

  it('回包缺 ReturnValue 字段 → 按成功处理（不编造失败原因）', async () => {
    psMock.mockResolvedValueOnce(okRun({ stdout: '' }));
    expect(await setDefaultPrinter('HP')).toEqual({ ok: true, error: null });
  });

  it('进程层失败（非零退出/超时）→ 不再解析 JSON', async () => {
    psMock.mockResolvedValueOnce(okRun({ code: 1, stderr: 'bad' }));
    expect((await setDefaultPrinter('HP')).ok).toBe(false);
    psMock.mockResolvedValueOnce(okRun({ timedOut: true }));
    expect((await setDefaultPrinter('HP')).error).toContain('超时');
  });

  it('非法打印机名 → 不进命令', async () => {
    const res = await setDefaultPrinter('a\nb');
    expect(res).toEqual({ ok: false, error: '非法打印机名' });
    expect(psMock).not.toHaveBeenCalled();
  });
});
