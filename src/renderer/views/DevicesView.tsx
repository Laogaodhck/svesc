import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Device } from '../../shared/types'
import { StatusDot } from '../components/atoms/StatusDot'
import { QualityBar } from '../components/atoms/QualityBar'
import { EmptyState } from '../components/atoms/EmptyState'
import { Icon } from '../components/Icon'
import { stateTone } from '../lib/semantics'
import { KIND_LABEL, STATE_LABEL, fmtBitRate, fmtDateTime, fmtDateTimeShort, fmtMs, fmtMac, fmtPct } from '../lib/format'

type StatusFilter = 'all' | 'online' | 'degraded' | 'offline'
/** 流量状态筛选（task-021 F4）：attributable=false 表示本机与该设备无可见 TCP 会话 */
type TrafficFilter = 'all' | 'attributable' | 'unattributable'
type SortKey = 'ip' | 'latency' | 'loss' | 'bandwidth' | 'lanConnections' | 'name' | 'firstSeen'
type SortDir = 'asc' | 'desc'

export interface DevicesViewProps {
  devices: Device[]
  selectedId: string | null
  onOpenDetail: (id: string) => void
  scanning: boolean
  totalDevices: number
}

const SORT_LABEL: Record<SortKey, string> = {
  ip: 'IP 地址',
  latency: '延迟',
  loss: '丢包',
  bandwidth: '带宽',
  lanConnections: '活跃连接',
  name: '名称',
  firstSeen: '首次接入',
}

/* --------------------------------------------------------------------------
   行组件：200+ 行时必须跳过无关重渲染。
   只比较该行真正展示的字段；rttHistory 按引用比较（不可变快照）。
   -------------------------------------------------------------------------- */
interface DeviceRowProps {
  device: Device
  selected: boolean
  onOpen: (id: string) => void
}

function sameRow(a: DeviceRowProps, b: DeviceRowProps): boolean {
  if (a.device === b.device && a.selected === b.selected && a.onOpen === b.onOpen) return true
  if (a.selected !== b.selected || a.onOpen !== b.onOpen) return false
  const x = a.device
  const y = b.device
  return (
    x.id === y.id &&
    x.ip === y.ip &&
    x.state === y.state &&
    x.mac === y.mac &&
    x.hostname === y.hostname &&
    x.displayName === y.displayName &&
    x.vendor === y.vendor &&
    x.osHint === y.osHint &&
    x.kind === y.kind &&
    x.isGateway === y.isGateway &&
    x.isSelf === y.isSelf &&
    x.ipConflict === y.ipConflict &&
    x.firstSeen === y.firstSeen &&
    x.quality.latencyMs === y.quality.latencyMs &&
    x.quality.packetLossPct === y.quality.packetLossPct &&
    x.quality.score === y.quality.score &&
    x.quality.grade === y.quality.grade &&
    x.quality.samples === y.quality.samples &&
    x.bandwidth.rxBps === y.bandwidth.rxBps &&
    x.bandwidth.txBps === y.bandwidth.txBps &&
    x.bandwidth.attributable === y.bandwidth.attributable
  )
}

const DeviceRow = memo(function DeviceRow({ device, selected, onOpen }: DeviceRowProps) {
  // 有样本就能显示测量值（延迟/丢包是真的），只是样本 < 8 时不给评级
  const hasSamples = device.quality.samples > 0
  const bw = device.bandwidth
  const mac = fmtMac(device.mac)
  const name = device.displayName ?? device.hostname

  return (
    <tr
      data-clickable="true"
      data-offline={device.state === 'offline' ? 'true' : undefined}
      data-active={selected ? 'true' : undefined}
      onClick={() => onOpen(device.id)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(device.id)
        }
      }}
      aria-label={`${device.ip} 详情`}
    >
      <td>
        <span className="dot-row" title={STATE_LABEL[device.state] ?? device.state}>
          <StatusDot tone={stateTone(device.state)} />
          <span className="u-11 muted">{STATE_LABEL[device.state] ?? device.state}</span>
        </span>
      </td>
      <td>
        <span className="dev-ip">{device.ip}</span>
        {device.isGateway && <span className="dev-badge">网关</span>}
        {device.isSelf && <span className="dev-badge">本机</span>}
        {device.ipConflict && (
          <span className="dev-badge dev-badge--conflict" title="ARP 表中该 IP 解析出多个 MAC，疑似地址冲突或 ARP 欺骗">
            IP 冲突
          </span>
        )}
      </td>
      <td>
        <span className="dev-name" title={name ?? undefined}>
          {name ?? <span className="na">—</span>}
        </span>
      </td>
      <td className="mono u-115">{mac ?? <span className="na">—</span>}</td>
      <td className="muted">{device.vendor ?? <span className="na">—</span>}</td>
      <td className="muted">{device.osHint ?? <span className="na">—</span>}</td>
      <td className="muted u-115">{KIND_LABEL[device.kind] ?? device.kind}</td>
      <td
        className="mono u-115"
        title={`首次接入 ${fmtDateTime(device.firstSeen)}（跨重启持久记录）`}
      >
        {fmtDateTimeShort(device.firstSeen)}
      </td>
      <td className="mono u-115">
        {hasSamples ? fmtMs(device.quality.latencyMs) : <span className="na">—</span>}
      </td>
      <td className="mono u-115">
        {hasSamples ? fmtPct(device.quality.packetLossPct) : <span className="na">—</span>}
      </td>
      <td>
        <QualityBar grade={device.quality.grade} samples={device.quality.samples} />
      </td>
      <td>
        {bw.attributable ? (
          <span
            className="bw-cell"
            title={`推算自网卡计数器与 TCP 连接占比（活跃连接 ${bw.connections}）${bw.estimated ? '，估算值' : ''}`}
          >
            <span className="bw-cell__row">
              <span className="dim">↓</span>
              {fmtBitRate(bw.rxBps)}
            </span>
            <span className="bw-cell__row" data-tx="true">
              <span className="dim">↑</span>
              {fmtBitRate(bw.txBps)}
            </span>
          </span>
        ) : (
          <span
            className="bw-cell__na"
            title={`局域网内无可见 TCP 会话，无法把网卡流量归集到这台机器（活跃连接 ${bw.connections}）`}
          >
            无流量归集
          </span>
        )}
      </td>
    </tr>
  )
}, sameRow)

/* -------------------------------------------------------------------------- */

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

const STATE_RANK: Record<string, number> = { offline: 0, degraded: 1, scanning: 2, online: 3 }

export function DevicesView({ devices, selectedId, onOpenDetail, scanning, totalDevices }: DevicesViewProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [kind, setKind] = useState<string>('all')
  const [traffic, setTraffic] = useState<TrafficFilter>('all')
  const [sort, setSort] = useState<SortKey>('ip')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  /** 增量分页：大网段（200+ 设备）时先渲染前 100 行，"显示更多"逐页放量 */
  const [visibleCount, setVisibleCount] = useState(100)
  const searchRef = useRef<HTMLInputElement | null>(null)

  // `/` 聚焦搜索框（brief §3 键盘约定）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing =
        el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const kinds = useMemo(() => {
    const set = new Set<string>()
    for (const d of devices) set.add(d.kind)
    return Array.from(set).sort()
  }, [devices])

  const counts = useMemo(() => {
    let online = 0
    let degraded = 0
    let offline = 0
    for (const d of devices) {
      if (d.state === 'online') online += 1
      else if (d.state === 'degraded') degraded += 1
      else if (d.state === 'offline') offline += 1
    }
    return { all: devices.length, online, degraded, offline }
  }, [devices])

  // 流量状态计数：与筛选同源（bandwidth.attributable）
  const trafficCounts = useMemo(() => {
    let yes = 0
    for (const d of devices) if (d.bandwidth.attributable) yes += 1
    return { yes, no: devices.length - yes }
  }, [devices])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = devices.filter((d) => {
      if (status !== 'all' && d.state !== status) return false
      if (kind !== 'all' && d.kind !== kind) return false
      if (traffic === 'attributable' && !d.bandwidth.attributable) return false
      if (traffic === 'unattributable' && d.bandwidth.attributable) return false
      if (!q) return true
      return (
        d.ip.includes(q) ||
        (d.mac ?? '').toLowerCase().includes(q) ||
        (d.hostname ?? '').toLowerCase().includes(q) ||
        (d.displayName ?? '').toLowerCase().includes(q) ||
        (d.vendor ?? '').toLowerCase().includes(q)
      )
    })

    const out = filtered.slice()
    // 排序方向：同一列再次点击在升/降序间切换；未评级设备始终垫底（不受方向影响）
    const dir = sortDir === 'asc' ? 1 : -1
    out.sort((a, b) => {
      switch (sort) {
        case 'latency': {
          // 未评级（grade === 'unknown'）一律排最后：样本不足 ≠ 0 分，不能挤在已评级设备前面
          const ar = a.quality.grade === 'unknown' ? 1 : 0
          const br = b.quality.grade === 'unknown' ? 1 : 0
          if (ar !== br) return ar - br
          // 同为未评级：样本多的（更接近出结论）在前
          if (ar === 1 && a.quality.samples !== b.quality.samples) {
            return dir * (b.quality.samples - a.quality.samples)
          }
          const av = a.quality.samples > 0 ? (a.quality.latencyMs ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
          const bv = b.quality.samples > 0 ? (b.quality.latencyMs ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
          return dir * (av - bv)
        }
        case 'loss': {
          // 与延迟同口径：未评级垫底，无样本视为最大值
          const ar = a.quality.grade === 'unknown' ? 1 : 0
          const br = b.quality.grade === 'unknown' ? 1 : 0
          if (ar !== br) return ar - br
          if (ar === 1 && a.quality.samples !== b.quality.samples) {
            return dir * (b.quality.samples - a.quality.samples)
          }
          const av = a.quality.samples > 0 ? (a.quality.packetLossPct ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
          const bv = b.quality.samples > 0 ? (b.quality.packetLossPct ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
          return dir * (av - bv)
        }
        case 'bandwidth':
          return dir * ((a.bandwidth.rxBps + a.bandwidth.txBps) - (b.bandwidth.rxBps + b.bandwidth.txBps))
        case 'lanConnections':
          // task-021 F4：无归集设备的字节数无意义，活跃连接数是本机可拿到的真实数据；
          // 下拉选择时默认降序（见 onChange），表头点击仍可切换方向
          return dir * (a.bandwidth.connections - b.bandwidth.connections)
        case 'name': {
          const an = (a.displayName ?? a.hostname ?? a.ip).toLowerCase()
          const bn = (b.displayName ?? b.hostname ?? b.ip).toLowerCase()
          return dir * (an < bn ? -1 : an > bn ? 1 : 0)
        }
        case 'firstSeen':
          // firstSeen 是持久化的确定值，无"未知"分支：直接数值比较
          return dir * (a.firstSeen - b.firstSeen)
        case 'ip':
        default: {
          const diff = ipValue(a.ip) - ipValue(b.ip)
          if (diff !== 0) return dir * diff
          return dir * ((STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9))
        }
      }
    })
    return out
  }, [devices, query, status, kind, traffic, sort, sortDir])

  // 筛选/排序变化时回到第一页，避免停留在深处看不到新结果的首行
  useEffect(() => {
    setVisibleCount(100)
  }, [query, status, kind, traffic, sort, sortDir])

  const visibleRows = useMemo(
    () => (rows.length > visibleCount ? rows.slice(0, visibleCount) : rows),
    [rows, visibleCount],
  )
  const hiddenCount = rows.length - visibleRows.length

  const onOpen = useCallback((id: string) => onOpenDetail(id), [onOpenDetail])
  const resetFilters = useCallback(() => {
    setQuery('')
    setStatus('all')
    setKind('all')
    setTraffic('all')
  }, [])

  const header = (key: SortKey, label: string, alignRight = false) => {
    const active = sort === key
    return (
      <th
        className={alignRight ? 'is-sortable cell-right' : 'is-sortable'}
        onClick={() => {
          if (active) {
            setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
          } else {
            setSort(key)
            setSortDir('asc')
          }
        }}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        title={`按${SORT_LABEL[key]}排序${active ? '，再次点击切换方向' : ''}`}
      >
        {label}
        {active && <span className="sort-caret">{sortDir === 'asc' ? '▾' : '▴'}</span>}
      </th>
    )
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">设备</div>
          <div className="view-desc">
            在线判定以 ARP 表为主信号；ICMP 不通不等于离线。样本不足（&lt; 8）时只显示「采样中 n/8」，不评级。
          </div>
        </div>
        <div className="toolbar__meta">
          共 <span className="mono">{totalDevices}</span> 台 · 当前显示{' '}
          <span className="mono">{rows.length}</span> 台
          {scanning && (
            <>
              {' · '}
              <Icon name="refresh" size={11} className="is-spinning" />
              扫描中
            </>
          )}
        </div>
      </div>

      <div className="toolbar">
        <label className="field">
          <Icon name="search" size={13} />
          <input
            ref={searchRef}
            className="field__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 IP / MAC / 主机名 / 厂商"
            spellCheck={false}
            aria-label="搜索设备"
          />
          <span className="field__kbd">/</span>
        </label>

        <div className="segmented" role="group" aria-label="状态筛选">
          {(
            [
              ['all', '全部', counts.all],
              ['online', '在线', counts.online],
              ['degraded', '降级', counts.degraded],
              ['offline', '离线', counts.offline],
            ] as Array<[StatusFilter, string, number]>
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              className="segmented__item"
              aria-pressed={status === key}
              onClick={() => setStatus(key)}
            >
              {label}
              <span className="segmented__count">{count}</span>
            </button>
          ))}
        </div>

        <select
          className="select"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label="设备类型筛选"
        >
          <option value="all">全部类型</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k] ?? k}
            </option>
          ))}
        </select>

        <div className="segmented" role="group" aria-label="流量状态筛选">
          {(
            [
              ['all', '全部流量', devices.length],
              ['attributable', '可归集', trafficCounts.yes],
              ['unattributable', '不可归集', trafficCounts.no],
            ] as Array<[TrafficFilter, string, number]>
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              className="segmented__item"
              aria-pressed={traffic === key}
              onClick={() => setTraffic(key)}
              title={
                key === 'all'
                  ? '不按流量归集状态筛选'
                  : key === 'attributable'
                    ? '只看与本机存在 TCP 会话、流量可归集的设备'
                    : '只看未与本机建立 TCP 会话、显示「无流量归集」的设备'
              }
            >
              {label}
              <span className="segmented__count">{count}</span>
            </button>
          ))}
        </div>

        <select
          className="select"
          value={sort}
          onChange={(e) => {
            const key = e.target.value as SortKey
            setSort(key)
            // 活跃连接数的意义在"谁连得多"，默认降序；其余保持升序习惯
            setSortDir(key === 'lanConnections' ? 'desc' : 'asc')
          }}
          aria-label="排序方式"
        >
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              按{SORT_LABEL[k]}排序
            </option>
          ))}
        </select>
      </div>

      <div className="card table-wrap">
        <table className="table table--devices">
          <colgroup className="cols-devices">
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>状态</th>
              {header('ip', 'IP')}
              {header('name', '主机名')}
              <th>MAC</th>
              <th>厂商</th>
              <th>系统</th>
              <th>类型</th>
              {header('firstSeen', '首次接入')}
              {header('latency', '延迟')}
              {header('loss', '丢包')}
              <th>质量</th>
              {header('bandwidth', '↓/↑ bit/s', true)}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((d) => (
              <DeviceRow key={d.id} device={d} selected={d.id === selectedId} onOpen={onOpen} />
            ))}
          </tbody>
        </table>

        {rows.length === 0 && (
          <EmptyState
            icon={query || status !== 'all' || kind !== 'all' ? 'search' : 'devices'}
            title={query || status !== 'all' || kind !== 'all' ? '没有匹配的设备' : '尚未发现设备'}
            desc={
              query || status !== 'all' || kind !== 'all'
                ? '当前筛选条件下没有设备。清空筛选可查看全部扫描结果。'
                : '本轮扫描未返回任何设备。请确认网卡已连接目标网段，或手动触发一次刷新。'
            }
            actions={
              query || status !== 'all' || kind !== 'all' ? (
                <button type="button" className="btn" onClick={resetFilters}>
                  清空筛选
                </button>
              ) : undefined
            }
          />
        )}

        <div className="table-foot">
          <span>
            在线 <span className="mono">{counts.online}</span> · 降级{' '}
            <span className="mono">{counts.degraded}</span> · 离线{' '}
            <span className="mono">{counts.offline}</span>
          </span>
          <span className="toolbar__spacer" />
          {hiddenCount > 0 ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setVisibleCount((n) => n + 100)}
            >
              显示更多（还有 {hiddenCount} 台）
            </button>
          ) : (
            <span>
              已显示 <span className="mono">{rows.length}</span> 台
            </span>
          )}
        </div>
      </div>
    </>
  )
}
