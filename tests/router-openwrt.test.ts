/**
 * OpenWrt ubus JSON-RPC 客户端测试（`src/main/engine/router/openwrt.ts`）。
 * transport 注入：不 mock 网络，直接喂真实抓包形状的响应。
 */
import { describe, expect, it } from 'vitest';
import {
  buildRpcRequest,
  parseBoard,
  parseDhcpLeases,
  parseIwinfoDevices,
  parseIwinfoInfo,
  parseWirelessDevices,
  ubusErrorMessage,
  UbusClient,
  UBUS_NULL_SESSION,
} from '../src/main/engine/router/openwrt';
import type { Transport } from '../src/main/engine/router/openwrt';
import { normalizeDhcpLeases, normalizeLeaseHostname, normalizeLeaseMac } from '../src/main/engine/router/leases';
import type { DhcpLease } from '../src/shared/types';

const ok = (payload: unknown) => async () => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: [0, payload] }), error: null });

describe('租约纯工具', () => {
  it.each(['AA:BB:CC:DD:EE:FF', 'aa-bb-cc-dd-ee-ff', 'AABB.CCDD.EEFF', 'AABBCCDDEEFF', ' aa:bb:cc:dd:ee:ff '])('MAC 规范化 %s', (value) => {
    expect(normalizeLeaseMac(value)).toBe('aa-bb-cc-dd-ee-ff');
  });

  it.each([null, 123, '', 'AA:BB-CC:DD:EE:FF', 'mac=AA:BB:CC:DD:EE:FF', 'AABBCCDDEEFF00', 'aa bb cc dd ee ff', 'gg-bb-cc-dd-ee-ff'])('拒绝非法 MAC %s', (value) => {
    expect(normalizeLeaseMac(value)).toBeNull();
  });

  it.each([null, 123, '', ' ', '*', '-', '--', 'UNKNOWN', '(Unknown)', 'n/a', 'None', 'a\u0000b', 'a\u007fb', '\tdevice', 'x'.repeat(254)])('拒绝空、占位和控制字符名称 %s', (value) => {
    expect(normalizeLeaseHostname(value)).toBeNull();
  });

  it('只 trim 真实自报名，不从名称格式猜设备', () => {
    expect(normalizeLeaseHostname('  客厅设备  ')).toBe('客厅设备');
    expect(normalizeLeaseHostname('123')).toBe('123');
    expect(normalizeLeaseHostname('x'.repeat(253))).toHaveLength(253);
  });

  const base: DhcpLease = { mac: 'AA:BB:CC:DD:EE:01', ip: '192.168.0.2', hostname: null, expiresAt: null };

  it('过滤非法地址/过期/非有限期限并复制，不修改输入', () => {
    const input = Object.freeze([
      Object.freeze({ ...base, hostname: ' host ', expiresAt: 1001 }),
      ...['999.1.1.1', '1.2.3', '::1', '192.168.00.1'].map((ip) => ({ ...base, ip })),
      ...[999, 1000, NaN, Infinity, -Infinity].map((expiresAt) => ({ ...base, expiresAt })),
      { ...base, mac: 'bad' },
    ]);
    const result = normalizeDhcpLeases(input, 1000);
    expect(result).toEqual([{ ...base, mac: 'aa-bb-cc-dd-ee-01', hostname: 'host', expiresAt: 1001 }]);
    expect(result[0]).not.toBe(input[0]);
    expect(input[0].hostname).toBe(' host ');
  });

  it('同 MAC+IP 优先有名、续租取较晚期限，null 保持未知/无限', () => {
    const leases = [
      { ...base, expiresAt: 1001 },
      { ...base, mac: 'aabb.ccdd.ee01', hostname: ' host ', expiresAt: 2000 },
      { ...base, hostname: 'host', expiresAt: 1500 },
    ];
    expect(normalizeDhcpLeases(leases, 1000)).toEqual([{ ...base, mac: 'aa-bb-cc-dd-ee-01', hostname: 'host', expiresAt: 2000 }]);
    expect(normalizeDhcpLeases([...leases, base], 1000)[0].expiresAt).toBeNull();
  });

  it('冲突名称永久置 null；排序和截断与输入顺序无关，同 MAC 不同 IP 保留', () => {
    const leases = [
      { ...base, hostname: 'alpha' }, { ...base, hostname: 'beta' },
      { ...base, hostname: 'alpha' }, { ...base, ip: '192.168.0.1', hostname: 'old' },
    ];
    const result = normalizeDhcpLeases(leases, 1000);
    expect(result).toHaveLength(2);
    expect(result[0].ip).toBe('192.168.0.1');
    expect(result[1].hostname).toBeNull();
    expect(result).toEqual(normalizeDhcpLeases([...leases].reverse(), 1000));
    const many = Array.from({ length: 520 }, (_, i) => ({ ...base, ip: `10.0.${Math.floor(i / 256)}.${i % 256}` }));
    expect(normalizeDhcpLeases(many, 1000)).toHaveLength(512);
    expect(normalizeDhcpLeases(many, 1000)).toEqual(normalizeDhcpLeases(many.reverse(), 1000));
  });
});

describe('纯函数解析', () => {
  it('buildRpcRequest 生成标准 JSON-RPC call', () => {
    const body = JSON.parse(buildRpcRequest(['000abc', 'system', 'board']));
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'call' });
    expect(body.params).toEqual(['000abc', 'system', 'board']);
  });

  it('parseBoard 提取主机名/型号/固件/运行时长', () => {
    const board = parseBoard({
      hostname: 'OpenWrt',
      model: 'Xiaomi Mi Router 4A Gigabit Edition',
      release: { description: 'OpenWrt 23.05.5 r24106-10cc5fcd00' },
      uptime: 86461,
    });
    expect(board).toEqual({
      hostname: 'OpenWrt',
      model: 'Xiaomi Mi Router 4A Gigabit Edition',
      firmware: 'OpenWrt 23.05.5 r24106-10cc5fcd00',
      uptimeSec: 86461,
    });
  });

  it('parseBoard 形状不符返回 null（不猜）', () => {
    expect(parseBoard(null)).toBeNull();
    expect(parseBoard('nonsense')).toBeNull();
    expect(parseBoard({})).toEqual({ hostname: null, model: null, firmware: null, uptimeSec: null });
  });

  it('parseDhcpLeases 解析 luci-rpc 租约列表', () => {
    const now = Date.now();
    const leases = parseDhcpLeases({
      dhcp_leases: [
        { expires: 3600, hostname: 'Max-PC', ipaddr: '192.168.2.101', macaddr: 'AA:BB:CC:DD:EE:01' },
        { expires: -1, hostname: 'static-host', ipaddr: '192.168.2.102', macaddr: 'AA:BB:CC:DD:EE:02' },
        { ipaddr: '192.168.2.103' }, // 缺 MAC → 丢弃
      ],
      dhcp6_leases: [],
    });
    expect(leases).toHaveLength(2);
    expect(leases[0]).toMatchObject({ ip: '192.168.2.101', mac: 'aa-bb-cc-dd-ee-01', hostname: 'Max-PC' });
    expect(leases[0].expiresAt).toBeGreaterThan(now);
    expect(leases[1].expiresAt).toBeNull();
  });

  it('expires=0 已过期；非法数字不能变成有效或无限租期', () => {
    const item = { ipaddr: '192.168.0.2', macaddr: 'aabb.ccdd.ee01', hostname: ' unknown ' };
    for (const expires of [0, -2, NaN, Infinity, -Infinity, Number.MAX_VALUE, '3600', 'bad', true, {}]) {
      expect(parseDhcpLeases({ dhcp_leases: [{ ...item, expires }] })).toEqual([]);
    }
    for (const expires of [-1, null, undefined]) {
      expect(parseDhcpLeases({ dhcp_leases: [{ ...item, expires }] })).toEqual([
        { ip: item.ipaddr, mac: 'aa-bb-cc-dd-ee-01', hostname: null, expiresAt: null },
      ]);
    }
  });

  it('OpenWrt 也过滤地址、合并重复及冲突名', () => {
    expect(parseDhcpLeases({ dhcp_leases: [
      { ipaddr: '192.168.0.2', macaddr: 'AABBCCDDEE01', hostname: 'a' },
      { ipaddr: '192.168.0.2', macaddr: 'AA:BB:CC:DD:EE:01', hostname: 'b' },
      { ipaddr: '192.168.0.2', macaddr: 'bad', hostname: 'fake' },
      { ipaddr: '999.0.0.1', macaddr: 'AABBCCDDEE01' },
    ] })).toEqual([{ ip: '192.168.0.2', mac: 'aa-bb-cc-dd-ee-01', hostname: null, expiresAt: null }]);
  });

  it('parseDhcpLeases 形状不符返回 []', () => {
    expect(parseDhcpLeases(null)).toEqual([]);
    expect(parseDhcpLeases({})).toEqual([]);
    expect(parseDhcpLeases({ dhcp_leases: 'nonsense' })).toEqual([]);
  });

  it('parseWirelessDevices 解析嵌套 radio/interface/clients', () => {
    const clients = parseWirelessDevices({
      radios: {
        radio0: {
          up: true,
          interfaces: {
            '@wifi-iface[0]': {
              config: { ssid: 'Home-5G' },
              clients: {
                'aa:bb:cc:dd:ee:11': { signal: -52, rx: { rate: 433000 }, tx: { rate: 866000 }, connected_time: 7200 },
                'aa:bb:cc:dd:ee:12': { signal: -70 },
              },
            },
          },
        },
      },
    });
    expect(clients).toHaveLength(2);
    expect(clients[0]).toMatchObject({
      mac: 'AA:BB:CC:DD:EE:11',
      ssid: 'Home-5G',
      signalDbm: -52,
      rxRateKbps: 433000,
      txRateKbps: 866000,
      connectedForSec: 7200,
    });
    expect(clients[1]).toMatchObject({ rxRateKbps: null, txRateKbps: null });
  });

  it('ubusErrorMessage 覆盖常见错误码', () => {
    expect(ubusErrorMessage(-32002)).toContain('用户名或密码');
    expect(ubusErrorMessage(-32000)).toContain('未编译');
    expect(ubusErrorMessage(-1)).toContain('无权访问');
    expect(ubusErrorMessage(-999)).toContain('-999');
  });
});

describe('UbusClient（transport 注入）', () => {
  it('login 成功缓存会话；call 自动带会话令牌', async () => {
    const calls: Array<unknown[]> = [];
    let sessionIssued = false;
    const transport: Transport = async (_url, body) => {
      const req = JSON.parse(body) as { params: unknown[] };
      calls.push(req.params);
      // params 形状是 [sid, object, method, params]：login 的 sid 必须是 32 位零 null-session
      const p = req.params as [string, string, string, Record<string, unknown>];
      if (p[1] === 'session' && p[2] === 'login') {
        // B-2 回归：不是 32 位零 sid 的 login 必须被拒（真机 uhttpd 就是这样）
        if (p[0] !== UBUS_NULL_SESSION) {
          return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Access denied' } }), error: null };
        }
        if (p[3]?.username !== 'root' || p[3]?.password !== 'secret') {
          return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Access denied' } }), error: null };
        }
        sessionIssued = true;
        return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: [0, { ubus_rpc_session: 'SESS123', timeout: 3600 }] }), error: null };
      }
      if (!sessionIssued) return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Access denied' } }), error: null };
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: [0, { hostname: 'OpenWrt' }] }), error: null };
    };

    const client = new UbusClient('192.168.2.1', transport);
    expect(client.loggedIn).toBe(false);
    const login = await client.login('root', 'secret');
    expect(login.ok).toBe(true);
    expect(client.loggedIn).toBe(true);

    // B-2 锁死：login 的 sid 必须是 32 位零 null-session（uhttpd 的 uh_ubus_allowed 只接受它）。
    // 假 transport 之上再加这一行，是为了让"sid 被改回字面量 'session'"这类回归当场红——
    // 只靠替身拒绝是不够的：替身拒绝会让 login 失败，但失败原因指向 -32002，
    // 看起来像"密码错"，排查方向会被带偏。
    expect(
      calls[0]?.[0],
      'login 的 sid 必须是 32 位零 null-session（uhttpd 的 uh_ubus_allowed 只接受它）',
    ).toBe(UBUS_NULL_SESSION);

    await client.board();
    const last = calls[calls.length - 1];
    expect(last[0]).toBe('SESS123');
  });

  it('login 失败清空会话并返回错误文案', async () => {
    const transport: Transport = async () => ({
      status: 200,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Access denied' } }),
      error: null,
    });
    const client = new UbusClient('192.168.2.1', transport);
    const res = await client.login('root', 'wrong');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('用户名或密码');
    expect(client.loggedIn).toBe(false);
  });

  it('网络失败返回 error 不抛异常', async () => {
    const transport: Transport = async () => ({ status: null, body: '', error: 'ECONNREFUSED' });
    const client = new UbusClient('192.168.2.1', transport);
    const res = await client.login('root', 'x');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ECONNREFUSED');
  });

  it('未登录时 call 直接返回 auth-required', async () => {
    const client = new UbusClient('192.168.2.1', ok({}));
    const res = await client.call('system', 'board');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('auth-required');
  });

  it('非法 JSON 响应返回错误', async () => {
    const transport: Transport = async () => ({ status: 200, body: '<html>gateway</html>', error: null });
    const client = new UbusClient('192.168.2.1', transport);
    const res = await client.login('root', 'x');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不是合法 JSON');
  });

  it.each(['null', '[]', '[0, {}]', '42', 'true', '"text"'])('RPC 顶层 %s 返回失败，不 throw；调用失败不作废会话', async (body) => {
    let response = body;
    const transport: Transport = async () => ({ status: 200, body: response, error: null });
    const client = new UbusClient('192.168.2.1', transport);
    await expect(client.login('root', 'x')).resolves.toMatchObject({ ok: false });
    response = JSON.stringify({ result: [0, { ubus_rpc_session: 'S1' }] });
    await client.login('root', 'x');
    response = body;
    await expect(client.call('system', 'board')).resolves.toMatchObject({ ok: false, payload: null });
    expect(client.loggedIn).toBe(true);
  });

  it('logout 清空会话', async () => {
    const client = new UbusClient('192.168.2.1', ok({ ubus_rpc_session: 'S1' }));
    await client.login('root', 'x');
    expect(client.loggedIn).toBe(true);
    client.logout();
    expect(client.loggedIn).toBe(false);
  });
});

/**
 * `sessionInvalid` 语义（Max-1 定的性 + 落的实现）：
 * **只有调用路径上的 -32002 代表会话死亡**。网络错误走 `res.error`、HTTP 非 200 走 status 分支、
 * `result:[6]` 是权限拒绝——它们都到不了 -32002，所以都不得作废会话。
 * 反向对照的意义：防止有人把修复做反成"任何失败都登出"（那正是我一开始担心的失效模式）。
 */
describe('UbusClient 会话作废只认调用路径的 -32002', () => {
  const loginOk = {
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: [0, { ubus_rpc_session: 'S1', timeout: 3600 }] }),
    error: null,
  };
  const rpcError = (code: number, message = 'Access denied') => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }),
    error: null,
  });
  const rpcResult = (code: number, payload: unknown = {}) => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: [code, payload] }),
    error: null,
  });

  /** 登录成功一次，之后的响应按队列走；记录实际发出的请求数。 */
  function scripted(steps: Array<{ status: number | null; body: string; error: string | null }>) {
    const sent: string[] = [];
    let index = 0;
    const transport: Transport = async (_url, body) => {
      sent.push(body);
      const step = steps[Math.min(index, steps.length - 1)] as (typeof steps)[number];
      index += 1;
      return step;
    };
    return { transport, sent };
  }

  async function loggedIn(steps: Array<{ status: number | null; body: string; error: string | null }>) {
    const s = scripted([loginOk, ...steps]);
    const client = new UbusClient('192.168.2.1', s.transport);
    expect((await client.login('root', 'secret')).ok, '前置登录必须成功').toBe(true);
    s.sent.length = 0; // 只统计 login 之后的请求
    return { client, sent: s.sent };
  }

  it('调用路径 -32002 → sessionInvalid=true 且会话当场作废', async () => {
    const { client } = await loggedIn([rpcError(-32002)]);
    const res = await client.call('system', 'board');
    expect({ ok: res.ok, error: res.error, sessionInvalid: res.sessionInvalid, loggedIn: client.loggedIn }).toEqual({
      ok: false,
      error: '会话已过期或无权限，请重新登录',
      sessionInvalid: true,
      loggedIn: false,
    });
  });

  it('作废后再 call → auth-required 且不再发请求（不得拿死 sid 重试）', async () => {
    const { client, sent } = await loggedIn([rpcError(-32002), loginOk, loginOk]);
    await client.call('system', 'board');
    const afterFirst = sent.length;
    const retry = await client.call('system', 'board');
    expect({ error: retry.error, sentBefore: afterFirst, sentAfter: sent.length }).toEqual({
      error: 'auth-required',
      sentBefore: 1,
      sentAfter: 1,
    });
  });

  it('反向对照：网络错误 → sessionInvalid falsy 且仍保持登录（重试不需要重新登录）', async () => {
    const { client } = await loggedIn([{ status: null, body: '', error: 'ETIMEDOUT' }, loginOk]);
    const res = await client.call('system', 'board');
    expect({ error: res.error, sessionInvalid: Boolean(res.sessionInvalid), loggedIn: client.loggedIn }).toEqual({
      error: 'ETIMEDOUT',
      sessionInvalid: false,
      loggedIn: true,
    });
  });

  it('反向对照：HTTP 非 200 → sessionInvalid falsy 且仍保持登录', async () => {
    const { client } = await loggedIn([{ status: 500, body: 'boom', error: null }, loginOk]);
    const res = await client.call('system', 'board');
    expect({ error: res.error, sessionInvalid: Boolean(res.sessionInvalid), loggedIn: client.loggedIn }).toEqual({
      error: 'HTTP 500',
      sessionInvalid: false,
      loggedIn: true,
    });
  });

  it('反向对照：result:[6] 权限拒绝 → sessionInvalid falsy 且仍保持登录', async () => {
    const { client } = await loggedIn([rpcResult(6, {}), loginOk]);
    const res = await client.call('system', 'board');
    expect({ error: res.error, sessionInvalid: Boolean(res.sessionInvalid), loggedIn: client.loggedIn }).toEqual({
      error: '权限被拒绝（UBUS_STATUS_PERMISSION_DENIED）',
      sessionInvalid: false,
      loggedIn: true,
    });
  });

  it('反向对照：登录路径的 -32002 是密码错，不得被当成会话失效', async () => {
    const s = scripted([rpcError(-32002)]);
    const client = new UbusClient('192.168.2.1', s.transport);
    const res = await client.login('root', 'wrong');
    expect({ ok: res.ok, error: res.error, loggedIn: client.loggedIn }).toEqual({
      ok: false,
      error: '用户名或密码错误',
      loggedIn: false,
    });
  });
});

describe('iwinfo 解析（task-024）', () => {
  it('parseIwinfoDevices 提取射频设备名', () => {
    expect(parseIwinfoDevices({ devices: [{ name: 'wlan0' }, { name: 'wlan1' }] })).toEqual(['wlan0', 'wlan1']);
  });

  it('parseIwinfoDevices 形状防御到底', () => {
    expect(parseIwinfoDevices({ devices: 'nope' })).toEqual([]);
    expect(parseIwinfoDevices({ devices: [null, 42, {}, { name: '' }, { other: 1 }] })).toEqual([]);
    expect(parseIwinfoDevices({ nope: 1 })).toEqual([]);
    expect(parseIwinfoDevices('garbage')).toEqual([]);
    expect(parseIwinfoDevices(null)).toEqual([]);
  });

  it('parseIwinfoInfo 提取 SSID/信道/关联数', () => {
    const info = parseIwinfoInfo(
      { ssid: 'HomeNet', channel: 6, assoclist: [{ mac: 'aa' }, { mac: 'bb' }] },
      'wlan0',
    );
    expect(info).toEqual({ device: 'wlan0', ssid: 'HomeNet', channel: 6, clientCount: 2 });
  });

  it('parseIwinfoInfo 字段缺失/形状不符 → 对应位 null，不猜', () => {
    expect(parseIwinfoInfo({}, 'wlan0')).toEqual({ device: 'wlan0', ssid: null, channel: null, clientCount: null });
    expect(parseIwinfoInfo({ ssid: '', channel: 0, assoclist: 'not-array' }, 'wlan1')).toEqual({
      device: 'wlan1',
      ssid: null,
      channel: null,
      clientCount: null,
    });
    expect(parseIwinfoInfo('garbage', 'wlan0')).toEqual({
      device: 'wlan0',
      ssid: null,
      channel: null,
      clientCount: null,
    });
    expect(parseIwinfoInfo(null, 'wlan0')).toEqual({
      device: 'wlan0',
      ssid: null,
      channel: null,
      clientCount: null,
    });
  });
});
