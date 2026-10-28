import { useEffect, useMemo, useState } from 'react'
import type { PrintJob, PrintJobAction, Printer } from '../../shared/types'
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
  refreshing: boolean
  refreshError: string | null
  now: number
  /** 是否显示本机虚拟打印机（状态提升到 App，切视图/刷新都不丢） */
  showVirtual: boolean
  onToggleVirtual: () => void
  onRefresh: () => void
  /** 告警跳转定位：滚动到该打印机卡并高亮（消费后回调 onFocusConsumed） */
  focusId?: string | null
  onFocusConsumed?: () => void
}

interface SuppliesNote {
  title: string
  sub: string
  explain: string
}

function suppliesNote(p: Printer): SuppliesNote | null {
  const cons = p.consumables
  if (cons.some((c) => c.levelPct !== null)) return null

  if (p.source === 'simulated') {
    return {
      title: '未获取耗材',
      sub: '演示数据未提供耗材余量',
      explain: '该条目为模拟数据，不代表真实设备的耗材状态。',
    }
  }
  if (p.state === 'offline') {
    return {
      title: '未获取耗材',
      sub: '设备离线，暂无法更新余量',
      explain: '当前设备离线且没有可用的耗材余量，请恢复连接后刷新。',
    }
  }
  if (cons.length > 0) {
    const sources = Array.from(new Set(cons.map((c) => CONSUMABLE_SOURCE_LABEL[c.source] ?? c.source)))
    return {
      title: '耗材条目未提供余量',
      sub: `耗材来源 ${sources.join(' · ')}`,
      explain: '已获取耗材条目，但没有可用的百分比余量；不能据此判断具体容量或协议设置。',
    }
  }
  if (p.ip === null) {
    return {
      title: '未获取耗材',
      sub: '无 IP，无法进行网络耗材查询',
      explain: '当前未获得打印机 IP 地址，也没有可用的耗材读数；不能据此判断设备是否支持耗材查询。',
    }
  }
  return {
    title: '未获取耗材',
    sub: '可能不支持或关闭耗材查询',
    explain: '本轮未获得耗材数据，可能不支持或关闭了耗材查询，也可能暂时不可达；无法据此判断 SNMP 是否启用。',
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
                  ? `${name}：未获取余量（来源 ${from}）`
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

/** 任务操作文案（task-024）。 */
const JOB_ACTION_LABEL: Record<PrintJobAction, string> = { cancel: '取消', pause: '暂停', resume: '恢复' }

/**
 * 按任务自报 status 判定可用操作（数据诚实：状态是 spooler 原文，只做子串匹配）：
 *  - 含 paus → 提供「恢复」
 *  - 正在打印/spooling → 提供「暂停」
 *  - 「取消」恒可用（对已完成的任务下发会得到 spooler 的明确报错，如实透出）
 */
function jobActions(job: PrintJob): PrintJobAction[] {
  const s = job.status.toLowerCase()
  const acts: PrintJobAction[] = []
  if (s.includes('paus')) acts.push('resume')
  else if (s.includes('print') || s.includes('spool')) acts.push('pause')
  acts.push('cancel')
  return acts
}

function PrinterCard({ printer, now, focus }: { printer: Printer; now: number; focus: boolean }) {
  const tone = printerStateTone(printer.state)
  const isFault = printer.state === 'error' || printer.state === 'warning'
  const hasQueue = printer.queueName != null
  const canOperate = hasQueue && printer.source !== 'simulated' && typeof window.lanApi !== 'undefined'
  const jobs = hasQueue ? printer.jobs : []
  const [expanded, setExpanded] = useState(false)
  const [confirmJobId, setConfirmJobId] = useState<string | null>(null)
  const [busyJobId, setBusyJobId] = useState<string | null>(null)
  const [opError, setOpError] = useState<string | null>(null)
  const SHOWN_LIMIT = 5
  const shownJobs = expanded ? jobs : jobs.slice(0, SHOWN_LIMIT)
  const overflow = expanded ? 0 : Math.max(0, jobs.length - SHOWN_LIMIT)

  /** 任务操作（task-024）：取消带内联确认（破坏性），暂停/恢复直接执行；失败原因如实透出。 */
  const runJobAction = async (action: PrintJobAction, job: PrintJob): Promise<void> => {
    if (busyJobId !== null || !canOperate || printer.queueName == null) return
    setBusyJobId(job.id)
    setOpError(null)
    setConfirmJobId(null)
    try {
      const res = await window.lanApi.printerJobAction(action, printer.queueName, job.id)
      if (!res.ok) setOpError(`${JOB_ACTION_LABEL[action]}任务失败：${res.error ?? '未知错误'}`)
    } catch (err) {
      setOpError(`${JOB_ACTION_LABEL[action]}任务失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusyJobId(null)
    }
  }

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
            {printer.isDefault && hasQueue && <span className="chip chip--accent">默认</span>}
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
            <span className="u-105 dim">{!hasQueue ? '未安装本机队列' : jobs.length === 0 ? '空闲' : `${jobs.length} 项`}</span>
          </div>
          {hasQueue && <span className="u-105 dim">本机队列：{printer.queueName}</span>}
          {!hasQueue ? (
            <span className="u-11 dim">{printer.source === 'simulated' ? '演示数据不可执行实际打印任务' : '仅监控设备，安装本机队列后方可操作打印任务'}</span>
          ) : shownJobs.length === 0 ? (
            <span className="u-11 dim">队列为空 · 最后发现 {relTime(printer.lastSeen, now)}</span>
          ) : (
            <div className="jobs">
              {shownJobs.map((job) => {
                const pct =
                  job.pages > 0 ? Math.min(100, (job.pagesPrinted / job.pages) * 100) : null
                // 非常态任务（打印中/spooling）才显示原文状态，常态不打扰
                const showStatus = job.status !== '' && !/print|spool/i.test(job.status)
                return (
                  <div className="job" key={job.id}>
                    <span className="job__doc" title={job.documentName}>
                      {job.documentName}
                    </span>
                    <span className="job__meta">
                      {showStatus ? `${job.status} · ` : ''}
                      {job.owner} · {job.pages > 0 ? `${job.pagesPrinted}/${job.pages}` : '页数未知'}
                    </span>
                    <div className="job__actions">
                      {confirmJobId === job.id ? (
                        <>
                          <button
                            type="button"
                            className="btn btn--sm btn--ghost btn--danger job__act"
                            disabled={busyJobId !== null || !canOperate}
                            onClick={() => void runJobAction('cancel', job)}
                            title="确认从打印队列删除该任务"
                          >
                            确认取消
                          </button>
                          <button
                            type="button"
                            className="btn btn--sm btn--ghost job__act"
                            disabled={busyJobId !== null || !canOperate}
                            onClick={() => setConfirmJobId(null)}
                          >
                            算了
                          </button>
                        </>
                      ) : (
                        jobActions(job).map((a) => (
                          <button
                            key={a}
                            type="button"
                            className={`btn btn--sm btn--ghost job__act${a === 'cancel' ? ' btn--danger' : ''}`}
                            disabled={busyJobId !== null || !canOperate}
                            title={
                              a === 'cancel'
                                ? `从打印队列删除「${job.documentName}」`
                                : `${JOB_ACTION_LABEL[a]}该任务`
                            }
                            onClick={() =>
                              a === 'cancel' ? setConfirmJobId(job.id) : void runJobAction(a, job)
                            }
                          >
                            {JOB_ACTION_LABEL[a]}
                          </button>
                        ))
                      )}
                    </div>
                    <div className="job__bar">
                      <Bar value={pct} max={100} color="var(--accent)" />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {overflow > 0 && (
            <button type="button" className="jobs__toggle" onClick={() => setExpanded(true)}>
              展开全部 {jobs.length} 项（还有 {overflow} 项）
            </button>
          )}
          {expanded && overflow === 0 && jobs.length > SHOWN_LIMIT && (
            <button type="button" className="jobs__toggle" onClick={() => setExpanded(false)}>
              收起队列
            </button>
          )}
          {opError && (
            <span className="job-op-error">
              <Icon name="warn" size={12} />
              {opError}
            </span>
          )}
        </div>
      </div>
    </article>
  )
}

export function PrintersView({
  printers,
  refreshing,
  refreshError,
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
            汇总协议识别、网络探活与本机队列；未获取耗材时如实标注，不以 0% 冒充。
          </div>
        </div>
        <div className="toolbar__meta">
          网络打印机 <span className="mono">{networkPrinters.length}</span> 台 · 在线{' '}
          <span className="mono">{onlineCount}</span> · 离线{' '}
          <span className="mono">{offlineCount}</span> · 故障{' '}
          <span className="mono">{faultCount}</span>
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
          disabled={refreshing}
          aria-busy={refreshing}
          title="仅刷新打印机状态与队列，不扫描全网"
        >
          <Icon name="refresh" size={12} className={refreshing ? 'is-spinning' : undefined} />
          {refreshing ? '刷新中…' : '刷新打印机'}
        </button>
      </div>
      {refreshError && <div className="router-msg" data-tone="crit" role="alert">{refreshError}</div>}

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
                  当前没有可显示的打印机记录，可独立刷新打印机或在打印管理中手动添加。
                  <br />
                  若设备处于休眠，可先手动唤醒后刷新。
                </>
              }
              actions={
                <button type="button" className="btn btn--primary" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing}>
                  <Icon name="refresh" size={13} className={refreshing ? 'is-spinning' : undefined} />
                  {refreshing ? '刷新中…' : '刷新打印机'}
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
