/**
 * B. 网络质量评分（`src/main/engine/network/quality.ts`）
 *
 * 断言依据：plan.md §5.1 + quality.ts 头部冻结公式
 *   latPen=clamp((lat-20)/1.5,0,60)  lossPen=clamp(loss*1.5,0,60)  jitterPen=clamp(jitter/3,0,20)
 *   score=round(clamp(100-三者之和,0,100))    grade: >=85 / >=70 / >=50 / else poor
 */
import { describe, expect, it } from 'vitest';
import { QUALITY, QUALITY_MIN_SAMPLES } from '../src/shared/constants';
import {
  clamp,
  computeQuality,
  gradeOf,
  isDegraded,
  unknownQuality,
} from '../src/main/engine/network/quality';

describe('B. clamp', () => {
  it('clamp(NaN, 0, 60) 应返回下界 0（NaN 不得向上传播）', () => {
    expect(clamp(Number.NaN, 0, 60)).toBe(0);
  });

  it('clamp(999, 0, 60) 应截断到上界 60', () => {
    expect(clamp(999, 0, 60)).toBe(60);
  });
});

describe('B. grade 边界（>= 判定）', () => {
  it('gradeOf(85) 应为 excellent（边界归高挡，不是 > 85）', () => {
    expect(gradeOf(85)).toBe('excellent');
  });

  it('gradeOf(84) 应为 good（差 1 分必须掉挡）', () => {
    expect(gradeOf(84)).toBe('good');
  });

  it('gradeOf(70) 应为 good', () => {
    expect(gradeOf(70)).toBe('good');
  });

  it('gradeOf(69) 应为 fair（差 1 分必须掉挡）', () => {
    expect(gradeOf(69)).toBe('fair');
  });

  it('gradeOf(50) 应为 fair', () => {
    expect(gradeOf(50)).toBe('fair');
  });

  it('gradeOf(49) 应为 poor（差 1 分必须掉挡）', () => {
    expect(gradeOf(49)).toBe('poor');
  });
});

describe('B. 样本不足时必须是 unknown（不得伪造"良好"）', () => {
  it('samples=1（单次扫描 ping）应为 score 0 / grade unknown', () => {
    const q = computeQuality({ latencyMs: 3, jitterMs: 0, packetLossPct: 0, samples: 1 });
    expect({ score: q.score, grade: q.grade }, '只有 1 个样本不足以算抖动与丢包').toEqual({
      score: 0,
      grade: 'unknown',
    });
  });

  it('samples=0 应为 score 0 / grade unknown', () => {
    const q = computeQuality({ latencyMs: null, jitterMs: null, packetLossPct: 0, samples: 0 });
    expect({ score: q.score, grade: q.grade }).toEqual({ score: 0, grade: 'unknown' });
  });

  it('samples 在 2..7（不足 2 个批次）时 grade 一律 unknown（置信门）', () => {
    const grades = [2, 3, 4, 5, 6, 7].map(
      (samples) => computeQuality({ latencyMs: 5, jitterMs: 0, packetLossPct: 0, samples }).grade,
    );
    expect(grades, '单批次（4 包）丢包粒度 25%，样本不足时任何结论都会闪变').toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('samples=7 且链路完美时 score 仍应为 100（score 是测量证据，grade 才是结论）', () => {
    const q = computeQuality({ latencyMs: 5, jitterMs: 0, packetLossPct: 0, samples: 7 });
    expect({ score: q.score, grade: q.grade }, 'score 必须保留数值供曲线使用，不得一并归零').toEqual({
      score: 100,
      grade: 'unknown',
    });
  });

  it('samples=8 时 grade 应按原边界判定（70 分 → good）', () => {
    // lat 5 → latPen 0；loss 20 → lossPen 30 → score 70
    const q = computeQuality({ latencyMs: 5, jitterMs: 0, packetLossPct: 20, samples: 8 });
    expect({ score: q.score, grade: q.grade }, '8 样本 = 2 个批次，置信门此时开门').toEqual({
      score: 70,
      grade: 'good',
    });
  });

  it('grade 门与 degraded 门必须在 7/8 边界上同时翻转（同源锁）', () => {
    const at7 = computeQuality({ latencyMs: 5, jitterMs: 0, packetLossPct: 25, samples: 7 });
    const at8 = computeQuality({ latencyMs: 5, jitterMs: 0, packetLossPct: 25, samples: 8 });
    expect(
      {
        grade7: at7.grade,
        degraded7: isDegraded(at7),
        grade8: at8.grade,
        degraded8: isDegraded(at8),
      },
      '两个门若用不同常量（如 grade 用 2、degraded 用 8），这里必然出现 7 号已出 grade 但未 degraded 的组合',
    ).toEqual({ grade7: 'unknown', degraded7: false, grade8: 'fair', degraded8: true });
  });

  it('unknownQuality() 应是没有 latency/jitter/samples 的诚实空值', () => {
    expect(unknownQuality()).toEqual({
      latencyMs: null,
      jitterMs: null,
      packetLossPct: 0,
      score: 0,
      grade: 'unknown',
      samples: 0,
    });
  });
});

describe('B. 冻结公式', () => {
  it('完美链路（lat 10 / jitter 0 / loss 0）应为 100 分 excellent', () => {
    const q = computeQuality({ latencyMs: 10, jitterMs: 0, packetLossPct: 0, samples: 10 });
    expect({ score: q.score, grade: q.grade }, 'lat 10 < SLA 20 → latPen=0').toEqual({
      score: 100,
      grade: 'excellent',
    });
  });

  it('lat 150ms 时 latPen 封顶 60，score 应为 40', () => {
    // (150-20)/1.5 = 86.67 → clamp 60
    const q = computeQuality({ latencyMs: 150, jitterMs: 0, packetLossPct: 0, samples: 10 });
    expect(q.score, 'penalty 应被 clamp 到 60，100-60=40').toBe(40);
  });

  it('latencyMs=null 且样本充足时应为 47/poor（不得进入 excellent/good 档）', () => {
    const q = computeQuality({ latencyMs: null, jitterMs: null, packetLossPct: 0, samples: 8 });
    // 冻结公式：null→100 → latPen=(100-20)/1.5=53.33 → 47/fair。
    // 队长已裁定「以公式为准」：quality.ts 注释里的"→60/40"是文档缺陷（见 test-report §5 C-2）。
    expect(
      { score: q.score, grade: q.grade },
      '未采到延迟必须按最差罚分处理。注意 47 < 50 所以 grade 是 poor 不是 fair —— 队长裁定意见里写的 "47/fair" 是笔误，47 的正确档位是 poor',
    ).toEqual({ score: 47, grade: 'poor' });
  });

  it('loss=100 时 lossPen 封顶 60，score 应为 40 而不是负数', () => {
    const q = computeQuality({ latencyMs: 10, jitterMs: 0, packetLossPct: 100, samples: 10 });
    expect(q.score, '100 - 0 - 60 = 40，下界钳制不应触发').toBe(40);
  });

  it('jitter 60ms 时 jitterPen=20，score 应为 80', () => {
    const q = computeQuality({ latencyMs: 10, jitterMs: 60, packetLossPct: 0, samples: 10 });
    expect(q.score).toBe(80);
  });

  it('score 无论如何不得越出 0..100', () => {
    const q = computeQuality({ latencyMs: 5000, jitterMs: 5000, packetLossPct: 100, samples: 10 });
    expect(q.score, `输入全为极端值，实得 ${q.score}`).toBe(0);
  });
});

describe('B. 异常输入不得抛异常', () => {
  it('NaN 延迟/抖动/丢包不应抛异常', () => {
    expect(() =>
      computeQuality({
        latencyMs: Number.NaN,
        jitterMs: Number.NaN,
        packetLossPct: Number.NaN,
        samples: 10,
      }),
    ).not.toThrow();
  });

  it('负延迟应按 0 罚分处理（不得产生 >100 的分数）', () => {
    const q = computeQuality({ latencyMs: -100, jitterMs: 0, packetLossPct: 0, samples: 10 });
    expect(q.score, '-100ms 是采集异常，按 0 罚分，分数必须被 clamp 在 100 以内').toBe(100);
  });

  it('丢包 250% 应按 100% 截断（score 40，不得出现负分）', () => {
    const q = computeQuality({ latencyMs: 10, jitterMs: 0, packetLossPct: 250, samples: 10 });
    expect(q.score).toBe(40);
  });
});

describe('B. isDegraded（§5.1 第 6 条：质量退化只在有样本时成立）', () => {
  it('sample 只有 1 个时不得判 degraded（扫描阶段的存活 ping 不算质量样本）', () => {
    const q = computeQuality({ latencyMs: 300, jitterMs: 0, packetLossPct: 0, samples: 1 });
    expect(q.grade, '单样本只能 unknown').toBe('unknown');
    expect(isDegraded(q), '样本不足时必须保持"未采样"，不许拿一次 ping 判网络劣化').toBe(false);
  });

  it('latency 200ms 且有 10 个样本应判 degraded', () => {
    const q = computeQuality({ latencyMs: 200, jitterMs: 0, packetLossPct: 0, samples: 10 });
    expect(isDegraded(q)).toBe(true);
  });

  it('丢包 20%（边界）应判 degraded', () => {
    const q = computeQuality({ latencyMs: 5, jitterMs: 0, packetLossPct: 20, samples: 10 });
    expect(isDegraded(q)).toBe(true);
  });

  it('只有 1 个批次（4 样本）时即使丢包 25% 也不得判 degraded（防闪变）', () => {
    // `ping -n 4` 的最小丢包粒度是 25%：单批次里 1 包被设备限速就会越过 20% 阈值
    const q = computeQuality({ latencyMs: 5, jitterMs: 0, packetLossPct: 25, samples: 4 });
    expect(
      isDegraded(q),
      '单批次就报警会让设备"35s 变红、55s 变绿"（实测 .196/.75/.148 均如此）',
    ).toBe(false);
  });

  it('两个批次（8 样本）丢包 25% 才应判 degraded（持续丢包）', () => {
    const q = computeQuality({ latencyMs: 5, jitterMs: 0, packetLossPct: 25, samples: 8 });
    expect(isDegraded(q), '这是 degradedMinSamples=8 的口径守卫').toBe(true);
  });
});

describe('B. 置信门常量必须单一来源（C-4 裁定第 3 条）', () => {
  it(`QUALITY_MIN_SAMPLES 的口径值是 ${QUALITY_MIN_SAMPLES}（>0 且为整数）`, () => {
    expect(Number.isInteger(QUALITY_MIN_SAMPLES) && QUALITY_MIN_SAMPLES > 0).toBe(true);
  });

  it('QUALITY.degradedMinSamples 必须与 QUALITY_MIN_SAMPLES 严格相等（不得出现第二个字面量 8）', () => {
    expect(
      QUALITY.degradedMinSamples,
      `degradedMinSamples=${QUALITY.degradedMinSamples}，QUALITY_MIN_SAMPLES=${QUALITY_MIN_SAMPLES}`,
    ).toBe(QUALITY_MIN_SAMPLES);
  });

  it('全样本区间内：grade !== unknown 当且仅当 samples >= QUALITY_MIN_SAMPLES', () => {
    // 7/8 单点等价锁的加强版：把 0..12 每个样本数都跑一遍，任一处两门取值不同即报红
    const mismatched: number[] = [];
    for (let samples = 0; samples <= 12; samples += 1) {
      const q = computeQuality({ latencyMs: 300, jitterMs: 50, packetLossPct: 30, samples });
      const hasGrade = q.grade !== 'unknown';
      if (hasGrade !== samples >= QUALITY_MIN_SAMPLES) mismatched.push(samples);
    }
    expect(mismatched, `grade 门与 samples>=${QUALITY_MIN_SAMPLES} 不一致的样本数：${mismatched.join(',')}`).toEqual([]);
  });

  it('全样本区间内：isDegraded 为 true 时 samples 必 >= QUALITY_MIN_SAMPLES', () => {
    const violated: number[] = [];
    for (let samples = 0; samples <= 12; samples += 1) {
      const q = computeQuality({ latencyMs: 300, jitterMs: 50, packetLossPct: 30, samples });
      if (isDegraded(q) && samples < QUALITY_MIN_SAMPLES) violated.push(samples);
    }
    expect(violated, `这些样本数下 degraded 门比置信门松：${violated.join(',')}`).toEqual([]);
  });
});
