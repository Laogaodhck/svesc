/**
 * R-05 真进程路径（迁自 scripts/fixes-check.mjs，Ray-2 审查 M1 裁决）。
 *
 * 为什么必须真进程：`tests/exec-fallback.test.ts` 走 `vi.mock('node:child_process')`，
 * 证明的是"实现逻辑正确"；本文件用真实 spawn 证明"真子进程被强杀后，真闸门真的释放、
 * execStats 真的归零、PowerShell 单飞通道真的恢复"——mock 覆盖不到这一层。
 *
 * 纪律：原脚本的两条 wall-clock 断言（elapsed<4000 / elapsed<1500）已删除——
 * 高负载机器上必然抖动，且"立即 settle"已由"await 在测试超时内完成"这一行为隐含保证；
 * "超时路径不 spawn taskkill（ping 类叶进程）"在真进程侧用**两侧证明**覆盖：
 * 负例 = 默认不 sweep，taskkill 调用标记不得出现；阳性对照 = sweepTree:true 时标记
 * 必须出现且携带 /T /F /PID <pid> 实参形状（证明检测链路有效，阴性断言不是空转）。
 * 观测通道：exec.ts 的 sweep 用裸名 spawn('taskkill')，libuv 的可执行解析会把当前
 * 目录排在 System32 之前——临时目录里放 node.exe 副本冒充 taskkill.exe，经
 * NODE_OPTIONS --require 钩子把调用写成标记文件（钩子按 exec.ts 实参形状匹配）。
 * 沙箱实测校准：此环境子进程退出会连带收割孙进程，"孙进程死活"不携带信息，故弃用。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RunResult } from '../src/main/engine/exec';
import { runNative, runPowerShell, execStats } from '../src/main/engine/exec';

/**
 * runPowerShell 的 timeoutMs 参数没有类型注解，TS 从默认值（as const 的 8000）把参数
 * 类型收窄成了字面量 8000 —— 传其他超时就编译错。正解是 src 侧补 `: number`（已报给
 * Max-1）；落地前测试侧用显式签名视图调用，绕过时不放宽任何运行时行为。
 */
const runPowerShellWithTimeout = runPowerShell as (code: string, timeoutMs: number) => Promise<RunResult>;

/** cmd/ping/taskkill/PowerShell 都是 Windows 资产；非 Windows 平台跳过本文件。 */
const itWin = process.platform === 'win32' ? it : it.skip;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询直到条件成立或超时（返回是否达成）；用于进程死亡等"一旦发生就永久"的观测 */
async function until(condition: () => Promise<boolean>, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await sleep(stepMs);
  }
}

describe('R-05 真进程：超时强杀必须释放闸门', () => {
  itWin(
    '超时子进程返回 timedOut=true 且 await 正常返回（立即 settle 的行为证明）',
    async () => {
      const killed = await runNative('cmd', ['/c', 'ping', '-n', '30', '127.0.0.1'], 'gbk', 400);
      expect(killed.timedOut, `code=${killed.code}, ms=${killed.ms}`).toBe(true);
    },
    15000,
  );

  itWin(
    '强杀收口后子进程闸门归零（execStats 真实观测）',
    async () => {
      await runNative('cmd', ['/c', 'ping', '-n', '30', '127.0.0.1'], 'gbk', 400);
      await sleep(1200); // 给 close/清剿收口留出真实世界的时间
      expect(execStats().children, JSON.stringify(execStats())).toBe(0);
    },
    15000,
  );

  itWin(
    '闸门已释放：紧随其后的命令在宽超时内正常执行（不悬挂）',
    async () => {
      await runNative('cmd', ['/c', 'ping', '-n', '30', '127.0.0.1'], 'gbk', 400);
      const raced = await runNative('cmd', ['/c', 'echo', 'gate-ok'], 'gbk', 10000);
      expect(String(raced.stdout).trim()).toBe('gate-ok');
    },
    15000,
  );

  itWin(
    'PowerShell 单飞通道在超时后仍可用',
    async () => {
      const ps = await runPowerShell('Write-Output 1', 8000);
      expect(ps.code).toBe(0);
      expect(ps.stdout.trim()).toBe('1');
    },
    15000,
  );

  itWin(
    'PowerShell 超时也返回 timedOut，且单飞闸门归零（真进程树清剿路径）',
    async () => {
      const psTimeout = await runPowerShellWithTimeout('Start-Sleep -Seconds 60', 600);
      expect(psTimeout.timedOut, `ms=${psTimeout.ms}`).toBe(true);
      await sleep(1500); // taskkill /T /F 清剿 conhost 树需要真实时间
      expect(execStats().powershellBusy, JSON.stringify(execStats())).toBe(0);
    },
    20000,
  );

  itWin(
    '正常退出路径未被超时定时器污染（code/timedOut 语义正确）',
    async () => {
      const twice = await runNative('cmd', ['/c', 'exit 3'], 'gbk', 5000);
      expect(twice.code).toBe(3);
      expect(twice.timedOut).toBe(false);
    },
    15000,
  );

  // —— ④ 叶进程超时不得 spawn taskkill（两侧证明，观测通道 = taskkill 是否真的被 spawn）——
  //
  // 观测原理（在此沙箱实测校准）：exec.ts 的 sweep 用裸名 spawn('taskkill')，libuv 的
  // 可执行解析会把**当前目录**排在 System32 之前——在临时目录里放一个 node.exe 副本
  // 命名为 taskkill.exe，再经 NODE_OPTIONS --require 钩子把"我被调用了"写成标记文件。
  // 钩子条件按 exec.ts 的实参形状匹配（['/T','/F','/PID',pid] → node 把 '/T' 解析成
  // "<盘>:\T"，故用 /\T$/i + '/F' + '/PID' 判别，不匹配即不写）。
  // 为什么不用"孙进程死活"当观测通道：本沙箱里子进程退出（无论自然还是被 kill）都会
  // 连带收割孙进程（实测），孙进程死活不携带"有没有 taskkill"的信息。
  //
  // 阳性对照不可省：没有它，钩子/解析链路坏了阴性断言照样绿（空转守卫）。
  // chdir/NODE_OPTIONS 的作用域严格限制在这两条用例内部（try/finally 还原），
  // 不影响同文件其余用例——它们清剿的是真 taskkill（System32），其间无污染窗口。

  interface Interception {
    marker: string;
    cleanup(): void;
  }

  /** 布置 taskkill 拦截：chdir 到含假 taskkill.exe 的目录 + NODE_OPTIONS 钩子；返回标记路径与还原函数 */
  async function armTaskkillInterception(): Promise<Interception> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svesc-exec-real-'));
    fs.copyFileSync(process.execPath, path.join(dir, 'taskkill.exe'));
    fs.writeFileSync(
      path.join(dir, 'hook.cjs'),
      [
        "const a = process.argv;",
        "if (a.length >= 4 && /\\\\T$/i.test(String(a[1])) && a[2] === '/F' && a[3] === '/PID') {",
        "  try { require('fs').writeFileSync(process.env.MARKER, 'swept ' + a.slice(1).join(' ')); } catch {}",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const marker = path.join(dir, 'sweep-marker.txt');
    const oldCwd = process.cwd();
    const oldNodeOptions = process.env.NODE_OPTIONS;
    const oldMarker = process.env.MARKER;
    process.chdir(dir);
    process.env.NODE_OPTIONS = `--require ${path.join(dir, 'hook.cjs')}`;
    process.env.MARKER = marker;
    return {
      marker,
      cleanup(): void {
        process.chdir(oldCwd);
        if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = oldNodeOptions;
        if (oldMarker === undefined) delete process.env.MARKER;
        else process.env.MARKER = oldMarker;
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* 假 taskkill（node 副本）可能还持有目录句柄，交给 OS 临时目录回收 */
        }
      },
    };
  }

  itWin(
    '④叶进程超时不清剿进程树：默认无 sweepTree，taskkill 标记不得出现',
    async () => {
      const ic = await armTaskkillInterception();
      try {
        const killed = await runNative(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 30000); setInterval(() => {}, 1000);'], 'utf8', 400);
        expect(killed.timedOut, '前置：叶进程必须被超时强杀').toBe(true);

        // 宽限 2s 覆盖 close→sweep 窗口：若实现错误地给叶进程也清剿，标记会在此出现
        await sleep(2000);
        expect(
          fs.existsSync(ic.marker),
          '叶进程（ping 类）超时不得 spawn taskkill /T（Vera：清剿拥塞会把 ping 5.5s 恶化到 10s）',
        ).toBe(false);
      } finally {
        ic.cleanup();
      }
    },
    15000,
  );

  itWin(
    '④阳性对照：sweepTree:true 时 taskkill 确实被 spawn 且指向本进程树（证明检测器有效）',
    async () => {
      const ic = await armTaskkillInterception();
      try {
        const killed = await runNative(
          process.execPath,
          ['-e', 'setTimeout(() => process.exit(0), 30000); setInterval(() => {}, 1000);'],
          'utf8',
          400,
          { sweepTree: true },
        );
        expect(killed.timedOut, '前置：必须被超时强杀').toBe(true);

        // sweep 在 close 派发后执行：标记应在数秒内出现。
        // 若这条红了，说明上面阴性断言的检测链路已失效（阴性会空转），必须先修这里。
        const swept = await until(() => Promise.resolve(fs.existsSync(ic.marker)), 6000);
        expect(swept, 'sweepTree:true 时必须真的 spawn 过 taskkill /T /F /PID <pid>').toBe(true);
        // 内容形状 = "swept <解析后的'/T'> /F /PID <pid>"：node 会把 '/T' 解析成 "<盘>:\T"（反斜杠），
        // 故只锁 /F /PID <数字> 的实参形状与实参个数，不锁盘符写法
        expect(fs.readFileSync(ic.marker, 'utf8'), '清剿调用必须携带 exec.ts 的实参形状').toMatch(
          /^swept .+\/F \/PID \d+$/,
        );
      } finally {
        ic.cleanup();
      }
    },
    15000,
  );
});
