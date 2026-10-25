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
  /** 所有到达 httpx 的请求（含 UPnP 描述页直查） */
  requests: [] as Array<{ url: string; body: string }>,
  /** 每个 JSON-RPC 请求的应答脚本；返回 null 表示"脚本没覆盖到"，测试会立刻炸 */
  script: null as null | ((parsed: Record<string, unknown>, seq: number) => { status: number | null; body: string; error: string | null }),
}));

vi.mock('../src/main/engine/router/httpx', () => ({
  httpRequest: async (url: string, opts: { body?: string }) => {
    const body = opts?.body ?? '';
    h.requests.push({ url, body });
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    // 非 JSON-RPC（UPnP description.xml 直查兜底）→ 模拟不可达
    if (!parsed || parsed.method !== 'call') {
      return { status: null, body: '', error: 'mock: 非 ubus 请求' };
    }
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
    // 管理页探测恒不可达：identity.brand 保持 null，避免走 openwrt 提示分支干扰
    detectManagementPage: async () => ({ reachable: false, error: 'mock: 探测关闭' }),
  };
});

vi.mock('../src/main/engine/router/upnp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/router/upnp')>();
  return {
    ...actual,
    // SSDP 与 UPnP 查询恒无结果：probeUpnp 走 descPaths 直查（被 httpx mock 挡下）
    ssdpDiscover: async () => null,
    upnpQuery: async () => null,
  };
});

import { RouterManager } from '../src/main/engine/router/index';

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
    throw new Error('脚本未识别调用: ' + JSON.stringify(p));
  };
}

/** 登录成功 + 三个数据调用全部 -32002（会话被撤销/过期） */
function scriptSessionDead(): void {
  h.script = (parsed) => (isLogin(parsed) ? rpcOk(parsed.id, [0, { ubus_rpc_session: 'S1' }]) : rpcErr(parsed.id, -32002));
}

/** 到达 httpx 的 JSON-RPC 请求数（排除 UPnP 描述页直查） */
function ubusCallCount(): number {
  return h.requests.filter((r) => r.body.includes('"method":"call"')).length;
}

const GW = '192.168.2.1';
function newManager(): RouterManager {
  return new RouterManager({ getGateway: () => GW });
}

beforeEach(() => {
  h.requests.length = 0;
  h.script = null;
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
