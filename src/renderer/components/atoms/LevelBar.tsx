import { clamp } from '../../lib/format'

export interface LevelBarProps {
  /** 真实百分比 0-100；null = 设备不报告，绝不兜底成 0 */
  pct: number | null
  label: string
  color: string
  title?: string
}

/**
 * 垂直液位条（24×64）—— 打印机耗材。
 * null 时画斜纹虚线底 + "不报告"，**不出现 0% 也不是空条假装 0**。
 */
export function LevelBar({ pct, label, color, title }: LevelBarProps) {
  const empty = pct === null || !Number.isFinite(pct)
  const shown = empty ? null : clamp(pct as number, 0, 100)
  const low = shown !== null && shown <= 10
  const lowish = shown !== null && shown <= 25

  return (
    <div
      className="level"
      title={title ?? (empty ? `${label}：设备不报告该耗材余量` : `${label}：剩余 ${Math.round(shown ?? 0)}%`)}
    >
      <div className="level__track" data-empty={empty}>
        {shown !== null && (
          <span
            className="level__fill"
            style={{ height: `${shown}%`, background: color, opacity: lowish ? 0.95 : 1 }}
          />
        )}
      </div>
      <span className="level__pct" data-empty={empty} data-low={low ? 'true' : undefined}>
        {empty ? '不报告' : `${Math.round(shown as number)}%`}
      </span>
      <span className="level__label" title={label}>
        {label}
      </span>
    </div>
  )
}
