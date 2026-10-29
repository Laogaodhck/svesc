/**
 * 路由器管理编排器：能力探测 → 按能力取数 → 诚实降级。
 *
 *  - 引擎层铁律：不 import electron。凭据持久化由主进程 router-store.ts 负责，
 *    本类只持有内存中的登录态。
 *  - 数据诚实原则：探测不到的能力如实标注，速率样本不足 2 次为 null。
 */
import { ROUTER } from '../../../shared/constants';
import type {
  DhcpLease,
  RouterBrand,
  RouterCapabilities,
  RouterIdentity,
  RouterStatus,
  WirelessBandStatus,
  WirelessClient,
} from '../../../shared/types';
import { detectManagementPage } from './detect';
import {
  UbusClient,
  parseBoard,
  parseDhcpLeases,
  parseIwinfoDevices,
  parseIwinfoInfo,
  parseWirelessDevices,
} from './openwrt';
import { ssdpDiscover, upnpQuery, resolveControlUrl, parseDeviceDescription } from './upnp';
import { fetchWebLeases } from './web-leases';
import { normalizeDhcpLeases } from './leases';
import { httpRequest } from './httpx';

export interface RouterManagerOptions {
  /** 网关 IP 提供者（由调用方接引擎的 cfg.gateway，本类不重复探测） */
  getGateway: () => string | null;
}

interface WanSample {
  at: number;
  rx: number | null;
  tx: number | null;
}

const EMPTY_CAPS: RouterCapabilities = { upnp: false, openwrt: false, managementPage: false };

export class RouterManager {
  private status: RouterStatus;
  private ubus: UbusClient | null = null;
  private user: string | null = null;
  private controlUrl: string | null = null;
  private wanSamples: WanSample[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<RouterStatus> | null = null;
  private refreshGeneration = 0;
  private refreshWebGeneration = 0;
  private webGeneration = 0;
  private onUpdate: ((status: RouterStatus) => void) | null = null;
  private gateway: string | null;
  private lastDetectAt: number | null = null;
  /**
   * 会话世代号（审计 L4）：logout 时自增。doRefresh 捕获进入时的世代，
   * 写回前比对——不一致即"这轮观测基于已作废的会话"，整体丢弃。
   * 否则 logout 后仍在飞的一轮（探测 await 可达数秒）会把旧会话的
   * DHCP 租约/无线客户端写回 status，UI 显示"未登录"却挂着旧数据。
   */
  private generation = 0;
  private loginAttempt = 0;
  /**
   * 内置浏览器建立的"管理页会话"是否存活。由主进程的 Cookie 监视器回调维护
   * （引擎层不 import electron）。与 ubus 会话正交：它只代表"用户在管理页上已登录"，
   * 不代表可获取 ubus 数据（DHCP/无线），UI 按 session.kind 区分文案。
   */
  private webSessionActive = false;
  /** 管理页最终可达 URL（含重定向落点）；一旦探测到即粘性保留，供内置浏览器打开。 */
  private adminUrl: string | null = null;
  // 同一网关内能力位不随登出回退，切换网关才清空。
  private openwrtCapable = false;
  /**
   * 同族的粘性能力位：HTTP 管理页"曾经可达"即认定。
   * 探测限频（detectRetryMs=60s）快于轮询（pollMs=10s），若每轮重算，
   * 已识别路由器每 6 轮有 5 轮被 UI 显示为"该路由器不支持"（审查 L6）。
   */
  private managementPageCapable = false;
  /**
   * Basic-Auth 会话（task-024）：管理页用 HTTP Basic 质询的路由器（华硕/部分华为等
   * 无 ubus 通道的固件），凭据经 Authorization 头验证成功后的登录态。
   * 登录时验证一次即进程内粘性（不存明文密码、不逐轮重验），logout 时清除。
   * 与 ubus / web 会话正交；不提供任何 ubus 数据（数据诚实：不解析页面内容）。
   */
  private basicAuthOk = false;
  private basicUser: string | null = null;
  /**
   * 会话失效自动重登（task-022 B-2）：凭据提供者由主进程注入（每次现读盘上密文，
   * 引擎层不常驻明文密码）。会话被服务端作废（-32002）时按退避调度重登：
   * 60s × 2ⁿ，上限 10min；连续 3 次失败停用，等用户手动登录。
   */
  private reloginProvider: (() => Promise<{ user: string; password: string } | null>) | null = null;
  private reloginTimer: NodeJS.Timeout | null = null;
  private reloginFailures = 0;
  private reloginInFlight = false;
  // 每个请求 URL 现取 Cookie，不跨域或路径复用凭据。
  private webLeaseProvider: ((url: string) => Promise<string | null>) | null = null;
  private webLeaseFailures = 0;
  private webLeaseRetryAt = 0;
  private ubusLeases: DhcpLease[] = [];
  private webLeases: DhcpLease[] = [];

  setWebLeaseProvider(p: ((url: string) => Promise<string | null>) | null): void {
    this.webLeaseProvider = p;
  }

  constructor(private readonly opts: RouterManagerOptions) {
    this.gateway = opts.getGateway();
    this.status = this.emptyStatus();
  }

  private publish(patch: Partial<RouterStatus>): void {
    this.status = { ...this.status, ...patch, ts: Math.max(Date.now(), this.status.ts + 1) };
    this.onUpdate?.(this.status);
  }

  private syncGateway(): void {
    const gateway = this.opts.getGateway();
    if (gateway === this.gateway) return;
    this.gateway = gateway;
    this.adminUrl = null;
    this.controlUrl = null;
    this.lastDetectAt = null;
    this.openwrtCapable = false;
    this.managementPageCapable = false;
    this.wanSamples = [];
    this.status = this.emptyStatus();
    this.logout();
  }

  private isCurrent(gen: number, gateway: string | null): boolean {
    return gen === this.generation && gateway === this.opts.getGateway();
  }

  private currentSession(): RouterStatus['session'] {
    const ubusAlive = this.ubus?.loggedIn === true;
    return {
      ...this.status.session,
      loggedIn: ubusAlive || this.webSessionActive || this.basicAuthOk,
      user: this.ubus !== null ? this.user : this.basicAuthOk ? this.basicUser : null,
      kind: ubusAlive ? 'ubus' : this.webSessionActive ? 'web' : this.basicAuthOk ? 'basic' : null,
    };
  }

  private mergedLeases(): DhcpLease[] {
    const primary = normalizeDhcpLeases(this.ubus?.loggedIn ? this.ubusLeases : []);
    const secondary = normalizeDhcpLeases(this.webSessionActive ? this.webLeases : []);
    const primaryMacs = new Set(primary.map((lease) => lease.mac));
    const names = new Map(secondary.map((lease) => [`${lease.mac}/${lease.ip}`, lease.hostname]));
    return normalizeDhcpLeases([
      ...primary.map((lease) => ({ ...lease, hostname: lease.hostname ?? names.get(`${lease.mac}/${lease.ip}`) ?? null })),
      ...secondary.filter((lease) => !primaryMacs.has(lease.mac)),
    ]);
  }

  private emptyStatus(): RouterStatus {
    return {
      ts: Date.now(),
      phase: 'probing',
      identity: null,
      capabilities: { ...EMPTY_CAPS },
      wan: { ip: null, totalBytesRx: null, totalBytesTx: null, rxBps: null, txBps: null, connectionStatus: null, uptimeSec: null },
      dhcpLeases: [],
      wirelessClients: [],
      wirelessStatus: null,
      systemBoard: null,
      session: { loggedIn: false, user: null, error: null, kind: null, invalidatedAt: null },
      lastError: null,
      capabilityNotes: [],
    };
  }

  getStatus(): RouterStatus {
    return this.status;
  }

  /** 登录 OpenWrt ubus；失败且管理页给出 Basic 质询时降级 Basic-Auth 验证（task-024）。成功后立即刷新一轮状态。 */
  async login(user: string, password: string): Promise<{ ok: boolean; error: string | null }> {
    this.syncGateway();
    const gw = this.gateway;
    if (!gw) return { ok: false, error: '网关地址未知，无法登录' };
    const gen = this.generation;
    const attempt = ++this.loginAttempt;
    const current = (): boolean => this.isCurrent(gen, gw) && attempt === this.loginAttempt;
    const cancelled = { ok: false, error: '登录已取消（会话或网关已变化）' };
    const client = new UbusClient(gw);
    const res = await client.login(user, password);
    if (!current()) { client.logout(); return cancelled; }
    if (!res.ok) {
      // Basic-Auth 降级（task-024）：无 ubus 通道的固件（管理页 401 + WWW-Authenticate: Basic，
      // 华硕/部分华为等）凭据经 Authorization 头验证，HTTP 200 即登录成功。
      // 只看状态码不解析页面内容——basic 会话仅提供登录态展示，不提供 ubus 数据。
      const basic = await this.tryBasicAuth(gw, user, password, current);
      if (!current()) return cancelled;
      if (basic.ok) {
        this.generation += 1;
        this.basicAuthOk = true;
        this.basicUser = user;
        this.reloginFailures = 0;
        this.publish({ session: { ...this.currentSession(), error: null, invalidatedAt: null } });
        await this.refresh();
        if (!this.basicAuthOk || attempt !== this.loginAttempt || gw !== this.opts.getGateway()) return cancelled;
        return { ok: true, error: null };
      }
      // 失败不清 this.ubus：若存在旧会话，它真实有效，下一轮 doRefresh 照常取数
      // （审查 L5：行为可辩护，但必须文档化。如须强制换登，在此先 logout 旧客户端）。
      // 同理不得清掉内置浏览器建立的管理页会话与既有 basic 会话：各种会话正交，
      // ubus 登录失败不构成"其他通道未登录"的证据。
      const failError = basic.attempted ? `Basic 认证失败：${basic.error ?? '凭据被拒绝'}` : res.error;
      this.publish({ session: { ...this.currentSession(), error: failError } });
      return { ok: false, error: failError };
    }
    this.generation += 1;
    this.ubus?.logout();
    this.ubusLeases = [];
    this.ubus = client;
    this.user = user;
    // 登录成功即认定支持 OpenWrt（能力位粘性，见 openwrtCapable 字段注释）
    this.openwrtCapable = true;
    // 会话恢复/手动登录成功：自动重登计数清零（手动登录成功同样成立）
    this.reloginFailures = 0;
    this.publish({
      capabilities: { ...this.status.capabilities, openwrt: true },
      session: { loggedIn: true, user, error: null, kind: 'ubus', invalidatedAt: null },
      dhcpLeases: this.mergedLeases(),
    });
    await this.refresh();
    if (this.ubus !== client || attempt !== this.loginAttempt || gw !== this.opts.getGateway()) return cancelled;
    return { ok: true, error: null };
  }

  /**
   * Basic-Auth 通用登录验证（task-024）：探测管理页是否给出 Basic 质询，
   * 是则带 Authorization 头 GET 验证凭据——HTTP 200 即通过，不解析页面内容。
   * attempted=false 表示该路由器没有 Basic 质询（上层沿用 ubus 登录的错误文案）。
   */
  private async tryBasicAuth(
    gw: string,
    user: string,
    password: string,
    current: () => boolean,
  ): Promise<{ attempted: boolean; ok: boolean; error: string | null }> {
    let page: Awaited<ReturnType<typeof detectManagementPage>>;
    try {
      page = await detectManagementPage(gw);
    } catch {
      return { attempted: false, ok: false, error: null };
    }
    if (!current() || !page.auth) return { attempted: false, ok: false, error: null };
    const url = page.url ?? `http://${gw}/`;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { attempted: true, ok: false, error: '管理页 URL 非法' };
    }
    const res = await httpRequest(url, {
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      timeoutMs: ROUTER.pageProbeTimeoutMs,
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
    });
    if (res.error) return { attempted: true, ok: false, error: `管理页请求失败（${res.error}）` };
    if (res.status === 200) return { attempted: true, ok: true, error: null };
    return { attempted: true, ok: false, error: `凭据被拒绝（HTTP ${res.status ?? 'no-response'}）` };
  }

  logout(): void {
    this.ubus?.logout();
    this.ubus = null;
    this.user = null;
    this.webSessionActive = false;
    // task-024：同步清除 Basic-Auth 会话（用户主动登出即全通道登出）
    this.basicAuthOk = false;
    this.basicUser = null;
    // 世代号自增：在飞的 doRefresh 收尾时发现自己属于旧世代，整体丢弃本轮结果
    this.generation += 1;
    // 用户主动登出：取消挂起的自动重登（主动退出 ≠ 会话失效，重登违背用户意图）
    if (this.reloginTimer !== null) {
      clearTimeout(this.reloginTimer);
      this.reloginTimer = null;
    }
    this.reloginFailures = 0;
    // 登出同时清 ubus 会话与管理页会话（主进程在调用本方法前后清路由器域 Cookie）。
    // 不动 capabilities：caps.openwrt / caps.managementPage 是能力位，须粘性保留；
    // 未登录时 CapRow 的 note 走"登录后可查看 DHCP 租约与无线客户端"既有分支，
    // UI 不会因此撒谎。
    this.ubusLeases = [];
    this.webLeases = [];
    this.webLeaseFailures = 0;
    this.webLeaseRetryAt = 0;
    this.publish({
      session: { loggedIn: false, user: null, error: null, kind: null, invalidatedAt: null },
      dhcpLeases: [],
      wirelessClients: [],
      wirelessStatus: null,
      systemBoard: null,
      capabilityNotes: [],
    });
  }

  getSessionRevision(): number {
    this.syncGateway();
    return this.generation;
  }

  getWebSessionRevision(): string {
    return `${this.getSessionRevision()}/${this.webGeneration}`;
  }

  hasWebSession(): boolean {
    return this.webSessionActive;
  }

  // Cookie 会话与 ubus 登录正交，不能使在飞 ubus 认证或失效观测作废。
  markWebSession(loggedIn: boolean): boolean {
    this.syncGateway();
    if (this.webSessionActive === loggedIn) return false;
    this.webGeneration += 1;
    this.webSessionActive = loggedIn;
    this.webLeaseFailures = 0;
    this.webLeaseRetryAt = 0;
    this.webLeases = [];
    this.publish({ session: this.currentSession(), dhcpLeases: this.mergedLeases(), capabilityNotes: [] });
    return true;
  }

  /** 管理页最终可达 URL（供主进程内置浏览器打开）；尚未探测到为 null。 */
  getAdminUrl(): string | null {
    return this.adminUrl;
  }

  /** 全量刷新：能力探测（限频）→ 按能力取数。并发调用自动合并。 */
  refresh(): Promise<RouterStatus> {
    this.syncGateway();
    if (this.refreshPromise && this.refreshGeneration === this.generation) {
      return this.refreshWebGeneration === this.webGeneration
        ? this.refreshPromise
        : this.refreshPromise.then(() => this.refresh());
    }
    const gen = this.generation;
    const gw = this.gateway;
    this.refreshGeneration = gen;
    this.refreshWebGeneration = this.webGeneration;
    const pending = this.doRefresh()
      .catch(() => {
        if (this.isCurrent(gen, gw)) {
          this.ubusLeases = [];
          this.webLeases = [];
          this.publish({ dhcpLeases: [], lastError: '路由器状态刷新失败，请稍后重试' });
        }
      })
      .then(() => this.status)
      .finally(() => { if (this.refreshPromise === pending) this.refreshPromise = null; });
    this.refreshPromise = pending;
    return pending;
  }

  private async doRefresh(): Promise<void> {
    const gw = this.opts.getGateway();
    // 世代捕获必须在任何 await 之前：logout 与本轮观测的先后即靠它判定
    const gen = this.generation;
    if (!gw) {
      this.publish({ ...this.emptyStatus(), phase: 'unreachable', lastError: '网关地址未知（尚未完成首轮局域网扫描）' });
      return;
    }

    const notes: string[] = [];
    let identity: RouterIdentity =
      this.status.identity?.ip === gw
        ? this.status.identity
        : { ip: gw, brand: null, modelHint: null, upnpFriendlyName: null, adminUrl: this.adminUrl };
    let caps: RouterCapabilities = { ...EMPTY_CAPS };

    const upnpPending = this.probeUpnp(gw, gen);
    const ubus = this.ubus;
    const ubusPending = ubus?.loggedIn ? Promise.all([
      ubus.call('luci-rpc', 'getDHCPLeases'),
      ubus.call('luci-rpc', 'getWirelessDevices'),
      ubus.call('system', 'board'),
      ubus.call('iwinfo', 'devices'),
    ]) : null;

    if (this.lastDetectAt === null || Date.now() - this.lastDetectAt >= ROUTER.detectRetryMs) {
      this.lastDetectAt = Date.now();
      const page = await detectManagementPage(gw);
      if (!this.isCurrent(gen, gw)) return;
      if (page.reachable) {
        // 曾可达即粘性认定（managementPageCapable 注释）：探测限频快于轮询，逐轮重算会闪烁
        this.managementPageCapable = true;
        caps.managementPage = true;
        // 管理页最终 URL 粘性保留（302 → /login 的落点），内置浏览器直接打开它
        if (page.url) this.adminUrl = page.url;
        // 401 Basic 质询时看不到页面正文 → brand=null，不覆盖既有品牌（数据诚实）
        if (page.brand !== null) {
          identity = { ...identity, brand: page.brand as RouterBrand, modelHint: identity.modelHint ?? page.hint };
        }
      } else {
        notes.push(`管理页不可达（${page.error ?? '无响应'}）`);
      }
    }
    caps.managementPage = this.managementPageCapable;

    // 探测到 OpenWrt 指纹即终身认定：能力位只进不退（见 openwrtCapable 字段注释）
    if (identity.brand === 'openwrt') this.openwrtCapable = true;

    // adminUrl 与粘性字段同步进 identity（探测限频轮也要带上，UI/主进程随时可用）
    if (identity.adminUrl !== this.adminUrl) identity = { ...identity, adminUrl: this.adminUrl };

    // —— OpenWrt 通道：有会话才取数 ——
    // ubus 会话与内置浏览器的管理页会话正交；loggedIn/kind 按"ubus 优先"合成，
    // 管理页会话独立存续不因本轮无 ubus 数据被打回 false。
    // 注意：ubusLoggedIn 必须在取数**之后**再求值——本轮调用就可能触发 -32002
    // 自清会话，提前求值会把死会话投影成"已登录"（UI 假已登录）。
    let dhcpLeases: DhcpLease[] = [];
    let wirelessClients: WirelessClient[] = [];
    let wirelessStatus: WirelessBandStatus[] | null = null;
    let systemBoard: RouterStatus['systemBoard'] = null;
    // 本round是否观测到"会话已失效"：只有调用路径的 -32002 算（瞬时故障不算）
    let sessionInvalid = false;
    // caps.openwrt 是能力位（是否支持 OpenWrt 协议），与登录态正交：openwrtCapable 为进程内
    // 粘性信号（只置 true），identity.brand 为本轮管理页指纹，登录态仅作兜底。
    caps.openwrt = this.openwrtCapable || identity.brand === 'openwrt' || (this.ubus !== null && this.ubus.loggedIn);

    const webGen = this.webGeneration;
    const webPending = this.readWebLeases(gw, identity.brand, gen);
    if (ubus && ubusPending) {
      const [leaseRes, wirelessRes, boardRes, iwinfoDevRes] = await ubusPending;
      if (!this.isCurrent(gen, gw)) return;
      sessionInvalid = [leaseRes, wirelessRes, boardRes, iwinfoDevRes].some((r) => r.sessionInvalid === true);
      dhcpLeases = leaseRes.ok ? parseDhcpLeases(leaseRes.payload) : [];
      wirelessClients = wirelessRes.ok ? parseWirelessDevices(wirelessRes.payload) : [];
      systemBoard = boardRes.ok ? parseBoard(boardRes.payload) : null;
      if (systemBoard && !identity.modelHint) identity = { ...identity, modelHint: systemBoard.model };
      // 无线频段状态（task-024）：iwinfo devices → 逐设备 iwinfo info，最多 4 个防超时膨胀；
      // 拿到设备列表（哪怕为空）→ 数组（[] = 已登录但无射频）；列表拿不到 → null（不支持/失败）。
      if (iwinfoDevRes.ok) {
        const devices = parseIwinfoDevices(iwinfoDevRes.payload).slice(0, 4);
        const infoRes = await Promise.all(devices.map((d) => ubus.call('iwinfo', 'info', { device: d })));
        sessionInvalid = sessionInvalid || infoRes.some((r) => r.sessionInvalid === true);
        wirelessStatus = infoRes.map((r, i) => parseIwinfoInfo(r.payload, devices[i]));
      }
      // 非 -32002 的调用失败（超时/HTTP/权限等）也要让界面知道原因，不得静默变空数据
      // （审查 M2，R-03"静默失败必须可感知"同源）。capabilityNotes 每轮重建，恢复后自然消失。
      const callLabels: Array<[string, typeof leaseRes]> = [
        ['DHCP 租约', leaseRes],
        ['无线客户端', wirelessRes],
        ['系统信息', boardRes],
        ['无线频段状态', iwinfoDevRes],
      ];
      for (const [label, r] of callLabels) {
        if (!r.ok && r.sessionInvalid !== true && r.error !== null && r.error !== 'auth-required') {
          notes.push(`${label}获取失败（${r.error}）`);
        }
      }
    } else if (identity.brand === 'openwrt') {
      notes.push('检测到 OpenWrt，登录后可查看 DHCP 租约与无线客户端');
    }
    const webResult = await webPending;
    if (!this.isCurrent(gen, gw)) return;
    this.ubusLeases = sessionInvalid ? [] : dhcpLeases;
    if (webGen === this.webGeneration) {
      if (webResult.note) notes.push(webResult.note);
      this.webLeases = webResult.leases;
    }
    dhcpLeases = this.mergedLeases();
    if (sessionInvalid) {
      wirelessClients = [];
      wirelessStatus = null;
      systemBoard = null;
    }
    const session = {
      ...this.currentSession(),
      error: sessionInvalid ? '路由器会话已过期，请重新登录' : this.status.session.error,
      invalidatedAt: sessionInvalid ? Date.now() : this.status.session.invalidatedAt,
    };
    // WAN 尚未完成时保留上轮能力证据；租约先推送，不以“探测中”冒充“不支持”。
    this.publish({
      identity, capabilities: { ...caps, upnp: this.status.capabilities.upnp },
      dhcpLeases, wirelessClients, wirelessStatus, systemBoard, session, capabilityNotes: [...notes],
    });
    const upnpSnap = await upnpPending;
    if (!this.isCurrent(gen, gw)) return;
    if (upnpSnap) {
      caps.upnp = true;
      identity = { ...identity, upnpFriendlyName: upnpSnap.friendlyName ?? identity.upnpFriendlyName };
      if (upnpSnap.modelName && !identity.modelHint) identity = { ...identity, modelHint: upnpSnap.modelName };
    } else {
      notes.push('该路由器不提供 UPnP IGD（WAN 信息与远程重启不可用）');
    }
    const now = Date.now();
    if (upnpSnap) {
      this.wanSamples.push({ at: now, rx: upnpSnap.totalBytesRx, tx: upnpSnap.totalBytesTx });
      this.wanSamples = this.wanSamples.filter((s) => now - s.at <= 5 * 60_000).slice(-12);
    }
    const rate = this.computeRates();

    this.publish({
      phase: 'ready',
      identity,
      capabilities: caps,
      wan: {
        ip: upnpSnap?.wanIp ?? null,
        totalBytesRx: upnpSnap?.totalBytesRx ?? null,
        totalBytesTx: upnpSnap?.totalBytesTx ?? null,
        rxBps: rate.rxBps,
        txBps: rate.txBps,
        connectionStatus: upnpSnap?.connectionStatus ?? null,
        uptimeSec: upnpSnap?.uptimeSec ?? null,
      },
      dhcpLeases: this.mergedLeases(),
      wirelessClients,
      wirelessStatus,
      systemBoard,
      session: this.currentSession(),
      lastError: null,
      capabilityNotes: notes,
    });
  }

  private async readWebLeases(gw: string, brand: RouterBrand | null, gen: number): Promise<{ leases: DhcpLease[]; note: string | null }> {
    if (!this.webSessionActive || !this.webLeaseProvider) return { leases: [], note: null };
    if (Date.now() < this.webLeaseRetryAt) {
      return { leases: [], note: `管理页租约（实验通道）：暂时退避，${Math.ceil((this.webLeaseRetryAt - Date.now()) / 1000)} 秒后自动重试` };
    }
    const provider = this.webLeaseProvider;
    const webGen = this.webGeneration;
    const current = (): boolean => this.isCurrent(gen, gw) && this.webSessionActive && webGen === this.webGeneration;
    const result = await fetchWebLeases({
      gateway: gw,
      brand,
      adminUrl: this.adminUrl,
      isCurrent: current,
      cookieProvider: async (url) => {
        if (!current()) return null;
        const cookie = await provider(url);
        return current() ? cookie : null;
      },
    });
    if (!current()) return { leases: [], note: null };
    if (result.ok) {
      this.webLeaseFailures = 0;
      this.webLeaseRetryAt = 0;
    } else {
      this.webLeaseFailures = Math.min(this.webLeaseFailures + 1, 4);
      this.webLeaseRetryAt = Date.now() + Math.min(ROUTER.pollMs * 2 ** (this.webLeaseFailures - 1), 60_000);
    }
    return result;
  }

  /** UPnP 探测：SSDP 优先，失败则直查常见描述路径；都不通返回 null。 */
  private async probeUpnp(gw: string, gen: number): Promise<Awaited<ReturnType<typeof upnpQuery>> | null> {
    const descPaths = ['/description.xml', '/igd.xml', '/igddesc.xml', '/wanipcn.xml'];
    const tryLocation = async (location: string): Promise<string | null> => {
      if (!this.isCurrent(gen, gw)) return null;
      const u = new URL(location);
      const res = await httpRequest(location, { port: Number(u.port) || 80, path: u.pathname, timeoutMs: ROUTER.upnpHttpTimeoutMs });
      if (!this.isCurrent(gen, gw) || res.error || res.status !== 200) return null;
      const parsed = parseDeviceDescription(res.body);
      if (!parsed) return null;
      this.controlUrl = resolveControlUrl(location, parsed.controlUrl);
      return location;
    };

    try {
      const disc = await ssdpDiscover();
      if (disc.location) {
        const loc = await tryLocation(disc.location);
        if (loc) return await upnpQuery(loc);
      }
    } catch {
      /* SSDP 失败不算致命，走直查兜底 */
    }

    for (const path of descPaths) {
      const location = `http://${gw}:1900${path}`;
      try {
        const loc = await tryLocation(location);
        if (loc) return await upnpQuery(loc);
      } catch {
        /* 下一个路径 */
      }
    }
    return null;
  }

  private computeRates(): { rxBps: number | null; txBps: number | null } {
    const valid = this.wanSamples.filter((s) => s.rx !== null && s.tx !== null) as Array<{ at: number; rx: number; tx: number }>;
    if (valid.length < 2) return { rxBps: null, txBps: null };
    const a = valid[valid.length - 2];
    const b = valid[valid.length - 1];
    const dtSec = (b.at - a.at) / 1000;
    if (dtSec <= 0 || b.rx < a.rx || b.tx < a.tx) {
      // 计数器回绕/重置（路由器重启过）：样本不可比 → 诚实返回 null
      return { rxBps: null, txBps: null };
    }
    return { rxBps: Math.round((b.rx - a.rx) / dtSec), txBps: Math.round((b.tx - a.tx) / dtSec) };
  }

  /**
   * 注入凭据提供者（task-022 B-2，主进程启动时调用一次）。
   * provider 每次调用现读盘上密文并解密，返回 null 表示"不重登"
   * （记住密码已关闭 / 凭据不存在）——这是用户意愿的表达，静默停用、不计失败。
   */
  setAutoRelogin(provider: () => Promise<{ user: string; password: string } | null>): void {
    this.reloginProvider = provider;
  }

  /**
   * 会话失效时由主进程轮询回调调用（session.invalidatedAt 粘性，每轮都会触发）。
   * 幂等：已有挂起定时器 / 重登进行中 / ubus 会话已恢复 / 无 provider 时直接跳过。
   * 退避：60s × 2ⁿ，上限 10min；连续 3 次失败永久停用（本进程内）。
   */
  scheduleRelogin(): void {
    if (this.reloginProvider === null) return;
    if (this.reloginTimer !== null || this.reloginInFlight) return;
    // ubus 会话已自行恢复（手动登录 / 上一轮重登成功）：无需重登
    if (this.ubus !== null && this.ubus.loggedIn) return;
    if (this.reloginFailures >= 3) {
      // 停用态：把原因持续暴露给 UI（error 每轮 doRefresh 会沿用上一条，不会被覆盖丢失）
      this.status = {
        ...this.status,
        session: { ...this.status.session, error: '已停止自动重登（凭据可能已失效），请手动登录' },
      };
      return;
    }
    const delay = Math.min(60_000 * 2 ** this.reloginFailures, 10 * 60_000);
    this.reloginTimer = setTimeout(() => {
      this.reloginTimer = null;
      void this.runRelogin();
    }, delay);
    this.reloginTimer.unref?.();
  }

  private async runRelogin(): Promise<void> {
    if (this.reloginInFlight || this.reloginProvider === null) return;
    this.reloginInFlight = true;
    const gen = this.generation;
    const gw = this.gateway;
    // 是否需要续链下一跳退避：必须在 finally 清掉 reloginInFlight **之后**再调
    // scheduleRelogin()——否则会被它的 inFlight 幂等守卫拦截，纯内部调度挂不出第二跳
    // （退避链自续断裂；生产被轮询再触发遮蔽，但内部链语义必须自洽）。
    let retry = false;
    try {
      // 每次现读凭据：不常驻明文密码；开关关闭时 provider 返回 null，静默停用
      const creds = await this.reloginProvider();
      if (!creds || !this.isCurrent(gen, gw)) return;
      const res = await this.login(creds.user, creds.password);
      if (!this.isCurrent(gen, gw) || res.ok) {
        // login() 成功路径已把 reloginFailures 清零
        return;
      }
      this.reloginFailures += 1;
      if (this.reloginFailures < 3) {
        retry = true;
      } else {
        this.status = {
          ...this.status,
          session: { ...this.status.session, error: '已停止自动重登（凭据可能已失效），请手动登录' },
        };
      }
    } catch {
      if (this.isCurrent(gen, gw)) {
        this.reloginFailures += 1;
        retry = this.reloginFailures < 3;
        this.publish({ session: { ...this.currentSession(), error: '自动重登失败，请检查保存的凭据或手动登录' } });
      }
    } finally {
      this.reloginInFlight = false;
      if (retry && this.isCurrent(gen, gw)) this.scheduleRelogin();
    }
  }

  startPolling(onUpdate: (s: RouterStatus) => void, checkWebSession?: () => Promise<unknown>): void {
    if (this.pollTimer) return;
    this.onUpdate = onUpdate;
    this.pollTimer = setInterval(() => {
      const gen = this.generation;
      const check = this.webSessionActive && checkWebSession ? checkWebSession() : Promise.resolve();
      void check.catch(() => undefined).then(() => {
        if (this.onUpdate !== null && (gen === this.generation || !this.webSessionActive)) return this.refresh();
        return this.status;
      });
    }, ROUTER.pollMs);
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
    this.onUpdate = null;
    this.generation += 1;
    if (this.reloginTimer) {
      clearTimeout(this.reloginTimer);
      this.reloginTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 供持久化层恢复登录态（主进程从 safeStorage 密文里解出来后回填）。 */
  restoreSession(user: string, password: string): void {
    void this.login(user, password).catch(() => {
      // 恢复失败保持未登录状态；失败原因经 login 失败分支写进 session.error，
      // UI 提示"已用保存的凭据自动登录失败，请重新登录"级别的问题由登录表单可见。
    });
  }
}
