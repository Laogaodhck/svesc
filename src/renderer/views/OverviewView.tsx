import { useMemo } from 'react'
import type { Alarm, Device, Printer, Snapshot } from '../../shared/types'
import { StatusDot } from '../components/atoms/StatusDot'
import { StatusPill } from '../components/atoms/StatusPill'
import { QualityBar } from '../components/atoms/QualityBar'
import { Icon } from '../components/Icon'
import { EmptyState } from '../components/atoms/EmptyState'
import { printerStateTone, severityTone, stateTone, qualityPhase } from '../lib/semantics'
import { QUALITY_MIN_SAMPLES } from '../../shared/constants'
import {
  PRINTER_STATE_LABEL,
  STATE_LABEL,
  fmtBitRateCompact,
  fmtBitRateParts,
  fmtMs,
  relTime,
} from '../lib/format'

export interface OverviewViewProps {
  snapshot: Snapshot
  now: number
  onOpenDetail: (id: string) => void
  onNavigate: (view: 'devices' | 'printers' | 'alarms') => void
  /** 引擎扫描轮进行中（与 DevicesView 的「· 扫描中」同口径） */
  scanning?: boolean
  /** 点击最新告警 timeline 项时回调（App 负责跳转告警视图） */
  onOpenAlarm?: (alarm: Alarm) => void
  /** 键盘激活健康表行时回调（App 负责打开对应设备抽屉） */
  onOpenDevice?: (deviceId: string) => void
}

const STATE_RANK: Record<string, number> = { offline: 0, degraded: 1, scanning: 2, online: 3 }

function ipValue(ip: string): number {
  const parts = ip.split('.')
  if (parts.length !== 4) return Number.MAX_SAFE_INTEGER
  let v = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isFinite(n)) return Number.MAX_SAFE_INTEGER
    v = v * 256 + n
  }
  return v
}

const SEV_LABEL: Record<string, string> = { critical: '紧急', warning: '重要', info: '一般' }

export function OverviewView({
  snapshot,
  now,
  onOpenDetail,
  onNavigate,
  scanning,
  onOpenAlarm,
  onOpenDevice,
}: OverviewViewProps) {
  const { system, devices, printers, alarms } = snapshot

  const activeAlarms = useMemo(() => alarms.filter((a) => a.resolvedAt === null), [alarms])
  const sevCounts = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0 }
    for (const a of activeAlarms) c[a.severity] += 1
    return c
  }, [activeAlarms])

  /**
   * 「降级 / 质量差」口径（team-lead 裁定）：
   * 只统计 `state === 'degraded'` 与样本达标（`samples >= 8`）的 `poor`；
   * `grade === 'unknown'` **一律不计入**——否则启动后前 30 秒全是采样中，
   * 满屏"降级"会让人把"还没测"误判成"网络坏了"。
   *
   * 口径：UI 只统计 degraded 与已评级的 poor；引擎 `system.degraded` 用同一判定，
   * 两者应相等，若不等以本处为准（unknown 不计入视觉告警）。
   *
   * `sampling` 必须单独计数并显示在脚注里：让用户能把"降级 0 / 采样中 12 / 未采样 7"
   * 对上账。否则看到"降级 0"会误以为全部健康，其实一台都还没评级过。
   */
  const qualityStats = useMemo(() => {
    let degraded = 0
    let poor = 0
    let sampling = 0
    for (const d of devices) {
      if (qualityPhase(d.quality.samples, d.quality.grade) === 'sampling') sampling += 1
      if (d.state === 'degraded') degraded += 1
      else if (d.quality.grade === 'poor' && d.quality.samples >= QUALITY_MIN_SAMPLES) poor += 1
    }
    return { degraded, poor, sampling, affected: degraded + poor }
  }, [devices])

  /** task-021 F4：可归集设备统计——x = attributable 台数，y = 在线设备总数 */
  const trafficStats = useMemo(() => {
    let yes = 0
    let online = 0
    for (const d of devices) {
      if (d.bandwidth.attributable) yes += 1
      if (d.state === 'online') online += 1
    }
    return { yes, online }
  }, [devices])

  const healthRows = useMemo(() => {
    const sorted = devices.slice().sort((a, b) => {
      const r = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9)
      return r !== 0 ? r : ipValue(a.ip) - ipValue(b.ip)
    })
    return sorted.slice(0, 8)
  }, [devices])

  const recentAlarms = useMemo(
    () => alarms.slice().sort((a, b) => b.raisedAt - a.raisedAt).slice(0, 6),
    [alarms]
  )

  // 速率单位是 bit/s（引擎 Δbytes×8/Δt）；null = 本轮未采到，显示「—」而不是 0
  const rx = fmtBitRateParts(system.rxBps)
  const tx = fmtBitRateParts(system.txBps)
  const bwUnsampled = system.rxBps === null || system.txBps === null
  const BW_UNSAMPLED_HINT = '本轮未能采样网络吞吐（网卡计数器读取失败或尚未建立基线）'
  // 与打印机视图同口径：本机虚拟打印机（PDF/XPS/Fax）不计入监控台数
  const realPrinters = printers.filter((p) => p.connection !== 'virtual')
  const virtualPrinterCount = printers.length - realPrinters.length
  const faultPrinters = realPrinters.filter((p) => p.state === 'error').length

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">总览</div>
          <div className="view-desc">
            {snapshot.subnet ? `网段 ${snapshot.subnet}` : '网段未识别'} · 快照时间{' '}
            {new Date(snapshot.ts).toLocaleTimeString('zh-CN', { hour12: false })}
            {scanning && <span className="dim"> · 扫描中</span>}
          </div>
        </div>
      </div>

      {/* KPI */}
      <div className="kpi-row">
        <div className="card kpi">
          <span className="kpi__label">
            <StatusDot tone="ok" size="sm" />
            在线设备
          </span>
          <span className="kpi__value">
            {system.online}
            <span className="kpi__unit">台</span>
          </span>
          <span className="kpi__foot">
            共 {system.totalDevices} 台 · 占比{' '}
            {system.totalDevices > 0 ? (
              `${Math.round((system.online / system.totalDevices) * 100)}%`
            ) : (
              <span className="na">—</span>
            )}
          </span>
        </div>

        <div className="card kpi">
          <span className="kpi__label">
            <StatusDot tone={system.offline > 0 ? 'crit' : 'muted'} size="sm" pulse={system.offline > 0} />
            离线 / 降级
          </span>
          <span className="kpi__value">
            {system.offline}
            <span className="kpi__unit">台离线</span>
          </span>
          <span className="kpi__foot">
            {qualityStats.affected > 0 ? (
              <span className="u-warn">降级 {qualityStats.affected} 台</span>
            ) : (
              <span>无降级设备</span>
            )}
            {qualityStats.sampling > 0 && (
              <span className="dim" title="已收到 ICMP 样本但不足 8 个，暂不评级，不计入降级">
                · 采样中 {qualityStats.sampling} 台
              </span>
            )}
            <span className="dim">· ARP 缺席 3 轮才判离线</span>
          </span>
        </div>

        <div className="card kpi">
          <span className="kpi__label">
            <StatusDot tone={faultPrinters > 0 ? 'crit' : 'ok'} size="sm" pulse={faultPrinters > 0} />
            打印机
          </span>
          <span className="kpi__value">
            {realPrinters.length}
            <span className="kpi__unit">台</span>
          </span>
          <span className="kpi__foot">
            {faultPrinters > 0 ? (
              <span className="u-crit">故障 {faultPrinters} 台</span>
            ) : (
              <span>无故障</span>
            )}
            <span className="dim">
              {virtualPrinterCount > 0 ? `· 另有 ${virtualPrinterCount} 台虚拟` : '· 含 spooler 队列'}
            </span>
          </span>
        </div>

        <div className="card kpi">
          <span className="kpi__label">
            <StatusDot tone={activeAlarms.length > 0 ? 'warn' : 'ok'} size="sm" pulse={sevCounts.critical > 0} />
            活跃告警
          </span>
          <span className="kpi__value">
            {activeAlarms.length}
            <span className="kpi__unit">条</span>
          </span>
          <span className="kpi__foot">
            <span className={sevCounts.critical > 0 ? 'u-crit' : 'dim'}>
              紧急 {sevCounts.critical}
            </span>
            <span className={sevCounts.warning > 0 ? 'u-warn' : 'dim'}>
              重要 {sevCounts.warning}
            </span>
            <span className={sevCounts.info > 0 ? 'u-accent' : 'dim'}>
              一般 {sevCounts.info}
            </span>
          </span>
        </div>

        <div className="card kpi">
          <span className="kpi__label">
            <Icon name="activity" size={12} />
            全网带宽
            <span className="chip chip--plain" title="按网卡计数器差分推算，非设备级流量镜像；单位 bit/s">
              估算
            </span>
          </span>
          <span
            className="kpi__value kpi__value--bw"
            title={bwUnsampled ? BW_UNSAMPLED_HINT : '网卡计数器差分推算，单位 bit/s'}
          >
            <span className="kpi__bw-row" data-empty={system.rxBps === null ? 'true' : undefined}>
              <span className="dim u-arrow">↓</span>
              {rx.value}
              <span className="kpi__unit">{rx.unit}</span>
            </span>
            <span className="kpi__bw-row" data-empty={system.txBps === null ? 'true' : undefined}>
              <span className="dim u-arrow">↑</span>
              {tx.value}
              <span className="kpi__unit">{tx.unit}</span>
            </span>
          </span>
          <span className="kpi__foot">
            <span className="dim">
              {bwUnsampled ? '本轮未采到吞吐 · 2s 采样' : '本机网卡合计 · bit/s · 2s 采样'}
            </span>
          </span>
        </div>

        <div className="card kpi">
          <span className="kpi__label">
            <Icon name="network" size={12} />
            可归集设备
            <span className="chip chip--plain" title="带宽归集的前提是本机与该设备存在 TCP 会话">
              口径
            </span>
          </span>
          <span
            className="kpi__value"
            title="x = 流量可归集的设备台数；y = 在线设备总数。不可归集 ≠ 离线，只是没有与本机的 TCP 会话"
          >
            {trafficStats.yes}
            <span className="kpi__unit">/ {trafficStats.online} 台在线</span>
          </span>
          <span className="kpi__foot">
            <span className="dim">仅统计与本机的 TCP 会话</span>
          </span>
        </div>
      </div>

      {/* 中部：设备健康表 + 打印机状态 */}
      <div className="overview-mid">
        <section className="card">
          <div className="card__head">
            <span className="card__title">设备健康</span>
            <span className="card__hint">按状态优先级排序 · 前 8 台</span>
            <span className="card__spacer" />
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onNavigate('devices')}>
              查看全部
              <Icon name="chevron-right" size={12} />
            </button>
          </div>
          {healthRows.length === 0 ? (
            <EmptyState icon="devices" title="尚未发现设备" desc="等待首轮扫描完成。" />
          ) : (
            <table className="table table--compact table--health">
              <colgroup className="cols-health">
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="状态" />
                  <th>IP</th>
                  <th>主机名</th>
                  <th>延迟</th>
                  <th>质量</th>
                  <th>↓/↑ bit/s</th>
                </tr>
              </thead>
              <tbody>
                {healthRows.map((d: Device) => (
                  <tr
                    key={d.id}
                    data-clickable="true"
                    data-offline={d.state === 'offline' ? 'true' : undefined}
                    onClick={() => onOpenDetail(d.id)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onOpenDevice?.(d.id)
                      }
                    }}
                    aria-label={`${d.ip} 详情`}
                  >
                    <td title={STATE_LABEL[d.state]}>
                      <StatusDot tone={stateTone(d.state)} />
                    </td>
                    <td className="mono">{d.ip}</td>
                    <td className="dev-name">{d.displayName ?? d.hostname ?? <span className="na">—</span>}</td>
                    <td className="mono">
                      {d.quality.samples > 0 ? (
                        fmtMs(d.quality.latencyMs)
                      ) : (
                        <span className="na">—</span>
                      )}
                    </td>
                    <td>
                      <QualityBar grade={d.quality.grade} samples={d.quality.samples} />
                    </td>
                    <td className="mono u-11">
                      {d.bandwidth.attributable ? (
                        `↓${fmtBitRateCompact(d.bandwidth.rxBps)} ↑${fmtBitRateCompact(d.bandwidth.txBps)}`
                      ) : (
                        <span className="na">无归集</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <div className="card__head">
            <span className="card__title">打印机状态</span>
            <span className="card__hint">
              {realPrinters.length} 台
              {realPrinters.length > 5 && ` · +${realPrinters.length - 5} 台更多`}
            </span>
            <span className="card__spacer" />
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onNavigate('printers')}>
              查看全部
              <Icon name="chevron-right" size={12} />
            </button>
          </div>
          {realPrinters.length === 0 ? (
            <EmptyState
              icon="printer"
              title="未发现网络打印机"
              desc="该网络内没有响应 9100/631 的设备。"
            />
          ) : (
            <div className="printer-mini-list">
              {realPrinters.slice(0, 5).map((p: Printer) => (
                <div className="printer-mini" key={p.id}>
                  <div className="printer-mini__main">
                    <span className="printer-mini__name" title={p.name}>
                      {p.name}
                    </span>
                    <span className="printer-mini__meta">
                      <span className="mono">{p.ip ?? '无 IP'}</span>
                      {p.isDefault && <span className="chip chip--accent">默认</span>}
                      {!p.consumables.some((c) => c.levelPct !== null) && (
                        <span className="dim">· 不报告耗材</span>
                      )}
                    </span>
                  </div>
                  <div className="printer-mini__side">
                    <StatusPill tone={printerStateTone(p.state)}>
                      {PRINTER_STATE_LABEL[p.state] ?? p.state}
                    </StatusPill>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* 底部：最新告警 */}
      <section className="card">
        <div className="card__head">
          <span className="card__title">最新告警</span>
          <span className="card__hint">最近 6 条</span>
          <span className="card__spacer" />
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onNavigate('alarms')}>
            全部告警
            <Icon name="chevron-right" size={12} />
          </button>
        </div>
        {recentAlarms.length === 0 ? (
          <EmptyState
            icon="shield"
            title="没有告警"
            desc="设备掉线、打印机故障或网络质量下降时会在这里出现。"
          />
        ) : (
          <div className="timeline">
            {recentAlarms.map((a: Alarm) => (
              <div
                className="timeline__item"
                key={a.id}
                role={onOpenAlarm ? 'button' : undefined}
                tabIndex={onOpenAlarm ? 0 : undefined}
                onClick={onOpenAlarm ? () => onOpenAlarm(a) : undefined}
                onKeyDown={
                  onOpenAlarm
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onOpenAlarm(a)
                        }
                      }
                    : undefined
                }
                style={onOpenAlarm ? { cursor: 'pointer' } : undefined}
                aria-label={`查看告警：${a.targetName} ${a.message}`}
              >
                <span className="timeline__dot" data-tone={severityTone(a.severity)} />
                <div className="timeline__body">
                  <span className="timeline__title">
                    {a.targetName} · {SEV_LABEL[a.severity] ?? a.severity}
                    {a.resolvedAt !== null && <span className="dim">（已恢复）</span>}
                  </span>
                  <span className="timeline__msg">{a.message}</span>
                </div>
                <span className="timeline__time">{relTime(a.raisedAt, now)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
