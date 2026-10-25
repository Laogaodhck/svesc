/**
 * 内置终端（task-019：侧边栏「诊断」下方的受限命令终端）。
 *
 * 权限控制三层（渲染层不可绕过）：
 *  1. 命令白名单：只放行网络诊断/系统信息类命令（TERMINAL_ALLOW），
 *     白名单外一律拒绝——这是运维终端不是任意 shell；
 *  2. 参数字符白名单：整个命令行禁 shell 元字符（管道/重定向/命令连接/引号/
 *     变量展开/转义），杜绝借参数逃逸执行任意命令；
 *  3. 执行约束：cmd 与 args 分离传 spawn（绝不拼 shell 字符串）、超时硬杀、
 *     单飞闸门（上一条未结束禁止提交新命令）。
 *
 * 权限需求：白名单内全部命令普通用户权限即可运行，不要求管理员；
 * 不弹 UAC、不请求 elevation。
 */
import { runGbkNative } from './engine/exec';

/** 命令白名单（键 = 首个 token；值为展示名 + 超时预算）。
 *  task-020 扩充：tasklist / whoami / nbtstat（后者同时服务设备识别的 NetBIOS 名路径）。 */
export const TERMINAL_ALLOW: Readonly<Record<string, { label: string; timeoutMs: number }>> = {
  ping: { label: 'ping', timeoutMs: 12_000 },
  tracert: { label: 'tracert', timeoutMs: 32_000 },
  ipconfig: { label: 'ipconfig', timeoutMs: 8_000 },
  arp: { label: 'arp', timeoutMs: 5_000 },
  nslookup: { label: 'nslookup', timeoutMs: 8_000 },
  netstat: { label: 'netstat', timeoutMs: 12_000 },
  route: { label: 'route', timeoutMs: 6_000 },
  hostname: { label: 'hostname', timeoutMs: 3_000 },
  getmac: { label: 'getmac', timeoutMs: 6_000 },
  systeminfo: { label: 'systeminfo', timeoutMs: 20_000 },
  tasklist: { label: 'tasklist', timeoutMs: 10_000 },
  whoami: { label: 'whoami', timeoutMs: 3_000 },
  nbtstat: { label: 'nbtstat', timeoutMs: 6_000 },
};

/**
 * 终端命令行校验（纯函数，可单测）。
 * 返回 { ok, cmd, args, timeoutMs, label, error }：ok=false 时 error 为中文原因。
 */
export function validateTerminalCommand(input: string): {
  ok: boolean;
  cmd: string;
  args: string[];
  timeoutMs: number;
  label: string;
  error: string | null;
} {
  const fail = (error: string): ReturnType<typeof validateTerminalCommand> => ({
    ok: false,
    cmd: '',
    args: [],
    timeoutMs: 0,
    label: '',
    error,
  });
  const raw = String(input ?? '').trim();
  if (!raw) return fail('命令为空');
  if (raw.length > 300) return fail('命令过长（上限 300 字符）');

  // shell 元字符一票拒绝：管道 / 重定向 / 命令连接 / 变量与转义 / 通配展开 / 引号
  // （白名单命令的参数不需要任何一种；引号一并禁掉，免得借引号注入参数）
  if (/[&|<>^`$"();\\%!*\u007f]/.test(raw) || /['"\u0000-\u001f]/.test(raw)) {
    return fail('包含不允许的字符（终端不支持管道、重定向、通配符与引号，请直接输入单条命令）');
  }

  const tokens = raw.split(/\s+/).filter(Boolean);
  const head = (tokens[0] ?? '').toLowerCase();
  const allow = TERMINAL_ALLOW[head];
  if (!allow) {
    const keys = Object.keys(TERMINAL_ALLOW).join(' / ');
    return fail(`命令不在白名单内：${head}（可用命令：${keys}）`);
  }
  // 通配与路径符号再查一层（防止后续往表里加命令时漏配）
  if (tokens.some((t) => /^[/-]{2,}/.test(t) === false && /^[./]/.test(t) && /\.[\\/]/.test(t))) {
    return fail('参数不允许包含路径片段');
  }
  return { ok: true, cmd: head, args: tokens.slice(1), timeoutMs: allow.timeoutMs, label: allow.label, error: null };
}

export interface TerminalResult {
  command: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  /** 一行结论（人读），如 "4/4 回包" */
  summary: string;
  /** 已解码输出（逐行） */
  lines: string[];
  error: string | null;
}

/** 单飞闸门：终端一次只跑一条命令（模型同 heartbeat 的 inFlight 防重入）。 */
let running = false;

/** 执行白名单内的终端命令。校验失败/执行异常一律返回结果对象，绝不抛。 */
export async function terminalRun(input: string): Promise<TerminalResult> {
  const startedAt = Date.now();
  const check = validateTerminalCommand(input);
  if (!check.ok) {
    return { command: String(input ?? ''), startedAt, durationMs: 0, ok: false, summary: '已拒绝', lines: [check.error ?? ''], error: check.error };
  }
  if (running) {
    return {
      command: input, startedAt, durationMs: 0, ok: false,
      summary: '已拒绝', lines: ['上一条命令尚未结束，请等待完成后再执行'], error: '终端忙',
    };
  }
  running = true;
  try {
    const res = await runGbkNative(check.cmd, check.args, check.timeoutMs);
    const durationMs = Date.now() - startedAt;
    const lines = res.stdout.split(/\r?\n/).filter((l, i, arr) => !(l === '' && i === arr.length - 1));
    if (res.spawnError) {
      return { command: input, startedAt, durationMs, ok: false, summary: '执行失败', lines: [...lines, `无法执行 ${check.label}（${res.spawnError}）`], error: res.spawnError };
    }
    return {
      command: input,
      startedAt,
      durationMs,
      ok: true,
      // 诚实截断：超时不算失败，如实说明
      summary: res.timedOut ? `已执行（${(check.timeoutMs / 1000).toFixed(0)}s 超时截断）` : `已执行（${durationMs}ms）`,
      lines: res.timedOut ? [...lines, `〔输出在 ${check.timeoutMs}ms 超时处截断〕`] : lines,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { command: input, startedAt, durationMs: Date.now() - startedAt, ok: false, summary: '执行失败', lines: [msg], error: msg };
  } finally {
    running = false;
  }
}
