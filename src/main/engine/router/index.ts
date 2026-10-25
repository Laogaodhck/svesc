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
  RouterActionStatus,
  RouterBrand,
  RouterCapabilities,
  RouterIdentity,
  RouterStatus,
  WirelessClient,
} from '../../../shared/types';
import { detectManagementPage } from './detect';
import { UbusClient, parseBoard, parseDhcpLeases, parseWirelessDevices } from './openwrt';
import { ssdpDiscover, upnpQuery, upnpReboot, resolveControlUrl, parseDeviceDescription } from './upnp';
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
  private refreshing = false;
  private lastDetectAt = 0;
  /**
   * 会话世代号（审计 L4）：logout 时自增。doRefresh 捕获进入时的世代，
   * 写回前比对——不一致即"这轮观测基于已作废的会话"，整体丢弃。
   * 否则 logout 后仍在飞的一轮（探测 await 可达数秒）会把旧会话的
   * DHCP 租约/无线客户端写回 status，UI 显示"未登录"却挂着旧数据。
   */
  private generation = 0;
  /**
   * 内置浏览器建立的"管理页会话"是否存活。由主进程的 Cookie 监视器回调维护
   * （引擎层不 import electron）。与 ubus 会话正交：它只代表"用户在管理页上已登录"，
   * 不代表可获取 ubus 数据（DHCP/无线），UI 按 session.kind 区分文案。
   */
  private webSessionActive = false;
  /** 管理页最终可达 URL（含重定向落点）；一旦探测到即粘性保留，供内置浏览器打开。 */
  private adminUrl: string | null = null;
  /**
   * 进程生命周期内只置 true、不置 false 的粘性能力位：探测到 OpenWrt 指纹或登录成功即认定。
   * 能力（协议支持）与会话（登录态）正交——会话过期/登出后 caps.openwrt 不得被打回 false，
   * 否则 UI 会对一台确实支持 OpenWrt 的路由器显示"该路由器不支持"（数据诚实原则）。
   */
  private openwrtCapable = false;
  /**
   * 同族的粘性能力位：HTTP 管理页"曾经可达"即认定。
   * 探测限频（detectRetryMs=60s）快于轮询（pollMs=10s），若每轮重算，
   * 已识别路由器每 6 轮有 5 轮被 UI 显示为"该路由器不支持"（审查 L6）。
   */
  private managementPageCapable = false;
  /**
   * 会话失效自动重登（task-022 B-2）：凭据提供者由主进程注入（每次现读盘上密文，
   * 引擎层不常驻明文密码）。会话被服务端作废（-32002）时按退避调度重登：
   * 60s × 2ⁿ，上限 10min；连续 3 次失败停用，等用户手动登录。
   */
  private reloginProvider: (() => Promise<{ user: string; password: string } | null>) | null = null;
  private reloginTimer: NodeJS.Timeout | null = null;
  private reloginFailures = 0;
  private reloginInFlight = false;

  constructor(private readonly opts: RouterManagerOptions) {
    this.status = this.emptyStatus();
  }

  private emptyStatus(): RouterStatus {
    return {
      ts: Date.now(),
      phase: 'probing',
      identity: null,
      capabilities: { ...EMPTY_CAPS },
      wan: { ip: null, totalBytesRx: null, totalBytesTx: null, rxBps: null, txBps: null },
      dhcpLeases: [],
      wirelessClients: [],
      systemBoard: null,
      session: { loggedIn: false, user: null, error: null, kind: null, invalidatedAt: null },
      lastError: null,
      capabilityNotes: [],
    };
  }

  getStatus(): RouterStatus {
    return this.status;
  }

  /** 登录 OpenWrt ubus；成功后立即刷新一轮状态。 */
  async login(user: string, password: string): Promise<{ ok: boolean; error: string | null }> {
    const gw = this.opts.getGateway();
    if (!gw) return { ok: false, error: '网关地址未知，无法登录' };
    const client = new UbusClient(gw);
    const res = await client.login(user, password);
    if (!res.ok) {
      // 失败不清 this.ubus：若存在旧会话，它真实有效，下一轮 doRefresh 照常取数
      // （审查 L5：行为可辩护，但必须文档化。如须强制换登，在此先 logout 旧客户端）。
      // 同理不得清掉内置浏览器建立的管理页会话：两种会话正交，ubus 登录失败
      // 不构成"管理页未登录"的证据。
    const webAlive = this.webSessionActive;
    this.status = {
      ...this.status,
      session: {
        loggedIn: webAlive,
        user: null,
        error: res.error,
        kind: webAlive ? 'web' : null,
        // 登录失败（凭据错等）不改变"会话是否曾被服务端作废"的事实，粘性保留
        invalidatedAt: this.status.session.invalidatedAt,
      },
    };
    return res;
  }
    this.ubus = client;
    this.user = user;
    // 登录成功即认定支持 OpenWrt（能力位粘性，见 openwrtCapable 字段注释）
    this.openwrtCapable = true;
    // 会话恢复/手动登录成功：自动重登计数清零（手动登录成功同样成立）
    this.reloginFailures = 0;
    this.status = {
      ...this.status,
      capabilities: { ...this.status.capabilities, openwrt: true },
      session: { loggedIn: true, user, error: null, kind: 'ubus', invalidatedAt: null },
    };
    await this.refresh();
    return { ok: true, error: null };
  }

  logout(): void {
    this.ubus?.logout();
    this.ubus = null;
    this.user = null;
    this.webSessionActive = false;
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
    this.status = {
      ...this.status,
      session: { loggedIn: false, user: null, error: null, kind: null, invalidatedAt: null },
      dhcpLeases: [],
      wirelessClients: [],
      systemBoard: null,
    };
  }

  /**
   * 内置浏览器的 Cookie 监视器回调（主进程调用）：路由器域出现会话 Cookie 即认定
   * 管理页登录成功。只影响 session（kind='web'），不设置 caps.openwrt——
   * 管理页会话拿不到 ubus 数据，把 caps.openwrt 置 true 会让 UI 撒谎。
   */
  markWebSession(loggedIn: boolean): void {
    if (loggedIn) {
      this.webSessionActive = true;
      this.status = {
        ...this.status,
        session: { ...this.status.session, loggedIn: true, user: null, error: null, kind: 'web' },
      };
      return;
    }
    // loggedIn=false：只清管理页会话，不动 ubus 会话（两者正交）
    if (!this.webSessionActive) return;
    this.webSessionActive = false;
    this.status = {
      ...this.status,
      session: { ...this.status.session, loggedIn: false, user: null, error: null, kind: null },
    };
  }

  /** 管理页最终可达 URL（供主进程内置浏览器打开）；尚未探测到为 null。 */
  getAdminUrl(): string | null {
    return this.adminUrl;
  }

  /** 重启路由器：UPnP Reboot 或 OpenWrt system reboot，两路都不可用则 unsupported。 */
  async reboot(): Promise<{ status: RouterActionStatus; error: string | null }> {
    if (this.ubus && this.ubus.loggedIn) {
      const res = await this.ubus.reboot();
      if (res.ok) return { status: 'ok', error: null };
      return { status: 'failed', error: res.error };
    }
    if (this.controlUrl) {
      const res = await upnpReboot(this.controlUrl);
      if (res.ok) return { status: 'ok', error: null };
      return { status: 'failed', error: res.error };
    }
    return { status: 'unsupported', error: '当前路由器既没有 OpenWrt 会话也没有 UPnP controlURL，无法远程重启' };
  }

  /** 全量刷新：能力探测（限频）→ 按能力取数。并发调用自动合并。 */
  async refresh(): Promise<RouterStatus> {
    if (this.refreshing) return this.status;
    this.refreshing = true;
    try {
      await this.doRefresh();
      return this.status;
    } catch (err) {
      // 防御性收口（审查 N4）：探测层现状均不抛，但级联抛出会经 startPolling 的
      // async 回调变成 unhandledRejection。失败轮如实写 lastError，不静默。
      this.status = {
        ...this.status,
        lastError: `路由器状态刷新失败：${err instanceof Error ? err.message : String(err)}`,
      };
      return this.status;
    } finally {
      this.refreshing = false;
    }
  }

  private async doRefresh(): Promise<void> {
    const gw = this.opts.getGateway();
    // 世代捕获必须在任何 await 之前：logout 与本轮观测的先后即靠它判定
    const gen = this.generation;
    if (!gw) {
      const base = this.emptyStatus();
      this.status = {
        ...base,
        phase: 'unreachable',
        lastError: '网关地址未知（尚未完成首轮局域网扫描）',
        // 粘性能力位与真实登录态不得因"本轮拿不到网关"被瞬态打回假值（审查 L3）：
        // UI 在 unreachable 态不渲染能力卡，但状态本身必须自洽，下一轮拿到网关即恢复。
        capabilities: { ...base.capabilities, openwrt: this.openwrtCapable },
        session: {
          ...base.session,
          loggedIn: (this.ubus !== null && this.ubus.loggedIn) || this.webSessionActive,
          user: this.ubus !== null ? this.user : null,
          kind: this.ubus !== null && this.ubus.loggedIn ? 'ubus' : this.webSessionActive ? 'web' : null,
          // invalidatedAt 粘性：本轮拿不到网关不构成"会话恢复"的证据，也不新增失效证据
          invalidatedAt: this.status.session.invalidatedAt,
        },
      };
      return;
    }

    const notes: string[] = [];
    let identity: RouterIdentity =
      this.status.identity?.ip === gw
        ? this.status.identity
        : { ip: gw, brand: null, modelHint: null, upnpFriendlyName: null, adminUrl: this.adminUrl };
    let caps: RouterCapabilities = { ...EMPTY_CAPS };

    // —— UPnP：描述页直查（SSDP 广播在闭网段常被禁，直查 /description.xml 兜底）——
    const upnpSnap = await this.probeUpnp(gw);
    if (upnpSnap) {
      caps.upnp = true;
      identity = { ...identity, upnpFriendlyName: upnpSnap.friendlyName ?? identity.upnpFriendlyName };
      if (upnpSnap.modelName && !identity.modelHint) identity = { ...identity, modelHint: upnpSnap.modelName };
    } else {
      notes.push('该路由器不提供 UPnP IGD（WAN 信息与远程重启不可用）');
    }

    // —— 管理页指纹（限频：60s 内不重复探测）——
    if (Date.now() - this.lastDetectAt > ROUTER.detectRetryMs || identity.brand === null) {
      this.lastDetectAt = Date.now();
      const page = await detectManagementPage(gw);
      if (page.reachable) {
        // 曾可达即粘性认定（managementPageCapable 注释）：探测限频快于轮询，逐轮重算会闪烁
        this.managementPageCapable = true;
        caps.managementPage = true;
        // 管理页最终 URL 粘性保留（302 → /login 的落点），内置浏览器直接打开它
        if (page.url) this.adminUrl = page.url;
        identity = { ...identity, brand: page.brand as RouterBrand, modelHint: identity.modelHint ?? page.hint };
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
    let systemBoard: RouterStatus['systemBoard'] = null;
    // 本round是否观测到"会话已失效"：只有调用路径的 -32002 算（瞬时故障不算）
    let sessionInvalid = false;
    // caps.openwrt 是能力位（是否支持 OpenWrt 协议），与登录态正交：openwrtCapable 为进程内
    // 粘性信号（只置 true），identity.brand 为本轮管理页指纹，登录态仅作兜底。
    caps.openwrt = this.openwrtCapable || identity.brand === 'openwrt' || (this.ubus !== null && this.ubus.loggedIn);

    if (this.ubus && this.ubus.loggedIn) {
      // 直接走 call() + 纯函数解析，不用 board()/dhcpLeases()/wirelessClients() 包装：
      // 包装会吞掉 sessionInvalid，"会话已过期"就必须在界面上可见，不能静默变成空数据。
      const [leaseRes, wirelessRes, boardRes] = await Promise.all([
        this.ubus.call('luci-rpc', 'getDHCPLeases'),
        this.ubus.call('luci-rpc', 'getWirelessDevices'),
        this.ubus.call('system', 'board'),
      ]);
      sessionInvalid = [leaseRes, wirelessRes, boardRes].some((r) => r.sessionInvalid === true);
      dhcpLeases = leaseRes.ok ? parseDhcpLeases(leaseRes.payload) : [];
      wirelessClients = wirelessRes.ok ? parseWirelessDevices(wirelessRes.payload) : [];
      systemBoard = boardRes.ok ? parseBoard(boardRes.payload) : null;
      if (systemBoard && !identity.modelHint) identity = { ...identity, modelHint: systemBoard.model };
      // 非 -32002 的调用失败（超时/HTTP/权限等）也要让界面知道原因，不得静默变空数据
      // （审查 M2，R-03"静默失败必须可感知"同源）。capabilityNotes 每轮重建，恢复后自然消失。
      const callLabels: Array<[string, typeof leaseRes]> = [
        ['DHCP 租约', leaseRes],
        ['无线客户端', wirelessRes],
        ['系统信息', boardRes],
      ];
      for (const [label, r] of callLabels) {
        if (!r.ok && r.sessionInvalid !== true && r.error !== null && r.error !== 'auth-required') {
          notes.push(`${label}获取失败（${r.error}）`);
        }
      }
    } else if (identity.brand === 'openwrt') {
      notes.push('检测到 OpenWrt，登录后可查看 DHCP 租约与无线客户端');
    }

    // —— WAN 速率：至少 2 个带计数器的样本才出 bps ——
    const ubusLoggedIn = this.ubus !== null && this.ubus.loggedIn;
    const now = Date.now();
    // 世代守卫（审计 L4）：本轮观测期间发生过 logout → 观测基于已作废的会话，
    // DHCP 租约/无线客户端/系统信息整体丢弃，不得覆盖 logout 清理后的干净状态。
    if (gen !== this.generation) return;
    if (upnpSnap) {
      this.wanSamples.push({ at: now, rx: upnpSnap.totalBytesRx, tx: upnpSnap.totalBytesTx });
      this.wanSamples = this.wanSamples.filter((s) => now - s.at <= 5 * 60_000).slice(-12);
    }
    const rate = this.computeRates();

    this.status = {
      ts: now,
      phase: 'ready',
      identity,
      capabilities: caps,
      wan: {
        ip: upnpSnap?.wanIp ?? null,
        totalBytesRx: upnpSnap?.totalBytesRx ?? null,
        totalBytesTx: upnpSnap?.totalBytesTx ?? null,
        rxBps: rate.rxBps,
        txBps: rate.txBps,
      },
      dhcpLeases,
      wirelessClients,
      systemBoard,
      session: {
        // 客户端自己也可能已作废会话（-32002）：不能只查 this.ubus !== null，那会让 UI 显示假的"已登录"
        loggedIn: ubusLoggedIn || this.webSessionActive,
        // 会话死后保留"最后登录的用户名"（既有契约，失效提示带着用户名更可读）；
        // 从未 ubus 登录 / 已登出 → null（管理页会话不知道用户名，也不编造）
        user: this.ubus !== null ? this.user : null,
        // 观测到会话失效时给出原因；未观测到时沿用上一条（消息要持续到用户重新登录）。
        // 重新登录成功与 logout 已有清零路径，这里不新增清零逻辑。
        error: sessionInvalid ? '路由器会话已过期，请重新登录' : this.status.session.error,
        kind: ubusLoggedIn ? 'ubus' : this.webSessionActive ? 'web' : null,
        // task-022 B-2：失效时刻粘性记录（主进程轮询回调据此触发自动重登）。
        // 瞬时故障不写（只有 -32002 算失效）；重新登录成功 / logout 已清零。
        invalidatedAt: sessionInvalid ? Date.now() : this.status.session.invalidatedAt,
      },
      lastError: null,
      capabilityNotes: notes,
    };
  }

  /** UPnP 探测：SSDP 优先，失败则直查常见描述路径；都不通返回 null。 */
  private async probeUpnp(gw: string): Promise<Awaited<ReturnType<typeof upnpQuery>> | null> {
    const descPaths = ['/description.xml', '/igd.xml', '/igddesc.xml', '/wanipcn.xml'];
    const tryLocation = async (location: string): Promise<string | null> => {
      const u = new URL(location);
      const res = await httpRequest(location, { port: Number(u.port) || 80, path: u.pathname, timeoutMs: ROUTER.upnpHttpTimeoutMs });
      if (res.error || res.status !== 200) return null;
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
    // 是否需要续链下一跳退避：必须在 finally 清掉 reloginInFlight **之后**再调
    // scheduleRelogin()——否则会被它的 inFlight 幂等守卫拦截，纯内部调度挂不出第二跳
    // （退避链自续断裂；生产被轮询再触发遮蔽，但内部链语义必须自洽）。
    let retry = false;
    try {
      // 每次现读凭据：不常驻明文密码；开关关闭时 provider 返回 null，静默停用
      const creds = await this.reloginProvider();
      if (!creds) return;
      const res = await this.login(creds.user, creds.password);
      if (res.ok) {
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
    } finally {
      this.reloginInFlight = false;
      if (retry) this.scheduleRelogin();
    }
  }

  /** 周期轮询（主进程启动时开启）。 */
  startPolling(onUpdate: (s: RouterStatus) => void): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      const before = this.status.ts;
      const after = await this.refresh();
      if (after.ts !== before) onUpdate(after);
    }, ROUTER.pollMs);
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
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
