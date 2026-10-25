/**
 * 渲染耗时测量 —— 用于验收第 6 条（256 行连续 20 次快照）。
 *
 * 起点在 IPC 快照回调里打点，终点在 React commit（useLayoutEffect）里结算，
 * 覆盖「事件 → setState → 协调 → DOM 提交」的完整链路。
 * 结果同时写入状态条 DOM 与 `window.__perf`，供 Vic 的冒烟脚本读数。
 */

let startedAt = 0

export function markSnapshotReceived(): void {
  startedAt = performance.now()
}

export function settleSnapshotRender(): number | null {
  if (startedAt === 0) return null
  const ms = performance.now() - startedAt
  startedAt = 0
  return ms
}

export interface PerfSample {
  lastMs: number
  samples: number[]
  avgMs: number
  maxMs: number
}

const MAX_SAMPLES = 40

const state: PerfSample = { lastMs: 0, samples: [], avgMs: 0, maxMs: 0 }

export function recordPerf(ms: number): PerfSample {
  state.lastMs = ms
  state.samples.push(ms)
  if (state.samples.length > MAX_SAMPLES) state.samples.shift()
  const sum = state.samples.reduce((a, b) => a + b, 0)
  state.avgMs = sum / state.samples.length
  state.maxMs = Math.max(...state.samples)
  return state
}

/** 供冒烟脚本读取（只读快照副本，避免外部改动内部统计） */
export function publishPerf(): void {
  const w = window as unknown as { __perf?: PerfSample }
  w.__perf = { ...state, samples: state.samples.slice() }
}
