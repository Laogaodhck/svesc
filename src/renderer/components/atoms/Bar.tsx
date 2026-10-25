export interface BarProps {
  /** 真实值；null = 无数据，不画填充（调用方负责文案，绝不能兜底成 0） */
  value: number | null
  max?: number
  /** CSS 颜色，默认 accent */
  color?: string
  tall?: boolean
  title?: string
}

/** 水平进度条 —— 队列进度、占比等。 */
export function Bar({ value, max = 100, color = 'var(--accent)', tall = false, title }: BarProps) {
  const pct =
    value === null || !Number.isFinite(value) || max <= 0
      ? null
      : Math.min(100, Math.max(0, (value / max) * 100))

  return (
    <div className={tall ? 'bar bar--tall' : 'bar'} title={title} aria-hidden={title ? undefined : true}>
      {pct !== null && (
        <span className="bar__fill" style={{ width: `${pct}%`, background: color }} />
      )}
    </div>
  )
}
