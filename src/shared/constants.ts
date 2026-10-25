/** 全局常量：端口表、超时预算、分频、并发、阈值。引擎与测试共用的唯一定义处。 */

/** 端口探测集合（plan.md 第 3 节冻结）。 */
export const PROBE_PORTS = [22, 80, 443, 445, 515, 631, 9100, 3389, 554, 62078] as const;

/** 判定"网络打印机"的端口：9100(JetDirect) / 631(IPP) / 515(LPD)。 */
export const PRINTER_PORTS = [9100, 631, 515] as const;

/** 设备详情页展示的端口 → 服务名。 */
export const PORT_SERVICE: Readonly<Record<number, string>> = {
  22: 'SSH',
  80: 'HTTP',
  139: 'NetBIOS',
  443: 'HTTPS',
  445: 'SMB',
  515: 'LPD',
  548: 'AFP',
  554: 'RTSP',
  631: 'IPP',
  3389: 'RDP',
  9100: 'JetDirect',
  62078: 'iPhone Sync',
};

/** 硬超时（毫秒）。实测依据见 investigation-report.md §2.11。 */
export const TIMEOUTS = {
  ping: 800,
  pingKill: 1200,
  arp: 2000,
  netstat: 3000,
  powershell: 8000,
  portConnect: 700,
  portsSweep: 350,
  dnsReverse: 800,
  snmp: 900,
  mdns: 1500,
} as const;

/** 子进程全局并发上限（实测 64@64=1523ms 无瓶颈）。 */
export const CONCURRENCY = {
  pingSweep: 64,
  portSweep: 64,
  dnsReverse: 8,
  powershell: 1,
  childGlobal: 64,
} as const;

/** 分频任务表（毫秒）。 */
export const SCHEDULE = {
  devices: 5000,
  bandwidth: 2000,
  printers: 15000,
  fullScan: 60000,
} as const;

/** 单轮全量子网扫描预算；超预算即用已得结果出快照。 */
export const SCAN_BUDGET_MS = 10000;

/** 质量评分阈值（plan.md §5.1 与 brief §3 quality 公式冻结）。 */
/**
 * 质量结论的置信门：≥8 个样本（= 2 个 `ping -n 4` 批次）才允许出 grade / 判 degraded。
 *
 * 单一来源：`computeQuality` 的 grade 门、`isDegraded`、`NET_QUALITY` 告警全部引用本常量。
 * 原因：单批次 4 包的最小丢包粒度就是 25%，1 包被设备限速即越过 20% 阈值，会闪变；
 * 2 个批次才具备区分"持续丢包"与"单包抖动"的判别力。
 */
export const QUALITY_MIN_SAMPLES = 8;

/** 质量评分阈值（plan.md §5.1 与 brief §3 quality 公式冻结）。 */
export const QUALITY = {
  excellent: 85,
  good: 70,
  fair: 50,
  degradedLatencyMs: 150,
  degradedLossPct: 20,
  slaLatencyMs: 20,
  /** @deprecated 用顶层 `QUALITY_MIN_SAMPLES`；仅为渲染层过渡保留别名（同一数值来源） */
  degradedMinSamples: QUALITY_MIN_SAMPLES,
} as const;

/** 滑动窗口与历史长度。 */
export const WINDOW = {
  qualitySamples: 20,
  rttHistory: 60,
  alarmHistory: 500,
  /** snapshot.warnings 上限（超出裁最旧） */
  warnings: 20,
} as const;

/** 告警阈值。 */
export const ALARM_THRESHOLDS = {
  supplyLowPct: 10,
  supplyCriticalPct: 5,
  poorGradeRounds: 2,
  offlineArpMisses: 3,
  /**
   * 告警抑制窗口（毫秒，task-017）：同因告警清除后 10 分钟内再次触发 → 合并回
   * 原记录（occurrences+1 / trace 记 re-raised），不新建、不重复推送，
   * 抑制网络抖动（离线闪断 / 耗材临界反复穿越 / 打印机间歇失联）造成的误报刷屏。
   * 窗口外照常新建（历史事实不吞）。
   */
  suppressWindowMs: 600_000,
} as const;

/** 单条告警的流转账目上限（最新 50 条，超出裁最旧；raise 恒保留首条）。 */
export const ALARM_TRACE_MAX = 50;

/**
 * DEVICE_NEW 存活时长（毫秒）：新设备告警产生后保持 active，
 * 仅当用户 ack 或满 10 分钟才自动 resolved（事件型告警必须让用户看得见）。
 */
export const NEW_DEVICE_TTL_MS = 600_000;

/**
 * 质量采样口径：只有 `ping -n 4` 的批量采样进入质量窗口，
 * 扫描/心跳阶段的单次存活 ping 不计入（否则"期望样本数 > 回复数"会造出假丢包）。
 */
export const QUALITY_SAMPLE = {
  intervalMs: 15_000,
  targetsPerRound: 12,
  concurrency: 8,
  packetCount: 4,
} as const;

/** 端口探测的超时（brief §3 ports.ts 规定 350ms，Vera 实测建议 700ms）。
 *  取 700ms：350ms 在跨网段/低端打印机上会漏判（实测 .170/.235 均在 700ms 内响应）。
 *  并发池 64，只对 ARP 在位主机探测，总耗时可控。 */
export const PORT_CONNECT_TIMEOUT_MS = TIMEOUTS.portConnect;

/** 网络打印机探活顺序：先 9100，再 631，再 515。 */
export const PRINTER_PROBE_ORDER = [9100, 631, 515] as const;

/** 演示数据源触发阈值：真实设备少于该数量时启用模拟源。 */
export const DEMO_DEVICE_THRESHOLD = 3;

/** OUI 前缀表最少条目数（oui.ts 必须满足，低于此值视为契约破坏）。 */
export const OUI_TABLE_MIN_ENTRIES = 60;

/**
 * 路由器管理探测预算。
 * 全部走 node:http / node:dgram（零依赖），与引擎层同一约束：不 import electron。
 */
export const ROUTER = {
  /** UPnP SSDP M-SEARCH 等待窗口 */
  ssdpTimeoutMs: 1500,
  /** UPnP description/SOAP 单次请求 */
  upnpHttpTimeoutMs: 2000,
  /** 管理页指纹探测单次请求 */
  pageProbeTimeoutMs: 1500,
  /** ubus JSON-RPC 单次请求 */
  ubusTimeoutMs: 2500,
  /** 路由器状态轮询周期 */
  pollMs: 10_000,
  /** 能力探测失败后的重试周期 */
  detectRetryMs: 60_000,
  /** 管理页探测端口顺序 */
  pagePorts: [80, 8080, 443] as const,
  /** UPnP 描述端口 */
  upnpPort: 1900,
} as const;

/**
 * 网络诊断中心预算。
 * tracert 全程可能 15-20s，超时硬杀并返回已收到的跳数（诚实截断，不报错）。
 */
export const DIAG = {
  pingTimeoutMs: 8000,
  tracertTimeoutMs: 30_000,
  dnsTimeoutMs: 4000,
  ipconfigTimeoutMs: 5000,
  /** tracert 最大跳数 */
  tracertMaxHops: 15,
  /** 应用运行日志环形缓冲上限 */
  logRingMax: 2000,
  /** 日志导出文件单批上限（条） */
  logExportLimit: 2000,
} as const;
