/**
 * task-025 局域网运维扩展单元测试：
 *   A. WOL magic packet 构造
 *   B. WatchManager 持续 Ping 监控（变迁 / 窗口 / 恢复）
 *   C. 端口扫描器（参数校验 + 本机真实端口）
 *   D. HTML 报告（转义 + 结构）
 *   F. tracert 结构化跳数解析
 *   H. store 备注/标签/监控目标持久化 + 配置导入导出数据形状
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { buildMagicPacket, normalizeMac, RE_MAC } from '../src/main/engine/wol';
import { WatchManager, cleanWatchNote } from '../src/main/engine/watch';
import { scanPortRange } from '../src/main/engine/diag/portscan';
import { buildHtmlReport, escapeHtml } from '../src/main/engine/report-html';
import { parseTracertHopsDetailed } from '../src/main/engine/diag/netdiag';
import { JsonStore, defaultState, normalizeTags } from '../src/main/engine/store';
import type { Snapshot } from '../src/shared/types';

// —— WatchManager 依赖的 pingSweep 打桩（不 spawn 真实 ping） ——
const mockState = vi.hoisted(() => ({ alive: {} as Record<string, boolean>, rtt: 2.5 }));
vi.mock('../src/main/engine/discovery/ping', () => ({
  pingSweep: vi.fn(async (hosts: string[]) => ({
    results: new Map(
      hosts.map((ip) => [ip, { alive: mockState.alive[ip] ?? false, rttMs: mockState.rtt, ttl: 64 }]),
    ),
  })),
}));

// ===================== A. WOL =====================
describe('A. WOL magic packet（task-025）', () => {
  it('报文 = 6×0xFF + 16×目标 MAC（字节级断言）', () => {
    const packet = buildMagicPacket('AA-BB-CC-DD-EE-FF');
    expect(packet).not.toBeNull();
    expect(packet?.length).toBe(102);
    expect(packet?.subarray(0, 6).every((b) => b === 0xff)).toBe(true);
    const macBytes = Buffer.from('aabbccddeeff', 'hex');
    for (let i = 0; i < 16; i += 1) {
      expect(packet?.subarray(6 + i * 6, 12 + i * 6).equals(macBytes)).toBe(true);
    }
  });

  it('冒号分隔 MAC 同样可构造；归一化去分隔符', () => {
    expect(buildMagicPacket('aa:bb:cc:dd:ee:ff')).not.toBeNull();
    expect(normalizeMac('AA:BB-CC:DD-EE:FF')).toBe('aabbccddeeff');
    expect(RE_MAC.test('aabbccddeeff')).toBe(false); // 必须带分隔符
  });

  it('非法 MAC 返回 null（不抛）', () => {
    expect(buildMagicPacket('not-a-mac')).toBeNull();
    expect(buildMagicPacket('')).toBeNull();
    expect(buildMagicPacket('aa:bb:cc:dd:ee')).toBeNull();
  });
});

// ===================== B. WatchManager =====================
describe('B. WatchManager 持续 Ping 监控（task-025）', () => {
  beforeEach(() => {
    mockState.alive = {};
    mockState.rtt = 2.5;
  });

  it('add：IP 非法拒绝；重复添加幂等并更新备注', () => {
    const wm = new WatchManager();
    expect(wm.add('999.1.1.1').ok).toBe(false);
    expect(wm.add('192.168.2.7').ok).toBe(true);
    expect(wm.add('192.168.2.7', 'NAS').ok).toBe(true);
    expect(wm.list()).toHaveLength(1);
    expect(wm.list()[0]?.note).toBe('NAS');
  });

  it('无样本时 state=unknown（不猜在线/离线）', () => {
    const wm = new WatchManager();
    wm.add('192.168.2.7');
    const status = wm.status();
    expect(status).toHaveLength(1);
    expect(status[0]?.state).toBe('unknown');
    expect(status[0]?.upPct).toBeNull();
    expect(status[0]?.downSince).toBeNull();
  });

  it('宕机变迁回调一次 + downSince 落账；恢复回调 + downSince 清空', async () => {
    const transitions: { down: boolean; ip: string }[] = [];
    const wm = new WatchManager({
      onTransition: (down, target) => transitions.push({ down, ip: target.ip }),
    });
    wm.add('192.168.2.7');
    mockState.alive['192.168.2.7'] = true;
    await wm.tick();
    expect(transitions).toHaveLength(0); // 一直在线：无变迁
    expect(wm.status()[0]?.state).toBe('up');

    mockState.alive['192.168.2.7'] = false;
    await wm.tick();
    expect(transitions).toEqual([{ down: true, ip: '192.168.2.7' }]);
    const downStatus = wm.status()[0];
    expect(downStatus?.state).toBe('down');
    expect(downStatus?.downSince).not.toBeNull();

    mockState.alive['192.168.2.7'] = true;
    await wm.tick();
    expect(transitions).toEqual([
      { down: true, ip: '192.168.2.7' },
      { down: false, ip: '192.168.2.7' },
    ]);
    expect(wm.status()[0]?.downSince).toBeNull();
  });

  it('窗口环形上限按 windowSize 截断；upPct 按窗口计算', async () => {
    const wm = new WatchManager({ windowSize: 3 });
    wm.add('192.168.2.7');
    mockState.alive['192.168.2.7'] = true;
    await wm.tick();
    await wm.tick();
    mockState.alive['192.168.2.7'] = false;
    await wm.tick();
    await wm.tick();
    const status = wm.status()[0];
    expect(status?.window).toHaveLength(3); // 4 轮采样只留最近 3 点
    expect(status?.upPct).toBe(33.3); // 窗口内 1/3 存活
  });

  it('remove：同时清空内存窗口与宕机计时', async () => {
    const wm = new WatchManager();
    wm.add('192.168.2.7');
    mockState.alive['192.168.2.7'] = false;
    await wm.tick();
    expect(wm.status()[0]?.state).toBe('down');
    wm.remove('192.168.2.7');
    expect(wm.list()).toHaveLength(0);
    expect(wm.status()).toHaveLength(0);
  });

  it('备注清洗：trim / 截断 40 字符 / 空串归 null', () => {
    expect(cleanWatchNote('  NAS 机房  ')).toBe('NAS 机房');
    expect(cleanWatchNote('   ')).toBeNull();
    expect(cleanWatchNote(null)).toBeNull();
    expect(cleanWatchNote('x'.repeat(50))).toHaveLength(40);
  });

  it('hydrate：脏目标直接丢弃（诚实原则）', () => {
    const wm = new WatchManager();
    wm.hydrate([
      { ip: '192.168.2.7', addedAt: 1000, note: 'NAS' },
      { ip: 'not-an-ip', addedAt: 1000, note: null },
    ]);
    expect(wm.list()).toHaveLength(1);
    expect(wm.list()[0]?.ip).toBe('192.168.2.7');
  });
});

// ===================== C. 端口扫描器 =====================
describe('C. 端口扫描器（task-025）', () => {
  it('目标含非法字符 → 拒绝（与诊断中心同一白名单）', async () => {
    const res = await scanPortRange('bad_target;', 1, 10);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('非法');
  });

  it('范围非法 / 超上限 → 拒绝', async () => {
    expect((await scanPortRange('127.0.0.1', 100, 1)).ok).toBe(false);
    expect((await scanPortRange('127.0.0.1', 0, 10)).ok).toBe(false);
    expect((await scanPortRange('127.0.0.1', 1, 65536)).ok).toBe(false);
    const tooMany = await scanPortRange('127.0.0.1', 1, 1100);
    expect(tooMany.ok).toBe(false);
    expect(tooMany.error).toContain('1024');
  });

  it('本机真实端口：监听端口开放、未监听端口关闭', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await scanPortRange('127.0.0.1', port, port + 1, { timeoutMs: 300 });
      expect(res.ok).toBe(true);
      expect(res.openPorts).toEqual([port]);
      expect(res.ports).toEqual([
        { port, open: true },
        { port: port + 1, open: false },
      ]);
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
    }
  });
});

// ===================== D. HTML 报告 =====================
describe('D. HTML 导出报告（task-025）', () => {
  const baseSnapshot: Snapshot = {
    ts: Date.parse('2026-10-26T12:00:00+08:00'),
    subnet: '192.168.2.0/24',
    dataSource: 'live',
    devices: [
      {
        id: 'dev-192.168.2.10',
        ip: '192.168.2.10',
        mac: 'aa-bb-cc-dd-ee-ff',
        hostname: 'nas',
        vendor: 'Synology',
        osHint: null,
        kind: 'server',
        state: 'online',
        firstSeen: 0,
        lastSeen: 0,
        openPorts: [],
        quality: { latencyMs: 3, jitterMs: 1, packetLossPct: 0, score: 90, grade: 'excellent', samples: 10 },
        bandwidth: { rxBps: 1500, txBps: 500, share: 0, connections: 2, attributable: true, estimated: false },
        rttHistory: [],
        isGateway: false,
        isSelf: false,
        displayName: null,
        ipConflict: false,
        note: '<script>alert(1)</script>',
        tags: ['机房" A'],
      },
    ],
    printers: [],
    system: {
      totalDevices: 1,
      online: 1,
      offline: 0,
      degraded: 0,
      printers: 0,
      printersWithFault: 0,
      rxBps: 1500,
      txBps: 500,
      bandwidthHistory: [],
      scan: { active: false, pct: 100, phase: 'idle', scanned: 0, total: 0, startedAt: null },
      lastScanAt: null,
      nextScanInMs: null,
      autoScan: true,
      autoScanIntervalSec: 60,
    },
    watches: [],
    warnings: [],
  };

  it('备注/标签中的 HTML 必须被转义（防注入）', () => {
    const html = buildHtmlReport(baseSnapshot);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('机房&quot; A');
  });

  it('结构完整：标题/网段/设备表/空表占位', () => {
    const html = buildHtmlReport(baseSnapshot);
    expect(html).toContain('SVESC 局域网巡检报告');
    expect(html).toContain('192.168.2.0/24');
    expect(html).toContain('<h2 id="devices">设备</h2>');
    expect(html).toContain('<p class="empty">暂无打印机数据</p>');
    expect(html).toContain('<h2 id="warnings">降级信息（数据可信度）</h2>');
  });

  it('escapeHtml 覆盖五个危险字符', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});

// ===================== F. tracert 跳数解析 =====================
describe('F. tracert 结构化跳数（task-025）', () => {
  const SAMPLE = [
    '通过最多 30 个跃点跟踪到 baidu.com [110.242.68.66]:',
    '',
    '  1    <1 ms    1 ms     1 ms  192.168.2.1',
    '  2     *        *        *     请求超时。',
    '  3     3 ms     4 ms     3 ms  10.108.0.1 [safe.example.com]',
    '  4    8 ms     8 ms     9 ms  110.242.68.66',
    '跟踪完成。',
  ].join('\r\n');

  it('解析 4 跳：<1 ms → 0；`*` → null；[主机名] 提取', () => {
    const hops = parseTracertHopsDetailed(SAMPLE);
    expect(hops).toHaveLength(4);
    expect(hops[0]).toMatchObject({ idx: 1, ip: '192.168.2.1', hostname: null, rtts: [0, 1, 1] });
    expect(hops[1]).toMatchObject({ idx: 2, ip: null, hostname: null, rtts: [null, null, null] });
    expect(hops[2]).toMatchObject({ idx: 3, ip: '10.108.0.1', hostname: 'safe.example.com', rtts: [3, 4, 3] });
    expect(hops[3]).toMatchObject({ idx: 4, ip: '110.242.68.66', rtts: [8, 8, 9] });
  });

  it('无法解析的文本 → 空数组（诚实降级）', () => {
    expect(parseTracertHopsDetailed('完全无法识别的输出')).toEqual([]);
    expect(parseTracertHopsDetailed('')).toEqual([]);
  });
});

// ===================== H. store 备注/标签/监控 + 配置形状 =====================
describe('H. store 备注/标签/监控目标（task-025）', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svesc-t025-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('JsonStore：note/tags/watch 增删改查 + 落盘往返', () => {
    const store = new JsonStore(dir, 'state.json', 1);
    store.setNote('dev-192.168.2.10', '机房主机');
    store.setTags('dev-192.168.2.10', [' 生产 ', '机房', '生产', 'x'.repeat(30)]);
    store.addWatchTarget('192.168.2.7', 'NAS');
    store.addWatchTarget('192.168.2.1', null);

    expect(store.noteOf('dev-192.168.2.10')).toBe('机房主机');
    expect(store.tagsOf('dev-192.168.2.10')).toEqual(['生产', '机房', 'x'.repeat(24)]);
    expect(store.watchTargets()).toHaveLength(2);
    expect(store.watchTargets()[0]).toMatchObject({ ip: '192.168.2.7', note: 'NAS' });

    // 清除语义
    store.setNote('dev-192.168.2.10', null);
    store.setTags('dev-192.168.2.10', []);
    expect(store.noteOf('dev-192.168.2.10')).toBeNull();
    expect(store.tagsOf('dev-192.168.2.10')).toBeNull();

    // 重启恢复（持久化往返；flush 绕过 debounce 同步落盘）
    store.addWatchTarget('192.168.2.7', 'NAS');
    store.flush();
    const reopened = new JsonStore(dir, 'state.json', 1);
    expect(reopened.watchTargets()).toHaveLength(2);
    expect(reopened.watchTargets().some((w) => w.ip === '192.168.2.7' && w.note === 'NAS')).toBe(true);
  });

  it('JsonStore：watch IP 非法拒绝；旧版文件缺新字段时自动补默认', () => {
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ version: 1, aliases: { 'dev-x': '旧' }, settings: { autoScan: false } }),
      'utf8',
    );
    const store = new JsonStore(dir, 'state.json', 1);
    expect(store.get().deviceNotes).toEqual({});
    expect(store.get().deviceTags).toEqual({});
    expect(store.get().watchList).toEqual([]);
    expect(store.addWatchTarget('300.1.1.1', null).ok).toBe(false);
    expect(store.aliasOf('dev-x')).toBe('旧');
  });

  it('normalizeTags：trim/去空/去重/截断 24 字符/上限 8 个', () => {
    expect(normalizeTags([' a ', 'a', '', 'b'])).toEqual(['a', 'b']);
    expect(normalizeTags(['x'.repeat(30)])).toEqual(['x'.repeat(24)]);
    expect(normalizeTags(Array.from({ length: 12 }, (_, i) => `t${i}`))).toHaveLength(8);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags([42, 'ok'] as unknown[])).toEqual(['ok']);
  });

  it('defaultState 包含新字段（Sqlite/Json 同构基线）', () => {
    const state = defaultState();
    expect(state.deviceNotes).toEqual({});
    expect(state.deviceTags).toEqual({});
    expect(state.watchList).toEqual([]);
  });
});
