/**
 * 网络质量评分 —— **纯函数，公式冻结**（brief §3 network/quality.ts、plan.md §5.1）。
 * Tess 会按下列公式写断言，任何人不得调整系数或四舍五入时机：
 *
 *   if samples < 2   → score 0, grade 'unknown'
 *   if samples >= 2  → score 按下列公式计算（样本不足也保留数值，作为测量证据）
 *   latPen    = clamp((latencyMs - 20) / 1.5, 0, 60)   // latencyMs 为 null 时按 100ms 处理：(100-20)/1.5 = 53.33
 *   lossPen   = clamp(packetLossPct * 1.5, 0, 60)
 *   jitterPen = clamp(jitterMs / 3, 0, 20)
 *   score     = round(clamp(100 - latPen - lossPen - jitterPen, 0, 100))
 *   grade     : 仅当 samples >= QUALITY_MIN_SAMPLES(8) 才按 >=85 excellent | >=70 good | >=50 fair | else poor
 *               判定；samples 2..7 一律 'unknown'（置信门，禁止"显示质量差但不告警"）
 *
 * 注意：`latencyMs=null` → latPen=(100-20)/1.5=53.33 → score 47 / grade 'poor'（47<50）。
 */
import type { NetQuality } from '../../../shared/types';
import { QUALITY, QUALITY_MIN_SAMPLES } from '../../../shared/constants';

export interface QualityInput {
  latencyMs: number | null;
  jitterMs: number | null;
  packetLossPct: number;
  samples: number;
}

export function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

export function gradeOf(score: number): NetQuality['grade'] {
  if (score >= QUALITY.excellent) return 'excellent';
  if (score >= QUALITY.good) return 'good';
  if (score >= QUALITY.fair) return 'fair';
  return 'poor';
}

/** 无样本时的诚实结果：0 分 + unknown，绝不伪造"良好"。 */
export function unknownQuality(): NetQuality {
  return {
    latencyMs: null,
    jitterMs: null,
    packetLossPct: 0,
    score: 0,
    grade: 'unknown',
    samples: 0,
  };
}

export function computeQuality(input: QualityInput): NetQuality {
  const samples = Math.max(0, Math.trunc(input.samples));
  const packetLossPct = clamp(input.packetLossPct, 0, 100);

  if (samples < 2) {
    return {
      latencyMs: input.latencyMs,
      jitterMs: input.jitterMs,
      packetLossPct,
      score: 0,
      grade: 'unknown',
      samples,
    };
  }

  const latencyForPenalty = input.latencyMs === null ? 100 : input.latencyMs;
  const jitterForPenalty = input.jitterMs === null ? 0 : input.jitterMs;

  const latPen = clamp((latencyForPenalty - QUALITY.slaLatencyMs) / 1.5, 0, 60);
  const lossPen = clamp(packetLossPct * 1.5, 0, 60);
  const jitterPen = clamp(jitterForPenalty / 3, 0, 20);
  const score = Math.round(clamp(100 - latPen - lossPen - jitterPen, 0, 100));

  // 置信门：样本不足只保留 score（测量证据），不下 grade 结论（禁止"显示质量差但不告警"）
  const grade = samples < QUALITY_MIN_SAMPLES ? 'unknown' : gradeOf(score);

  return {
    latencyMs: input.latencyMs,
    jitterMs: input.jitterMs,
    packetLossPct,
    score,
    grade,
    samples,
  };
}

/**
 * 是否达到"质量退化"告警阈值（plan.md §5.1 第 6 条 / NET_QUALITY 规则）。
 *
 * 采样口径契约：150ms / 20% 阈值不动，改的是"样本充足性"——
 * `computeQuality` 在 `samples < QUALITY_MIN_SAMPLES(8)` 时 grade 一律 unknown；
 * 判 degraded 引用**同一个常量**（2 个 `ping -n 4` 批次）。
 * 原因：单批次 4 包的最小丢包粒度就是 25%，1 包被设备限速就会瞬时越过 20%，
 * 产生"35s 红、55s 绿"的闪变（`.176` / `.196` 实测）。两个批次才足以区分持续丢包与单包抖动。
 */
export function isDegraded(quality: NetQuality): boolean {
  // 与 computeQuality 的 grade 门同源（QUALITY_MIN_SAMPLES）：样本不足既不给 grade，也不判劣化
  if (quality.samples < QUALITY_MIN_SAMPLES) return false;
  const slow = quality.latencyMs !== null && quality.latencyMs > QUALITY.degradedLatencyMs;
  const lossy = quality.packetLossPct >= QUALITY.degradedLossPct;
  return slow || lossy;
}
