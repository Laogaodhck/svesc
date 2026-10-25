import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiagKind, DiagResult, LogBundle, NetAdapter } from '../../shared/types'
import { EmptyState } from '../components/atoms/EmptyState'
import { Icon } from '../components/Icon'

/**
 * 诊断中心：网络诊断 / 本机网卡 / 应用日志。
 *
 * 数据诚实原则的落点：
 *  - 网卡字段拿不到就显示 '—'（ipconfig 解析失败不编造）
 *  - 日志环形缓冲滚动时明确标注"仅保留最近"，不假装是全量
 *  - 所有 IPC 调用统一 fail() 错误出口（审计红线：IPC 抛错必须可见）
 */

/** 快速诊断按钮组（kind 与 shared 契约 DiagKind 一一对应） */
const DIAG_ACTIONS: { kind: DiagKind; label: string }[] = [
  { kind: 'ping', label: 'Ping' },
  { kind: 'tracert', label: '路由跟踪' },
  { kind: 'ports', label: '端口扫描' },
  { kind: 'dns', label: 'DNS 解析' },
]

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 目标白名单：与主进程 sanitize 一致（字母数字与 . _ -，≤253，不以 . 或 - 开头结尾） */
const TARGET_RE = /^[A-Za-z0-9._-]{1,253}$/

function isValidTarget(t: string): boolean {
  if (!TARGET_RE.test(t)) return false
  return !t.startsWith('.') && !t.startsWith('-') && !t.endsWith('.') && !t.endsWith('-')
}

export function DiagnosticsView({
  presetTarget,
  onPresetConsumed,
}: {
  /** 从设备详情"网络诊断"跳转过来预填的目标；消费一次即清除 */
  presetTarget: string | null
  onPresetConsumed: () => void
}) {
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyKind, setBusyKind] = useState<DiagKind | null>(null)
  const [diagMsg, setDiagMsg] = useState<string | null>(null)
  const [diag, setDiag] = useState<DiagResult | null>(null)

  const [adapters, setAdapters] = useState<NetAdapter[] | null>(null)
  const [adapterErr, setAdapterErr] = useState<string | null>(null)
  const [adapterLoading, setAdapterLoading] = useState(false)

  const [bundle, setBundle] = useState<LogBundle | null>(null)
  const [logErr, setLogErr] = useState<string | null>(null)
  const [logMsg, setLogMsg] = useState<string | null>(null)
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)

  const hasApi = typeof window !== 'undefined' && window.lanApi !== undefined

  /** 目标即时校验：输入不合法时就地提示，诊断按钮同时禁用（不发 IPC） */
  const targetTrimmed = target.trim()
  const targetInvalid = targetTrimmed !== '' && !isValidTarget(targetTrimmed)

  /** 统一错误出口（沿用 PrinterManageView 的 fail 模式） */
  const fail = useCallback((err: unknown) => {
    const text = err instanceof Error ? err.message : String(err)
    setDiagMsg(text)
  }, [])

  /* -------- 快速诊断 -------- */
  const runDiag = useCallback(
    async (kind: DiagKind, targetArg?: string) => {
      if (!hasApi || busy) return
      const t = (targetArg ?? target).trim()
      // 与主进程白名单一致：格式不合法就不发 IPC（提示由 targetInvalid 渲染）
      if (!t || !isValidTarget(t)) return
      setBusy(true)
      setBusyKind(kind)
      setDiagMsg(null)
      setDiag(null)
      try {
        setDiag(await window.lanApi.diagRun(kind, t))
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
        setBusyKind(null)
      }
    },
    [hasApi, busy, target, fail],
  )

  /* -------- presetTarget：填入目标并自动跑一次 ping（ref 防重复） --------
   * P1 时序缺陷修复：busy 时不标记 ref、不清 preset——否则 runDiag 因 busy return
   * 后 onPresetConsumed 已把 state 清掉，自动 ping 静默丢失。
   * 等 busy 变 false 后本 effect 依赖 busy 重跑，再走完整消费流程。 */
  const runDiagRef = useRef(runDiag)
  runDiagRef.current = runDiag
  const consumedPresetRef = useRef<string | null>(null)
  useEffect(() => {
    if (!hasApi) return
    if (!presetTarget || consumedPresetRef.current === presetTarget) return
    if (busy) return
    consumedPresetRef.current = presetTarget
    setTarget(presetTarget)
    void runDiagRef.current('ping', presetTarget)
    onPresetConsumed()
  }, [presetTarget, onPresetConsumed, hasApi, busy])

  /* -------- 本机网卡 -------- */
  const reloadAdapters = useCallback(async () => {
    if (!hasApi) return
    setAdapterLoading(true)
    try {
      setAdapters(await window.lanApi.diagAdapters())
      setAdapterErr(null)
    } catch (err) {
      setAdapterErr(err instanceof Error ? err.message : String(err))
    } finally {
      setAdapterLoading(false)
    }
  }, [hasApi])

  useEffect(() => {
    void reloadAdapters()
  }, [reloadAdapters])

  /* -------- 应用日志 -------- */
  const reloadLogs = useCallback(async () => {
    if (!hasApi) return
    setLogsLoading(true)
    try {
      setBundle(await window.lanApi.logsGetRecent(100))
      setLogErr(null)
    } catch (err) {
      setLogErr(err instanceof Error ? err.message : String(err))
    } finally {
      setLogsLoading(false)
    }
  }, [hasApi])

  useEffect(() => {
    void reloadLogs()
  }, [reloadLogs])

  const onExport = useCallback(async () => {
    if (!hasApi) return
    setLogMsg(null)
    try {
      const res = await window.lanApi.logsExport()
      if (res.ok) {
        setExportPath(res.path)
        setLogMsg(null)
      } else {
        setLogMsg(res.error ?? '导出失败')
      }
    } catch (err) {
      setLogMsg(err instanceof Error ? err.message : String(err))
    }
  }, [hasApi])

  if (!hasApi) {
    return (
      <div className="card">
        <EmptyState icon="warn" title="未连接主进程" desc="诊断中心需要主进程提供 window.lanApi。" />
      </div>
    )
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">诊断中心</div>
          <div className="view-desc">网络连通性诊断、本机网卡信息与应用运行日志排查。</div>
        </div>
      </div>

      {/* —— 快速诊断 —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">快速诊断</span>
          <span className="card__hint">路由跟踪可能需要约 30 秒，请耐心等待</span>
        </div>
        <div className="manage-add">
          <input
            className="input"
            type="text"
            placeholder="IP 或主机名，如 192.168.2.1"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runDiag('ping')
            }}
          />
        </div>
        {targetInvalid && (
          <div className="router-msg" data-tone="crit">
            目标格式不正确（仅允许字母、数字与 . _ -）
          </div>
        )}
        <div className="diag-actions mt-10">
          {DIAG_ACTIONS.map((a) => (
            <button
              key={a.kind}
              type="button"
              className="btn"
              disabled={busy || targetInvalid || !targetTrimmed}
              onClick={() => void runDiag(a.kind)}
            >
              {busy && busyKind === a.kind ? '诊断中…' : a.label}
            </button>
          ))}
        </div>
        {diagMsg && (
          <div className="router-msg" data-tone="crit">
            {diagMsg}
          </div>
        )}
        {diag && (
          <div className="mt-10">
            <div className={diag.ok ? 'u-115' : 'u-115 u-crit'}>
              {diag.ok ? diag.summary : (diag.error ?? diag.summary ?? '诊断失败')}
            </div>
            <pre className="diag-output">{diag.lines.join('\n')}</pre>
          </div>
        )}
      </div>

      {/* —— 本机网卡 —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">本机网卡</span>
          <span className="card__hint">ipconfig /all 解析结果 · 拿不到的字段显示 —</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void reloadAdapters()}
            disabled={adapterLoading}
          >
            <Icon name="refresh" size={13} />
            {adapterLoading ? '刷新中…' : '刷新'}
          </button>
        </div>
        {adapterErr ? (
          <div className="router-msg" data-tone="crit">
            读取网卡信息失败：{adapterErr}
          </div>
        ) : adapters && adapters.length === 0 ? (
          <EmptyState icon="network" title="未获取到网卡信息" desc="ipconfig 解析无结果，请稍后刷新重试。" />
        ) : adapters ? (
          <table className="conn-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>状态</th>
                <th>IP</th>
                <th>网关</th>
                <th>DNS</th>
                <th>MAC</th>
                <th>DHCP</th>
              </tr>
            </thead>
            <tbody>
              {adapters.map((a, i) => (
                <tr key={`${a.name}-${a.mac ?? i}`}>
                  <td>{a.name}</td>
                  <td>{a.state === 'connected' ? '已连接' : '未连接'}</td>
                  <td className="mono">{a.ip ?? '—'}</td>
                  <td className="mono">{a.gateway ?? '—'}</td>
                  <td className="mono">{a.dns.length > 0 ? a.dns.join(', ') : '—'}</td>
                  <td className="mono">{a.mac ?? '—'}</td>
                  <td>{a.dhcp === null ? '—' : a.dhcp ? '是' : '否'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="u-11 dim">正在读取网卡信息…</div>
        )}
      </div>

      {/* —— 应用日志 —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">应用日志</span>
          <span className="card__hint">
            {bundle
              ? `共 ${bundle.total} 条${bundle.truncated ? '（仅保留最近 100 条）' : ''}`
              : '最近 100 条'}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void reloadLogs()}
            disabled={logsLoading}
          >
            <Icon name="refresh" size={13} />
            {logsLoading ? '刷新中…' : '刷新'}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void onExport()}>
            <Icon name="export" size={13} />
            导出日志文件
          </button>
        </div>
        {logMsg && (
          <div className="router-msg" data-tone="crit">
            {logMsg}
          </div>
        )}
        {exportPath && <div className="u-11 dim mono">已导出：{exportPath}</div>}
        {logErr ? (
          <div className="router-msg" data-tone="crit">
            读取日志失败：{logErr}
          </div>
        ) : bundle && bundle.entries.length === 0 ? (
          <EmptyState icon="info" title="暂无日志" desc="应用运行日志为空（环形缓冲未写入）。" />
        ) : bundle ? (
          <div className="diag-log-list">
            {bundle.entries.map((e, i) => (
              <div
                key={`${e.ts}-${e.source}-${e.message}-${i}`}
                className={`diag-log${e.level === 'error' ? ' diag-log__err' : e.level === 'warn' ? ' diag-log__warn' : ''}`}
                title={`${fmtTime(e.ts)} [${e.level}] ${e.source} ${e.message}`}
              >
                <span className="mono">{fmtTime(e.ts)}</span>
                <span className="mono">[{e.level}]</span>
                <span className="dim">{e.source}</span>
                <span>{e.message}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="u-11 dim">正在读取日志…</div>
        )}
      </div>
    </>
  )
}
