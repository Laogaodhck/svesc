/**
 * 共享数据契约 —— 形状冻结（plan.md 第 5 节 + §5.1 契约补充）。
 * 字段名即为渲染层与引擎的唯一边界，任何人不得单方修改。
 */

export type DeviceKind =
  | 'workstation'
  | 'printer'
  | 'router'
  | 'server'
  | 'mobile'
  | 'tablet'
  | 'camera'
  | 'iot'
  | 'ap'
  | 'switch'
  | 'unknown';

export type LinkState = 'online' | 'offline' | 'degraded' | 'scanning';
export type DataSource = 'live' | 'mixed' | 'demo';

export interface NetQuality {
  latencyMs: number | null;
  jitterMs: number | null;
  packetLossPct: number;
  score: number;
  grade: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
  samples: number;
}

export interface BandwidthStat {
  rxBps: number;
  txBps: number;
  share: number;
  connections: number;
  /** 是否存在可归集的局域网流量。false 时 rxBps/txBps 无意义，UI 必须显示"无流量归集"而不是 0 */
  attributable: boolean;
  estimated: boolean;
}

export interface Device {
  id: string;
  ip: string;
  mac: string | null;
  hostname: string | null;
  vendor: string | null;
  osHint: string | null;
  kind: DeviceKind;
  state: LinkState;
  firstSeen: number;
  lastSeen: number;
  openPorts: number[];
  quality: NetQuality;
  bandwidth: BandwidthStat;
  rttHistory: number[];
  isGateway: boolean;
  isSelf: boolean;
  displayName: string | null;
  /**
   * ARP 层检出该 IP 同时对应多个不同 MAC（地址冲突 / ARP 欺骗嫌疑）。
   * 侦测结果联动：true 时设备列表挂红色徽标，并产生 IP_CONFLICT critical 告警。
   */
  ipConflict: boolean;
  /** 用户备注（task-025）；未设置为 undefined/null，由 applyDeviceMeta 注入 */
  note?: string | null;
  /** 用户标签（task-025，≤8 个、每个 ≤24 字符）；未设置时为 undefined 或空数组 */
  tags?: string[];
}

export type ConsumableKind =
  | 'black'
  | 'cyan'
  | 'magenta'
  | 'yellow'
  | 'drum'
  | 'waste'
  | 'other';

export interface Consumable {
  kind: ConsumableKind;
  label: string;
  levelPct: number | null;
  maxCapacity: number | null;
  current: number | null;
  /** 耗材来源：snmp（Printer MIB）/ spooler / ipp（Get-Printer-Attributes）/ unknown */
  source: 'snmp' | 'spooler' | 'ipp' | 'unknown';
}

export type PrinterState =
  | 'idle'
  | 'printing'
  | 'warning'
  | 'error'
  | 'offline'
  | 'unknown';

export interface PrintJob {
  id: string;
  documentName: string;
  owner: string;
  status: string;
  pages: number;
  pagesPrinted: number;
  submittedAt: number;
}

/** 打印任务操作类型（task-024）。 */
export type PrintJobAction = 'cancel' | 'pause' | 'resume';

export interface Printer {
  id: string;
  name: string;
  queueName: string | null;
  /** 用户设置的显示别名（打印管理页设置）；null = 未设置 */
  alias: string | null;
  model: string | null;
  ip: string | null;
  mac: string | null;
  connection: 'network' | 'usb' | 'virtual' | 'unknown';
  state: PrinterState;
  stateDetail: string | null;
  isDefault: boolean;
  shared: boolean;
  /** 是否来自打印管理页的手动添加（自动发现不到也纳入监控） */
  manual: boolean;
  pageCount: number | null;
  consumables: Consumable[];
  jobs: PrintJob[];
  source: 'snmp' | 'ipp' | 'mdns' | 'probe' | 'spooler' | 'both' | 'simulated';
  lastSeen: number;
}

/** 打印管理页：手动添加的网络打印机条目（持久化于 JsonStore）。 */
export interface ManualPrinterEntry {
  ip: string;
  /** 显示名备注；null = 用默认命名 */
  note: string | null;
  addedAt: number;
}

/** 打印管理页配置（渲染层可见的持久化镜像）。 */
export interface PrinterManageConfig {
  manual: ManualPrinterEntry[];
  /** 被忽略（隐藏且不产生告警）的自动发现打印机 id */
  ignored: string[];
}

/**
 * 应用设置（设置页读写；持久化于 JsonStore.settings）。
 * autoScan / autoScanIntervalSec：task-026 后语义为「实时监控开关 / 深度扫描间隔」
 * （字段名保持不变以兼容已持久化设置）；snmpEnabled / useMdns 是打印机采集的
 * 运行时开关（下一轮打印机刷新即生效）。
 */
export interface AppSettings {
  autoScan: boolean;
  /** 深度扫描间隔（秒，task-026 前 UI 语义为"自动扫描间隔"），30-3600 */
  autoScanIntervalSec: number;
  /** 打印机页是否显示本机虚拟打印机（旧值在会话态，现持久化） */
  showVirtualPrinters: boolean;
  /** SNMP 耗材采集（UDP 161）；关闭后耗材只剩 IPP 与打印队列 */
  snmpEnabled: boolean;
  /** mDNS 打印机发现（增强路径，默认关闭） */
  useMdns: boolean;
  /** 点关闭按钮时最小化到系统托盘而不是退出（托盘菜单"退出"始终真正退出） */
  closeToTray: boolean;
  /** 打印机离线/故障/耗材不足时弹系统通知，恢复时同样提醒（默认开启） */
  printerAlerts: boolean;
  /**
   * 是否记住路由器登录凭据（task-022 B-1，默认 true）。
   * 关闭即清除盘上已存凭据，且后续登录不再落盘；自动重登也随之停用。
   */
  rememberRouterPassword: boolean;
}

/** 设置页载荷 = AppSettings + 主进程注入的只读信息。 */
export interface SettingsPayload extends AppSettings {
  /** 应用版本（package.json version，经 app.getVersion() 注入） */
  appVersion: string;
  /** 开机自启当前状态（task-021：OS 为唯一事实源，读 app.getLoginItemSettings()，不进 store） */
  launchAtLogin: boolean;
  /** 开机自启是否可设置（dev 模式注册的是 electron.exe 本体，须用安装版） */
  launchAtLoginAvailable: boolean;
}

// —— 网络诊断与运维（诊断中心 / 日志 / 远程操作） ——

export type DiagKind = 'ping' | 'tracert' | 'ports' | 'dns';

/** 单次网络诊断结果。lines 是已解码的明细（GBK/编码由主进程统一处理）。 */
export interface DiagResult {
  kind: DiagKind;
  target: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  /** 一行结论（人读），如 "4/4 回包 · 平均 3ms" */
  summary: string;
  /** 明细行（原样输出/解析结果，供运维排查） */
  lines: string[];
  /** 权限不足 / 执行失败原因；成功为 null */
  error: string | null;
  /** tracert 专用：结构化跳数表（task-025）；解析失败/非 tracert 为 undefined 或空数组（诚实降级） */
  hops?: TracertHop[];
}

/** tracert 结构化跳（task-025）。`* * *` 行 rtts 全 null、ip/hostname null。 */
export interface TracertHop {
  idx: number;
  ip: string | null;
  hostname: string | null;
  /** 三次探测延迟（ms）；超时为 null */
  rtts: (number | null)[];
}

/** 自定义端口扫描结果（task-025）。 */
export interface PortScanResult {
  ok: boolean;
  /** 全部被扫描端口（升序）与开放状态 */
  ports: { port: number; open: boolean }[];
  /** 仅开放端口（升序） */
  openPorts: number[];
  durationMs: number;
  /** 参数非法 / 校验失败 / 执行异常原因；成功为 null */
  error: string | null;
}

/** 本机网卡（ipconfig /all 解析；数据诚实：拿不到的字段为 null/[]）。 */
export interface NetAdapter {
  name: string;
  state: 'connected' | 'disconnected';
  ip: string | null;
  gateway: string | null;
  dns: string[];
  mac: string | null;
  /** null = 无法判定 */
  dhcp: boolean | null;
}

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

/** 应用运行日志查询结果（环形缓冲，engine 层内存 + 可导出 NDJSON）。 */
export interface LogBundle {
  entries: LogEntry[];
  total: number;
  /** total > entries.length 时为 true（环形缓冲已滚动） */
  truncated: boolean;
}

/**
 * 远程操作类型（task-019 起移除 'ssh'：内网 SSH 使用率低且 Windows 内置 ssh
 * 需目标侧启用 OpenSSH Server，误触率高；识别特征中的端口 22 → SSH 保留）。
 * 历史版本发送的 'ssh' 请求由 ipc 白名单拒绝并返回迁移说明。
 */
export type RemoteOpKind = 'rdp' | 'share';

/**
 * 内置终端单次命令执行结果（task-019）。
 * 受限终端：命令先过主进程白名单校验，拒绝时 ok=false 且 error 给中文原因。
 */
export interface TerminalResult {
  command: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  /** 一行结论（人读），如「已执行（235ms）」「已拒绝」 */
  summary: string;
  /** 已解码输出（逐行；超时截断时末尾带说明行） */
  lines: string[];
  /** 拒绝原因 / 执行失败原因；成功为 null */
  error: string | null;
}

export interface ScanProgress {
  active: boolean;
  pct: number;
  phase: string;
  scanned: number;
  total: number;
  startedAt: number | null;
}

/**
 * 可感知的降级信息（team-lead 批准的契约变更 R-03）。
 * 引擎捕到"命令解析失败 / 权限不足 / 采集异常"时写入快照，避免界面把失败显示成"网络里没有设备"。
 */
export interface WarningEntry {
  source: 'discovery' | 'printers' | 'bandwidth' | 'system' | 'store';
  message: string;
  at: number;
}

export interface SystemStat {
  totalDevices: number;
  online: number;
  offline: number;
  degraded: number;
  printers: number;
  printersWithFault: number;
  /** null = 采样失败/尚未建立基线（"不知道"），0 = 确认为零流量。两者不得混淆。 */
  rxBps: number | null;
  txBps: number | null;
  /** 总带宽历史环（task-025，60 点）：rxBps/txBps 为 null 的点 = 该轮采样失败（曲线断开，诚实呈现） */
  bandwidthHistory: BandwidthPoint[];
  scan: ScanProgress;
  /**
   * task-026 语义：lastScanAt / nextScanInMs / autoScanIntervalSec 均指"深度扫描"
   * （端口/指纹/主机名采集轮）；设备活性判定由 5s 心跳实时覆盖，不再依赖它。
   * autoScan = 实时监控开关（off = 暂停心跳探测与深度扫描，设备状态冻结）。
   */
  lastScanAt: number | null;
  nextScanInMs: number | null;
  autoScan: boolean;
  autoScanIntervalSec: number;
}

/** 总带宽历史单点（task-025）。 */
export interface BandwidthPoint {
  ts: number;
  rxBps: number | null;
  txBps: number | null;
}

// —— 持续 Ping 监控（task-025） ——

/** 监控目标（持久化进 store 的配置部分）。 */
export interface WatchTarget {
  ip: string;
  addedAt: number;
  /** 备注/名字；null = 未设置（UI 显示 IP） */
  note: string | null;
}

/** 监控窗口单点采样。 */
export interface WatchSample {
  ts: number;
  alive: boolean;
  rttMs: number | null;
}

/** 监控目标运行状态（快照推送）。 */
export interface WatchStatus {
  ip: string;
  addedAt: number;
  note: string | null;
  /** 最近最多 60 点采样（旧→新） */
  window: WatchSample[];
  /** 窗口内存活率（%）；无样本为 null */
  upPct: number | null;
  /** 连续宕机起始时刻；在线/无样本为 null */
  downSince: number | null;
  /** unknown = 尚无样本；不猜 */
  state: 'up' | 'down' | 'unknown';
}

export interface Snapshot {
  ts: number;
  subnet: string | null;
  dataSource: DataSource;
  devices: Device[];
  printers: Printer[];
  system: SystemStat;
  /** 持续 Ping 监控目标状态（task-025） */
  watches: WatchStatus[];
  /** 引擎侧的降级/失败信息（去重、上限 20 条、条件恢复后消失） */
  warnings: WarningEntry[];
}

/** 持久化的设备状态转移记录（SQLite device_status_log）。 */
export interface DeviceStatusEvent {
  state: string;
  at: number;
  latencyMs: number | null;
}

export interface DeviceDetail {
  device: Device;
  ports: { port: number; service: string; open: boolean }[];
  connections: { remoteIp: string; remotePort: number; state: string; proto: string }[];
  history: { ts: number; rtt: number | null; rxBps: number; txBps: number }[];
  /** 跨重启的状态转移历史（新→旧，最多 50 条）；JSON 后端/无记录时为空数组（诚实降级） */
  statusHistory: DeviceStatusEvent[];
}

/** 预加载桥暴露给渲染层的 API 形状（plan.md 第 5 节 IPC 通道一一对应）。 */
export interface LanApi {
  getSnapshot(): Promise<Snapshot>;
  refresh(): Promise<{ started: boolean }>;
  setAutoScan(enabled: boolean, intervalSec?: number): Promise<{ autoScan: boolean; intervalSec: number }>;
  getDeviceDetail(deviceId: string): Promise<DeviceDetail | null>;
  /** 导出运行报告（task-025：format 缺省 json，新增 html 自包含报告） */
  exportReport(format?: 'json' | 'html'): Promise<{ ok: boolean; path: string | null; error?: string }>;
  /** 设置设备显示别名（null/空串清除）；与打印机别名共用一张持久化表 */
  setDeviceAlias(deviceId: string, alias: string | null): Promise<{ ok: boolean }>;
  // —— 设备运维（task-025） ——
  /** WOL 网络唤醒：发送 UDP 广播 magic packet；发送成功 ≠ 设备一定唤醒（UDP 无确认） */
  deviceWake(deviceId: string): Promise<{ ok: boolean; error: string | null }>;
  /** 设置设备备注（null/空串清除） */
  deviceSetNote(deviceId: string, note: string | null): Promise<{ ok: boolean }>;
  /** 设置设备标签（数组会被归一化：trim/去空/去重/≤8 个/每个 ≤24 字符；null 清除） */
  deviceSetTags(deviceId: string, tags: string[] | null): Promise<{ ok: boolean }>;
  // —— 持续 Ping 监控（task-025） ——
  /** 当前监控目标与运行状态 */
  watchList(): Promise<WatchStatus[]>;
  watchAdd(ip: string, note?: string | null): Promise<{ ok: boolean; error: string | null }>;
  watchRemove(ip: string): Promise<{ ok: boolean }>;
  // —— 诊断扩展（task-025） ——
  /** 自定义端口范围扫描（单次 ≤1024 端口） */
  diagPortScan(ip: string, from: number, to: number): Promise<PortScanResult>;
  // —— 配置（task-025） ——
  /** 导出配置到下载目录（settings+别名+备注+标签+监控+打印管理+firstSeen） */
  configExport(): Promise<{ ok: boolean; path: string | null; error?: string }>;
  /** 导入配置（渲染层传 JSON 文本；逐键合并，非法键跳过并计入 skipped） */
  configImport(json: string): Promise<{ ok: boolean; imported: string[]; skipped: string[]; error: string | null }>;
  routerGetStatus(): Promise<RouterStatus>;
  routerRefresh(): Promise<RouterStatus>;
  routerLogin(
    user: string,
    password: string,
  ): Promise<{ ok: boolean; error: string | null; persisted: boolean; persistError: string | null }>;
  routerLogout(): Promise<{ ok: boolean }>;
  /** 打开内置浏览器窗口访问路由器管理页，用户在真实页面上完成登录 */
  /**
   * 检测路由器管理页会话（task-032）：主进程读 persist:router-admin 分区的会话
   * Cookie，命中即 router.markWebSession(true)。页面内嵌 webview（不再弹窗）在
   * dom-ready / did-navigate 后调用。
   */
  routerCheckWebSession(): Promise<{ session: boolean }>;
  // —— 打印管理 ——
  printerGetManageConfig(): Promise<PrinterManageConfig>;
  printerRefresh(): Promise<{ ok: boolean; error: string | null }>;
  printerAddManual(ip: string, note: string | null): Promise<{ ok: boolean; error: string | null }>;
  printerRemoveManual(ip: string): Promise<{ ok: boolean }>;
  printerSetIgnored(printerId: string, ignored: boolean): Promise<{ ok: boolean }>;
  printerSetAlias(printerId: string, alias: string | null): Promise<{ ok: boolean }>;
  /** 打印任务操作（task-024）：取消/暂停/恢复；错误如实透出不吞 */
  printerJobAction(
    action: PrintJobAction,
    printerName: string,
    jobId: string,
  ): Promise<{ ok: boolean; error: string | null }>;
  /** 让打印机打印一张测试页（rundll32 printui） */
  printerPrintTestPage(printerName: string): Promise<{ ok: boolean; error: string | null }>;
  /** 设为系统默认打印机（CIM Win32_Printer.SetDefaultPrinter） */
  printerSetDefault(printerName: string): Promise<{ ok: boolean; error: string | null }>;
  /** 用内置浏览器窗口打开打印机 Web 管理页（http://<ip>） */
  printerOpenAdmin(ip: string): Promise<{ ok: boolean; error: string | null; url: string | null }>;
  // —— 设置页 ——
  settingsGet(): Promise<SettingsPayload>;
  /** 局部更新：只传需要变更的字段，返回更新后的完整设置 */
  settingsUpdate(patch: Partial<AppSettings>): Promise<SettingsPayload>;
  /** 开机自启开关（task-021：主进程 setLoginItemSettings + 写后回读验证；dev 模式返回不可用文案） */
  setLaunchAtLogin(on: boolean): Promise<{ ok: boolean; error: string | null }>;
  // —— 网络诊断 / 日志 / 远程操作 ——
  diagRun(kind: DiagKind, target: string): Promise<DiagResult>;
  diagAdapters(): Promise<NetAdapter[]>;
  logsGetRecent(limit?: number): Promise<LogBundle>;
  logsExport(): Promise<{ ok: boolean; path: string | null; error?: string }>;
  /** 远程操作：rdp=mstsc、share=资源管理器打开 \\target（task-019 起移除 ssh） */
  remoteOpen(kind: RemoteOpKind, target: string, user?: string): Promise<{ ok: boolean; error: string | null }>;
  /** 内置终端：执行一条白名单内命令（主进程二次校验，渲染层不可绕过） */
  terminalRun(command: string): Promise<TerminalResult>;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  onScanProgress(cb: (p: ScanProgress) => void): () => void;
  onRouterStatus(cb: (s: RouterStatus) => void): () => void;
}

// —— 路由器管理（能力探测 + 诚实降级）——

/**
 * 路由器管理协议能力，每项独立探测。
 * false 的能力 UI 必须显示"该路由器不支持"，绝不假装可操作。
 */
export interface RouterCapabilities {
  /** UPnP IGD：WAN IP / 流量计数器 / 重启 */
  upnp: boolean;
  /** OpenWrt ubus JSON-RPC 协议支持（与登录态正交：未登录也可为 true，登录态看 session.loggedIn） */
  openwrt: boolean;
  /** HTTP 管理页可达且识别出品牌指纹 */
  managementPage: boolean;
}

export type RouterBrand =
  | 'openwrt'
  | 'tplink'
  | 'xiaomi'
  | 'asus'
  | 'huawei'
  | 'netgear'
  | 'tenda'
  | 'zte'
  | 'h3c'
  | 'ruijie'
  | 'mercury'
  | 'linksys'
  | 'dlink'
  | 'glinet'
  | 'generic'
  | null;

export interface RouterIdentity {
  ip: string;
  brand: RouterBrand;
  /** 指纹细节（Server 响应头 / 页面标题 / UPnP modelName），识别不出为 null */
  modelHint: string | null;
  /** UPnP device description 的 friendlyName */
  upnpFriendlyName: string | null;
  /** 管理页最终可达 URL（含重定向落点），供内置浏览器直接打开；探测不出为 null */
  adminUrl: string | null;
}

export interface DhcpLease {
  ip: string;
  mac: string;
  hostname: string | null;
  /** unix ms；null = 未知或无限租期 */
  expiresAt: number | null;
}

/**
 * 路由器通道 → 设备识别管线的单向提示（task-022 C-1）。
 * 引擎只读不持久化：路由器通道每轮刷新即重灌，主机名来自 DHCP 租约的设备自报，
 * 是比 rDNS 更权威的 hostname 来源。仅当设备自身 hostname 为空时回填，绝不覆盖。
 */
export interface RouterHints {
  leaseHostnames: DhcpLease[];
}

export interface WirelessClient {
  mac: string;
  ssid: string | null;
  /** 负数 dBm；设备不报告为 null */
  signalDbm: number | null;
  rxRateKbps: number | null;
  txRateKbps: number | null;
  connectedForSec: number | null;
}


/**
 * OpenWrt 无线射频状态（task-024，iwinfo）。
 * 任一字段设备不报告即 null，不猜。
 */
export interface WirelessBandStatus {
  /** 无线射频设备名，如 radio0 / radio1 */
  device: string;
  ssid: string | null;
  channel: number | null;
  /** 已关联客户端数（assoclist 长度） */
  clientCount: number | null;
}

/** 路由器通道快照（独立 IPC 推送，不进 Snapshot 冻结契约）。 */
export interface RouterStatus {
  ts: number;
  /** probing=探测中 / ready=探测完成 / unreachable=网关不可达 */
  phase: 'probing' | 'ready' | 'unreachable';
  identity: RouterIdentity | null;
  capabilities: RouterCapabilities;
  /** UPnP 通道数据（capabilities.upnp=false 时全部 null，不得填 0） */
  wan: {
    ip: string | null;
    /** UPnP 累计计数器（字节）；设备不提供该 action 时为 null */
    totalBytesRx: number | null;
    totalBytesTx: number | null;
    /** 相对上一次采样的速率；样本不足 2 次为 null */
    rxBps: number | null;
    txBps: number | null;
    /** GetStatusInfo 的连接状态（如 Connected）；设备不提供该 action 时为 null（task-024） */
    connectionStatus: string | null;
    /** GetStatusInfo 的连接时长（秒）；设备不提供该 action 时为 null（task-024） */
    uptimeSec: number | null;
  };
  /** OpenWrt 通道数据（未登录 / 不支持时为空数组，绝不编造） */
  dhcpLeases: DhcpLease[];
  wirelessClients: WirelessClient[];
  /**
   * OpenWrt 无线射频状态（task-024）。
   * null = 未登录或不支持（区别于 []：已登录但拿不到任何射频也如实给空数组）。
   */
  wirelessStatus: WirelessBandStatus[] | null;
  systemBoard: {
    hostname: string | null;
    model: string | null;
    firmware: string | null;
    uptimeSec: number | null;
  } | null;
  /**
   * 会话状态。kind 区分会话来源：
   *  - 'ubus'：OpenWrt 账密登录（可取 DHCP 租约 / 无线客户端 / 系统信息）
   *  - 'web' ：内置浏览器登录管理页后由 Cookie 检测建立（不代表 ubus 数据可用）
   *  - 'basic'：管理页 HTTP Basic-Auth 通用登录（task-024，仅登录态展示，不解析页面内容）
   *  - null  ：未登录
   */
  session: {
    loggedIn: boolean;
    user: string | null;
    error: string | null;
    kind: 'ubus' | 'web' | 'basic' | null;
    /**
     * 观测到会话被服务端作废（-32002）的时刻（unix ms，task-022 B-2）；
     * null = 会话有效或从未建立。粘性：观测到一次即保留，直到重新登录成功或 logout。
     * 主进程据此触发自动重登（退避 60s×2ⁿ，上限 10min，连续 3 次失败停用）。
     */
    invalidatedAt: number | null;
  };
  /** 最近一次探测/操作的失败说明；null = 一切正常 */
  lastError: string | null;
  /** 不可用能力的解释文案，如"该路由器不提供 UPnP IGD" */
  capabilityNotes: string[];
}
