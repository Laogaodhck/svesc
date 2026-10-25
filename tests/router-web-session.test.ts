/**
 * RouterManager 管理页会话（内置浏览器登录）编排层断言。
 *
 * 背景：路由器登录原来只有 OpenWrt ubus 一条路，非 OpenWrt 固件登录必然
 * POST /ubus → HTTP 404。改造后新增"内置浏览器登录"通道：主进程 BrowserWindow
 * 打开管理页，Cookie 监视器回调 router.markWebSession(true)。
 *
 * 本文件锁死编排层的可观测行为：
 *  1) markWebSession 建立的是 kind='web' 的会话，不碰 caps.openwrt（能力位不得撒谎）；
 *  2) refresh 轮询不得把 web 会话打回未登录（正交合成：ubus 优先，web 独立存续）；
 *  3) ubus 登录失败不得清掉已建立的 web 会话；
 *  4) logout 同时清两种会话；管理页探测 URL 粘性保留进 identity.adminUrl；
 *  5) B-2 自动重登状态机（task-022）：invalidatedAt 生命周期（唯一置位来源 =
 *     -32002 观测，唯一清除 = 重登成功/logout）、scheduleRelogin 幂等、
 *     退避 60s×2ⁿ 封顶 10min、3 次失败停用、provider null 静默停不计失败、
 *     logout 取消挂起 timer。
 *
 * electron 侧（BrowserWindow/Cookie 监视）不在此覆盖——engine 层铁律是不 import
 * electron，router-browser.ts 是薄胶水，行为由真机验证。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; body: string }>,
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
    // 模拟 TP-Link 家用固件：管理页可达（302 落点 /login），无 ubus 端点
    detectManagementPage: async () => ({
      reachable: true,
      brand: 'tplink' as const,
      hint: 'TP-Link',
      error: null,
      url: 'http://192.168.2.1/login.html',
    }),
  };
});

vi.mock('../src/main/engine/router/upnp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/router/upnp')>();
  return {
    ...actual,
    ssdpDiscover: async () => null,
    upnpQuery: async () => null,
  };
});

import { RouterManager } from '../src/main/engine/router/index';

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

function scriptAllOk(): void {
  h.script = (parsed, _seq) => {
    const p = parsed.params as unknown[];
    if (isLogin(parsed)) return rpcOk(parsed.id, [0, { ubus_rpc_session: 'S1', timeout: 3600 }]);
    if (p[1] === 'system' && p[2] === 'board') return rpcOk(parsed.id, [0, { hostname: 'OpenWrt', model: 'x86-64', release: { description: 'OpenWrt 23.05' }, uptime: 1 }]);
    if (p[1] === 'luci-rpc' && p[2] === 'getDHCPLeases') return rpcOk(parsed.id, [0, { dhcp_leases: [] }]);
    if (p[1] === 'luci-rpc' && p[2] === 'getWirelessDevices') return rpcOk(parsed.id, [0, { radios: {} }]);
    throw new Error('脚本未识别调用: ' + JSON.stringify(p));
  };
}

const GW = '192.168.2.1';
const newManager = (): RouterManager => new RouterManager({ getGateway: () => GW });

beforeEach(() => {
  h.requests.length = 0;
  h.script = null;
});

describe('RouterManager 管理页会话（内置浏览器登录）', () => {
  it('markWebSession(true) → kind="web" 的已登录会话，不碰 caps.openwrt；refresh 后依旧', async () => {
    const mgr = newManager();
    mgr.markWebSession(true);

    const s0 = mgr.getStatus();
    expect(s0.session).toEqual({ loggedIn: true, user: null, error: null, kind: 'web', invalidatedAt: null });
    expect(s0.capabilities.openwrt, '管理页会话拿不到 ubus 数据，caps.openwrt 必须保持 false（能力位不得撒谎）').toBe(false);

    const s1 = await mgr.refresh();
    expect(s1.session.kind).toBe('web');
    expect(s1.session.loggedIn).toBe(true);
    // 管理页探测到的落点 URL 必须进 identity（内置浏览器第二次打开直接用它）
    expect(s1.identity?.adminUrl).toBe('http://192.168.2.1/login.html');
  });

  it('web 会话存续期间 ubus 登录失败 → web 会话不得被打回未登录，失败原因可见', async () => {
    const mgr = newManager();
    mgr.markWebSession(true);

    // ubus 登录被拒（-32002 = 用户名或密码错误，或非 OpenWrt 固件走不到 200）
    h.script = (parsed) => (isLogin(parsed) ? rpcErr(parsed.id, -32002) : rpcOk(parsed.id, [0, {}]));
    const res = await mgr.login('root', 'wrong');
    expect(res.ok).toBe(false);

    const s = mgr.getStatus();
    expect(s.session.kind, '两种会话正交：ubus 登录失败不构成"管理页未登录"的证据').toBe('web');
    expect(s.session.loggedIn).toBe(true);
    expect(s.session.error).toBe('用户名或密码错误');
  });

  it('ubus 登录成功 → 会话切换为 kind="ubus" 且带用户名；logout 双清', async () => {
    scriptAllOk();
    const mgr = newManager();
    mgr.markWebSession(true);

    const res = await mgr.login('root', 'secret');
    expect(res.ok).toBe(true);
    const s1 = mgr.getStatus();
    expect(s1.session).toEqual({ loggedIn: true, user: 'root', error: null, kind: 'ubus', invalidatedAt: null });

    mgr.logout();
    const s2 = mgr.getStatus();
    expect(s2.session).toEqual({ loggedIn: false, user: null, error: null, kind: null, invalidatedAt: null });
    // 能力位粘性不变：管理页仍可达
    expect(s2.capabilities.managementPage).toBe(true);
  });

  it('markWebSession(false) 只清 web 会话，不动已登录的 ubus 会话', async () => {
    scriptAllOk();
    const mgr = newManager();
    await mgr.login('root', 'secret');
    mgr.markWebSession(false);

    const s = mgr.getStatus();
    expect(s.session.kind).toBe('ubus');
    expect(s.session.loggedIn).toBe(true);
    expect(s.session.user).toBe('root');
  });
});

describe('B-2 会话失效自动重登状态机（task-022）', () => {
  const T0 = 1_700_000_000_000;

  /** 数据调用全部 -32002（会话被服务端作废）；login 仍可成功（方便重登后继续造失效）。 */
  function scriptInvalidate(): void {
    h.script = (parsed) => (isLogin(parsed) ? rpcOk(parsed.id, [0, { ubus_rpc_session: 'S1', timeout: 3600 }]) : rpcErr(parsed.id, -32002));
  }
  /** 全部调用 -32002：login 路径 -32002 = 密码错误（自动重登失败场景）。 */
  function scriptAllFail(): void {
    h.script = (parsed) => rpcErr(parsed.id, -32002);
  }

  /** 登录成功 → 一轮数据调用失效：得到 invalidatedAt=T0 的粘性失效态。 */
  async function invalidatedManager(): Promise<RouterManager> {
    const mgr = newManager();
    scriptAllOk();
    await mgr.login('root', 'secret');
    scriptInvalidate();
    await mgr.refresh();
    return mgr;
  }

  beforeEach(() => {
    h.requests.length = 0;
    h.script = null;
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('invalidatedAt 生命周期：失效轮置位为观测时刻，跨轮粘性保留（无调用轮不清除）', async () => {
    const mgr = await invalidatedManager();
    let s = mgr.getStatus();
    expect(s.session.invalidatedAt, '失效轮必须记下 -32002 的观测时刻').toBe(T0);
    expect(s.session.error).toBe('路由器会话已过期，请重新登录');
    expect(s.session.loggedIn, '-32002 后客户端已自清会话，不得投影成假已登录').toBe(false);

    // 下一轮轮询（10s 后）：ubus 已死不会发数据调用，sessionInvalid=false，
    // invalidatedAt 必须原样沿用——既不新增也不清除
    vi.advanceTimersByTime(10_000);
    await mgr.refresh();
    s = mgr.getStatus();
    expect(s.session.invalidatedAt, '普通轮询不得清除 invalidatedAt（粘性）').toBe(T0);
    expect(s.session.error, '失效提示必须持续到重新登录，不得下一轮就被冲掉').toBe('路由器会话已过期，请重新登录');
  });

  it('瞬时故障（HTTP 500）不得写 invalidatedAt：只有 -32002 算会话失效', async () => {
    const mgr = newManager();
    scriptAllOk();
    await mgr.login('root', 'secret');

    h.script = (parsed) => (isLogin(parsed) ? rpcOk(parsed.id, [0, { ubus_rpc_session: 'S1', timeout: 3600 }]) : { status: 500, body: 'oops', error: null });
    await mgr.refresh();
    const s = mgr.getStatus();
    expect(s.session.invalidatedAt, '服务器 500 是瞬时故障，写 invalidatedAt 会触发一轮无谓的自动重登').toBe(null);
    expect(s.session.error, '瞬时故障不是会话失效，不得挂"会话已过期"文案').toBe(null);
  });

  it('清除时机：重新登录成功 → null；logout → null；login 失败 → 粘性保留', async () => {
    // login 失败（凭据错）不清：不改变"曾被服务端作废"的事实
    const mgr = await invalidatedManager();
    scriptAllFail();
    const bad = await mgr.login('root', 'wrong');
    expect(bad.ok).toBe(false);
    expect(mgr.getStatus().session.invalidatedAt, 'login 失败不得清 invalidatedAt').toBe(T0);

    // 手动登录成功是唯一合法清除路径之一
    scriptAllOk();
    const good = await mgr.login('root', 'secret');
    expect(good.ok).toBe(true);
    expect(mgr.getStatus().session.invalidatedAt, '重新登录成功必须清 invalidatedAt').toBe(null);

    // logout 是另一个唯一合法清除路径
    scriptInvalidate();
    await mgr.refresh();
    expect(mgr.getStatus().session.invalidatedAt).toBe(Date.now());
    mgr.logout();
    expect(mgr.getStatus().session.invalidatedAt, 'logout 必须清 invalidatedAt').toBe(null);
  });

  it('幂等：失效后每轮轮询都触发 scheduleRelogin，timer 不得叠加（10 次调用只重登 1 次）', async () => {
    const mgr = await invalidatedManager();
    const provider = vi.fn(async () => null);
    mgr.setAutoRelogin(provider);

    // 主进程轮询回调每轮都会调（invalidatedAt 粘性）：10 轮 × scheduleRelogin
    for (let i = 0; i < 10; i += 1) mgr.scheduleRelogin();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider, 'timer 叠加会变成重登风暴：10 次调度只允许 1 次 provider 读凭据').toHaveBeenCalledTimes(1);
  });

  it('退避序列 60s→120s→240s（失败时刻自续挂出），第 3 次失败停用并挂出文案，此后不再调度', async () => {
    const mgr = await invalidatedManager();
    scriptAllFail(); // 重登的 login 也失败（密码错）
    const provider = vi.fn(async () => ({ user: 'root', password: 'bad' }));
    mgr.setAutoRelogin(provider);
    mgr.scheduleRelogin();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(provider, '第 1 跳必须是 60s（failures=0）').toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider).toHaveBeenCalledTimes(1); // 失败，failures=1 → 失败时刻立即自续挂出 120s（新语义，无轮询漂移）

    // 中间插入轮询触发：timer 挂起期间 scheduleRelogin 必须被幂等守卫拦截
    //（不推迟、不重挂——否则退避起点漂移甚至活锁）
    await vi.advanceTimersByTimeAsync(10_000);
    mgr.scheduleRelogin();

    await vi.advanceTimersByTimeAsync(109_999);
    expect(provider, '第 2 跳必须在 180s（60+120，60×2¹）：120s 内不得重试').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider).toHaveBeenCalledTimes(2); // failures=2 → 自续挂出 240s

    await vi.advanceTimersByTimeAsync(10_000);
    mgr.scheduleRelogin();

    await vi.advanceTimersByTimeAsync(229_999);
    expect(provider, '第 3 跳必须在 420s（180+240，60×2²）').toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider).toHaveBeenCalledTimes(3); // failures=3 → 停用

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    mgr.scheduleRelogin(); // 停用后轮询仍每轮触发
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(provider, '3 次失败后必须永久停用（本进程内），不得继续重登风暴').toHaveBeenCalledTimes(3);

    expect(mgr.getStatus().session.error, '停用原因必须可见，绝不静默空转').toBe('已停止自动重登（凭据可能已失效），请手动登录');
  });

  it('纯内部调度零轮询：失败后不靠任何轮询，三跳自续（60s→120s→240s）直到 3 次停用', async () => {
    // 锁死修复语义：runRelogin 在 finally 清 inFlight 后必须自续下一跳，
    // 引擎层退避链自身闭环，不依赖主进程轮询续命（修复前第二跳永远挂不出）。
    const mgr = await invalidatedManager();
    scriptAllFail();
    const provider = vi.fn(async () => ({ user: 'root', password: 'bad' }));
    mgr.setAutoRelogin(provider);
    mgr.scheduleRelogin(); // 全程唯一一次外部触发

    await vi.advanceTimersByTimeAsync(60_000); // 跳1 @60s → 失败 failures=1 → 自续 120s
    expect(provider).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(provider, '第二跳必须自续挂出：60s 失败后 120s 内（无任何轮询介入）不得重试，120s 整必须重试').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 跳2 @180s → 失败 failures=2 → 自续 240s
    expect(provider).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(239_999);
    expect(provider, '第三跳必须自续挂出：180s 失败后 240s 内不得重试').toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // 跳3 @420s → 失败 failures=3 → 停用
    expect(provider).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(provider, '停用后内部不再自续').toHaveBeenCalledTimes(3);
    expect(mgr.getStatus().session.error).toBe('已停止自动重登（凭据可能已失效），请手动登录');
  });

  it('重登成功：ubus 会话恢复、invalidatedAt 清 null、退避计数清零', async () => {
    const mgr = await invalidatedManager();
    const provider = vi.fn(async () => ({ user: 'root', password: 'secret' }));
    mgr.setAutoRelogin(provider);
    mgr.scheduleRelogin();

    scriptAllOk();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider).toHaveBeenCalledTimes(1);
    const s = mgr.getStatus();
    expect(s.session.loggedIn, '重登成功后 ubus 会话必须恢复').toBe(true);
    expect(s.session.user).toBe('root');
    expect(s.session.invalidatedAt, '重登成功清 invalidatedAt').toBe(null);
    expect(s.session.error).toBe(null);

    // 已恢复：继续 advance 不得再触发任何重登
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('provider 返回 null（记住密码已关）→ 静默停用不计失败：下一跳仍是 60s', async () => {
    const mgr = await invalidatedManager();
    const provider = vi.fn(async () => null);
    mgr.setAutoRelogin(provider);
    mgr.scheduleRelogin();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(provider, '用户关闭开关 = 退出重登，静默停不得再挂 timer').toHaveBeenCalledTimes(1);
    expect(mgr.getStatus().session.error, '静默停不是失败：不得新增停用/失败文案（过期提示粘性沿用是既有语义）').toBe('路由器会话已过期，请重新登录');

    // 证明"不计失败"：换回有效 provider 后再调度，第一跳仍是 60s 起步
    //（若 null 那次被计入 failures，退避会变 120s，60s 时刻不会触发）
    scriptAllOk();
    const resumed = vi.fn(async () => ({ user: 'root', password: 'secret' }));
    mgr.setAutoRelogin(resumed);
    mgr.scheduleRelogin();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(resumed, '退避从 0 起算（null 未计失败）：60s 时刻不得已触发').toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(mgr.getStatus().session.loggedIn, '重登成功恢复会话').toBe(true);
  });

  it('logout 取消挂起的重登 timer（主动退出 ≠ 会话失效，重登违背用户意图）', async () => {
    const mgr = await invalidatedManager();
    const provider = vi.fn(async () => ({ user: 'root', password: 'secret' }));
    mgr.setAutoRelogin(provider);
    mgr.scheduleRelogin();

    mgr.logout();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(provider, 'logout 后挂起的重登必须被取消，绝不背着用户的退出意愿自动登录').toHaveBeenCalledTimes(0);
  });

  it('3 次失败停用后，手动登录成功即复活：计数清零、下一跳回到 60s 起步', async () => {
    const mgr = await invalidatedManager();
    scriptAllFail();
    mgr.setAutoRelogin(async () => ({ user: 'root', password: 'bad' }));
    mgr.scheduleRelogin();
    // 三跳全部走完：失败时刻自续挂出下一跳（新语义）；中间轮询调用被幂等守卫拦截
    await vi.advanceTimersByTimeAsync(60_000); // 跳1 @60s → failures=1，自续 120s
    await vi.advanceTimersByTimeAsync(10_000);
    mgr.scheduleRelogin();
    await vi.advanceTimersByTimeAsync(120_000); // 跳2 @180s → failures=2，自续 240s
    await vi.advanceTimersByTimeAsync(10_000);
    mgr.scheduleRelogin();
    await vi.advanceTimersByTimeAsync(240_000); // 跳3 @420s → failures=3 → 停用
    expect(mgr.getStatus().session.error, '前置：已进入停用态').toBe('已停止自动重登（凭据可能已失效），请手动登录');

    // 用户手动登录成功 → reloginFailures 归零
    scriptAllOk();
    await mgr.login('root', 'secret');
    expect(mgr.getStatus().session.loggedIn).toBe(true);

    // 再次失效 → 重登第一跳必须回到 60s（计数已清），并成功恢复
    scriptInvalidate();
    await mgr.refresh();
    const second = vi.fn(async () => ({ user: 'root', password: 'secret' }));
    mgr.setAutoRelogin(second);
    mgr.scheduleRelogin();
    scriptAllOk();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(second, '停用后手动登录必须复活计数：60s 时刻不得已触发').toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(mgr.getStatus().session.loggedIn, '复活后的重登必须成功').toBe(true);
  });
});
