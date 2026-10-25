/**
 * OpenWrt ubus JSON-RPC 通道（POST /ubus）。
 *
 * transport 注入式设计：网络出口独立成函数，vitest 直接替换，不必 mock node:http。
 * 数据诚实原则：任何解析失败都返回 { ok:false, error }，绝不编造空结构以外的数据。
 */
import { ROUTER } from '../../../shared/constants';
import { httpRequest } from './httpx';
import type { DhcpLease, WirelessBandStatus, WirelessClient } from '../../../shared/types';

export interface RpcResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

export type Transport = (
  url: string,
  body: string,
  timeoutMs: number,
) => Promise<{ status: number | null; body: string; error: string | null }>;

const defaultTransport: Transport = async (url, body, timeoutMs) => {
  const u = new URL(url);
  const res = await httpRequest(url, {
    port: Number(u.port) || 80,
    path: u.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    timeoutMs,
  });
  return { status: res.status, body: res.body, error: res.error };
};

/**
 * ubus null-session（32 位零）：uhttpd 的 `uh_ubus_allowed` 只接受这种 sid 调
 * `session.login`（官方语义 "just has enough access rights for the session.login call"）。
 * 若发字面量 `'session'`，它会被当成一个不存在的会话 → 一律 -32002 Access denied，
 * 真机登录必然失败，且错误文案与"密码错误"无法区分。
 */
export const UBUS_NULL_SESSION = '0'.repeat(32);

/**
 * ubus 标准错误码 → 文案。
 * `context` 必须区分路径：-32002 在登录路径表示"用户名或密码错误"，
 * 在调用路径表示"会话无效/过期/无权"（官方文档明确同一码两种含义）。
 */
export function ubusErrorMessage(code: number, context: 'login' | 'call' = 'login'): string {
  switch (code) {
    case -32000:
      return '方法不存在（该固件未编译此 ubus 对象）';
    case -32002:
      return context === 'login' ? '用户名或密码错误' : '会话已过期或无权限，请重新登录';
    case 6:
      return '权限被拒绝（UBUS_STATUS_PERMISSION_DENIED）';
    case -1:
      // 真实 ubus 不返回此码；为兼容旧行为与既有断言保留
      return '无权访问（真实 ubus 不返回此码，兼容保留）';
    case -2:
      return '参数无效';
    default:
      return `ubus 错误码 ${code}`;
  }
}

/** 组装 JSON-RPC 请求体（纯函数）。 */
export function buildRpcRequest(params: unknown[], id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'call', params });
}

export interface BoardInfo {
  hostname: string | null;
  model: string | null;
  firmware: string | null;
  uptimeSec: number | null;
}

/** 解析 `system board` 响应（纯函数；形状不符 → null，不猜）。 */
export function parseBoard(payload: unknown): BoardInfo | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const release = typeof p.release === 'object' && p.release !== null ? (p.release as Record<string, unknown>) : {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    hostname: str(p.hostname),
    model: str(p.model),
    firmware: str(release.description) ?? str(release.version),
    uptimeSec: typeof p.uptime === 'number' && p.uptime >= 0 ? p.uptime : null,
  };
}

/** 解析 `luci-rpc getDHCPLeases` 响应（纯函数；不认识形状就返回 []）。 */
export function parseDhcpLeases(payload: unknown): DhcpLease[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const list = (payload as Record<string, unknown>).dhcp_leases;
  if (!Array.isArray(list)) return [];
  const now = Date.now();
  const out: DhcpLease[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const l = item as Record<string, unknown>;
    const ip = typeof l.ipaddr === 'string' ? l.ipaddr : null;
    const mac = typeof l.macaddr === 'string' ? l.macaddr : null;
    if (!ip || !mac) continue; // 缺关键字段的条目直接丢弃，绝不补造
    // expires <= 0（-1 = 无限租期）→ null；正数秒 → 到期时间
    const expires = typeof l.expires === 'number' && l.expires > 0 ? now + l.expires * 1000 : null;
    out.push({
      ip,
      mac,
      hostname: typeof l.hostname === 'string' && l.hostname.length > 0 ? l.hostname : null,
      expiresAt: expires,
    });
  }
  return out;
}

/** 解析 `luci-rpc getWirelessDevices` 响应（纯函数；形状防御到底）。 */
export function parseWirelessDevices(payload: unknown): WirelessClient[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const radios = (payload as Record<string, unknown>).radios;
  if (typeof radios !== 'object' || radios === null) return [];
  const out: WirelessClient[] = [];
  for (const radio of Object.values(radios as Record<string, unknown>)) {
    if (typeof radio !== 'object' || radio === null) continue;
    const interfaces = (radio as Record<string, unknown>).interfaces;
    if (typeof interfaces !== 'object' || interfaces === null) continue;
    for (const iface of Object.values(interfaces as Record<string, unknown>)) {
      if (typeof iface !== 'object' || iface === null) continue;
      const ifn = iface as Record<string, unknown>;
      const ssid = typeof ifn.config === 'object' && ifn.config !== null
        ? ((ifn.config as Record<string, unknown>).ssid as unknown)
        : null;
      const clients = ifn.clients;
      if (typeof clients !== 'object' || clients === null) continue;
      for (const [mac, c] of Object.entries(clients as Record<string, unknown>)) {
        if (typeof c !== 'object' || c === null) continue;
        const cl = c as Record<string, unknown>;
        const num = (v: unknown): number | null =>
          typeof v === 'number' && Number.isFinite(v) ? v : null;
        // 速率字段有两种固件形状：{rx:{rate:..}} 与 平铺 rx_rate
        const rate = (v: unknown): number | null => {
          if (typeof v === 'object' && v !== null) {
            return num((v as Record<string, unknown>).rate);
          }
          return num(v);
        };
        out.push({
          mac: mac.toUpperCase(),
          ssid: typeof ssid === 'string' ? ssid : null,
          signalDbm: num(cl.signal),
          rxRateKbps: rate(cl.rx ?? cl.rx_rate),
          txRateKbps: rate(cl.tx ?? cl.tx_rate),
          connectedForSec: num(cl.connected_time),
        });
      }
    }
  }
  return out;
}

/**
 * 解析 `iwinfo devices` 响应（task-024，纯函数；形状不符 → 空数组）。
 * 响应形如 { devices: [{ name: "wlan0" }, { name: "wlan1" }] }。
 */
export function parseIwinfoDevices(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const list = (payload as Record<string, unknown>).devices;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) out.push(name);
  }
  return out;
}

/**
 * 解析 `iwinfo info` 响应（task-024，纯函数；字段缺失/形状不符 → 对应位 null，不猜）。
 * 响应含 ssid / channel / assoclist（已关联客户端数组）等字段。
 */
export function parseIwinfoInfo(payload: unknown, device: string): WirelessBandStatus {
  const empty: WirelessBandStatus = { device, ssid: null, channel: null, clientCount: null };
  if (typeof payload !== 'object' || payload === null) return empty;
  const p = payload as Record<string, unknown>;
  const ssid = typeof p.ssid === 'string' && p.ssid.length > 0 ? p.ssid : null;
  const channel =
    typeof p.channel === 'number' && Number.isFinite(p.channel) && p.channel > 0 ? p.channel : null;
  const clientCount = Array.isArray(p.assoclist) ? p.assoclist.length : null;
  return { device, ssid, channel, clientCount };
}

export interface UbusCallResult {
  ok: boolean;
  payload: unknown;
  error: string | null;
  /**
   * 失败原因是否为"会话已失效"（调用路径上的 -32002）。
   * 官方语义：无效/过期 sid 一律走 -32002，且**重试同一个 sid 永远不会成功**——
   * 它与网络超时/HTTP 错误有本质区别，上层必须据此作废会话并引导重新登录，
   * 否则每轮刷新都会静默拿到空数据（UI 显示"已登录"却什么都没有）。
   */
  sessionInvalid?: boolean;
}

/** -32002 在调用路径上的含义（与登录路径的"用户名或密码错误"区分）。 */
const SESSION_INVALID_CODE = -32002;

/** OpenWrt ubus JSON-RPC 客户端。 */
export class UbusClient {
  private session: string | null = null;
  private rpcId = 1;

  constructor(
    private readonly gatewayIp: string,
    private readonly transport: Transport = defaultTransport,
    private readonly timeoutMs = ROUTER.ubusTimeoutMs,
  ) {}

  get loggedIn(): boolean {
    return this.session !== null;
  }

  /** 登录并缓存会话。失败时清空会话并返回错误文案。 */
  async login(user: string, password: string): Promise<{ ok: boolean; error: string | null }> {
    // sid 必须是 32 位零 null-session，否则 uhttpd 直接以 -32002 拒绝（B-2 根因）
    const res = await this.raw([
      UBUS_NULL_SESSION,
      'session',
      'login',
      { username: user, password, timeout: 3600 },
    ]);
    if (!res.ok) {
      this.session = null;
      return { ok: false, error: res.error };
    }
    const data = res.payload as Record<string, unknown> | null;
    const token = typeof data?.ubus_rpc_session === 'string' ? data.ubus_rpc_session : null;
    if (!token) {
      this.session = null;
      return { ok: false, error: '登录响应缺少会话令牌' };
    }
    this.session = token;
    return { ok: true, error: null };
  }

  logout(): void {
    this.session = null;
  }

  /** 单次 ubus call；会话缺失时直接返回 auth-required。 */
  async call(object: string, method: string, params: Record<string, unknown> = {}): Promise<UbusCallResult> {
    if (this.session === null) return { ok: false, payload: null, error: 'auth-required' };
    return this.raw([this.session, object, method, params]);
  }

  async board(): Promise<BoardInfo | null> {
    const res = await this.call('system', 'board');
    return res.ok ? parseBoard(res.payload) : null;
  }

  async dhcpLeases(): Promise<DhcpLease[]> {
    const res = await this.call('luci-rpc', 'getDHCPLeases');
    return res.ok ? parseDhcpLeases(res.payload) : [];
  }

  async wirelessClients(): Promise<WirelessClient[]> {
    const res = await this.call('luci-rpc', 'getWirelessDevices');
    return res.ok ? parseWirelessDevices(res.payload) : [];
  }

  async reboot(): Promise<{ ok: boolean; error: string | null }> {
    const res = await this.call('system', 'reboot');
    return res.ok ? { ok: true, error: null } : { ok: false, error: res.error };
  }

  /** 底层 JSON-RPC：请求/响应/错误码统一收口。 */
  private async raw(params: unknown[]): Promise<UbusCallResult> {
    const body = buildRpcRequest(params, this.rpcId++);
    // 错误码含义按调用路径分流：login 与 call 拿到同一个 -32002 时提示完全不同
    const context: 'login' | 'call' =
      params[1] === 'session' && params[2] === 'login' ? 'login' : 'call';
    let res: { status: number | null; body: string; error: string | null };
    try {
      res = await this.transport(`http://${this.gatewayIp}/ubus`, body, this.timeoutMs);
    } catch (err) {
      return { ok: false, payload: null, error: err instanceof Error ? err.message : String(err) };
    }
    if (res.error) return { ok: false, payload: null, error: res.error };
    if (res.status !== 200) {
      // 登录路径拿到 404 几乎必然是"路由器根本没有 /ubus 端点"（家用固件：TP-Link/
      // 小米/运营商网关等），裸 "HTTP 404" 会让用户以为应用坏了。给出可行动的指引。
      const error =
        context === 'login'
          ? `HTTP ${res.status}（该路由器未提供 /ubus 登录接口，可能不是 OpenWrt 固件；请改用"内置浏览器登录"打开管理页）`
          : `HTTP ${res.status}`;
      return { ok: false, payload: null, error };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return { ok: false, payload: null, error: 'ubus 响应不是合法 JSON' };
    }
    const obj = parsed as { result?: unknown; error?: { code?: number; message?: string } | null };
    // 只有"调用路径上的 -32002"代表会话失效：官方语义是无效/过期 sid 一律走此码，
    // 且重试同一个 sid 永远不会成功。其余失败都不得清会话——
    //   - result:[6]（UBUS_STATUS_PERMISSION_DENIED）是单对象 ACL 拒绝，会话本身有效
    //   - 超时 / 非 200 / 非法 JSON / 传输异常是瞬时故障，清会话会把抖动放大成持续故障
    // 登录路径的 -32002 是"用户名或密码错误"，同样不清（login 自己会重置会话）。
    if (obj.error && typeof obj.error === 'object') {
      const code = typeof obj.error.code === 'number' ? obj.error.code : -999;
      const sessionInvalid = context === 'call' && code === SESSION_INVALID_CODE;
      if (sessionInvalid) this.session = null;
      return {
        ok: false,
        payload: null,
        error: ubusErrorMessage(code, context),
        sessionInvalid,
      };
    }
    if (!Array.isArray(obj.result) || obj.result.length === 0) {
      return { ok: false, payload: null, error: 'ubus 响应缺少 result 数组' };
    }
    const [code, payload] = obj.result as [number, unknown];
    if (typeof code !== 'number' || code !== 0) {
      // 部分固件不走 JSON-RPC error 对象，而是用 result 码回 -32002，对称处理
      const sessionInvalid = context === 'call' && code === SESSION_INVALID_CODE;
      if (sessionInvalid) this.session = null;
      return {
        ok: false,
        payload: null,
        error: ubusErrorMessage(code, context),
        sessionInvalid,
      };
    }
    return { ok: true, payload: payload ?? null, error: null };
  }
}
