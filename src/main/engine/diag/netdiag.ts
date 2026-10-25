/**
 * 网络诊断中心引擎（诊断页的 ping / tracert / 端口 / DNS 四类一键诊断 + 本机网卡读取）。
 *
 * 设计要点（数据诚实铁律）：
 *  - 所有目标先过 validateDiagTarget（字符白名单 + 长度），失败直接返回
 *    ok:false + 中文 error，绝不把可疑字符串交给子进程；
 *  - cmd 与 args 永远分离传入 runGbkNative，绝不拼 shell 字符串；
 *  - tracert 超时被硬杀**不是失败**：统计已到达的跳数并如实注明"超时截断"，
 *    比"30 秒后报错"对运维更有用；
 *  - 解析函数全部导出为纯函数（parseTracertHops / parseIpconfigOutput），
 *    vitest 直接覆盖，不跑真实网络命令。
 *
 * 本文件不 import electron，可被 vitest 在纯 Node 下直接导入。
 */
import dnsPromises from 'node:dns/promises';
import { DIAG } from '../../../shared/constants';
import type { DiagKind, DiagResult, NetAdapter, TracertHop } from '../../../shared/types';
import { runGbkNative } from '../exec';
import { parsePingStats } from '../discovery/ping';
import { probeHosts } from '../discovery/ports';
import { isValidIpv4 } from '../store';

// —— 目标校验 ——

/** 白名单字符集：字母数字与 . _ -（IPv4 与主机名的公共子集），空白与注入字符天然被拒。 */
const RE_TARGET_CHARS = /^[A-Za-z0-9._-]+$/;

/**
 * 诊断目标校验。返回 { ok, error }，ok:false 时 error 是中文文案。
 * 规则：非空、≤253 字符（DNS 单标签上限）、字符白名单；
 * ping/ports/tracert 要求合法 IPv4 或主机名，dns 同样接受主机名或 IP。
 */
export function validateDiagTarget(kind: DiagKind, target: string): { ok: boolean; error: string | null } {
  void kind; // 四类目标当前共用同一字符白名单；kind 保留在签名上供未来按类收紧
  const t = target.trim();
  if (!t) return { ok: false, error: '目标不能为空' };
  if (t.length > 253) return { ok: false, error: '目标过长（≤253 字符）' };
  if (!RE_TARGET_CHARS.test(t)) return { ok: false, error: '目标包含非法字符（只允许字母、数字与 . _ -）' };
  if (t.startsWith('.') || t.startsWith('-') || t.endsWith('.') || t.endsWith('-')) {
    return { ok: false, error: '目标不能以 . 或 - 开头或结尾' };
  }
  return { ok: true, error: null };
}

// —— 结果骨架 ——

function emptyResult(kind: DiagKind, target: string, startedAt: number): DiagResult {
  return {
    kind,
    target,
    startedAt,
    durationMs: 0,
    ok: false,
    summary: '',
    lines: [],
    error: null,
  };
}

/** stdout 按行拆分：过滤空行、去首尾空白、截断到 maxLines。 */
function splitLines(text: string, maxLines: number): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, maxLines);
}

// —— ping ——

async function diagPing(target: string, startedAt: number): Promise<DiagResult> {
  const res = await runGbkNative('ping', ['-n', '4', '-w', '1000', target], DIAG.pingTimeoutMs);
  const result = emptyResult('ping', target, startedAt);
  result.durationMs = Date.now() - startedAt;
  result.lines = splitLines(res.stdout, 30);

  if (res.spawnError) {
    result.error = `无法执行 ping 命令（${res.spawnError}）`;
    result.summary = '执行失败';
    return result;
  }
  const stats = parsePingStats(res.stdout);
  // 统计行缺失 = 输出不符合任何已知格式（命令没跑起来 / 乱码），不能编结论
  if (stats.lossPct === null) {
    result.error = 'ping 输出解析失败';
    result.summary = '输出无法解析';
    return result;
  }
  if (stats.lossPct >= 100) {
    result.ok = false;
    result.summary = '请求全部超时';
    return result;
  }
  const sent = res.stdout.match(/(?:已发送|Sent)\s*[=＝]\s*(\d+)/i);
  const sentN = sent ? Number(sent[1]) : 4;
  result.ok = true;
  const avg = stats.avgRttMs;
  result.summary = `${sentN - Math.round((sentN * stats.lossPct) / 100)}/${sentN} 回包 · ${
    avg !== null ? `平均 ${avg}ms` : '平均耗时未知'
  }`;
  return result;
}

// —— tracert ——

export interface TracertParse {
  /** 已到达（有回包）的跳数 */
  hops: number;
  /** 是否正常到达目标（输出含目标地址或"完成"字样） */
  reached: boolean;
}

/**
 * 纯函数：解析 tracert 输出。
 * 跳数判据：行首是跳序号且行内含 ms 回包（`  1    <1 ms   <1 ms  192.168.2.1`）；
 * 全 `*` 的超时跳行不计入。
 * 到达判据（两选一）：
 *  - 出现"跟踪完成。"/"Trace complete."（tracert 自己跑完的正常收尾；
 *    "跟踪无法完成。"不算——那是逐跳全超时后的失败收尾）；
 *  - 目标 IP 出现在带 ms 回包的跳行上。注意头部
 *    "跟踪到 X 的路由"也含目标 IP，必须排除（这正是测试抓过的坑）。
 */
export function parseTracertHops(text: string, target: string, timedOut: boolean): TracertParse {
  void timedOut; // 是否硬杀只影响 runDiag 层的 summary 文案；到达判定只看输出内容本身
  const lines = text.split(/\r?\n/);
  let hops = 0;
  let onHop = false;
  for (const line of lines) {
    // 跳行形如 "  1    <1 ms    1 ms    1 ms  192.168.2.1"：序号开头 + 行内含 ms
    if (/^\s*\d{1,3}\s/.test(line) && /\bms\b/i.test(line)) {
      hops += 1;
      if (line.includes(target)) onHop = true;
    }
  }
  const reached = /跟踪完成|Trace complete/i.test(text) || onHop;
  return { hops, reached };
}

/**
 * 纯函数（task-025）：把 tracert 输出解析为结构化跳数表。
 *  - 回包跳：`  1    <1 ms    1 ms     1 ms  192.168.2.1`（rtts 逐个提取，`<1 ms` 记 0）；
 *  - 超时跳：`  2     *        *        *     请求超时。`（rtts 全 null、ip null）；
 *  - hostname：仅未加 -d 的输出才有 `[主机名]` 后缀，取得到就带上，取不到 null（不猜）；
 *  - 无法识别的行直接跳过；整体解析不出任何跳 → 空数组（诚实降级，文本仍在 lines）。
 */
export function parseTracertHopsDetailed(text: string): TracertHop[] {
  const out: TracertHop[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(\d{1,3})\s+(.+)$/.exec(line);
    if (!m) continue;
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 1 || idx > 255) continue;
    const rest = m[2];
    const rtts: (number | null)[] = [];
    const tokenRe = /(<\s*\d+(?:\.\d+)?\s*ms|\d+(?:\.\d+)?\s*ms|\*)/gi;
    let tok: RegExpExecArray | null = null;
    while ((tok = tokenRe.exec(rest)) !== null && rtts.length < 3) {
      const token = tok[1];
      if (token === '*') {
        rtts.push(null);
        continue;
      }
      const num = /(\d+(?:\.\d+)?)/.exec(token);
      if (!num) {
        rtts.push(null);
        continue;
      }
      // `<1 ms` 按 0 记（与 parsePingOutput 的 sub-ms 语义一致）
      rtts.push(/</.test(token) ? 0 : Math.round(Number(num[1]) * 10) / 10);
    }
    // 无任何 rtt/超时令牌的行（如序号行混入的其他文本）直接跳过
    if (rtts.length === 0) continue;
    // 目标 IP / 主机名：取行内最后一个 IPv4；`[...]` 括号内为主机名（无 -d 时出现）
    const ipMatches = rest.match(/\d{1,3}(?:\.\d{1,3}){3}/g);
    const ip = ipMatches && ipMatches.length > 0 ? (ipMatches[ipMatches.length - 1] as string) : null;
    const hostM = /\[([^\]\s]+)\]/.exec(rest);
    const hostname = hostM ? (hostM[1] as string) : null;
    out.push({ idx, ip, hostname, rtts });
  }
  return out;
}

async function diagTracert(target: string, startedAt: number): Promise<DiagResult> {
  const res = await runGbkNative(
    'tracert',
    ['-d', '-h', String(DIAG.tracertMaxHops), '-w', '800', target],
    DIAG.tracertTimeoutMs,
  );
  const result = emptyResult('tracert', target, startedAt);
  result.durationMs = Date.now() - startedAt;
  result.lines = splitLines(res.stdout, 40);

  if (res.spawnError) {
    result.error = `无法执行 tracert 命令（${res.spawnError}）`;
    result.summary = '执行失败';
    return result;
  }
  // task-025：结构化跳数表（解析失败为空数组，诚实降级——文本 lines 仍在）
  result.hops = parseTracertHopsDetailed(res.stdout);
  const { hops, reached } = parseTracertHops(res.stdout, target, res.timedOut);
  // 超时硬杀不是失败：如实报告已到达的跳数（诚实截断）
  if (res.timedOut) {
    result.ok = true;
    result.summary = `已达 ${hops} 跳后超时截断`;
    return result;
  }
  if (reached) {
    result.ok = true;
    result.summary = hops > 0 ? `${hops} 跳到达 ${target}` : '已到达目标（无逐跳回包）';
  } else {
    result.ok = false;
    result.summary = `未能到达目标（${hops} 跳）`;
  }
  return result;
}

// —— ports ——

/** 诊断页探测的常用端口 → 服务名。 */
const DIAG_PORTS: readonly number[] = [22, 53, 80, 139, 443, 445, 902, 3389, 9100];
const DIAG_PORT_SERVICE: Readonly<Record<number, string>> = {
  22: 'SSH',
  53: 'DNS',
  80: 'HTTP',
  139: 'NetBIOS',
  443: 'HTTPS',
  445: 'SMB',
  902: 'VMware',
  3389: 'RDP',
  9100: 'RAW 打印',
};

async function diagPorts(target: string, startedAt: number): Promise<DiagResult> {
  const result = emptyResult('ports', target, startedAt);
  const opened = await probeHosts([target], DIAG_PORTS, 8, { timeoutMs: 1200 });
  result.durationMs = Date.now() - startedAt;
  const openPorts = opened.get(target) ?? [];
  result.ok = true;
  // lines：每个探测端口一行明细，按端口升序
  result.lines = DIAG_PORTS.map((p) => {
    const svc = DIAG_PORT_SERVICE[p] ?? String(p);
    return `${p} ${svc} ${openPorts.includes(p) ? '开放' : '关闭'}`;
  });
  if (openPorts.length === 0) {
    result.summary = '常用端口全部关闭';
    return result;
  }
  const detail = openPorts.map((p) => `${p}(${DIAG_PORT_SERVICE[p] ?? p})`).join(', ');
  result.summary = `开放 ${openPorts.length} 个端口：${detail}`;
  // task-019 移除 SSH 一键连接后的替代引导（22 开放才有意义）
  if (openPorts.includes(22)) {
    result.lines.push('提示：目标开放 SSH（22）。可在本机系统终端执行 ssh <目标IP> 连接（需目标启用 OpenSSH 服务）；本应用「终端」页也可用 nbtstat -A <目标IP> 查询其 NetBIOS 名。');
  }
  return result;
}

// —— dns ——

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

async function diagDns(target: string, startedAt: number): Promise<DiagResult> {
  const result = emptyResult('dns', target, startedAt);
  result.durationMs = Date.now() - startedAt;
  try {
    if (isValidIpv4(target)) {
      // IP 目标做反向解析
      const names = await dnsPromises.reverse(target);
      result.ok = true;
      result.lines = names.length > 0 ? names.map((n) => `反向解析：${n}`) : ['无 PTR 记录'];
      result.summary =
        names.length > 0 ? `反向解析：${names[0]}` : `未查询到 ${target} 的 PTR 记录`;
      return result;
    }
    // 项目 @types/node 版本的 LookupOptions 不含 signal，超时用 Promise.race 兜底
    const addrs = await Promise.race([
      dnsPromises.lookup(target, { all: true }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error('DNS 查询超时'), { name: 'TimeoutError' })),
          DIAG.dnsTimeoutMs,
        ),
      ),
    ]);
    result.ok = true;
    result.lines = addrs.map((a) => `${a.address} (IPv${a.family})`);
    result.summary = `解析到 ${addrs.length} 个地址：${addrs[0]?.address ?? '未知'}`;
    return result;
  } catch (err) {
    result.durationMs = Date.now() - startedAt;
    if (isAbortError(err)) {
      result.error = `DNS 查询超时（${DIAG.dnsTimeoutMs}ms）`;
      result.summary = '查询超时';
      return result;
    }
    const code = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : '';
    if (code === 'ENOTFOUND') {
      result.error = '无法解析该主机名';
      result.summary = '解析失败';
      return result;
    }
    result.error = `DNS 查询失败${code ? `（${code}）` : ''}`;
    result.summary = '查询失败';
    return result;
  }
}

// —— 统一入口 ——

/**
 * 执行一次网络诊断。先过目标校验（失败返回 ok:false + error），
 * 再按 kind 分发；任何异常都被捕获为 DiagResult.error，绝不抛。
 */
export async function runDiag(kind: DiagKind, target: string): Promise<DiagResult> {
  const startedAt = Date.now();
  const check = validateDiagTarget(kind, target);
  if (!check.ok) {
    const result = emptyResult(kind, target, startedAt);
    result.error = check.error;
    result.summary = '校验未通过';
    return result;
  }
  try {
    switch (kind) {
      case 'ping':
        return await diagPing(target, startedAt);
      case 'tracert':
        return await diagTracert(target, startedAt);
      case 'ports':
        return await diagPorts(target, startedAt);
      case 'dns':
        return await diagDns(target, startedAt);
    }
  } catch (err) {
    const result = emptyResult(kind, target, startedAt);
    result.durationMs = Date.now() - startedAt;
    result.error = err instanceof Error ? err.message : String(err);
    result.summary = '诊断执行异常';
    return result;
  }
}

// —— 本机网卡（ipconfig /all） ——

/** 从字段行提取最后一个冒号后的 IP（兼容"点号填充 + (首选)"后缀）。 */
function extractIp(line: string): string | null {
  const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(line);
  return m ? m[1] : null;
}

/**
 * 纯函数：解析中文 Windows `ipconfig /all` 输出为 NetAdapter[]。
 * 分段判据：以含"适配器"/"Adapter"的行起始一个网卡块。
 * 状态判据（保守）：块内有 IPv4 或默认网关 → connected；
 * 出现"媒体已断开"/"Media disconnected" → disconnected；
 * 两者皆无（既有无 IP 也无断开字样）→ disconnected（宁可信其未连接）。
 * 拿不到的字段 null/[]，绝不编造。
 */
export function parseIpconfigOutput(text: string): NetAdapter[] {
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const adapters: NetAdapter[] = [];

  let current: {
    name: string;
    ip: string | null;
    gateway: string | null;
    dns: string[];
    mac: string | null;
    dhcp: boolean | null;
    disconnected: boolean;
  } | null = null;

  const flush = (): void => {
    if (!current) return;
    // 状态判定：断开字样最优先；否则有 IP 或网关才算连接（写注释说明保守判据）
    const state: NetAdapter['state'] = current.disconnected
      ? 'disconnected'
      : current.ip || current.gateway
        ? 'connected'
        : 'disconnected';
    adapters.push({
      name: current.name,
      state,
      ip: current.ip,
      gateway: current.gateway,
      dns: current.dns,
      mac: current.mac,
      dhcp: current.dhcp,
    });
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    // 网卡块起始：适配器行（中文 "以太网适配器 以太网:" / 英文 "Ethernet adapter Ethernet:"）。
    // 两个排除判据（SMOKE 实测 Hyper-V/WSL 虚拟网卡踩过的坑）：
    //  - 字段行的值可能含 "Adapter"（如 "描述 . . . : Hyper-V Virtual Ethernet Adapter"），
    //    但字段行有点号填充（". ."），块头没有；
    //  - 块头恒以冒号结尾，字段行以值结尾。
    if (/适配器|adapter/i.test(line) && !/\.\s+\./.test(line) && /[：:]\s*$/.test(line)) {
      flush();
      // 名称取"适配器/adapter"之后、行尾冒号之前的部分
      const m = /(?:适配器|adapter)\s*(.*?)[：:]\s*$/i.exec(line);
      const name = (m ? m[1] : line.split(/[：:]/)[0]).trim() || '未知适配器';
      current = {
        name,
        ip: null,
        gateway: null,
        dns: [],
        mac: null,
        dhcp: null,
        disconnected: /媒体已断开|Media disconnected/i.test(line),
      };
      continue;
    }
    if (!current) continue; // 块外的前导行（"Windows IP 配置"、主机名等）忽略
    if (/媒体已断开|Media disconnected/i.test(line)) {
      current.disconnected = true;
      continue;
    }
    if (/物理地址|Physical Address/i.test(line)) {
      const m = /([0-9A-Fa-f]{2}(?:[-:][0-9A-Fa-f]{2}){5})/.exec(line);
      if (m) current.mac = m[1]; // 保留原始分隔符（中文系统是 '-'）
      continue;
    }
    if (/DHCP 已启用|DHCP Enabled/i.test(line)) {
      current.dhcp = /是|Yes/i.test(line) ? true : /否|No/i.test(line) ? false : null;
      continue;
    }
    if (/IPv4 地址|IPv4 Address/i.test(line)) {
      if (!current.ip) current.ip = extractIp(line); // 多地址块取第一个
      continue;
    }
    if (/默认网关|Default Gateway/i.test(line)) {
      if (!current.gateway) current.gateway = extractIp(line);
      continue;
    }
    if (/DNS 服务器|DNS Servers/i.test(line)) {
      const ip = extractIp(line);
      if (ip) current.dns.push(ip);
      continue;
    }
    // DNS 续行：紧跟 DNS 行之后、整行只有一个缩进 IP 的行（多个 DNS 服务器逐行列出）
    if (/^\s+\d{1,3}(?:\.\d{1,3}){3}\s*$/.test(line) && current.dns.length > 0) {
      const ip = extractIp(line);
      if (ip && !current.dns.includes(ip)) current.dns.push(ip);
    }
  }
  flush();
  return adapters;
}

/**
 * 读取本机网卡信息。ipconfig 执行失败（spawnError / 空输出 / 超时）返回 []，
 * 绝不编造网卡。
 */
export async function readAdapters(): Promise<NetAdapter[]> {
  const res = await runGbkNative('ipconfig', ['/all'], DIAG.ipconfigTimeoutMs);
  if (res.spawnError) return [];
  return parseIpconfigOutput(res.stdout);
}
