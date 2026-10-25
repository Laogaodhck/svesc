import { useEffect, useMemo } from 'react'
import type { Alarm, Printer } from '../../shared/types'
import { StatusPill } from '../components/atoms/StatusPill'
import { LevelBar } from '../components/atoms/LevelBar'
import { Bar } from '../components/atoms/Bar'
import { EmptyState } from '../components/atoms/EmptyState'
import { Icon } from '../components/Icon'
import { consumableColor, printerStateTone } from '../lib/semantics'
import {
  CONSUMABLE_LABEL,
  CONSUMABLE_SOURCE_LABEL,
  CONNECTION_LABEL,
  PRINTER_SOURCE_LABEL,
  PRINTER_STATE_LABEL,
  fmtInt,
  relTime,
} from '../lib/format'

export interface PrintersViewProps {
  printers: Printer[]
  alarms: Alarm[]
  scanning: boolean
  now: number
  /** 是否显示本机虚拟打印机（状态提升到 App，切视图/刷新都不丢） */
  showVirtual: boolean
  onToggleVirtual: () => void
  onRefresh: () => void
  /** 告警跳转定位：滚动到该打印机卡并高亮（消费后回调 onFocusConsumed） */
  focusId?: string | null
  onFocusConsumed?: () => void
}

/** source 含 snmp：'snmp' 与 'both' 都算（前者纯 SNMP，后者 SNMP + 队列） */
function hasSnmpSource(p: Printer): boolean {
  return p.source === 'snmp' || p.source === 'both'
}

interface SuppliesNote {
  /** 主行（≤14 字），只在真的取不到余量时出现 */
  title: string
  /** 副行：一句具体原因 */
  sub: string
  /** 完整解释，放 title 属性 */
  explain: string
}

/**
 * 耗材空态的分支依据「数据实际从哪来」，绝不写死一句话——
 * 否则会出现「徽标写着 SNMP 通了、文案却说 SNMP 没响应」的自相矛盾。
 *
 * 判定顺序（顺序本身即语义，不要调换）：
 *   1. 有真实余量 → 不出现空态
 *   2. 无 IP（WSD 端口等）→ 从未探测过，绝不能写"无响应"
 *   3. 有耗材条目但容量全空 → 按 source 分「SNMP 未报告容量」/「条目无余量字段」
 *   4. 空耗材表 → 按 source 分「设备不报告耗材」/「未启用 SNMP」
 * 只有走到第 4 支的 else 分支，才意味着"确实探测过 UDP 161 且失败"。
 */
function suppliesNote(p: Printer): SuppliesNote | null {
  const cons = p.consumables
  const anyLevel = cons.some((c) => c.levelPct !== null)
  if (cons.length > 0 && anyLevel) return null

  // 优先于一切 SNMP 文案：没有 IP 就没有探测，任何"无响应"都是虚假陈述
  if (p.ip === null && p.connection !== 'virtual') {
    return {
      title: '无 IP 地址，无法探测耗材',
      sub: 'WSD 端口未解析出 IP',
      explain: '该打印机通过 WSD 端口接入且系统未解析出 IP，SNMP/IPP 均无法探测。',
    }
  }

  const snmp = hasSnmpSource(p)

  if (cons.length > 0 && !anyLevel) {
    return snmp
      ? {
          title: 'SNMP 未报告耗材容量',
          sub: 'maxCapacity 为 -2/-3，视为未知',
          explain:
            '设备已响应 SNMP，但未报告耗材容量：maxCapacity 返回 -2/-3，按 RFC 8010 语义为未知/无限，因此没有百分比余量。',
        }
      : {
          title: '耗材条目无余量字段',
          sub: '设备返回了条目但容量为空',
          explain: '设备返回了耗材条目，但所有容量字段为空，无法换算百分比。',
        }
  }

  return snmp
    ? {
        title: '设备不报告耗材',
        sub: 'SNMP 返回了空耗材表',
        explain: '设备已响应 SNMP，但 Printer MIB 未返回任何耗材条目。',
      }
    : {
        title: '未启用 SNMP',
        sub: 'UDP 161 无响应，队列无墨量',
        explain: '未启用 SNMP（UDP 161 无响应），系统打印队列接口不提供耗材属性。',
      }
}

function Supplies({ printer }: { printer: Printer }) {
  const note = suppliesNote(printer)

  if (note) {
    return (
      <div className="consumables__empty" title={note.explain}>
        <Icon name="info" size={14} className="dim note__icon" />
        <div className="u-stack u-stack-2">
          <span className="u-115 muted">{note.title}</span>
          <span className="u-105 muted">{note.sub}</span>
        </div>
      </div>
    )
  }

  const sources = Array.from(new Set(printer.consumables.map((c) => c.source)))

  return (
    <div className="u-stack u-stack-5">
      <div className="consumables">
        {printer.consumables.map((c, i) => {
          const name = c.label || CONSUMABLE_LABEL[c.kind] || c.kind
          const from = CONSUMABLE_SOURCE_LABEL[c.source] ?? c.source
          return (
            <LevelBar
              key={`${c.kind}-${i}`}
              pct={c.levelPct}
              label={name}
              color={consumableColor(c.kind)}
              title={
                c.levelPct === null
                  ? `${name}：设备不报告余量（来源 ${from}）`
                  : `${name}：剩余 ${Math.round(c.levelPct)}%（来源 ${from}）`
              }
            />
          )
        })}
      </div>
      <span className="u-105 dim">耗材来源 {sources.map((s) => CONSUMABLE_SOURCE_LABEL[s] ?? s).join(' · ')}</span>
    </div>
  )
}

function PrinterCard({ printer, now, focus }: { printer: Printer; now: number; focus: boolean }) {
  const tone = printerStateTone(printer.state)
  const isFault = printer.state === 'error' || printer.state === 'warning'
  const jobs = printer.jobs
  const shownJobs = jobs.slice(0, 5)
  const overflow = jobs.length - shownJobs.length

  return (
    <article
      className={focus ? 'card printer-card is-focused' : 'card printer-card'}
      id={`printer-card-${printer.id}`}
    >
      {isFault && (
        <div className="fault-banner" data-tone={printer.state === 'error' ? 'crit' : 'warn'}>
          <Icon name="warn" size={14} />
          <span className="fault-banner__text">
            {printer.stateDetail ?? (printer.state === 'error' ? '打印机报告故障，需现场处理' : '打印机报告警告状态')}
          </span>
        </div>
      )}

      <div className="printer-card__head">
        <div className="printer-card__title">
          <span className="printer-card__name" title={printer.alias ?? printer.name}>
            {printer.alias ?? printer.name}
          </span>
          {printer.alias && <span className="printer-card__origname">{printer.name}</span>}
          <div className="printer-card__tags">
            {printer.manual && <span className="chip chip--plain">手动</span>}
            {printer.isDefault && <span className="chip chip--accent">默认</span>}
            {printer.shared && <span className="chip chip--plain">共享</span>}
            {printer.connection !== 'network' && (
              <span className="chip chip--plain">{CONNECTION_LABEL[printer.connection]}</span>
            )}
          </div>
        </div>
        <StatusPill tone={tone}>{PRINTER_STATE_LABEL[printer.state] ?? printer.state}</StatusPill>
      </div>

      <div className="printer-card__meta">
        <span>{printer.model ?? <span className="na">型号未知</span>}</span>
        <span className="dim">·</span>
        <span className="mono">{printer.ip ?? '无 IP'}</span>
        <span className="dim">·</span>
        <span>{CONNECTION_LABEL[printer.connection]}</span>
        <span
          className="src-badge"
          data-sim={printer.source === 'simulated' ? 'true' : undefined}
          title={
            printer.source === 'simulated'
              ? '演示数据：该打印机条目由模拟数据源生成'
              : `数据来源：${PRINTER_SOURCE_LABEL[printer.source]}`
          }
        >
          {PRINTER_SOURCE_LABEL[printer.source] ?? printer.source}
        </span>
        {printer.pageCount !== null && (
          <span className="dim">累计 {fmtInt(printer.pageCount)} 页</span>
        )}
      </div>

      <div className="printer-card__body">
        {printer.connection !== 'virtual' && <Supplies printer={printer} />}

        <div className="u-stack u-stack-5">
          <div className="row-between">
            <span className="u-caps">队列</span>
            <span className="u-105 dim">{jobs.length === 0 ? '空闲' : `${jobs.length} 项`}</span>
          </div>
          {shownJobs.length === 0 ? (
            <span className="u-11 dim">队列为空 · 最后发现 {relTime(printer.lastSeen, now)}</span>
          ) : (
            <div className="jobs">
              {shownJobs.map((job) => {
                const pct =
                  job.pages > 0 ? Math.min(100, (job.pagesPrinted / job.pages) * 100) : null
                return (
                  <div className="job" key={job.id}>
                    <span className="job__doc" title={job.documentName}>
                      {job.documentName}
                    </span>
                    <span className="job__meta">
                      {job.owner} · {job.pages > 0 ? `${job.pagesPrinted}/${job.pages}` : '页数未知'}
                    </span>
                    <div className="job__bar">
                      <Bar value={pct} max={100} color="var(--accent)" />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {overflow > 0 && <span className="jobs__more">+{overflow} 项排队</span>}
        </div>
      </div>
    </article>
  )
}

export function PrintersView({
  printers,
  alarms,
  scanning,
  now,
  showVirtual,
  onToggleVirtual,
  onRefresh,
  focusId,
  onFocusConsumed,
}: PrintersViewProps) {
  // 本机虚拟打印机（PDF / XPS / Fax）不属于局域网监控范围，默认隐藏
  const networkPrinters = useMemo(
    () => printers.filter((p) => p.connection === 'network'),
    [printers]
  )
  const virtualCount = useMemo(
    () => printers.filter((p) => p.connection === 'virtual').length,
    [printers]
  )
  const visible = useMemo(
    () => (showVirtual ? printers : printers.filter((p) => p.connection !== 'virtual')),
    [printers, showVirtual]
  )

  // 在线 = 网络可达（idle/printing/warning/error 都意味着设备有响应）；离线单列
  const onlineCount = networkPrinters.filter((p) => p.state !== 'offline' && p.state !== 'unknown').length
  const offlineCount = networkPrinters.filter((p) => p.state === 'offline').length
  const faultCount = networkPrinters.filter((p) => p.state === 'error').length

  // 告警从 alarms 实时统计（未恢复），与侧边栏/总览同口径（审计 L-1）
  const activeAlarms = useMemo(
    () => alarms.filter((a) => a.targetType === 'printer' && a.resolvedAt === null).length,
    [alarms]
  )

  // 审计 L-2：告警跳转定位——滚动到目标卡并高亮，消费后回调清除
  useEffect(() => {
    if (!focusId) return
    const el = document.getElementById(`printer-card-${focusId}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = window.setTimeout(() => onFocusConsumed?.(), 2500)
    return () => window.clearTimeout(timer)
  }, [focusId, onFocusConsumed])

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">打印机</div>
          <div className="view-desc">
            状态叠加网络探活（9100/631/515）；耗材取不到时显示「不报告」，不以 0% 冒充。
          </div>
        </div>
        <div className="toolbar__meta">
          网络打印机 <span className="mono">{networkPrinters.length}</span> 台 · 在线{' '}
          <span className="mono">{onlineCount}</span> · 离线{' '}
          <span className="mono">{offlineCount}</span> · 故障{' '}
          <span className="mono">{faultCount}</span> · 活动告警{' '}
          <span className="mono">{activeAlarms}</span>
          {showVirtual && virtualCount > 0 && (
            <>
              {' · '}虚拟 <span className="mono">{virtualCount}</span>
            </>
          )}
        </div>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className="switch-field"
          aria-pressed={showVirtual}
          onClick={onToggleVirtual}
          title="本机虚拟打印机（Microsoft Print to PDF / XPS / Fax 等）不参与网络监控"
        >
          <span className="switch" data-on={showVirtual} aria-hidden="true">
            <span className="switch__knob" />
          </span>
          显示本机虚拟打印机
        </button>
        {!showVirtual && virtualCount > 0 && (
          <span className="toolbar__meta">已隐藏 {virtualCount} 台虚拟设备</span>
        )}
        <span className="toolbar__spacer" />
        <button
          type="button"
          className="btn btn--sm"
          onClick={onRefresh}
          disabled={scanning}
          title="重新探测打印机状态与队列"
        >
          <Icon name="refresh" size={12} className={scanning ? 'is-spinning' : undefined} />
          {scanning ? '扫描中…' : '重新探测'}
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="card">
          {printers.length > 0 ? (
            <EmptyState
              icon="printer"
              title="没有可监控的网络打印机"
              desc={
                <>
                  本机只存在 {virtualCount} 台虚拟打印机（PDF / XPS / Fax），它们不参与局域网监控。
                  <br />
                  如需查看，打开上方「显示本机虚拟打印机」。
                </>
              }
              actions={
                <button type="button" className="btn" onClick={onToggleVirtual}>
                  显示虚拟打印机
                </button>
              }
            />
          ) : (
            <EmptyState
              icon="printer"
              title="未发现网络打印机"
              desc={
                <>
                  该网络内没有响应 9100/631 的打印设备，系统打印队列也为空。
                  <br />
                  若打印机使用 WSD 或处于休眠，可先手动唤醒后重新扫描。
                </>
              }
              actions={
                <button type="button" className="btn btn--primary" onClick={onRefresh} disabled={scanning}>
                  <Icon name="refresh" size={13} className={scanning ? 'is-spinning' : undefined} />
                  {scanning ? '扫描中…' : '立即扫描'}
                </button>
              }
            />
          )}
        </div>
      ) : (
        <div className="printer-grid">
          {visible.map((p) => (
            <PrinterCard key={p.id} printer={p} now={now} focus={focusId === p.id} />
          ))}
        </div>
      )}
    </>
  )
}
