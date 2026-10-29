/**
 * RouterManager 集成断言：ubus 会话失效在编排层的投影。
 *
 * 背景（task #13）：Max-1 修掉三处——
 *   1) `index.ts:221` `loggedIn` 派生从 `this.ubus !== null`（独立谎言）改为
 *      `this.ubus !== null && this.ubus.loggedIn`；
 *   2) `index.ts:187` 三个 ubus 调用的 `sessionInvalid` 透到 doRefresh；
 *   3) `index.ts:225` 观测到失效时 `session.error` = '路由器会话已过期，请重新登录'。
 *
 * 本文件锁死这三处的**可观测行为**，重点是四条反向对照：
 * 网络抖动 / HTTP 500 / 单对象权限拒绝**不得**被放大成"登出 + 报会话过期"。
 * caps 口径（D-017 后）：caps.openwrt 是能力位，进程内只置 true 不置 false——
 * 会话当轮死掉、后续轮次、logout 之后都必须保持 true（会话维度由 UI 的 CapRow
 * note 分支表达，caps 不得撒谎）。
 *
 * mock 策略：detect / upnp / httpx 三个模块替换，RouterManager 与 UbusClient
 * 全部走真实代码路径（UbusClient 用默认 transport → 被 mock 的 httpRequest），
 * 不注入替身客户端——要验的正是"真客户端 + 真编排"的拼接。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// —— 共享脚本状态（vi.hoisted：mock 工厂先于 import 求值也能引用）——
const h = vi.hoisted(() => ({
  /** 所有到达 httpx 的请求（含 UPnP 描述页直查与 Basic 凭据验证 GET） */
  requests: [] as Array<{ url: string; body: string; headers?: Record<string, string> }>,
  /** 每个 JSON-RPC 请求的应答脚本；返回 null 表示"脚本没覆盖到"，测试会立刻炸 */
  script: null as null | ((parsed: Record<string, unknown>, seq: number) => { status: number | null; body: string; error: string | null }),
  /** task-024：管理页探测结果；null = 默认"探测关闭"（既有用例语义不变） */
  detectResult: null as null | {
    reachable: boolean;
    brand: string | null;
    hint: string | null;
    error: string | null;
    url: string | null;
    auth: 'basic' | null;
  },
  /** task-024：Basic 凭据验证 GET（带 Authorization 头的非 JSON-RPC 请求）的应答；null = 模拟不可达 */
  basicVerifyResponse: null as null | { status: number | null; body: string; error: string | null },
  webPage: null as string | null,
  rpcGate: null as Promise<void> | null,
  upnpGate: null as Promise<void> | null,
  detectGate: null as Promise<void> | null,
}));

vi.mock('../src/main/engine/router/httpx', () => ({
  httpRequest: async (url: string, opts: { body?: string; headers?: Record<string, string> }) => {
    const body = opts?.body ?? '';
    h.requests.push({ url, body, headers: opts?.headers });
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    // 非 JSON-RPC：带 Authorization 头的是 Basic 凭据验证 GET（task-024），按配置应答；
    // 其余（UPnP description.xml 直查兜底）→ 模拟不可达
    if (!parsed || parsed.method !== 'call') {
      if (h.basicVerifyResponse && opts?.headers?.Authorization) return h.basicVerifyResponse;
      if (h.webPage !== null && opts?.headers?.Cookie) return { status: 200, body: h.webPage, error: null };
      return { status: null, body: '', error: 'mock: 非 ubus 请求' };
    }
    if (h.rpcGate) await h.rpcGate;
    const seq = h.requests.filter((r) => r.body.includes('"method":"call"')).length;
    const res = h.script!(parsed, seq);
    if (res === null) throw new Error('脚本未覆盖该请求: ' + body);
    return res;
  },
}));

vi.mock('../src/main/engine/router/detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/router/detect')>();
  return {
    ...actual,
    // 管理页探测默认不可达：identity.brand 保持 null，避免走 openwrt 提示分支干扰；
    // task-024：h.detectResult 非空时按配置返回（Basic-Auth 登录测试）
    detectManagementPage: async () => {
      if (h.detectGate) await h.detectGate;
      return h.detectResult ?? { reachable: false, error: 'mock: 探测关闭' };
    },
  };
});

vi.mock('../src/main/engine/router/upnp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/router/upnp')>();
  return {
    ...actual,
    // SSDP 与 UPnP 查询恒无结果：probeUpnp 走 descPaths 直查（被 httpx mock 挡下）
    ssdpDiscover: async () => { if (h.upnpGate) await h.upnpGate; return null; },
    upnpQuery: async () => null,
  };
});

import { RouterManager } from '../src/main/engine/router/index';
import * as webLeases from '../src/main/engine/router/web-leases';

// —— JSON-RPC 应答构造器（严格复刻 uhttpd 形状）——
const rpcOk = (id: unknown, result: unknown) => ({
  status: 200,
  body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  error: null,
});
const rpcErr = (id: unknown, code: number) => ({
  status: 200,
  body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'mock' } }),
  error: null,
});

const isLogin = (p: Record<string, unknown>) =>
  Array.isArray(p.params) && p.params[1] === 'session' && p.params[2] === 'login';

/** 登录成功 + 三个数据调用全部正常的脚本 */
function scriptAllOk(): void {
  h.script = (parsed, _seq) => {
    const p = parsed.params as unknown[];
    if (isLogin(parsed)) return rpcOk(parsed.id, [0, { ubus_rpc_session: 'S1', timeout: 3600 }]);
    if (p[1] === 'system' && p[2] === 'board') {
      return rpcOk(parsed.id, [0, {
        hostname: 'OpenWrt',
        model: 'x86-64',
        release: { description: 'OpenWrt 23.05.0', version: '23.05.0' },
        uptime: 12345,
      }]);
    }
    if (p[1] === 'luci-rpc' && p[2] === 'getDHCPLeases') {
      return rpcOk(parsed.id, [0, { dhcp_leases: [{ ipaddr: '192.168.2.10', macaddr: 'AA:BB:CC:DD:EE:01', hostname: 'pc-1', expires: -1 }] }]);
    }
    if (p[1] === 'luci-rpc' && p[2] === 'getWirelessDevices') {
      return rpcOk(parsed.id, [0, {
        radios: { radio0: { interfaces: { iface0: { config: { ssid: 'HomeNet' }, clients: { 'aa:bb:cc:dd:ee:02': { signal: -50, rx: { rate: 130000 } } } } } } },
      }]);
    }
    // task-024：iwinfo 通道（设备列表 + 单设备信息）
    if (p[1] === 'iwinfo' && p[2] === 'devices') {
      return rpcOk(parsed.id, [0, { devices: [{ name: 'wlan0' }] }]);
    }
    if (p[1] === 'iwinfo' && p[2] === 'info') {
      return rpcOk(parsed.id, [0, { ssid: 'HomeNet', channel: 6, assoclist: [{ mac: 'aa:bb:cc:dd:ee:02' }] }]);
    }
    throw new Error('脚本未识别调用: ' + JSON.stringify(p));
  };
}

/** 登录成功 + 三个数据调用全部 -32002（会话被撤销/过期） */
function scriptSessionDead(): void {
  h.script = (parsed) => (isLogin(parsed) ? rpcOk(parsed.id, [0, { ubus_rpc_session: 'S1' }]) : rpcErr(parsed.id, -32002));
}

/** 登录本身就 -32002（无 ubus 通道的固件，task-024 Basic-Auth 降级测试用） */
function scriptUbusLoginDead(): void {
  h.script = (parsed) => rpcErr(parsed.id, -32002);
}

/** 到达 httpx 的 JSON-RPC 请求数（排除 UPnP 描述页直查） */
function ubusCallCount(): number {
  return h.requests.filter((r) => r.body.includes('"method":"call"')).length;
}

/** 带 Authorization 头的请求数（Basic 凭据验证 GET，task-024） */
function authGetCount(): number {
  return h.requests.filter((r) => typeof r.headers?.Authorization === 'string').length;
}

const GW = '192.168.2.1';
function newManager(): RouterManager {
  return new RouterManager({ getGateway: () => GW });
}

beforeEach(() => {
  h.requests.length = 0;
  h.script = null;
  h.detectResult = null;
  h.basicVerifyResponse = null;
  h.webPage = null;
  h.rpcGate = null;
  h.upnpGate = null;
  h.detectGate = null;
});

describe('RouterManager 会话失效投影（-32002 在编排层）', () => {
  it('三个 ubus 调用全部 -32002 → 界面必须看到"未登录 + 会话过期原因"，数据不编造', async () => {
    scriptSessionDead();
    const mgr = newManager();
    const loginRes = await mgr.login('root', 'secret');
    expect(loginRes.ok, '登录本身必须成功——失效发生在登录之后的数据调用上').toBe(true);

    const s = mgr.getStatus();
    expect({
      loggedIn: s.session.loggedIn,
      user: s.session.user,
      error: s.session.error,
    }).toEqual({
      // 若这里还是 true，UI 会显示假的"已登录"（旧 bug：只查 this.ubus !== null）
      loggedIn: false,
      user: 'root',
      error: '路由器会话已过期，请重新登录',
    });
    // caps 与 loggedIn 的"不同步"是设计使然（D-017）：能力（协议支持）与会话（登录态）
    // 正交，caps.openwrt 进程内只进不退。当轮门在调用前过会置位，即便门不过，
    // openwrtCapable 粘性位也保证它为 true——锁它 true 是防有人把"会话死了就收回
    // 能力标识"当成修复方向（那会让 UI 把支持 OpenWrt 的路由器显示为不支持）。
    expect(s.capabilities.openwrt, '会话当轮死掉：caps.openwrt 应保持 true（能力位粘性）').toBe(true);
    // 数据诚实：三个调用都失败 → 空结构，绝不编造
    expect({ leases: s.dhcpLeases, wireless: s.wirelessClients, board: s.systemBoard })
      .toEqual({ leases: [], wireless: [], board: null });
  });

  it('失效之后的下一轮 refresh：错误消息必须持续，且不得再拿死 sid 发请求', async () => {
    scriptSessionDead();
    const mgr = newManager();
    await mgr.login('root', 'secret');
    const before = ubusCallCount();

    // 第二轮：客户端已作废会话（loggedIn=false），编排层应跳过三个调用
    const s2 = await mgr.refresh();
    expect(s2.session.error, '错误消息必须持续到用户重新登录，不能静默变回 null 让 UI 不提示')
      .toBe('路由器会话已过期，请重新登录');
    expect(s2.session.loggedIn).toBe(false);
    expect(ubusCallCount(), '会话已死还继续发请求：每轮刷新都会撞一次 -32002').toBe(before);
    // caps.openwrt 必须仍为 true（D-017 后的断言，非旧口径的"回落 false"）：
    // 能力（协议支持）与会话（登录态）正交——"支持 OpenWrt 的路由器在会话过期后
    // 显示为该路由器不支持"是疏漏不是设计，违反数据诚实。UI 的会话维度由 CapRow 的
    // note 分支（"已登录 / 登录后可查看"）表达，caps 不得撒谎。
    expect(s2.capabilities.openwrt, '会话过期后 caps.openwrt 必须保持 true：能力位粘性，只进不退').toBe(true);
  });

  it('重新登录成功后错误消息清零，数据通道恢复', async () => {
    scriptSessionDead();
    const mgr = newManager();
    await mgr.login('root', 'secret');
    expect(mgr.getStatus().session.error).toBe('路由器会话已过期，请重新登录');

    scriptAllOk();
    const again = await mgr.login('root', 'secret');
    expect(again.ok).toBe(true);
    const s = mgr.getStatus();
    expect({ loggedIn: s.session.loggedIn, error: s.session.error })
      .toEqual({ loggedIn: true, error: null });
    expect(s.systemBoard?.hostname, '重新登录后必须真的拿到板子信息，而不是只改状态位').toBe('OpenWrt');
    expect(s.dhcpLeases).toHaveLength(1);
    expect(s.wirelessClients).toHaveLength(1);
  });

  it('反向对照①：三个调用全部网络错误 → 不得登出、不得报"会话过期"，且下一轮能恢复', async () => {
    h.script = (parsed) => (isLogin(parsed)
      ? rpcOk(parsed.id, [0, { ubus_rpc_session: 'S1' }])
      : { status: null, body: '', error: 'mock: 网络抖动' });
    const mgr = newManager();
    await mgr.login('root', 'secret');

    const s = mgr.getStatus();
    expect({
      loggedIn: s.session.loggedIn,
      error: s.session.error,
    }).toEqual({
      // 这条是防"任何失败都登出"做反：网络抖动是瞬时故障，清会话会把故障放大成持续故障
      loggedIn: true,
      error: null,
    });

    // 会话仍在的证明：换正常脚本后同一客户端直接恢复出数，无需重新登录
    scriptAllOk();
    const s2 = await mgr.refresh();
    expect(s2.session.loggedIn).toBe(true);
    expect(s2.systemBoard?.hostname).toBe('OpenWrt');
  });

  it('反向对照②：board 成功 + leases 网络错误 + wireless 成功 → 不置位失效、登录保持', async () => {
    h.script = (parsed) => {
      const p = parsed.params as unknown[];
      if (isLogin(parsed)) return rpcOk(parsed.id, [0, { ubus_rpc_session: 'S1' }]);
      if (p[1] === 'system' && p[2] === 'board') {
        return rpcOk(parsed.id, [0, { hostname: 'OpenWrt', model: 'x86-64', release: { description: 'OpenWrt 23.05.0' }, uptime: 999 }]);
      }
      if (p[1] === 'luci-rpc' && p[2] === 'getDHCPLeases') {
        return { status: null, body: '', error: 'mock: 网络抖动' };
      }
      if (p[1] === 'luci-rpc' && p[2] === 'getWirelessDevices') {
        return rpcOk(parsed.id, [0, {
          radios: { radio0: { interfaces: { iface0: { config: { ssid: 'HomeNet' }, clients: { 'aa:bb:cc:dd:ee:02': { signal: -50, rx: { rate: 130000 } } } } } } },
        }]);
      }
      if (p[1] === 'iwinfo' && p[2] === 'devices') {
        return rpcOk(parsed.id, [0, { devices: [{ name: 'wlan0' }] }]);
      }
      if (p[1] === 'iwinfo' && p[2] === 'info') {
        return rpcOk(parsed.id, [0, { ssid: 'HomeNet', channel: 6, assoclist: [] }]);
      }
      throw new Error('脚本未识别调用: ' + JSON.stringify(p));
    };
    const mgr = newManager();
    await mgr.login('root', 'secret');

    const s = mgr.getStatus();
    expect({ loggedIn: s.session.loggedIn, error: s.session.error })
      .toEqual({ loggedIn: true, error: null });
    // 单对象失败只污染它自己：board/wireless 照常出数，leases 空但不连带会话
    expect(s.systemBoard?.hostname).toBe('OpenWrt');
    expect(s.wirelessClients).toHaveLength(1);
    expect(s.dhcpLeases).toEqual([]);
  });

  it('反向对照③：权限拒绝 result:[6] 是单对象 ACL，不是会话失效', async () => {
    h.script = (parsed) => (isLogin(parsed)
      ? rpcOk(parsed.id, [0, { ubus_rpc_session: 'S1' }])
      : { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: [6, {}] }), error: null });
    const mgr = newManager();
    await mgr.login('root', 'secret');

    const s = mgr.getStatus();
    expect({ loggedIn: s.session.loggedIn, error: s.session.error })
      .toEqual({ loggedIn: true, error: null });
  });

  it('反向对照④：HTTP 500 是瞬时故障，不清会话、不报"已过期"', async () => {
    h.script = (parsed) => (isLogin(parsed)
      ? rpcOk(parsed.id, [0, { ubus_rpc_session: 'S1' }])
      : { status: 500, body: 'Internal Server Error', error: null });
    const mgr = newManager();
    await mgr.login('root', 'secret');

    const s = mgr.getStatus();
    expect({ loggedIn: s.session.loggedIn, error: s.session.error })
      .toEqual({ loggedIn: true, error: null });
    // 瞬时故障不清"已存在的过期提示"也不能反过来清掉登录态：会话仍在，下一轮能恢复
    scriptAllOk();
    const s2 = await mgr.refresh();
    expect(s2.session.loggedIn).toBe(true);
    expect(s2.systemBoard?.hostname).toBe('OpenWrt');
  });

  it('logout() 后连续两轮 refresh：caps.openwrt 粘性保持 true，session.loggedIn 为 false', async () => {
    scriptAllOk();
    const mgr = newManager();
    await mgr.login('root', 'secret');
    expect(mgr.getStatus().capabilities.openwrt, '登录成功即认定支持 OpenWrt').toBe(true);
    const before = ubusCallCount();

    mgr.logout();

    const s1 = await mgr.refresh();
    expect({ capsOpenwrt: s1.capabilities.openwrt, loggedIn: s1.session.loggedIn })
      .toEqual({ capsOpenwrt: true, loggedIn: false });

    const s2 = await mgr.refresh();
    expect({ capsOpenwrt: s2.capabilities.openwrt, loggedIn: s2.session.loggedIn })
      .toEqual({ capsOpenwrt: true, loggedIn: false });

    // 登出后两轮都不得再摸 ubus（ubus 已置 null），且按会话取得的数据被清空
    expect(ubusCallCount(), 'logout 后还在发 ubus 请求').toBe(before);
    expect({ leases: s2.dhcpLeases, wireless: s2.wirelessClients, board: s2.systemBoard })
      .toEqual({ leases: [], wireless: [], board: null });
  });

  it('未登录时 refresh 不得产生任何 ubus 请求', async () => {
    scriptAllOk();
    const mgr = newManager();
    await mgr.refresh();
    expect(ubusCallCount(), '没登录就发 ubus 请求：轻则 401 噪声，重则把密码带进日志').toBe(0);
    expect(mgr.getStatus().session.loggedIn).toBe(false);
  });
});

describe('审计 L4：logout 世代号（在飞 doRefresh 的竞态）', () => {
  it('logout 与在飞 refresh 竞态：旧会话数据不得写回 status', async () => {
    scriptAllOk();
    const mgr = newManager();
    await mgr.login('root', 'secret');
    expect(mgr.getStatus().session.kind).toBe('ubus');

    // refresh() 启动 doRefresh，在第一个探测 await 处挂起；此时同步 logout → 世代自增。
    // 无世代守卫时，这轮在飞的观测会把旧会话的 DHCP/无线数据覆盖回 status。
    const pending = mgr.refresh();
    mgr.logout();
    expect(mgr.getStatus().session.kind).toBeNull();
    await pending;

    const s = mgr.getStatus();
    expect({
      leases: s.dhcpLeases.length,
      board: s.systemBoard,
      loggedIn: s.session.loggedIn,
      kind: s.session.kind,
    }).toEqual({ leases: 0, board: null, loggedIn: false, kind: null });

    // 世代自增后的下一轮正常刷新不得"复活"旧数据
    const s2 = await mgr.refresh();
    expect(s2.dhcpLeases).toHaveLength(0);
    expect(s2.session.loggedIn).toBe(false);
    expect(s2.capabilities.openwrt, '能力位粘性不因世代自增回退').toBe(true);
  });

  it('无 logout 的正常 refresh 不受世代守卫影响（回归对照）', async () => {
    scriptAllOk();
    const mgr = newManager();
    await mgr.login('root', 'secret');
    const s = await mgr.refresh();
    expect(s.session.kind).toBe('ubus');
    expect(s.dhcpLeases.length).toBeGreaterThan(0);
    expect(s.systemBoard).not.toBeNull();
  });
});

/**
 * Basic-Auth 通用登录（task-024）：无 ubus 通道的固件（管理页 401 + Basic 质询，
 * 华硕等）的降级路径。锁四条编排层投影：
 *  1) 质询 + 凭据 GET 200 → kind=basic 登录成功，但**不提供任何 ubus 数据**（会话正交）；
 *  2) 质询存在但验证 401 → 错误文案以 Basic 结果为准（不再沿用 ubus 的"用户名或密码"）；
 *  3) 无质询 → 不降级、不发凭据 GET（不把密码泼给表单页），沿用 ubus 文案；
 *  4) logout 全通道登出，basic 会话不残留。
 */
describe('Basic-Auth 通用登录（task-024）', () => {
  /** 401 + WWW-Authenticate: Basic 的管理页探测结果（detect mock 的配置） */
  const BASIC_CHALLENGE = {
    reachable: true,
    brand: null,
    hint: null,
    error: null,
    url: `http://${GW}/`,
    auth: 'basic' as const,
  };

  it('ubus 登录失败 + Basic 质询 + 凭据 GET 200 → kind=basic 登录成功，数据不编造', async () => {
    scriptUbusLoginDead(); // ubus 通道不存在（登录即 -32002）
    h.detectResult = BASIC_CHALLENGE;
    h.basicVerifyResponse = { status: 200, body: '<html>ASUS Router</html>', error: null };

    const mgr = newManager();
    const res = await mgr.login('root', 'secret');
    expect(res.ok, 'Basic 凭据验证通过即登录成功').toBe(true);

    const s = mgr.getStatus();
    expect({
      loggedIn: s.session.loggedIn,
      user: s.session.user,
      kind: s.session.kind,
      error: s.session.error,
    }).toEqual({ loggedIn: true, user: 'root', kind: 'basic', error: null });

    // 数据诚实：basic 会话只提供登录态展示，不提供 ubus 数据 → 全空 + wirelessStatus null
    expect({ leases: s.dhcpLeases, wireless: s.wirelessClients, board: s.systemBoard, wifi: s.wirelessStatus })
      .toEqual({ leases: [], wireless: [], board: null, wifi: null });
    // caps：openwrt 不因 basic 会话置位（能力与会话正交）；管理页可达 → managementPage 置位
    expect({ openwrt: s.capabilities.openwrt, managementPage: s.capabilities.managementPage })
      .toEqual({ openwrt: false, managementPage: true });

    // 凭据验证 GET 确实带上了 Authorization 头，且落在管理页 URL 上
    expect(authGetCount()).toBe(1);
    const authReq = h.requests.find((r) => typeof r.headers?.Authorization === 'string');
    expect(authReq?.headers?.Authorization).toBe(`Basic ${Buffer.from('root:secret').toString('base64')}`);
    expect(authReq?.url).toBe(`http://${GW}/`);
  });

  it('质询存在但凭据 GET 401 → 登录失败，错误以"Basic 认证失败："开头', async () => {
    scriptUbusLoginDead();
    h.detectResult = BASIC_CHALLENGE;
    h.basicVerifyResponse = { status: 401, body: '', error: null };

    const mgr = newManager();
    const res = await mgr.login('root', 'wrong');
    expect(res.ok).toBe(false);
    expect(res.error, 'Basic 质询是这台路由器的实际通道，错误文案以 Basic 结果为准').toMatch(/^Basic 认证失败：/);
    expect(res.error).toContain('401');

    const s = mgr.getStatus();
    expect({ loggedIn: s.session.loggedIn, kind: s.session.kind, user: s.session.user })
      .toEqual({ loggedIn: false, kind: null, user: null });
  });

  it('管理页可达但无 Basic 质询（如表单登录）→ 不降级，沿用 ubus 错误文案', async () => {
    scriptUbusLoginDead();
    h.detectResult = { reachable: true, brand: null, hint: null, error: null, url: `http://${GW}/`, auth: null };

    const mgr = newManager();
    const res = await mgr.login('root', 'secret');
    expect(res.ok).toBe(false);
    expect(res.error, '没有质询就没有 Basic 通道，错误保持 ubus 的 -32002 文案').toContain('用户名或密码');
    expect(authGetCount(), '无 Basic 质询不得发送凭据验证 GET（不把密码泼给表单页）').toBe(0);
    expect(mgr.getStatus().session.loggedIn).toBe(false);
  });

  it('logout() 清除 basic 会话：loggedIn false、kind null，后续 refresh 不复活', async () => {
    scriptUbusLoginDead();
    h.detectResult = BASIC_CHALLENGE;
    h.basicVerifyResponse = { status: 200, body: '<html>ok</html>', error: null };

    const mgr = newManager();
    expect((await mgr.login('root', 'secret')).ok).toBe(true);
    expect(mgr.getStatus().session.kind).toBe('basic');

    mgr.logout();
    const s1 = await mgr.refresh();
    expect({ loggedIn: s1.session.loggedIn, kind: s1.session.kind, user: s1.session.user })
      .toEqual({ loggedIn: false, kind: null, user: null });
  });
});


describe('双通道实时租约与并发边界', () => {
  const webPage = (name: string, ip = '192.168.2.10', mac = 'aa-bb-cc-dd-ee-01') =>
    `<tr><td>${name}</td><td>${mac}</td><td>${ip}</td></tr>`;

  function webManager(): RouterManager {
    const mgr = newManager();
    mgr.markWebSession(true);
    mgr.setWebLeaseProvider(async () => 'session=test');
    return mgr;
  }

  it('ubus 名称优先；同 MAC/IP 缺名由 web 补充，不同 IP 不串名', async () => {
    scriptAllOk();
    const base = h.script!;
    const mgr = webManager();
    h.webPage = webPage('web-name');
    await mgr.login('root', 'secret');
    expect(mgr.getStatus().dhcpLeases[0]?.hostname).toBe('pc-1');
    h.script = (parsed, seq) => (parsed.params as unknown[])[2] === 'getDHCPLeases'
      ? rpcOk(parsed.id, [0, { dhcp_leases: [{ ipaddr: '192.168.2.10', macaddr: 'AA:BB:CC:DD:EE:01', hostname: '*', expires: -1 }] }])
      : base(parsed, seq);
    await mgr.refresh();
    expect(mgr.getStatus().dhcpLeases[0]?.hostname).toBe('web-name');
    h.webPage = webPage('old-device', '192.168.2.99');
    await mgr.refresh();
    expect(mgr.getStatus().dhcpLeases).toHaveLength(1);
    expect(mgr.getStatus().dhcpLeases[0]?.hostname).toBeNull();
  });

  it('ubus ACL 失败或会话过期时，web 租约独立可用；过期状态仍可见', async () => {
    scriptAllOk();
    const base = h.script!;
    h.script = (parsed, seq) => (parsed.params as unknown[])[2] === 'getDHCPLeases'
      ? rpcOk(parsed.id, [6, {}]) : base(parsed, seq);
    const mgr = webManager();
    h.webPage = webPage('phone');
    await mgr.login('root', 'secret');
    expect(mgr.getStatus().session.kind).toBe('ubus');
    expect(mgr.getStatus().dhcpLeases[0]?.hostname).toBe('phone');
    h.script = (parsed) => rpcErr(parsed.id, -32002);
    await mgr.refresh();
    expect(mgr.getStatus().session.kind).toBe('web');
    expect(mgr.getStatus().session.invalidatedAt).not.toBeNull();
    expect(mgr.getStatus().dhcpLeases[0]?.hostname).toBe('phone');
    expect(mgr.getStatus().wirelessClients).toEqual([]);
  });

  it('识别为 OpenWrt 但仅管理页登录时，仍尝试 web 通道', async () => {
    h.detectResult = { reachable: true, brand: 'openwrt', hint: null, error: null, url: `http://${GW}/`, auth: null };
    h.webPage = webPage('openwrt-web');
    const mgr = webManager();
    await mgr.refresh();
    expect(mgr.getStatus().dhcpLeases[0]?.hostname).toBe('openwrt-web');
    expect(ubusCallCount()).toBe(0);
  });

  it('web 失败清除上轮名称，退避后成功自动恢复', async () => {
    vi.useFakeTimers();
    try {
      const mgr = webManager();
      h.webPage = webPage('phone');
      await mgr.refresh();
      expect(mgr.getStatus().dhcpLeases).toHaveLength(1);
      h.webPage = null;
      await mgr.refresh();
      expect(mgr.getStatus().dhcpLeases).toEqual([]);
      h.webPage = webPage('renewed');
      await mgr.refresh();
      expect(mgr.getStatus().dhcpLeases).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_000);
      await mgr.refresh();
      expect(mgr.getStatus().dhcpLeases[0]?.hostname).toBe('renewed');
    } finally { vi.useRealTimers(); }
  });

  it('并发 refresh 共享同一个 Promise 和本轮结果，不立即返回旧帧', async () => {
    const gate = Promise.withResolvers<void>();
    h.detectGate = gate.promise;
    const mgr = newManager();
    const first = mgr.refresh();
    const second = mgr.refresh();
    expect(first).toBe(second);
    const done = vi.fn();
    void second.then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    gate.resolve();
    expect(await first).toBe(await second);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('租约推送不等待 WAN 探测；手动刷新与 logout 即时通知', async () => {
    scriptAllOk();
    const mgr = newManager();
    await mgr.login('root', 'secret');
    const gate = Promise.withResolvers<void>();
    const pushed = Promise.withResolvers<void>();
    h.upnpGate = gate.promise;
    const updates = vi.fn((status) => { if (status.dhcpLeases.length > 0) pushed.resolve(); });
    mgr.startPolling(updates);
    try {
      const pending = mgr.refresh();
      const done = vi.fn();
      void pending.then(done);
      await pushed.promise;
      expect(done).not.toHaveBeenCalled();
      mgr.logout();
      expect(updates.mock.lastCall?.[0].dhcpLeases).toEqual([]);
      gate.resolve();
      await pending;
      expect(updates.mock.lastCall?.[0].session.loggedIn).toBe(false);
    } finally { gate.resolve(); mgr.stopPolling(); }
  });

  it('在飞登录或登录后刷新期间 logout，返回取消且不恢复会话', async () => {
    scriptAllOk();
    const mgr = newManager();
    const gate = Promise.withResolvers<void>();
    h.rpcGate = gate.promise;
    const pending = mgr.login('root', 'secret');
    mgr.logout();
    gate.resolve();
    expect((await pending).ok).toBe(false);
    expect(mgr.getStatus().session.loggedIn).toBe(false);
    h.rpcGate = null;
    const wan = Promise.withResolvers<void>();
    h.upnpGate = wan.promise;
    const authenticated = Promise.withResolvers<void>();
    mgr.startPolling((status) => { if (status.session.loggedIn) authenticated.resolve(); });
    try {
      const next = mgr.login('root', 'secret');
      await authenticated.promise;
      mgr.logout();
      wan.resolve();
      expect((await next).ok).toBe(false);
    } finally { wan.resolve(); mgr.stopPolling(); }
  });

  it('网关改变清除旧客户端、租约和能力，不向新网关复用凭据', async () => {
    scriptAllOk();
    let gateway: string | null = GW;
    const mgr = new RouterManager({ getGateway: () => gateway });
    await mgr.login('root', 'secret');
    const before = ubusCallCount();
    gateway = '192.168.3.1';
    await mgr.refresh();
    expect(ubusCallCount()).toBe(before);
    expect(mgr.getStatus().identity?.ip).toBe(gateway);
    expect(mgr.getStatus().dhcpLeases).toEqual([]);
    expect(mgr.getStatus().session.loggedIn).toBe(false);
    expect(mgr.getStatus().capabilities.openwrt).toBe(false);
    gateway = null;
    await mgr.refresh();
    expect(mgr.getStatus().phase).toBe('unreachable');
  });

  it('登录发生于旧刷新期间时，合并等待后补新会话刷新', async () => {
    scriptAllOk();
    const mgr = newManager();
    const gate = Promise.withResolvers<void>();
    h.detectGate = gate.promise;
    const oldRefresh = mgr.refresh();
    const login = mgr.login('root', 'secret');
    await Promise.resolve();
    gate.resolve();
    await oldRefresh;
    expect((await login).ok).toBe(true);
    expect(mgr.getStatus().dhcpLeases[0]?.hostname).toBe('pc-1');
  });

  it('管理页会话变化不取消在飞 ubus 登录', async () => {
    scriptAllOk();
    const mgr = newManager();
    const gate = Promise.withResolvers<void>();
    h.rpcGate = gate.promise;
    const pending = mgr.login('root', 'secret');
    mgr.markWebSession(true);
    gate.resolve();
    expect((await pending).ok).toBe(true);
    expect(mgr.getStatus().session.kind).toBe('ubus');
    expect(mgr.getStatus().dhcpLeases[0]?.hostname).toBe('pc-1');
  });

  it('管理页退出不丢弃在飞 ubus 会话失效证据', async () => {
    scriptAllOk();
    const mgr = webManager();
    await mgr.login('root', 'secret');
    const gate = Promise.withResolvers<void>();
    h.rpcGate = gate.promise;
    scriptSessionDead();
    const pending = mgr.refresh();
    mgr.markWebSession(false);
    gate.resolve();
    await pending;
    expect(mgr.getStatus().session.invalidatedAt).not.toBeNull();
    expect(mgr.getStatus().session.loggedIn).toBe(false);
    expect(mgr.getStatus().dhcpLeases).toEqual([]);
  });

  it('新登录刷新不等待旧轮 WAN，旧轮完成不清除新轮 Promise', async () => {
    scriptAllOk();
    const mgr = newManager();
    const oldWan = Promise.withResolvers<void>();
    const newWan = Promise.withResolvers<void>();
    const pushed = Promise.withResolvers<void>();
    h.upnpGate = oldWan.promise;
    const oldRefresh = mgr.refresh();
    h.upnpGate = newWan.promise;
    mgr.startPolling((status) => { if (status.dhcpLeases.length > 0) pushed.resolve(); });
    try {
      const login = mgr.login('root', 'secret');
      await pushed.promise;
      expect(mgr.getStatus().dhcpLeases[0]?.hostname).toBe('pc-1');
      const currentRefresh = mgr.refresh();
      oldWan.resolve();
      await oldRefresh;
      expect(mgr.refresh()).toBe(currentRefresh);
      newWan.resolve();
      expect((await login).ok).toBe(true);
      await currentRefresh;
    } finally { oldWan.resolve(); newWan.resolve(); mgr.stopPolling(); }
  });

  it('退出后迟到 Cookie 不启动管理页请求', async () => {
    const mgr = newManager();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<string | null>();
    mgr.setWebLeaseProvider(() => { entered.resolve(); return gate.promise; });
    mgr.markWebSession(true);
    const pending = mgr.refresh();
    await entered.promise;
    mgr.logout();
    gate.resolve('session=late');
    await pending;
    expect(h.requests.filter((request) => request.headers?.Cookie)).toEqual([]);
    expect(mgr.getStatus().dhcpLeases).toEqual([]);
  });

  it('web 已完成但 ubus 仍等待时换会话，旧 web 租约不得重新写回', async () => {
    scriptAllOk();
    const mgr = webManager();
    await mgr.login('root', 'secret');
    const rpcGate = Promise.withResolvers<void>();
    h.rpcGate = rpcGate.promise;
    const response = Promise.withResolvers<webLeases.WebLeaseResult>();
    const fetch = vi.spyOn(webLeases, 'fetchWebLeases').mockReturnValueOnce(response.promise);
    try {
      mgr.markWebSession(false);
      mgr.markWebSession(true);
      const pending = mgr.refresh();
      response.resolve({ ok: true, leases: [{ ip: '192.168.2.20', mac: 'aa-bb-cc-dd-ee-02', hostname: 'old-web', expiresAt: null }], note: 'old-web-note' });
      await response.promise;
      mgr.markWebSession(false);
      mgr.markWebSession(true);
      rpcGate.resolve();
      await pending;
      expect(mgr.getStatus().dhcpLeases.map((lease) => lease.hostname)).toEqual(['pc-1']);
      expect(mgr.getStatus().capabilityNotes).not.toContain('old-web-note');
    } finally { rpcGate.resolve(); fetch.mockRestore(); }
  });

  it('管理页退出立即撤销 web 补名，保留 ubus 会话和数据', async () => {
    scriptAllOk();
    const mgr = webManager();
    h.webPage = webPage('web-only', '192.168.2.20', 'aa-bb-cc-dd-ee-02');
    await mgr.login('root', 'secret');
    expect(mgr.getStatus().dhcpLeases).toHaveLength(2);
    mgr.markWebSession(false);
    expect(mgr.getStatus().session.kind).toBe('ubus');
    expect(mgr.getStatus().dhcpLeases.map((lease) => lease.hostname)).toEqual(['pc-1']);
  });

  it('轮询检查 Cookie 到期，主动退出后不再自动检测并复活旧 Cookie', async () => {
    vi.useFakeTimers();
    const mgr = webManager();
    const check = vi.fn(async () => mgr.markWebSession(false));
    const update = vi.fn();
    mgr.startPolling(update, check);
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(check).toHaveBeenCalledTimes(1);
      expect(mgr.hasWebSession()).toBe(false);
      expect(update.mock.lastCall?.[0].session.loggedIn).toBe(false);
      mgr.logout();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(check).toHaveBeenCalledTimes(1);
    } finally { mgr.stopPolling(); vi.useRealTimers(); }
  });

  it('租约提前推帧时保留尚未完成的 WAN 能力证据', async () => {
    const mgr = newManager();
    mgr.getStatus().capabilities.upnp = true;
    const gate = Promise.withResolvers<void>();
    const pushed = Promise.withResolvers<void>();
    h.upnpGate = gate.promise;
    mgr.startPolling(() => pushed.resolve());
    try {
      const pending = mgr.refresh();
      await pushed.promise;
      expect(mgr.getStatus().capabilities.upnp).toBe(true);
      gate.resolve();
      expect((await pending).capabilities.upnp).toBe(false);
    } finally { gate.resolve(); mgr.stopPolling(); }
  });

  it('WAN 慢响应期间租约到期，最终状态不得重新推回过期租约', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    const gate = Promise.withResolvers<void>();
    try {
      scriptAllOk();
      await mgr.login('root', 'secret');
      const base = h.script!;
      h.script = (parsed, seq) => (parsed.params as unknown[])[2] === 'getDHCPLeases'
        ? rpcOk(parsed.id, [0, { dhcp_leases: [{ ipaddr: '192.168.2.10', macaddr: 'AA:BB:CC:DD:EE:01', hostname: 'short-lease', expires: 1 }] }])
        : base(parsed, seq);
      h.upnpGate = gate.promise;
      const pushed = Promise.withResolvers<void>();
      mgr.startPolling((status) => { if (status.dhcpLeases[0]?.hostname === 'short-lease') pushed.resolve(); });
      const pending = mgr.refresh();
      await pushed.promise;
      vi.setSystemTime(Date.now() + 1_001);
      gate.resolve();
      expect((await pending).dhcpLeases).toEqual([]);
    } finally { gate.resolve(); mgr.stopPolling(); vi.useRealTimers(); }
  });

  it('停止轮询后在飞检查完成，不再发送刷新或推送', async () => {
    vi.useFakeTimers();
    const mgr = webManager();
    const gate = Promise.withResolvers<void>();
    const check = vi.fn(() => gate.promise);
    const update = vi.fn();
    mgr.startPolling(update, check);
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(check).toHaveBeenCalledTimes(1);
      mgr.stopPolling();
      gate.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(update).not.toHaveBeenCalled();
      expect(h.requests).toEqual([]);
    } finally { gate.resolve(); mgr.stopPolling(); vi.useRealTimers(); }
  });
});
