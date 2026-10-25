import type { RefObject } from 'react'
import { StatusDot } from '../atoms/StatusDot'
import { fmtClock, fmtCountdown } from '../../lib/format'
import { useTick } from '../../hooks/useTick'

export interface StatusBarProps {
  /** 最近一次收到快照的时间；null = 尚未收到 */
  snapshotTs: number | null
  /** 下一次扫描的绝对时间戳 */
  nextScanAt: number | null
  autoScan: boolean
  scanning: boolean
  dataSource: string
  /**
   * 渲染耗时由 App 直接写 DOM（避免为了显示一个数字再触发一次整树渲染）。
   */
  renderMsRef: RefObject<HTMLSpanElement | null>
}

export function StatusBar({
  snapshotTs,
  nextScanAt,
  autoScan,
  scanning,
  dataSource,
  renderMsRef,
}: StatusBarProps) {
  const now = useTick(1000)
  const age = snapshotTs === null ? null : Math.max(0, now - snapshotTs)
  // 15s 没收到快照 = 心跳断了（推送间隔 5s，容 3 拍）
  const heartbeatOk = age !== null && age < 15_000
  const remaining = nextScanAt === null ? null : Math.max(0, nextScanAt - now)

  return (
    <footer className="statusbar">
      <span className="statusbar__seg">
        <StatusDot tone={heartbeatOk ? 'ok' : 'crit'} size="sm" pulse={!heartbeatOk} />
        心跳 {heartbeatOk ? '正常' : '中断'}
        {age !== null && <span className="dim">· {Math.round(age / 1000)}s 前</span>}
      </span>

      <span className="statusbar__sep" />

      <span className="statusbar__seg">
        {scanning ? (
          <span className="statusbar__scanning">正在扫描…</span>
        ) : autoScan ? (
          <>
            下次扫描 <span className="mono">{fmtCountdown(remaining)}</span>
          </>
        ) : (
          '自动扫描已关闭 · 仍持续监控'
        )}
      </span>

      <span className="statusbar__sep" />

      <span className="statusbar__seg">
        数据源 <span className="mono">{dataSource}</span>
      </span>

      <span className="statusbar__spacer" />

      <span className="statusbar__seg dim" title="最近一次快照的应用耗时（performance.now 实测）">
        渲染 <span className="mono" ref={renderMsRef}>—</span> ms
      </span>

      <span className="statusbar__seg dim">
        快照 <span className="mono">{fmtClock(snapshotTs)}</span>
      </span>
    </footer>
  )
}
