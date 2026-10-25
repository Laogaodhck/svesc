/**
 * 网络诊断引擎层测试（src/main/engine/diag/netlog.ts + netdiag.ts）
 *
 * 只覆盖纯函数与内存类，不跑真实网络命令（ping/tracert 的执行路径由
 * 自检时的真实环境覆盖）。ipconfig 样本按真实中文 Windows 输出形状构造。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NetLog } from '../src/main/engine/diag/netlog';
import {
  parseIpconfigOutput,
  parseTracertHops,
  validateDiagTarget,
} from '../src/main/engine/diag/netdiag';

// —— 1. validateDiagTarget ——

describe('validateDiagTarget', () => {
  it('合法 IPv4 与主机名通过（四类目标）', () => {
    for (const kind of ['ping', 'tracert', 'ports', 'dns'] as const) {
      expect(validateDiagTarget(kind, '192.168.2.1')).toEqual({ ok: true, error: null });
      expect(validateDiagTarget(kind, 'router.local')).toEqual({ ok: true, error: null });
      expect(validateDiagTarget(kind, 'my_host-01')).toEqual({ ok: true, error: null });
    }
  });

  it('注入字符 / 空白 / 过长 / 空串拒绝', () => {
    expect(validateDiagTarget('ping', '; rm -rf').ok).toBe(false);
    expect(validateDiagTarget('ping', '1.2.3.4 & calc').ok).toBe(false);
    expect(validateDiagTarget('ping', '1.2.3.4 | echo x').ok).toBe(false);
    expect(validateDiagTarget('ping', '`calc`').ok).toBe(false);
    expect(validateDiagTarget('ping', '$(calc)').ok).toBe(false);
    expect(validateDiagTarget('ping', '1.2.3.4 > file').ok).toBe(false);
    expect(validateDiagTarget('ping', '1.2.3.4;2').ok).toBe(false);
    expect(validateDiagTarget('ping', 'a b').ok).toBe(false);
    expect(validateDiagTarget('ping', '\t').ok).toBe(false);
    expect(validateDiagTarget('ping', '').ok).toBe(false);
    expect(validateDiagTarget('ping', '   ').ok).toBe(false);
    expect(validateDiagTarget('ping', 'a'.repeat(254)).ok).toBe(false);
    expect(validateDiagTarget('dns', '.bad').ok).toBe(false);
    expect(validateDiagTarget('dns', 'bad-').ok).toBe(false);
    // 253 字符恰好是上限
    expect(validateDiagTarget('ping', 'a'.repeat(253)).ok).toBe(true);
  });
});

// —— 2. parseIpconfigOutput ——

/** 真实形状的中文 `ipconfig /all` 样本：一块连接态 + 一块媒体已断开。 */
const IPCONFIG_ZH = `Windows IP 配置

主机名 . . . . . . . . . . . . . : DESKTOP-ABC

以太网适配器 以太网:

   连接特定的 DNS 后缀 . . . . . . . : lan
   描述. . . . . . . . . . . . . . . : Realtek PCIe GbE Family Controller
   物理地址. . . . . . . . . . . . . : A1-B2-C3-D4-E5-F5
   DHCP 已启用: 是
   自动配置已启用: 是
   IPv4 地址 . . . . . . . . . . . . : 192.168.2.10 (首选)
   子网掩码  . . . . . . . . . . . . : 255.255.255.0
   默认网关. . . . . . . . . . . . . : 192.168.2.1
   DHCP 服务器 . . . . . . . . . . . : 192.168.2.1
   DNS 服务器. . . . . . . . . . . . : 192.168.2.1
                                        8.8.8.8
   TCPIP 上的 NetBIOS  . . . . . . . : 已启用

无线局域网适配器 WLAN:

   连接特定的 DNS 后缀 . . . . . . . :
   描述. . . . . . . . . . . . . . . : Intel(R) Wi-Fi 6 AX201
   物理地址. . . . . . . . . . . . . : B2-C3-D4-E5-F6-A1
   DHCP 已启用: 是
   自动配置已启用: 是
   媒体状态  . . . . . . . . . . . . : 媒体已断开
   DNS 服务器. . . . . . . . . . . . :
`;

describe('parseIpconfigOutput', () => {
  it('解析两块网卡：连接态字段齐全，断开态字段诚实为 null', () => {
    const adapters = parseIpconfigOutput(IPCONFIG_ZH);
    expect(adapters).toHaveLength(2);

    const eth = adapters[0];
    expect(eth.name).toBe('以太网');
    expect(eth.state).toBe('connected');
    expect(eth.ip).toBe('192.168.2.10');
    expect(eth.gateway).toBe('192.168.2.1');
    expect(eth.dns).toEqual(['192.168.2.1', '8.8.8.8']);
    expect(eth.mac).toBe('A1-B2-C3-D4-E5-F5');
    expect(eth.dhcp).toBe(true);

    const wlan = adapters[1];
    expect(wlan.name).toBe('WLAN');
    expect(wlan.state).toBe('disconnected');
    expect(wlan.ip).toBeNull();
    expect(wlan.gateway).toBeNull();
    expect(wlan.mac).toBe('B2-C3-D4-E5-F6-A1');
    expect(wlan.dhcp).toBe(true);
    expect(wlan.dns).toEqual([]);
  });

  it('空输入返回 []，不抛异常', () => {
    expect(parseIpconfigOutput('')).toEqual([]);
    expect(parseIpconfigOutput('   \r\n')).toEqual([]);
  });

  it('DHCP 否 → false；无 DHCP 行 → null', () => {
    const sample = `以太网适配器 以太网:

   IPv4 地址 . . . . . . . . . . . . : 10.0.0.5
   默认网关. . . . . . . . . . . . . : 10.0.0.1
`;
    const a = parseIpconfigOutput(sample);
    expect(a).toHaveLength(1);
    expect(a[0].dhcp).toBeNull();
  });

  it('Hyper-V/WSL 虚拟网卡：描述字段值含 Adapter 不再误判为块起始（SMOKE 回归）', () => {
    const sample = `Windows IP 配置

以太网适配器 vEthernet (Default Switch):

   连接特定的 DNS 后缀 . . . . . . . :
   描述. . . . . . . . . . . . . . . : Hyper-V Virtual Ethernet Adapter
   物理地址. . . . . . . . . . . . . : 00-15-5D-9E-F7-77
   DHCP 已启用: 否
   IPv4 地址 . . . . . . . . . . . . : 172.26.176.1
`;
    const a = parseIpconfigOutput(sample);
    expect(a).toHaveLength(1); // 修复前：描述行被拆成第二块"适配器"
    expect(a[0].name).toBe('vEthernet (Default Switch)');
    expect(a[0].ip).toBe('172.26.176.1');
    expect(a[0].mac).toBe('00-15-5D-9E-F7-77');
    expect(a[0].dhcp).toBe(false);
  });
});

// —— 3. tracert 截断判定 ——

describe('parseTracertHops', () => {
  it('超时样本：前几跳有 IP、无"完成"字样 → hops 正确且未到达', () => {
    const text = `通过最多 15 个跃点跟踪到 8.8.8.8 的路由:

  1    <1 ms   <1 ms   <1 ms  192.168.2.1
  2     *        *        *     请求超时。
  3    5 ms     4 ms     5 ms  10.100.0.1
  4    *        *        *     请求超时。`;
    // 模拟被硬杀（timedOut=true）且输出里没有目标 IP
    const parsed = parseTracertHops(text, '8.8.8.8', true);
    expect(parsed.hops).toBe(2);
    expect(parsed.reached).toBe(false);
  });

  it('正常完成：输出含"跟踪完成" → reached=true', () => {
    const text = `  1    <1 ms   <1 ms   <1 ms  192.168.2.1
  2    3 ms     3 ms     2 ms  192.168.2.99

跟踪完成。`;
    const parsed = parseTracertHops(text, '192.168.2.99', false);
    expect(parsed.hops).toBe(2);
    expect(parsed.reached).toBe(true);
  });

  it('正常完成时即使 timedOut 标志误传，输出含"完成"仍判到达', () => {
    const parsed = parseTracertHops('跟踪完成。', '1.2.3.4', true);
    expect(parsed.reached).toBe(true);
  });
});

// —— 4. NetLog ——

describe('NetLog', () => {
  it('push 超 ringMax 后 truncated=true 且保留最新', () => {
    const log = new NetLog(5);
    for (let i = 0; i < 8; i++) {
      log.push('info', 'test', `msg-${i}`, 1000 + i);
    }
    const bundle = log.list(100);
    expect(bundle.total).toBe(5);
    expect(bundle.truncated).toBe(true);
    // 最新在前：msg-7 排第一，最旧的 msg-0~2 已被环形滚动裁掉
    expect(bundle.entries[0].message).toBe('msg-7');
    expect(bundle.entries[4].message).toBe('msg-3');
    // list(2) 同样是截断态
    const two = log.list(2);
    expect(two.total).toBe(5);
    expect(two.entries).toHaveLength(2);
    expect(two.truncated).toBe(true);
  });

  it('未滚动时 truncated=false；entries 按 ts 倒序', () => {
    const log = new NetLog(10);
    log.push('info', 'a', 'first', 100);
    log.push('error', 'b', 'second', 200);
    const bundle = log.list();
    expect(bundle.truncated).toBe(false);
    expect(bundle.total).toBe(2);
    expect(bundle.entries[0].message).toBe('second');
    expect(bundle.entries[0].level).toBe('error');
    expect(bundle.entries[1].message).toBe('first');
  });

  it('exportNdjson 写真实临时目录：文件存在、每行可 JSON.parse、首行 _meta', () => {
    const log = new NetLog(10);
    log.push('info', 'diag', 'hello', 1000);
    log.push('warn', 'diag', 'careful', 2000);
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-netlog-'));
    try {
      const out = log.exportNdjson(dir);
      expect(out.ok).toBe(true);
      expect(out.path).not.toBeNull();
      // 文件名冒号已替换为 '-'（Windows 路径约束）
      expect(path.basename(out.path ?? '').startsWith('svesc-logs-')).toBe(true);
      expect(out.path).not.toContain('T:'); // 文件名里的 ISO 冒号必须已替换为 '-'
      const raw = readFileSync(out.path!, 'utf8');
      const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
      expect(lines.length).toBe(3);
      const meta = JSON.parse(lines[0]) as { _meta: { count: number; exportedAt: number } };
      expect(meta._meta.count).toBe(2);
      expect(typeof meta._meta.exportedAt).toBe('number');
      const e1 = JSON.parse(lines[1]) as { ts: number; level: string; message: string };
      expect(e1.message).toBe('careful'); // 最新在前
      const e2 = JSON.parse(lines[2]) as { ts: number; message: string };
      expect(e2.message).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exportNdjson 到不存在的深层路径失败时不抛，返回 ok:false + error', () => {
    const log = new NetLog(4);
    log.push('info', 'x', 'y');
    // Windows 上非法文件名字符（冒号）作为目录 → I/O 失败
    const out = log.exportNdjson('Z:\\__no_such__\\dir');
    expect(out.ok).toBe(false);
    expect(typeof out.error).toBe('string');
    expect(out.path).toBeNull();
  });

  it('clear() 后 list 为空', () => {
    const log = new NetLog(5);
    log.push('info', 'a', 'x');
    log.clear();
    const bundle = log.list();
    expect(bundle.total).toBe(0);
    expect(bundle.entries).toEqual([]);
    expect(bundle.truncated).toBe(false);
  });
});
