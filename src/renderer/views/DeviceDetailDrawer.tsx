import { useEffect, useMemo, useRef, useState } from 'react'
import type { Device, DeviceDetail, LanApi, RemoteOpKind } from '../../shared/types'
import { ScoreRing } from '../components/atoms/ScoreRing'
import { Sparkline } from '../components/atoms/Sparkline'
import { StatusPill } from '../components/atoms/StatusPill'
import { StatusDot } from '../components/atoms/StatusDot'
import { Hint } from '../components/atoms/Hint'
import { EmptyState } from '../components/atoms/EmptyState'
import { DrawerSkeleton, SkeletonLine } from '../components/atoms/Skeleton'
import { Icon } from '../components/Icon'
import { qualityPhase, stateTone } from '../lib/semantics'
import { QUALITY_MIN_SAMPLES } from '../../shared/constants'
import {
  KIND_LABEL,
  STATE_LABEL,
  fmtBitRate,
  fmtDateTime,
  fmtInt,
  fmtMac,
  fmtMs,
  fmtPct,
  portService,
  relTime,
} from '../lib/format'

export interface DeviceDetailDrawerProps {
  deviceId: string | null
  /** 快照中的实时设备对象（详情接口只取端口/连接/历史，其余以快照为准） */
  device: Device | null
  now: number
  onClose: () => void
  /** 点"网络诊断"时由 App 跳转诊断页并预填目标（可选：测试环境/旧调用方未传则隐藏入口行为降级） */
  onRunDiagnostics?: (ip: string) => void
}

function readApi(): LanApi | null {
  return window.lanApi ?? null
}

export function DeviceDetailDrawer({ deviceId, device, now, onClose, onRunDiagnostics }: DeviceDetailDrawerProps) {
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DeviceDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 别名草稿（审计 H-1：别名持久化与快照投影早已存在，此前 UI 无入口） */
  const [aliasDraft, setAliasDraft] = useState('')
  const [aliasMsg, setAliasMsg] = useState<string | null>(null)
  /** 远程操作（RDP/共享；task-019 移除 SSH）结果提示，模式同 aliasMsg */
  const [remoteMsg, setRemoteMsg] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  // 换设备时重置别名草稿与远程操作提示
  useEffect(() => {
    setAliasDraft('')
    setAliasMsg(null)
    setRemoteMsg(null)
  }, [activeId])

  const saveAlias = async (): Promise<void> => {
    const api = readApi()
    if (!api || !activeId) return
    try {
      await api.setDeviceAlias(activeId, aliasDraft.trim() || null)
      setAliasMsg(aliasDraft.trim() ? '别名已保存' : '别名已清除')
    } catch (err) {
      setAliasMsg(err instanceof Error ? err.message : String(err))
    }
  }

  /** 远程操作：RDP/SSH/打开共享，统一结果出口（ok → 提示已发起；失败/异常 → 红字原因） */
  const remoteOpen = async (kind: RemoteOpKind, ip: string, okText: string): Promise<void> => {
    const api = readApi()
    if (!api) {
      setRemoteMsg('预加载桥不可用，无法发起远程操作')
      return
    }
    try {
      const res = await api.remoteOpen(kind, ip)
      setRemoteMsg(res.ok ? okText : (res.error ?? '操作失败'))
    } catch (err) {
      setRemoteMsg(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 打开/关闭：抽屉节点常驻（transform: translateX(100%)），只切 data-open。
   * 不用 requestAnimationFrame 触发——无头/离屏环境下 rAF 可能不派发，
   * 会导致冒烟截图里抽屉永远不出现。过渡由 CSS transition 完成。
   */
  useEffect(() => {
    if (!deviceId) {
      setOpen(false)
      return
    }
    setActiveId(deviceId)
    setDetail(null)
    setError(null)
    setLoading(true)
    setOpen(true)
  }, [deviceId])

  // 只在打开时取一次详情：端口 / 连接 / 历史曲线
  useEffect(() => {
    if (!activeId || !deviceId) return
    const api = readApi()
    if (!api) {
      setLoading(false)
      setError('预加载桥不可用，无法读取详情')
      return
    }
    let alive = true
    api
      .getDeviceDetail(activeId)
      .then((d) => {
        if (!alive) return
        setDetail(d)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [activeId, deviceId])

  // Esc 关闭
  useEffect(() => {
    if (!deviceId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    const t = window.setTimeout(() => closeRef.current?.focus(), 240)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(t)
    }
  }, [deviceId, onClose])

  // 样本不足（< 8）时不给评级，但延迟/丢包仍是真实测量值
  const phase = device ? qualityPhase(device.quality.samples, device.quality.grade) : 'unavailable'
  const hasSamples = (device?.quality.samples ?? 0) > 0
  const rated = phase === 'graded'

  /** 历史曲线：详情接口的 60 点 + 若快照更新则本地追加一点（不轮询 IPC） */
  const history = useMemo(() => {
    if (!detail) return []
    const base = detail.history.slice(-60)
    if (!device || base.length === 0) return base
    const lastTs = base[base.length - 1].ts
    if (device.lastSeen <= lastTs) return base
    return [
      ...base,
      {
        ts: device.lastSeen,
        rtt: device.quality.latencyMs,
        rxBps: device.bandwidth.rxBps,
        txBps: device.bandwidth.txBps,
      },
    ].slice(-60)
  }, [detail, device])

  const rttSeries = useMemo(() => history.map((h) => h.rtt), [history])
  const rxSeries = useMemo(() => history.map((h) => h.rxBps), [history])
  const txSeries = useMemo(() => history.map((h) => h.txBps), [history])

  const ports = useMemo(() => {
    if (detail) return detail.ports.filter((p) => p.open)
    if (!device) return []
    return device.openPorts.map((port) => ({ port, service: portService(port), open: true }))
  }, [detail, device])

  const connections = detail?.connections.slice(0, 10) ?? []
  const mac = fmtMac(device?.mac ?? null)

  // 只有"已评级且为 poor"才把 RTT 曲线画成红；采样中保持强调色（样本不足 ≠ 差）
  const rttColor = rated && device?.quality.grade === 'poor' ? 'var(--crit)' : 'var(--accent)'

  return (
    <>
      <div className="drawer-scrim" data-open={open} onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        data-open={open}
        role="dialog"
        aria-modal="true"
        aria-label="设备详情"
        aria-hidden={!open}
      >
        <div className="drawer__head">
          <div className="drawer__title-block">
            <span className="drawer__eyebrow">设备详情</span>
            <span className="drawer__name">
              {device?.displayName ?? device?.hostname ?? device?.ip ?? '—'}
            </span>
            <span className="drawer__sub">
              {device ? (
                <>
                  <StatusDot tone={stateTone(device.state)} />
                  {STATE_LABEL[device.state] ?? device.state}
                  <span className="dim">·</span>
                  {KIND_LABEL[device.kind] ?? device.kind}
                  {device.isGateway && <span className="chip chip--accent">网关</span>}
                  {device.isSelf && <span className="chip chip--plain">本机</span>}
                </>
              ) : (
                '加载中…'
              )}
            </span>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--icon btn--ghost"
            onClick={onClose}
            aria-label="关闭详情"
            title="关闭（Esc）"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="drawer__body">
          {/* 审计 H-3：设备被清出快照且详情接口返回 null → 明确的"已消失"空态，
              旧实现永久卡在骨架屏（加载态与"不存在"不可区分）。 */}
          {!loading && !device && detail === null && !error ? (
            <EmptyState
              icon="devices"
              title="该设备已从网络中消失"
              desc="它已连续多轮未出现在扫描结果里（ARP 缺席且无响应），或已被移出监控。关闭后可在告警历史里回看它的记录。"
            />
          ) : !device ? (
            <DrawerSkeleton />
          ) : (
            <>
              {/* -------- 身份 -------- */}
              <section>
                <div className="row-between row-between--top">
                  <span className="drawer-ip selectable">{device.ip}</span>
                  {device.state === 'degraded' && (
                    <StatusPill tone="warn" title="丢包 ≥20% 或延迟 >150ms">
                      网络降级
                    </StatusPill>
                  )}
                </div>
                <dl className="dl mt-12">
                  <dt>别名</dt>
                  <dd>
                    <div className="alias-edit">
                      <input
                        className="input alias-edit__input"
                        type="text"
                        placeholder={device.hostname ?? device.ip}
                        value={aliasDraft}
                        onChange={(e) => {
                          setAliasDraft(e.target.value)
                          setAliasMsg(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveAlias()
                        }}
                      />
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void saveAlias()}>
                        保存
                      </button>
                    </div>
                    {aliasMsg && <span className="u-11 dim">{aliasMsg}</span>}
                  </dd>
                  <dt>MAC</dt>
                  <dd className="detail-value">{mac ?? <span className="na">—</span>}</dd>
                  <dt>主机名</dt>
                  <dd>{device.hostname ?? <span className="na">—</span>}</dd>
                  <dt>操作系统</dt>
                  <dd>{device.osHint ?? <span className="na">—</span>}</dd>
                  <dt>厂商</dt>
                  <dd>{device.vendor ?? <span className="na">—</span>}</dd>
                  <dt>类型</dt>
                  <dd>{KIND_LABEL[device.kind] ?? device.kind}</dd>
                  <dt>首次发现</dt>
                  <dd className="detail-value u-11">
                    {fmtDateTime(device.firstSeen)}
                    <span className="dim"> · {relTime(device.firstSeen, now)}</span>
                  </dd>
                  <dt>最后发现</dt>
                  <dd className="detail-value u-11">
                    {fmtDateTime(device.lastSeen)}
                    <span className="dim"> · {relTime(device.lastSeen, now)}</span>
                  </dd>
                </dl>

                {/* —— 远程操作：有 IP 才有意义 —— */}
                {device.ip && (
                  <>
                    <div className="section-label mt-12">远程操作</div>
                    <div className="diag-actions mt-10">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void remoteOpen('rdp', device.ip, `已发起 RDP 连接：${device.ip}`)}
                      >
                        远程桌面(RDP)
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void remoteOpen('share', device.ip, `已在资源管理器打开 \\\\${device.ip}`)}
                      >
                        打开共享
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        title="跳转到诊断中心并预填该 IP"
                        onClick={() => {
                          setRemoteMsg(null)
                          onRunDiagnostics?.(device.ip)
                        }}
                      >
                        网络诊断
                      </button>
                    </div>
                    {remoteMsg && <div className="u-11 mt-10">{remoteMsg}</div>}
                  </>
                )}
              </section>

              {/* -------- 网络质量 -------- */}
              <section>
                <div className="section-label">网络质量</div>
                <div className="quality-block">
                  <ScoreRing
                    score={device.quality.score}
                    grade={device.quality.grade}
                    samples={device.quality.samples}
                  />
                  <div className="stat3">
                    <div className="stat3__item">
                      <span className="stat3__label">延迟</span>
                      <span
                        className="stat3__value"
                        data-empty={hasSamples ? undefined : 'true'}
                        data-tone={
                          rated && (device.quality.latencyMs ?? 0) > 150 ? 'crit' : undefined
                        }
                      >
                        {hasSamples ? fmtMs(device.quality.latencyMs) : '未采样'}
                      </span>
                    </div>
                    <div className="stat3__item">
                      <span className="stat3__label">抖动</span>
                      <span className="stat3__value" data-empty={hasSamples ? undefined : 'true'}>
                        {hasSamples ? fmtMs(device.quality.jitterMs) : '未采样'}
                      </span>
                    </div>
                    <div className="stat3__item">
                      <span className="stat3__label">丢包</span>
                      <span
                        className="stat3__value"
                        data-empty={hasSamples ? undefined : 'true'}
                        data-tone={
                          rated && device.quality.packetLossPct >= 20 ? 'crit' : undefined
                        }
                      >
                        {hasSamples ? fmtPct(device.quality.packetLossPct) : '未采样'}
                      </span>
                    </div>
                  </div>
                </div>

                {phase === 'unavailable' && (
                  <p className="note mt-10">
                    <Icon name="info" size={13} className="note__icon" />
                    该主机未响应 ICMP（可能禁 ping），本轮没有 RTT 样本。在线判定来自 ARP 表，不代表链路异常。
                  </p>
                )}

                {phase === 'sampling' && (
                  <p className="note mt-10">
                    <Icon name="info" size={13} className="note__icon" />
                    已收到 {device.quality.samples} 个 ICMP 样本，累计 {QUALITY_MIN_SAMPLES} 个后给出
                    优/良/中/差评级。上方数值是已测得的真实值，暂不作结论。
                  </p>
                )}

                <div className="chart-box mt-10">
                  <div className="chart-box__head">
                    <span className="chart-box__title">RTT · 最近 60 点</span>
                    <span className="chart-box__legend">
                      <span className="legend-dot u-crit">超时</span>
                    </span>
                  </div>
                  <Sparkline
                    values={rttSeries.length > 0 ? rttSeries : device.rttHistory.map((v) => v)}
                    height={62}
                    maxPoints={60}
                    stroke={rttColor}
                    area
                    unit="ms"
                  />
                </div>
              </section>

              {/* -------- 带宽 -------- */}
              <section>
                <div className="section-label">
                  带宽
                  <Hint text="估算值：按网卡计数器与 TCP 连接占比推算，非设备级流量镜像；速率单位 bit/s">
                    <span className="chip chip--plain">估算值</span>
                  </Hint>
                </div>

                {device.bandwidth.attributable ? (
                  <div className="bw-block">
                    <div className="bw-pair">
                      <span className="bw-row">
                        <span className="bw-row__label">
                          <span className="u-arrow">↓</span>接收
                        </span>
                        <span className="bw-row__value">{fmtBitRate(device.bandwidth.rxBps)}</span>
                      </span>
                      <span className="bw-row">
                        <span className="bw-row__label">
                          <span className="u-arrow">↑</span>发送
                        </span>
                        <span className="bw-row__value">{fmtBitRate(device.bandwidth.txBps)}</span>
                      </span>
                    </div>

                    <div className="bw-charts">
                      <div className="chart-box">
                        <div className="chart-box__head">
                          <span className="chart-box__title">↓ 接收</span>
                        </div>
                        <Sparkline values={rxSeries} height={34} stroke="var(--accent)" markGaps={false} />
                      </div>
                      <div className="chart-box">
                        <div className="chart-box__head">
                          <span className="chart-box__title">↑ 发送</span>
                        </div>
                        <Sparkline values={txSeries} height={34} stroke="var(--text-muted)" markGaps={false} />
                      </div>
                    </div>

                    <div className="row-between">
                      <span className="u-11 dim">
                        活跃连接 <span className="mono">{fmtInt(device.bandwidth.connections)}</span> · 占比{' '}
                        <span className="mono">{fmtPct(device.bandwidth.share * 100)}</span>
                      </span>
                      {device.bandwidth.estimated && <span className="chip chip--plain">推算</span>}
                    </div>

                    {/* task-021 F4：口径说明常驻（原来只在悬浮 title 里），数字旁边永远有解释 */}
                    <div className="bw-note">
                      <Icon name="info" size={13} className="bw-note__icon" />
                      <span>
                        估算值：按网卡计数器与本机 TCP 连接占比分摊；流量统计仅覆盖与本机的会话，不是设备级流量镜像。
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="stack">
                    <div className="bw-pair">
                      <span className="bw-row">
                        <span className="bw-row__label">
                          <span className="u-arrow">↓</span>接收
                        </span>
                        <span className="bw-row__value" data-empty="true">
                          无流量归集
                        </span>
                      </span>
                      <span className="bw-row">
                        <span className="bw-row__label">
                          <span className="u-arrow">↑</span>发送
                        </span>
                        <span className="bw-row__value" data-empty="true">
                          无流量归集
                        </span>
                      </span>
                    </div>
                    {/* task-021 F4：解释从悬浮 title 升级为常驻说明块（琥珀描边，区别于错误） */}
                    <div className="bw-note" data-tone="warn">
                      <Icon name="info" size={13} className="bw-note__icon" />
                      <span>
                        该设备未与本机建立 TCP 会话，流量无法归集；流量统计仅覆盖与本机的会话，不代表设备没有流量。
                      </span>
                    </div>
                  </div>
                )}
              </section>

              {/* -------- 开放端口 -------- */}
              <section>
                <div className="section-label">
                  开放端口
                  <span className="u-105 dim">{ports.length}</span>
                </div>
                {loading ? (
                  <SkeletonLine width="60%" height={20} />
                ) : ports.length === 0 ? (
                  <p className="note">
                    <Icon name="info" size={13} className="note__icon" />
                    {detail ? '该设备未响应任何被探测的端口（80/443/445/3389/9100/631/515 等）。' : '端口数据未获取到。'}
                  </p>
                ) : (
                  <div className="chip-row">
                    {ports.map((p) => (
                      <span className="chip chip--port" key={p.port}>
                        {p.port}
                        <span className="chip__svc">{p.service || portService(p.port)}</span>
                      </span>
                    ))}
                  </div>
                )}
              </section>

              {/* -------- 活跃连接 -------- */}
              <section>
                <div className="section-label">
                  活跃连接
                  <span className="u-105 dim">最多 10 条</span>
                </div>
                {error ? (
                  <p className="router-msg" data-tone="bad">{error}</p>
                ) : loading ? (
                  <DrawerSkeleton />
                ) : connections.length === 0 ? (
                  <p className="note">
                    <Icon name="info" size={13} className="note__icon" />
                    未观察到与本机建立的 TCP 会话。
                  </p>
                ) : (
                  <table className="conn-table">
                    <colgroup className="cols-conn">
                      <col />
                      <col />
                      <col />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>远端</th>
                        <th>状态</th>
                        <th>协议</th>
                      </tr>
                    </thead>
                    <tbody>
                      {connections.map((c, i) => (
                        <tr key={`${c.remoteIp}:${c.remotePort}-${i}`}>
                          <td className="mono-sm">
                            {c.remoteIp}:{c.remotePort}
                          </td>
                          <td className="col-state u-105">{c.state}</td>
                          <td className="col-proto u-105">{c.proto}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  )
}
