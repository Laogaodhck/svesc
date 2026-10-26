import { useCallback, useEffect, useRef, useState } from 'react'
import type { LanApi, ScanProgress, Snapshot } from '../../shared/types'
import { markSnapshotReceived } from '../lib/perf'

/**
 * 实时数据源 hook —— 推送优先（plan §3）：
 * - 主进程每 5s 推 `lan:snapshot`（带宽 2s 单独体现在 system.rxBps/txBps 的 tick 里）
 * - 首屏用 `getSnapshot()` 取一次，避免等到下一个心跳才出内容
 * - 渲染层不轮询、不 fetch，绝不自己造数据
 *
 * 状态只持有快照引用，不做深拷贝（brief §4）。
 */

/** 运行时仍要判空：主进程 preload 注入失败时 window.lanApi 会是 undefined */
function readApi(): LanApi | null {
  return window.lanApi ?? null
}

export interface LiveFeed {
  snapshot: Snapshot | null
  progress: ScanProgress | null
  /** 预加载桥缺失（主进程未注入）——UI 必须明说，不能假装有数据 */
  apiMissing: boolean
  error: string | null
  /** 用户手动关闭全局错误条（数据诚实：关闭是用户主动行为，不是静默） */
  dismissError: () => void
  refresh: () => void
  setAutoScan: (enabled: boolean) => void
  /** 导出报告（task-025：format 缺省 json，可传 html） */
  exportReport: (format?: 'json' | 'html') => Promise<{ ok: boolean; path: string | null; error?: string }>
}

export function useLiveFeed(): LiveFeed {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [apiMissing, setApiMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const apiRef = useRef<LanApi | null>(null)

  useEffect(() => {
    const api = readApi()
    apiRef.current = api

    if (!api) {
      setApiMissing(true)
      return
    }

    let alive = true
    const offs: Array<() => void> = []

    offs.push(
      api.onSnapshot((s) => {
        if (!alive) return
        markSnapshotReceived()
        setSnapshot(s)
      })
    )
    offs.push(
      api.onScanProgress((p) => {
        if (alive) setProgress(p)
      })
    )

    // 首屏
    api
      .getSnapshot()
      .then((s) => {
        if (alive && s) {
          markSnapshotReceived()
          setSnapshot(s)
        }
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      alive = false
      for (const off of offs) {
        try {
          off()
        } catch {
          /* 清理失败不得影响卸载 */
        }
      }
    }
  }, [])

  const refresh = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    api
      .refresh()
      .then(() => setError(null))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  const setAutoScan = useCallback((enabled: boolean) => {
    const api = apiRef.current
    if (!api) return
    api
      .setAutoScan(enabled)
      .then(() => setError(null))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  const exportReport = useCallback(async (format?: 'json' | 'html') => {
    const api = apiRef.current
    if (!api) return { ok: false, path: null, error: '未连接主进程，无法导出报告' }
    try {
      const res = await api.exportReport(format)
      if (!res.ok) {
        setError(res.error ?? '导出失败')
        return res
      }
      setError(null)
      return res
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      return { ok: false, path: null, error: message }
    }
  }, [])

  const dismissError = useCallback(() => setError(null), [])

  return {
    snapshot,
    progress,
    apiMissing,
    error,
    dismissError,
    refresh,
    setAutoScan,
    exportReport,
  }
}
