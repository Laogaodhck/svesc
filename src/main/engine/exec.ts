/**
 * 唯一的子进程出口。编码双通道在此集中绑定（plan.md §5.2 / brief §9.2）。
 *
 * 铁律：
 *  - 抓中文文本（arp / ping / netstat / route）→ 原生 exe + TextDecoder('gb18030')
 *  - 抓结构化数据（Get-Printer 等）→ powershell + [Console]::OutputEncoding=UTF8 + ConvertTo-Json → utf8
 *  - 禁止 chcp 65001；禁止用 PowerShell 调 arp/ping（代码页 65001 会让 MUI 程序回退英文资源）
 *  - 调用点不得自行 .toString()，解码方式由本文件按声明执行
 *
 * 本文件不 import electron，可被 vitest 在纯 Node 下直接导入。
 */
import { spawn } from 'node:child_process';
import { TIMEOUTS, CONCURRENCY } from '../../shared/constants';

export type Encoding = 'gbk' | 'utf8';

const gbkDecoder = new TextDecoder('gb18030', { fatal: false });

/** 路径 1 解码器：中文 GBK/GB18030 输出。 */
export function decodeGbk(buf: Buffer): string {
  return gbkDecoder.decode(buf);
}

/** 路径 2 解码器：PowerShell UTF-8 输出。 */
export function decodeUtf8(buf: Buffer): string {
  return buf.toString('utf8');
}

export function decodeAs(buf: Buffer, enc: Encoding): string {
  return enc === 'gbk' ? decodeGbk(buf) : decodeUtf8(buf);
}

/** 令牌式并发闸门：release 直接唤醒下一个等待者，active 计数不漂移。 */
class Gate {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }

  get current(): number {
    return this.active;
  }
}

const childGate = new Gate(CONCURRENCY.childGlobal);
const powershellGate = new Gate(CONCURRENCY.powershell);

export interface RunResult {
  cmd: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  /** 是否被硬超时强杀 */
  timedOut: boolean;
  /** spawn 失败（如命令不存在）时的错误码，如 'ENOENT' */
  spawnError: string | null;
  ms: number;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  /** 追加环境变量（不要用于改代码页，禁止 chcp） */
  env?: Record<string, string>;
  /**
   * 强杀后是否清剿整个进程树（`taskkill /T /F`）。
   * 只有 `runPowerShell` 需要：PowerShell 会派生 conhost 等孙进程，
   * 孙进程仍持有 stdout 管道时 close 不派发（R-05 根因）。
   * ping/arp/netstat 是无子进程的叶进程——Vera 受控实验证明给它们也清剿
   * 会把一次扫描从 5.5s 恶化到 10s（进程创建拥塞正反馈），故默认关闭。
   * 前瞻：未来新增会派生孙进程的命令（cmd /c、wmic 类）必须显式传 sweepTree: true。
   */
  sweepTree?: boolean;
}

/**
 * 统一子进程封装。cmd 与 args 永远分离传入，绝不拼 shell 字符串（plan.md §5.3）。
 */
export async function runNative(
  cmd: string,
  args: string[],
  enc: Encoding,
  timeoutMs: number,
  opts: RunOptions = {},
): Promise<RunResult> {
  await childGate.acquire();
  const started = Date.now();
  try {
    return await new Promise<RunResult>((resolve) => {
      let settled = false;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let spawnError: string | null = null;
      let timer: NodeJS.Timeout | null = null;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, {
          windowsHide: true,
          cwd: opts.cwd,
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({
          cmd,
          args,
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: err instanceof Error ? err.message : String(err),
          ms: Date.now() - started,
        });
        return;
      }

      /**
       * 进程树清剿（尽力而为）：父进程退出后，PowerShell 派生的 conhost/
       * 孙进程可能仍存活。放在 close 收尾而非超时路径——超时路径必须
       * 立即 settle 释放闸门，不得被额外的子进程创建阻塞。
       */
      const sweepTreeByPid = (pid: number | undefined): void => {
        if (process.platform !== 'win32' || pid === undefined) return;
        try {
          spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
            windowsHide: true,
            stdio: 'ignore',
          }).on('error', () => {
            /* taskkill 不存在或进程已消失：尽力而为，不影响主流程 */
          });
        } catch {
          /* 同上 */
        }
      };

      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const out = Buffer.concat(stdoutChunks);
        const errBuf = Buffer.concat(stderrChunks);
        resolve({
          cmd,
          args,
          code,
          // 双通道解码在此收口：调用点拿到的永远是已解码字符串
          stdout: decodeAs(out, enc),
          stderr: decodeAs(errBuf, enc),
          timedOut,
          spawnError,
          ms: Date.now() - started,
        });
      };

      /**
       * 超时路径：先杀直接子进程，**立即 settle**。
       * kill 之后 close 何时（甚至是否）派发不受我们控制——被强杀的子进程、
       * 句柄卡住的 powershell 都可能永不派发 close。闸门释放绝不能押注在
       * close 上（R-05 根因正是这条链路断裂导致闸门永久占用）。
       */
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* 进程可能已退出 */
        }
        finish(null);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('error', (err: NodeJS.ErrnoException) => {
        spawnError = err.code ?? err.message;
        finish(null);
      });
      child.on('close', (code: number | null) => {
        finish(code);
        // 超时被杀的进程退出后清剿残留进程树；正常退出的进程树是干净的，无需多此一举
        if (timedOut && opts.sweepTree) sweepTreeByPid(child.pid);
      });
    });
  } finally {
    childGate.release();
  }
}

/** 路径 1 的快捷入口：原生 exe + GBK。 */
export function runGbkNative(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return runNative(cmd, args, 'gbk', timeoutMs);
}

/**
 * PowerShell 单飞执行器（全局同一时刻只跑 1 个：冷启动 700-900ms，并发无收益）。
 * 自动加 UTF-8 输出编码前缀，并把 stdout 按 UTF-8 解码。
 */
export async function runPowerShell(code: string, timeoutMs: number = TIMEOUTS.powershell): Promise<RunResult> {
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${code}`;
  await powershellGate.acquire();
  try {
    return await runNative(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      'utf8',
      timeoutMs,
      // PowerShell 可能派生孙进程：强杀后必须清剿进程树，否则管道句柄不释放
      { sweepTree: true },
    );
  } finally {
    powershellGate.release();
  }
}

/** 结构化 JSON 取数：`<code> | ConvertTo-Json -Depth 4 -Compress`。 */
export function psJsonCommand(code: string): string {
  return `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${code} | ConvertTo-Json -Depth 4 -Compress`;
}

/**
 * PowerShell JSON 解析容错（investigation-report.md §3.5）：
 *  - 0 条结果 → PowerShell 输出空字符串 → 返回 []
 *  - 单条结果 → JSON 是对象不是数组 → 包成数组
 * 解析失败也返回 []，绝不抛异常拖垮探测主流程。
 */
export function parsePsJson<T = unknown>(raw: string): { items: T[]; error: string | null } {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return { items: [], error: null };
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return { items: parsed as T[], error: null };
    return { items: [parsed as T], error: null };
  } catch (err) {
    return { items: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 供测试观察：当前在跑的子进程数与 PowerShell 是否占用中。 */
export function execStats(): { children: number; powershellBusy: number } {
  return { children: childGate.current, powershellBusy: powershellGate.current };
}
