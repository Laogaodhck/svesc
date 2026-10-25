import { useEffect, useRef, useState } from 'react'
import type { WarningEntry } from '../../../shared/types'
import { Icon } from '../Icon'
import { fmtClock, fmtCountdown, relTime } from '../../lib/format'
import { useTick } from '../../hooks/useTick'
import logoUrl from '../../assets/logo.png'

export interface TopBarProps {
  subnet: string | null
  dataSource: string
  lastScanAt: number | null
  autoScan: boolean
  autoScanIntervalSec: number
  /** 下一次扫描的绝对时间戳；由 App 用 snapshot.ts + nextScanInMs 算出 */
  nextScanAt: number | null
  scanning: boolean
  /** 引擎侧"某些数据源没采到"的提示（不是故障，不进告警中心计数） */
  warnings: WarningEntry[]
  onRefresh: () => void
  /** format：json = 结构化快照；html = 自包含巡检报告（task-025） */
  onExport: (format: 'json' | 'html') => Promise<{ ok: boolean; path: string | null; error?: string }>
  onToggleAutoScan: () => void
}

const WARN_SOURCE_LABEL: Record<string, string> = {
  discovery: '设备发现',
  printers: '打印机采集',
  bandwidth: '带宽采集',
  system: '系统信息',
}

const SOURCE_HINT: Record<string, string> = {
  demo: '当前网段未探测到足够设备，主进程已切换到模拟数据源，界面中所有数值均为演示数据。',
  mixed: '部分数据来自真实探测，部分来自模拟补齐；带「模拟」角标的条目为演示数据。',
}

export function TopBar({
  subnet,
  dataSource,
  lastScanAt,
  autoScan,
  autoScanIntervalSec,
  nextScanAt,
  scanning,
  warnings,
  onRefresh,
  onExport,
  onToggleAutoScan,
}: TopBarProps) {
  const now = useTick(1000)
  const isDemo = dataSource !== 'live'
  const remaining = nextScanAt === null ? null : Math.max(0, nextScanAt - now)

  // 导出成功反馈：按钮旁短暂显示目标路径，5s 后自动消失；失败走全局错误条（useLiveFeed 已 setError）
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const exportTimerRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current)
    }
  }, [])

  const handleExport = (format: 'json' | 'html') => {
    void onExport(format).then((res) => {
      if (!res.ok || !res.path) return
      setExportMsg(`已导出：${res.path}`)
      if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current)
      exportTimerRef.current = window.setTimeout(() => setExportMsg(null), 5000)
    })
  }

  // 数据不完整：只列前 5 条，剩下的折成"另有 N 条"。琥珀色，绝不进告警计数、绝不染红。
  const warnTitle =
    warnings.length === 0
      ? undefined
      : [
          `部分数据源本轮未采到（不代表设备故障）：`,
          ...warnings
            .slice(0, 5)
            .map((w) => `· ${WARN_SOURCE_LABEL[w.source] ?? w.source} · ${w.message} · ${relTime(w.at, now)}`),
          warnings.length > 5 ? `…另有 ${warnings.length - 5} 条` : '',
        ]
          .filter(Boolean)
          .join('\n')

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <img src={logoUrl} alt="浩玥工作室" width={18} height={18} className="topbar__logo" />
        <span className="topbar__name">SVESC</span>
        <span className="topbar__sub">局域网管理台</span>
      </div>

      <span className="chip chip--mono" title="当前扫描网段">
        <Icon name="network" size={12} />
        {subnet ?? '未识别网段'}
      </span>

      {dataSource === 'unknown' ? (
        <span className="chip" title="尚未收到主进程快照">
          <Icon name="clock" size={12} />
          等待数据
        </span>
      ) : isDemo ? (
        <span
          className="chip chip--warn"
          title={SOURCE_HINT[dataSource] ?? '当前展示的是演示数据'}
          role="status"
        >
          <Icon name="warn" size={12} />
          演示数据
        </span>
      ) : (
        <span className="chip chip--ok chip--plain" title="数据来自本机真实探测">
          <Icon name="activity" size={12} />
          实时数据
        </span>
      )}

      {warnings.length > 0 && (
        <span
          className="chip chip--warn topbar__warn"
          role="status"
          title={warnTitle}
          aria-label={`数据不完整 ${warnings.length} 项`}
        >
          <Icon name="warn" size={12} />
          数据不完整 {warnings.length}
        </span>
      )}

      <span className="topbar__spacer" />

      <div className="topbar__meta">
        <Icon name="clock" size={13} />
        <span>
          最后扫描 <span className="mono">{fmtClock(lastScanAt)}</span>
        </span>
      </div>

      <div className="topbar__actions">
        <button
          type="button"
          className="switch-field"
          onClick={onToggleAutoScan}
          aria-pressed={autoScan}
          title={autoScan ? '关闭自动扫描' : '开启自动扫描'}
        >
          <span className="switch" data-on={autoScan} aria-hidden="true">
            <span className="switch__knob" />
          </span>
          <span>自动扫描</span>
          <span className="mono switch-field__interval">{autoScanIntervalSec}s</span>
        </button>

        <span
          className="topbar__countdown"
          data-off={autoScan ? undefined : 'true'}
          title={
            autoScan
              ? '距离下一次自动扫描'
              : '自动扫描已关闭，但心跳 / 带宽 / 打印机采集仍在运行'
          }
        >
          {autoScan ? fmtCountdown(remaining) : '自动扫描已关闭 · 仍持续监控'}
        </span>

        <button
          type="button"
          className="btn btn--primary"
          onClick={onRefresh}
          disabled={scanning}
          title="立即执行一轮完整扫描"
        >
          <Icon name="refresh" size={13} className={scanning ? 'is-spinning' : undefined} />
          {scanning ? '扫描中' : '立即刷新'}
        </button>
        {/* task-025：导出改为下拉（JSON 结构化快照 / HTML 自包含巡检报告） */}
        <details className="topbar__export dropdown" title="导出报告">
          <summary className="btn" role="button" tabIndex={0}>
            <Icon name="export" size={13} />
            导出
          </summary>
          <div className="dropdown__menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="dropdown__item"
              onClick={() => {
                handleExport('json')
                ;(document.activeElement as HTMLElement | null)?.blur()
              }}
            >
              JSON 快照
              <span className="dropdown__hint">结构化数据 · 供对账</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dropdown__item"
              onClick={() => {
                handleExport('html')
                ;(document.activeElement as HTMLElement | null)?.blur()
              }}
            >
              HTML 巡检报告
              <span className="dropdown__hint">自包含单文件 · 可直接打开</span>
            </button>
          </div>
        </details>
        {exportMsg && (
          <span className="topbar__export-ok" role="status" title={exportMsg}>
            {exportMsg}
          </span>
        )}
      </div>
    </header>
  )
}
