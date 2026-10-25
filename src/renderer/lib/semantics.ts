/**
 * UI 语义映射 —— 把契约里的字符串枚举翻成视觉 tone。
 * 全部以 string 入参，避免渲染层在原子组件上绑定共享类型。
 */

import { QUALITY_MIN_SAMPLES } from '../../shared/constants'

/**
 * 质量态三分类：无样本 / 采样中（样本不足，不给评级）/ 已评级（`graded`）。
 *
 * team-lead 裁定：`samples < QUALITY_MIN_SAMPLES` 时引擎一律给 `grade === 'unknown'`，
 * `score` 仍照常计算（数值是真实测量，保留为证据）。因此 `unknown` 有两种成因，
 * UI 必须分开表达，否则"禁 ping 的机器"会永远挂在"采样中 0/8"上骗人等结果。
 */
export type QualityPhase = 'unavailable' | 'sampling' | 'graded'

/**
 * 判定质量态。按**成因**分三支（顺序即语义，不要调换）：
 *   1. `samples === 0` → 从未拿到 ICMP 样本（大概率禁 ping），不是"采样中"；
 *   2. `0 < samples < 8` → 正在采样，显示 `采样中 n/8`；
 *   3. `samples >= 8` → 按 grade 上色。
 *
 * 第 3 支再挡一次 `grade === 'unknown'`：契约上 >=8 必须有评级，但若样本全部超时
 * （8 次采样零有效 RTT）引擎仍可能给 unknown，此时退回"无法评级"，
 * 不能装作已评级，更不能画成 0 分。
 *
 * 只看样本数与 grade，**不看 score**——score 在样本不足时照样有值，
 * 用它判断会把"采样中"误判成"已评级"。
 */
export function qualityPhase(samples: number, grade: string): QualityPhase {
  if (samples <= 0) return 'unavailable'
  if (samples < QUALITY_MIN_SAMPLES) return 'sampling'
  if (grade === 'unknown') return 'unavailable'
  return 'graded'
}

export type Tone = 'ok' | 'warn' | 'crit' | 'muted' | 'accent'

/** 链路状态 → 色。离线是灰（"不见了"），不是红（"起火了"）。 */
export function stateTone(state: string): Tone {
  switch (state) {
    case 'online':
      return 'ok'
    case 'degraded':
      return 'warn'
    case 'scanning':
      return 'accent'
    case 'offline':
    default:
      return 'muted'
  }
}

/** 质量等级 → 色。unknown 用灰，不参与红黄绿语义。 */
export function gradeTone(grade: string): Tone {
  switch (grade) {
    case 'excellent':
      return 'ok'
    case 'good':
      return 'accent'
    case 'fair':
      return 'warn'
    case 'poor':
      return 'crit'
    default:
      return 'muted'
  }
}

/** 质量等级 → 实心段数（0 表示未采样，不画任何实心段）。 */
export function gradeSegments(grade: string): number {
  switch (grade) {
    case 'excellent':
      return 5
    case 'good':
      return 4
    case 'fair':
      return 3
    case 'poor':
      return 2
    default:
      return 0
  }
}

/**
 * 是否已有**评级结论**（等价于 `qualityPhase === 'graded'`）。
 * 注意：这只是"能不能显示优/良/中/差"，不代表"有没有测量值"——
 * 样本不足时延迟/丢包仍是真的（用 `samples > 0` 判断）。
 */
export function isQualitySampled(grade: string, samples: number): boolean {
  return qualityPhase(samples, grade) === 'graded'
}

export function printerStateTone(state: string): Tone {
  switch (state) {
    case 'idle':
      return 'ok'
    case 'printing':
      return 'accent'
    case 'warning':
      return 'warn'
    case 'error':
      return 'crit'
    case 'offline':
      return 'muted'
    default:
      return 'muted'
  }
}

export function severityTone(severity: string): Tone {
  switch (severity) {
    case 'critical':
      return 'crit'
    case 'warning':
      return 'warn'
    case 'info':
      return 'accent'
    default:
      return 'muted'
  }
}

/** 耗材种类 → CSS 变量色（K/C/M/Y/鼓/废粉）。 */
export function consumableColor(kind: string): string {
  switch (kind) {
    case 'black':
      return 'var(--toner-k)'
    case 'cyan':
      return 'var(--toner-c)'
    case 'magenta':
      return 'var(--toner-m)'
    case 'yellow':
      return 'var(--toner-y)'
    case 'drum':
      return 'var(--toner-drum)'
    case 'waste':
      return 'var(--toner-waste)'
    default:
      return 'var(--toner-other)'
  }
}
