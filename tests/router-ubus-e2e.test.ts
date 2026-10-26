/**
 * ubus 端到端（真实 node:http 全链路，**不注入 transport**）。
 *
 * 这是 task-001 报告里"ubus 未端到端验证"这条边界的闭环：
 * `new UbusClient('127.0.0.1:' + port)` 走真实 `defaultTransport` → `httpx.httpRequest`
 * → node:http → 假 ubus 服务器 → 原路返回。
 *
 * 假服务器**严格复刻 uhttpd 的会话门禁**，否则 login-sid 那类 bug 会继续隐身：
 *  - `session.login` 只接受 `params[0] === '0'.repeat(32)`（32 位零 null-session）
 *  - 非 login 调用的 `params[0]` 必须是本服务器已下发的会话，否则 -32002
 *  - 错用户名/密码 → -32002；未知对象/方法 → -32000；权限拒绝 → `result:[6,{}]`
 *
 * **声明：这里是"形状复刻"，不是完整 ACL 语义**（不实现 ubus 的权限对象树、
 * 不做 ACL 检查、不模拟多会话并发与过期回收）。它只保证"协议形状与会话门禁"
 * 与真实 uhttpd 一致，从而能抓住 sid/login 形态、错误码分流、JSON-RPC 编号、
 * 传输层回归这类问题。
 *
 * 时序约束：除超时用例外**不做任何 wall-clock 断言**；并发用服务器记录的
 * 请求计数与 id 序列证明；超时用例用服务器 delay(3000) + 客户端常量推导。
 */
import * as http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTER } from '../src/shared/constants';
import { UBUS_NULL_SESSION, UbusClient } from '../src/main/engine/router/openwrt';

interface Recorded {
  id: number;
  params: unknown[];
  path: string;
  method: string;
  contentType: string | undefined;
  body: string;
}

type Mode = 'ok' | 'http404' | 'http500' | 'html';

const BOARD_PAYLOAD = {
  hostname: 'OpenWrt',
  model: 'Xiaomi Mi Router 4A Gigabit Edition',
  release: { description: 'OpenWrt 23.05.5 r24106-10cc5fcd00', version: '23.05.5' },
  uptime: 86_461,
};
const DHCP_PAYLOAD = {
  dhcp_leases: [
    { ipaddr: '192.168.2.31', macaddr: 'AA:BB:CC:00:00:1F', hostname: 'phone', expires: 3600 },
    { ipaddr: '192.168.2.32', macaddr: 'AA:BB:CC:00:00:20', hostname: '', expires: -1 },
  ],
};
const WIFI_PAYLOAD = {
  radios: {
    radio0: {
      interfaces: [
        {
          config: { ssid: 'HomeNet' },
          clients: {
            'aa:bb:cc:00:00:31': { signal: -52, rx: { rate: 130_000 }, tx: { rate: 86_600 }, connected_time: 90 },
          },
        },
      ],
    },
  },
};

/** 已下发且未撤销的会话（uhttpd 的会话表形状）。 */
let liveSessions = new Set<string>();
let mode: Mode = 'ok';
/** 并发用例里让 board 晚于另外两个方法回包，制造乱序。 */
let boardDelayMs = 0;
const requests: Recorded[] = [];

const server = http.createServer((req, res) => {
  // 客户端超时销毁连接后服务端再写会 EPIPE：必须吞掉，否则假服务器自己崩
  res.on('error', () => {});
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('error', () => {});

  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');

    if (req.url !== '/ubus' || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (mode === 'http404') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('nope');
      return;
    }
    if (mode === 'http500') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
      return;
    }
    if (mode === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>router login</body></html>');
      return;
    }

    let msg: { id?: unknown; params?: unknown };
    try {
      msg = JSON.parse(raw) as { id?: unknown; params?: unknown };
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('this is not json at all');
      return;
    }

    const params = Array.isArray(msg.params) ? (msg.params as unknown[]) : [];
    const id = typeof msg.id === 'number' ? msg.id : 0;
    requests.push({
      id,
      params,
      path: req.url ?? '',
      method: req.method ?? '',
      contentType: req.headers['content-type'],
      body: raw,
    });

    const reply = (payload: Record<string, unknown>, delayMs = 0): void => {
      const send = (): void => {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
        } catch {
          /* 连接已被客户端销毁 */
        }
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    };
    const deny = (code: number, message = 'Access denied'): void => reply({ error: { code, message } });

    const [sid, object, method, args] = params as [string, string, string, Record<string, unknown>];

    // —— session.login：只认 32 位零 null-session，且校验用户名密码 ——
    if (object === 'session' && method === 'login') {
      if (sid !== UBUS_NULL_SESSION) {
        deny(-32002);
        return;
      }
      const a = args ?? {};
      if (a.username !== 'root' || a.password !== 'secret') {
        deny(-32002);
        return;
      }
      liveSessions.add('S1');
      reply({ result: [0, { ubus_rpc_session: 'S1', timeout: 3600, expires: 3600 }] });
      return;
    }

    // —— 其余调用：sid 必须是已下发会话 ——
    if (typeof sid !== 'string' || !liveSessions.has(sid)) {
      deny(-32002);
      return;
    }

    if (object === 'system' && method === 'board') {
      reply({ result: [0, BOARD_PAYLOAD] }, boardDelayMs);
      return;
    }
    if (object === 'system' && method === 'hang') {
      reply({ result: [0, {}] }, 3_000);
      return;
    }
    if (object === 'system' && method === 'denied') {
      reply({ result: [6, {}] });
      return;
    }
    if (object === 'luci-rpc' && method === 'getDHCPLeases') {
      reply({ result: [0, DHCP_PAYLOAD] });
      return;
    }
    if (object === 'luci-rpc' && method === 'getWirelessDevices') {
      reply({ result: [0, WIFI_PAYLOAD] });
      return;
    }
    deny(-32000, 'Method not found');
  });
});

let port = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 每个用例前重置服务器状态，避免跨用例串味。 */
function reset(): void {
  requests.length = 0;
  mode = 'ok';
  boardDelayMs = 0;
  liveSessions = new Set();
}

function client(): UbusClient {
  return new UbusClient(`127.0.0.1:${port}`);
}

async function loggedInClient(): Promise<UbusClient> {
  const c = client();
  const res = await c.login('root', 'secret');
  expect(res.ok, '前置登录必须成功，否则本用例无意义').toBe(true);
  return c;
}

describe('ubus 端到端（真实 HTTP，形状复刻 uhttpd 门禁）', () => {
  it('①login 成功（32 位零 sid）→ 后续 call 的 params[0] 确实带上会话令牌', async () => {
    reset();
    const c = client();
    const login = await c.login('root', 'secret');
    expect(login).toEqual({ ok: true, error: null });
    expect(c.loggedIn).toBe(true);

    // 服务器视角：login 请求用的是 32 位零 sid，不是字面量 'session'
    const loginReq = requests[0];
    expect({ loginSid: loginReq?.params[0], isNullSession: loginReq?.params[0] === UBUS_NULL_SESSION }).toEqual({
      loginSid: UBUS_NULL_SESSION,
      isNullSession: true,
    });

    await c.board();
    const callReq = requests[1];
    expect(callReq?.params[0], 'call 必须带上下发的会话令牌，否则服务器会以 -32002 拒绝').toBe('S1');
  });

  it('②错密码 → -32002 → ok:false、文案"用户名或密码错误"、loggedIn=false', async () => {
    reset();
    const c = client();
    const res = await c.login('root', 'wrong');
    expect({ ok: res.ok, error: res.error, loggedIn: c.loggedIn }).toEqual({
      ok: false,
      error: '用户名或密码错误',
      loggedIn: false,
    });
  });

  it('③会话被撤销后 call → -32002 → 文案是 call 语境的"会话已过期或无权限，请重新登录"', async () => {
    reset();
    const c = await loggedInClient();
    const before = await c.call('system', 'board');
    expect(before.ok, '前置调用必须成功').toBe(true);

    liveSessions.clear(); // 模拟会话过期/被踢
    const after = await c.call('system', 'board');
    // -32002 是唯一"证据确凿的会话死亡"信号：网络抖动走 res.error、HTTP 错误走 status 分支，
    // 都到不了这里。所以会话必须当场作废，且不得再拿死 sid 重试。
    expect({ ok: after.ok, error: after.error, sessionInvalid: after.sessionInvalid, loggedIn: c.loggedIn }).toEqual({
      ok: false,
      error: '会话已过期或无权限，请重新登录',
      sessionInvalid: true,
      loggedIn: false,
    });
    const seen = requests.length;
    const retry = await c.call('system', 'board');
    expect({ error: retry.error, requests: requests.length }, '作废后必须走 auth-required 短路，不得再拿死 sid 发请求').toEqual({
      error: 'auth-required',
      requests: seen,
    });
  });

  it('③-反  HTTP 500 与权限拒绝都不得作废会话（防止修复做反成"任何失败都登出"）', async () => {
    reset();
    const c = await loggedInClient();

    mode = 'http500';
    const http500 = await c.call('system', 'board');
    expect({ sessionInvalid: Boolean(http500.sessionInvalid), loggedIn: c.loggedIn }).toEqual({
      sessionInvalid: false,
      loggedIn: true,
    });

    mode = 'ok';
    const denied = await c.call('system', 'denied');
    expect({ error: denied.error, sessionInvalid: Boolean(denied.sessionInvalid), loggedIn: c.loggedIn }).toEqual({
      error: '权限被拒绝（UBUS_STATUS_PERMISSION_DENIED）',
      sessionInvalid: false,
      loggedIn: true,
    });

    // 会话还在：下一轮正常调用必须仍然成功（不需要用户重新登录）
    const ok = await c.call('system', 'board');
    expect(ok.ok).toBe(true);
  });

  it('④非 200 → 文案为 HTTP 404 / HTTP 500', async () => {
    reset();
    const c = await loggedInClient();

    mode = 'http404';
    const notFound = await c.call('system', 'board');
    expect(notFound.error).toBe('HTTP 404');

    mode = 'http500';
    const serverError = await c.call('system', 'board');
    expect(serverError.error).toBe('HTTP 500');
  });

  it('④b登录路径非 200 → 文案必须指引"内置浏览器登录"（非 OpenWrt 固件的 404 不是应用坏了）', async () => {
    reset();
    mode = 'http404';
    const c = new UbusClient(`127.0.0.1:${port}`);
    const res = await c.login('root', 'secret');
    expect(res.ok).toBe(false);
    // 裸 "HTTP 404" 会让人以为应用坏了；登录语境的 404 几乎必然是"该固件没有 /ubus 端点"
    expect(res.error).toMatch(/^HTTP 404（该路由器未提供 \/ubus 登录接口/);
    expect(res.error).toContain('内置浏览器');
    // call 语境不受影响：仍是裸 HTTP 状态码（用例④已锁），不重复堆砌指引
  });

  it('⑤非 JSON 响应体 → "ubus 响应不是合法 JSON"', async () => {
    reset();
    const c = await loggedInClient();
    mode = 'html';
    const res = await c.call('system', 'board');
    expect(res.error).toBe('ubus 响应不是合法 JSON');
  });

  it('⑥未知对象/方法 → -32000 → "方法不存在"', async () => {
    reset();
    const c = await loggedInClient();
    const res = await c.call('nonexistent', 'noSuchMethod');
    expect(res.error).toContain('方法不存在');
  });

  it('⑦result:[6,{}] → "权限被拒绝"（UBUS_STATUS_PERMISSION_DENIED）', async () => {
    reset();
    const c = await loggedInClient();
    const res = await c.call('system', 'denied');
    expect(res.error).toContain('权限被拒绝');
  });

  it('⑧并发三连发 + 服务器乱序回包 → 不串味，且 rpcId 严格连续不重复（集合语义）', async () => {
    reset();
    const c = client();
    expect((await c.login('root', 'secret')).ok, '前置登录必须成功').toBe(true);
    requests.length = 0; // 只统计三个并发调用本身
    boardDelayMs = 50; // board 故意最后回包

    const [board, leases, wireless] = await Promise.all([
      c.board(),
      c.dhcpLeases(),
      c.wirelessClients(),
    ]);

    expect({
      hostname: board?.hostname,
      model: board?.model,
      leaseCount: leases.length,
      wirelessCount: wireless.length,
      firstLeaseIp: leases[0]?.ip,
      wirelessMac: wireless[0]?.mac,
      wirelessRate: wireless[0]?.rxRateKbps,
    }).toEqual({
      hostname: 'OpenWrt',
      model: 'Xiaomi Mi Router 4A Gigabit Edition',
      leaseCount: 2,
      wirelessCount: 1,
      firstLeaseIp: '192.168.2.31',
      wirelessMac: 'AA:BB:CC:00:00:31',
      wirelessRate: 130_000,
    });

    // 乱序回包不得让 id 错位。注意语义边界：HTTP 不保证到达顺序，
    // 三个并发请求 push 到 requests 的顺序可能是 2,4,3——所以这里断言
    // **集合**性质（排序后严格连续、不重复、恰好 3 个），不断言到达顺序。
    // login 消耗了 id 1，故期望区间是 2..4；"不错位"由上方载荷七项断言证明
    // （board 的 50ms 延迟回包若被 leases/wireless 拿到，载荷立刻对不上）。
    const ids = requests.map((r) => r.id).sort((a, b) => a - b);
    const unique = new Set(ids).size === ids.length;
    const consecutive = ids.every((v, i) => i === 0 || v === (ids[i - 1] as number) + 1);
    expect({
      ids: ids.join(','),
      count: ids.length,
      consecutive,
      unique,
    }, `服务器实际收到的 id 集合（排序后）：${ids.join(',')}`).toEqual({ ids: '2,3,4', count: 3, consecutive: true, unique: true });
  });

  it(`⑨超时：server delay 3000ms > ROUTER.ubusTimeoutMs(${ROUTER.ubusTimeoutMs}) → 文案含 timeout，且不悬挂`, async () => {
    reset();
    const c = await loggedInClient();
    const res = await c.call('system', 'hang');
    expect(res.ok).toBe(false);
    expect(res.error, `实际错误：${res.error ?? '(null)'}`).toContain(`timeout after ${ROUTER.ubusTimeoutMs}ms`);
  });

  it('⑩未登录 call 不发请求（服务器计数=0）；logout 后同样短路；重新 login 恢复', async () => {
    reset();
    const c = client();

    const before = await c.call('system', 'board');
    expect({ error: before.error, received: requests.length }).toEqual({ error: 'auth-required', received: 0 });

    await c.login('root', 'secret');
    expect((await c.board())?.hostname).toBe('OpenWrt');
    const afterLogin = requests.length;
    expect(afterLogin, 'login + board 两次请求').toBe(2);

    c.logout();
    const afterLogout = await c.call('system', 'board');
    expect({ error: afterLogout.error, received: requests.length }).toEqual({
      error: 'auth-required',
      received: afterLogin,
    });

    const again = await c.login('root', 'secret');
    expect({ ok: again.ok, loggedIn: c.loggedIn }).toEqual({ ok: true, loggedIn: true });
  });

  it('⑪传输层回归网：POST /ubus + application/json + 合法 JSON-RPC 四字段', async () => {
    reset();
    const c = await loggedInClient();
    await c.board();

    const sent = requests[requests.length - 1];
    expect({
      method: sent?.method,
      path: sent?.path,
      contentType: sent?.contentType,
    }).toEqual({ method: 'POST', path: '/ubus', contentType: 'application/json' });

    let parsed: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } = {};
    expect(() => {
      parsed = JSON.parse(sent?.body ?? '');
    }, 'body 必须是合法 JSON').not.toThrow();
    expect({
      jsonrpc: parsed.jsonrpc,
      method: parsed.method,
      idIsNumber: typeof parsed.id === 'number',
      paramsIsArray: Array.isArray(parsed.params),
    }).toEqual({ jsonrpc: '2.0', method: 'call', idIsNumber: true, paramsIsArray: true });
  });
});
