/**
 * 纯格式化函数 —— 无 React 依赖，无副作用。
 *
 * 数据诚实原则（见 plan §5.1 / investigation §5）：
 * 任何 `null` 都不允许被兜底成 0 或空串冒充真实值，必须由调用方
 * 显式展示「未采样 / 不报告 / 无流量归集」。本文件只提供格式化，
 * 不替调用方做「null → 0」的决定。
 */

const BIT_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'] as const

/**
 * 速率：`rxBps / txBps` 的单位是 **bit/s**（引擎 `Δbytes × 8 / Δt`），
 * 不是 B/s。按 SI（1000）进位，保留 1–2 位小数。
 *
 * 历史坑：早期版本按 B/s 显示，11,285,049 bit/s（≈11.3 Mbit/s）会被写成 10.76 M/s，
 * 差 8 倍——运维据此判断链路是否打满，这类错误不可接受。
 *
 * `null` = 本轮未能采样，由调用方决定显示「—」，这里只返回破折号，
 * **绝不把它当 0 bps**（0 = 确认为零流量，语义完全不同）。
 */
export function fmtBitRate(bps: number | null): string {
  const p = fmtBitRateParts(bps)
  return p.unit ? `${p.value} ${p.unit}` : p.value
}

/** 速率拆成数值与单位两段，供 KPI 用不同字号排版。 */
export function fmtBitRateParts(bps: number | null): { value: string; unit: string } {
  if (bps === null || !Number.isFinite(bps) || bps < 0) return { value: '—', unit: '' }
  if (bps < 1000) return { value: String(Math.round(bps)), unit: 'bps' }
  let v = bps
  let i = 0
  while (v >= 1000 && i < BIT_UNITS.length - 1) {
    v /= 1000
    i += 1
  }
  const digits = v >= 10 ? 1 : 2
  return { value: v.toFixed(digits), unit: BIT_UNITS[i] }
}

/** 速率紧凑形式：11.3M / 193K，用于窄列（单位由表头声明 bit/s）。 */
export function fmtBitRateCompact(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps) || bps < 0) return '—'
  if (bps < 1000) return String(Math.round(bps))
  if (bps < 1e6) return `${(bps / 1e3).toFixed(bps < 1e4 ? 1 : 0)}K`
  if (bps < 1e9) return `${(bps / 1e6).toFixed(bps < 1e7 ? 2 : 1)}M`
  return `${(bps / 1e9).toFixed(1)}G`
}

/** 毫秒延迟：整数化，避免 12.0000001ms 抖动。 */
export function fmtMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 10) return `${ms.toFixed(1)} ms`
  return `${Math.round(ms)} ms`
}

/** 百分比：整数（丢包率、占比）。 */
export function fmtPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—'
  return `${Math.round(pct * 10) / 10}%`
}

/** 整数 + 千分位。 */
export function fmtInt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US')
}

/** 时钟 HH:mm:ss —— 状态条与顶栏用。 */
export function fmtClock(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 日期时间 YYYY-MM-DD HH:mm:ss —— 首次/最后发现用。 */
export function fmtDateTime(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`
}

/** 短日期时间（表格列内）：`MM-DD HH:mm`；完整时刻用 title 展示 fmtDateTime。 */
export function fmtDateTimeShort(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 相对时间：3 分钟前。 */
export function relTime(ts: number | null, now: number = Date.now()): string {  if (ts === null || !Number.isFinite(ts)) return '—'
  const diff = now - ts
  if (diff < 0) return '刚刚'
  const s = Math.floor(diff / 1000)
  if (s < 10) return '刚刚'
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return fmtDateTime(ts)
}

/** 倒计时：12s / 1m 05s。 */
export function fmtCountdown(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}

/** MAC 统一小写冒号分隔；null 原样返回 null（由 UI 显示 —）。 */
export function fmtMac(mac: string | null): string | null {
  if (!mac) return null
  const hex = mac.replace(/[^0-9a-f]/gi, '')
  if (hex.length !== 12) return mac
  return hex
    .toLowerCase()
    .match(/.{2}/g)!
    .join(':')
}

/** 设备类型中文名。 */
export const KIND_LABEL: Record<string, string> = {
  workstation: '工作站',
  printer: '打印机',
  router: '路由',
  camera: '监控摄像',
  server: '服务器',
  mobile: '手机',
  iot: '物联网',
  unknown: '未知',
}

/** 链路状态中文名。 */
export const STATE_LABEL: Record<string, string> = {
  online: '在线',
  offline: '离线',
  degraded: '降级',
  scanning: '扫描中',
}

/** 质量等级中文名。 */
export const GRADE_LABEL: Record<string, string> = {
  excellent: '优',
  good: '良',
  fair: '中',
  poor: '差',
  unknown: '未采样',
}

/**
 * 告警严重度中文名（task-017 统一分级口径）：
 * critical=紧急（设备离线/打印机故障/IP 冲突，需立即处置）、
 * warning=重要（质量劣化/耗材偏低，需关注）、info=一般（新设备接入等事件提示）。
 */
export const SEVERITY_LABEL: Record<string, string> = {
  critical: '紧急',
  warning: '重要',
  info: '一般',
}

/** 打印机状态中文名。 */
export const PRINTER_STATE_LABEL: Record<string, string> = {
  idle: '待机',
  printing: '打印中',
  warning: '警告',
  error: '故障',
  offline: '离线',
  unknown: '未知',
}

/** 打印机连接方式中文名。 */
export const CONNECTION_LABEL: Record<string, string> = {
  network: '网络',
  usb: 'USB',
  virtual: '虚拟',
  unknown: '未知',
}

/** 打印机数据源角标文案。 */
export const PRINTER_SOURCE_LABEL: Record<string, string> = {
  snmp: 'SNMP',
  spooler: '系统队列',
  both: 'SNMP + 队列',
  simulated: '模拟',
}

/** 耗材数据源徽标文案（snmp / spooler / ipp / unknown）。 */
export const CONSUMABLE_SOURCE_LABEL: Record<string, string> = {
  snmp: 'SNMP',
  spooler: '系统队列',
  ipp: 'IPP',
  unknown: '未知',
}

/** 耗材类型中文名（label 为空时兜底）。 */
export const CONSUMABLE_LABEL: Record<string, string> = {
  black: '黑',
  cyan: '青',
  magenta: '洋红',
  yellow: '黄',
  drum: '感光鼓',
  waste: '废粉',
  other: '其他',
}

/** 已知端口 → 服务名。仅用于展示 chip 的副标签。 */
export const PORT_SERVICE: Record<number, string> = {
  22: 'SSH',
  23: 'Telnet',
  53: 'DNS',
  80: 'HTTP',
  135: 'RPC',
  139: 'NetBIOS',
  443: 'HTTPS',
  445: 'SMB',
  515: 'LPD',
  631: 'IPP',
  902: 'VMware',
  1433: 'MSSQL',
  3306: 'MySQL',
  3389: 'RDP',
  5432: 'PostgreSQL',
  5900: 'VNC',
  8080: 'HTTP-Alt',
  8443: 'HTTPS-Alt',
  9100: 'RAW-Print',
  161: 'SNMP',
}

export function portService(port: number, fallback = 'TCP'): string {
  return PORT_SERVICE[port] ?? fallback
}

/** 把数值裁剪到区间。 */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
