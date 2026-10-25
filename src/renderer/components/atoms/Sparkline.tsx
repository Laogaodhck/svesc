import { useMemo } from 'react'

/**
 * Sparkline —— 折线迷你图，零依赖，纯 SVG。
 *
 * 关键行为（数据诚实）：
 * - `null` 表示该点无采样（ICMP 超时 / 未采集），**断线**而不是补 0，
 *   断点用红点标出，避免把"没测到"画成"延迟为 0"。
 * - 全部为 null 时只画一条虚线基准，不伪造曲线。
 * - 自动纵向缩放，但保留 0 以上最小跨度，防止平坦数据抖动成假波浪。
 */

export interface SparklineProps {
  values: Array<number | null>
  width?: number
  height?: number
  /** 只取末尾 N 个点（RTT 最近 60 点） */
  maxPoints?: number
  stroke?: string
  /** 断点红点 */
  markGaps?: boolean
  /** 折线下方低透明度填充 */
  area?: boolean
  /** 单位，用于可访问描述 */
  unit?: string
  className?: string
}

interface SegmentPoint {
  x: number
  y: number
}

export function Sparkline({
  values,
  width = 160,
  height = 36,
  maxPoints,
  stroke = 'var(--accent)',
  markGaps = true,
  area = false,
  unit = '',
  className,
}: SparklineProps) {
  const { segments, gaps, hasData, flatY } = useMemo(() => {
    const pts = maxPoints && values.length > maxPoints ? values.slice(-maxPoints) : values
    const n = pts.length
    const padX = 2
    const padY = 3
    const innerW = Math.max(1, width - padX * 2)
    const innerH = Math.max(1, height - padY * 2)

    const nums: number[] = []
    for (const v of pts) {
      if (v !== null && Number.isFinite(v)) nums.push(v)
    }
    const has = nums.length > 0
    if (!has) {
      return { segments: [] as SegmentPoint[][], gaps: [] as SegmentPoint[], hasData: false, flatY: height / 2 }
    }

    let min = Math.min(...nums)
    let max = Math.max(...nums)
    if (max === min) {
      const d = Math.max(1, Math.abs(max) * 0.15)
      min -= d
      max += d
    } else {
      const span = max - min
      min -= span * 0.16
      max += span * 0.16
    }
    const span = max - min || 1

    const xAt = (i: number) => (n === 1 ? padX + innerW / 2 : padX + (i * innerW) / (n - 1))
    const yAt = (v: number) => padY + innerH - ((v - min) / span) * innerH

    const segs: SegmentPoint[][] = []
    const gapPoints: SegmentPoint[] = []
    let current: SegmentPoint[] = []

    for (let i = 0; i < n; i += 1) {
      const v = pts[i]
      if (v === null || !Number.isFinite(v)) {
        if (current.length > 1) segs.push(current)
        current = []
        gapPoints.push({ x: xAt(i), y: height - 3 })
        continue
      }
      current.push({ x: xAt(i), y: yAt(v) })
    }
    if (current.length > 1) segs.push(current)
    // 单点序列也要能看见：补一个 1px 短段
    if (segs.length === 0 && current.length === 1) {
      const p = current[0]
      segs.push([{ x: p.x - 0.75, y: p.y }, { x: p.x + 0.75, y: p.y }])
    }

    return { segments: segs, gaps: gapPoints, hasData: true, flatY: height / 2 }
  }, [values, maxPoints, width, height])

  const linePath = (seg: SegmentPoint[]) =>
    seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')

  const areaPath = (seg: SegmentPoint[]) => {
    if (seg.length < 2) return ''
    const base = height - 1
    const first = seg[0]
    const last = seg[seg.length - 1]
    return `${linePath(seg)} L${last.x.toFixed(2)},${base} L${first.x.toFixed(2)},${base} Z`
  }

  return (
    <svg
      className={['spark', className].filter(Boolean).join(' ')}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={hasData ? `趋势曲线，最近 ${values.length} 个采样点${unit ? `，单位 ${unit}` : ''}` : '无采样数据'}
    >
      {!hasData && (
        <line
          x1={2}
          y1={flatY}
          x2={width - 2}
          y2={flatY}
          stroke="var(--border-strong)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      )}
      {area &&
        segments.map((seg, i) => (
          <path key={`a${i}`} d={areaPath(seg)} fill={stroke} opacity={0.1} stroke="none" />
        ))}
      {segments.map((seg, i) => (
        <path
          key={`l${i}`}
          d={linePath(seg)}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {markGaps &&
        gaps.map((p, i) => (
          <circle key={`g${i}`} cx={p.x} cy={p.y} r={1.8} fill="var(--crit)" opacity={0.85} />
        ))}
    </svg>
  )
}
