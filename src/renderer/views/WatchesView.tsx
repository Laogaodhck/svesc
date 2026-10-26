import { useMemo, useState } from 'react'
import type { Device, WatchStatus } from '../../shared/types'
import { EmptyState } from '../components/atoms/EmptyState'
import { Sparkline } from '../components/atoms/Sparkline'
import { StatusDot } from '../components/atoms/StatusDot'
import { Icon } from '../components/Icon'
import type { Tone } from '../lib/semantics'
import { fmtDateTime, relTime } from '../lib/format'

/**
 * 持续 Ping 监控（task-025）：
 * - 目标每 WATCH.intervalMs(5s) 被 ICMP 探测一次，宕机/恢复立即推新快照（本页状态实时刷新）。
 * - 数据诚实：unknown = 尚无样本，不猜在线；rtt 超时画断点。
 */

export interface WatchesViewProps {
  watches: WatchStatus[]
  /** 快照设备列表：用于把监控目标关联回设备详情 */
  devices: Device[]
  onOpenDetail: (id: string) => void
  onNavigate: (view: 'devices') => void
}

function readApi(): typeof window.lanApi | null {
  return window.lanApi ?? null
}

/** 状态 → 圆点色调；unknown（尚无样本）用 muted，不猜 */
function watchTone(state: WatchStatus['state']): Tone {
  if (state === 'up') return 'ok'
  if (state === 'down') return 'crit'
  return 'muted'
}

const WATCH_STATE_LABEL: Record<WatchStatus['state'], string> = {
  up: '在线',
  down: '宕机',
  unknown: '待采样',
}

/** 宕机持续时长（人话）：秒/分/时/天，只到两级 */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  const d = Math.floor(h / 24)
  return `${d} 天 ${h % 24} 小时`
}

export function WatchesView({ watches, devices, onOpenDetail, onNavigate }: WatchesViewProps) {
  const [ipDraft, setIpDraft] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [formMsg, setFormMsg] = useState<string | null>(null)
  const [formTone, setFormTone] = useState<'ok' | 'bad'>('ok')
  const [busy, setBusy] = useState(false)
  const [rowMsg, setRowMsg] = useState<string | null>(null)

  const deviceByIp = useMemo(() => {
    const m = new Map<string, Device>()
    for (const d of devices) {
      if (d.ip && !m.has(d.ip)) m.set(d.ip, d)
    }
    return m
  }, [devices])

  const downCount = watches.filter((w) => w.state === 'down').length

  const submit = async (): Promise<void> => {
    const api = readApi()
    const ip = ipDraft.trim()
    if (!api) {
      setFormMsg('预加载桥不可用，无法添加监控')
      setFormTone('bad')
      return
    }
    if (!ip) {
      setFormMsg('请输入要监控的 IP 地址')
      setFormTone('bad')
      return
    }
    setBusy(true)
    try {
      const res = await api.watchAdd(ip, noteDraft.trim() || null)
      if (res.ok) {
        setFormMsg(`已加入监控：${ip}（每 5s 探测，宕机自动告警）`)
        setFormTone('ok')
        setIpDraft('')
        setNoteDraft('')
      } else {
        setFormMsg(res.error ?? '添加失败')
        setFormTone('bad')
      }
    } catch (err) {
      setFormMsg(err instanceof Error ? err.message : String(err))
      setFormTone('bad')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (ip: string): Promise<void> => {
    const api = readApi()
    if (!api) {
      setRowMsg('预加载桥不可用，无法移出监控')
      return
    }
    try {
      await api.watchRemove(ip)
      setRowMsg(`已移出监控：${ip}`)
    } catch (err) {
      setRowMsg(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <div className="view-title">监控</div>
          <div className="view-desc">
            对重点目标持续 ICMP 探测（每 5 秒一轮，保留最近 60 点）；目标宕机在下方以状态标示。
          </div>
        </div>
        {watches.length > 0 && (
          <div className="toolbar__meta">
            共 <span className="mono">{watches.length}</span> 个目标
            {downCount > 0 && (
              <>
                {' '}
                · <span className="u-crit">宕机 {downCount}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* 添加目标 */}
      <div className="card mt-10">
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ width: 200 }}
            type="text"
            placeholder="IP 地址，如 192.168.1.1"
            value={ipDraft}
            list="watch-ip-options"
            onChange={(e) => {
              setIpDraft(e.target.value)
              setFormMsg(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            aria-label="监控目标 IP"
          />
          <datalist id="watch-ip-options">
            {devices.map((d) => (
              <option key={d.id} value={d.ip}>
                {d.displayName ?? d.hostname ?? d.ip}
              </option>
            ))}
          </datalist>
          <input
            className="input"
            style={{ width: 220 }}
            type="text"
            placeholder="备注（可选，≤40 字符）"
            value={noteDraft}
            onChange={(e) => {
              setNoteDraft(e.target.value)
              setFormMsg(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            aria-label="监控备注"
          />
          <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
            <Icon name="activity" size={13} />
            加入监控
          </button>
          {formMsg && (
            <span className="u-11" data-tone={formTone === 'ok' ? undefined : 'crit'}>
              {formMsg}
            </span>
          )}
        </div>
      </div>

      {watches.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="activity"
            title="还没有监控目标"
            desc="把路由器、NAS、摄像头等关键设备加入持续监控，它们一旦失联你会第一时间收到告警。也可以在设备详情抽屉里一键加入。"
            actions={
              <button type="button" className="btn" onClick={() => onNavigate('devices')}>
                去设备列表选择
              </button>
            }
          />
        </div>
      ) : (
        <div className="card table-wrap mt-10">
          <table className="table table--watches">
            <thead>
              <tr>
                <th>状态</th>
                <th>目标</th>
                <th>可用率</th>
                <th>宕机时长</th>
                <th>最近探测</th>
                <th>RTT · 最近 60 点</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {watches.map((w) => {
                const dev = deviceByIp.get(w.ip)
                const rttSeries = w.window.map((s) => (s.alive ? s.rttMs : null))
                return (
                  <tr
                    key={w.ip}
                    data-clickable={dev ? 'true' : undefined}
                    data-offline={w.state === 'down' ? 'true' : undefined}
                    onClick={() => {
                      if (dev) onOpenDetail(dev.id)
                    }}
                    tabIndex={dev ? 0 : undefined}
                    onKeyDown={(e) => {
                      if (dev && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault()
                        onOpenDetail(dev.id)
                      }
                    }}
                    aria-label={dev ? `${w.note ?? w.ip} 设备详情` : undefined}
                  >
                    <td>
                      <span className="dot-row">
                        <StatusDot
                          tone={watchTone(w.state)}
                          pulse={w.state === 'down'}
                          title={WATCH_STATE_LABEL[w.state]}
                        />
                        <span className={w.state === 'down' ? 'u-11 u-crit' : 'u-11 muted'}>
                          {WATCH_STATE_LABEL[w.state]}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="dev-ip">{w.ip}</span>
                      {w.note && <span className="dev-name">{w.note}</span>}
                      {dev && <span className="dev-badge">已关联设备</span>}
                    </td>
                    <td className="mono u-115">
                      {w.upPct === null ? <span className="na">—</span> : `${w.upPct.toFixed(0)}%`}
                    </td>
                    <td className="mono u-115">
                      {w.downSince === null ? (
                        <span className="na">—</span>
                      ) : (
                        <span className="u-crit">{fmtDuration(Date.now() - w.downSince)}</span>
                      )}
                    </td>
                    <td className="u-11 muted">
                      {w.window.length > 0
                        ? relTime(w.window[w.window.length - 1].ts, Date.now())
                        : <span className="na">—</span>}
                    </td>
                    <td>
                      {rttSeries.length > 0 ? (
                        <Sparkline values={rttSeries} width={120} height={26} maxPoints={60} unit="ms" />
                      ) : (
                        <span className="na">暂无采样</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        title={
                          w.downSince !== null
                            ? `自 ${fmtDateTime(w.downSince)} 起失联`
                            : `加入于 ${fmtDateTime(w.addedAt)}`
                        }
                        onClick={(e) => {
                          e.stopPropagation()
                          void remove(w.ip)
                        }}
                      >
                        移出监控
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rowMsg && <div className="u-11 muted" style={{ padding: '6px 12px' }}>{rowMsg}</div>}
        </div>
      )}
    </div>
  )
}
