import { gradeTone, qualityPhase, type Tone } from '../../lib/semantics'
import { QUALITY_MIN_SAMPLES } from '../../../shared/constants'

export interface ScoreRingProps {
  /** 0-100 评分；无样本时传 null */
  score: number | null
  grade: string
  samples: number
  size?: number
  stroke?: number
}

const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  crit: 'var(--crit)',
  accent: 'var(--accent)',
  muted: 'var(--text-dim)',
}

const GRADE_SUB: Record<string, string> = {
  excellent: '优',
  good: '良',
  fair: '中',
  poor: '差',
  unknown: '未采样',
}

/**
 * 评分环 —— 详情抽屉的网络质量主指标。
 *
 * - `samples === 0`：空环 + 中心 "—" + 角标「未采样」（不显示 0 分）；
 * - `0 < samples < 8`：**中性灰环 + 真实分数** + 角标「采样中 5/8」。
 *   score 是真实测量结果，保留显示；但样本不足以给评级，所以不着琥珀/红，
 *   也不写「差」——否则前 30 秒每一台设备都像质量事故；
 * - 已评级：沿用现有 good/fair/poor 配色。
 */
export function ScoreRing({ score, grade, samples, size = 92, stroke = 7 }: ScoreRingProps) {
  const phase = qualityPhase(samples, grade)
  const hasScore = score !== null && Number.isFinite(score)
  const graded = phase === 'graded' && hasScore
  const sampling = phase === 'sampling' && hasScore
  const drawn = graded || sampling

  const tone: Tone = graded ? gradeTone(grade) : 'muted'
  const color = TONE_COLOR[tone]

  const c = size / 2
  const r = (size - stroke) / 2 - 1
  const circ = 2 * Math.PI * r
  const pct = drawn ? Math.max(0, Math.min(100, score as number)) / 100 : 0

  const sublabel = graded
    ? GRADE_SUB[grade] ?? grade
    : sampling
      ? `采样中 ${samples}/${QUALITY_MIN_SAMPLES}`
      : samples > 0
        ? '无有效样本'
        : '未采样'

  const aria = graded
    ? `网络质量评分 ${Math.round(score as number)} 分，${GRADE_SUB[grade] ?? grade}`
    : sampling
      ? `网络质量采样中，已收到 ${samples} 个样本，评分 ${Math.round(score as number)} 分，样本不足暂不评级`
      : samples > 0
        ? `网络质量无有效样本，已采样 ${samples} 次`
        : '网络质量未采样'

  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={aria}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth={1}
        opacity={0.6}
      />
      {drawn && (
        <circle
          className="ring__arc"
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(pct * circ).toFixed(2)} ${circ.toFixed(2)}`}
          transform={`rotate(-90 ${c} ${c})`}
        />
      )}
      <text
        x={c}
        y={c + 2}
        textAnchor="middle"
        className="ring__value"
        fill={graded ? 'var(--text)' : 'var(--text-dim)'}
      >
        {drawn ? Math.round(score as number) : '—'}
      </text>
      <text
        x={c}
        y={sampling ? c + 19 : c + 18}
        textAnchor="middle"
        className="ring__sublabel"
        data-phase={phase}
        fill="var(--text-dim)"
      >
        {sublabel}
      </text>
    </svg>
  )
}
