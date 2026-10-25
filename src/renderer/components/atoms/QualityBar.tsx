import { gradeSegments, gradeTone, qualityPhase, type Tone } from '../../lib/semantics'
import { QUALITY_MIN_SAMPLES } from '../../../shared/constants'
import { GRADE_LABEL } from '../../lib/format'

export interface QualityBarProps {
  grade: string
  samples: number
  /** 紧凑模式：只留段与短标签 */
  compact?: boolean
}

/**
 * 网络质量 5 段条 + 等级文字。
 *
 * 三态必须分开（team-lead 裁定的置信门：samples < 8 时 grade 一律 unknown）：
 * - `samples === 0` → 「未采样」，灰；不画段
 * - `0 < samples < 8` → 「采样中 5/8」，灰；**不画段、不着琥珀/红**
 * - 否则 → 正常评级配色
 *
 * 启动后前 30 秒所有设备都会落在第二态，若那时满屏红黄，用户会误判整网有问题。
 */
export function QualityBar({ grade, samples, compact = false }: QualityBarProps) {
  const phase = qualityPhase(samples, grade)

  if (phase === 'unavailable') {
    return (
      <span
        className="quality__text"
        data-phase="none"
        title={
          samples > 0
            ? `已发起 ${samples} 次 ICMP 采样，但均未取得有效 RTT，无法评级`
            : '该主机未响应 ICMP（可能禁 ping），无法评估质量；在线判定来自 ARP 表'
        }
      >
        未采样
      </span>
    )
  }

  if (phase === 'sampling') {
    return (
      <span
        className="quality__text"
        data-phase="sampling"
        title={`已收到 ${samples} 个 ICMP 样本，累计 ${QUALITY_MIN_SAMPLES} 个后给出质量结论（样本不足暂不评级）`}
      >
        采样中 {samples}/{QUALITY_MIN_SAMPLES}
      </span>
    )
  }

  const tone: Tone = gradeTone(grade)
  const filled = gradeSegments(grade)
  const label = GRADE_LABEL[grade] ?? grade

  return (
    <span
      className="quality"
      title={`质量评分 ${GRADE_LABEL[grade] ?? grade} · 样本 ${samples} 次`}
      aria-label={`网络质量 ${label}`}
    >
      <span className="quality__segs" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="quality__seg" data-on={i < filled} data-tone={tone} />
        ))}
      </span>
      {!compact && <span className="quality__text">{label}</span>}
    </span>
  )
}
