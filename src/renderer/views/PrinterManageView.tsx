import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Printer, PrinterManageConfig } from '../../shared/types'
import { StatusPill } from '../components/atoms/StatusPill'
import { EmptyState } from '../components/atoms/EmptyState'
import { Icon } from '../components/Icon'
import { CONSUMABLE_LABEL, PRINTER_SOURCE_LABEL, PRINTER_STATE_LABEL, fmtDateTime, fmtMac } from '../lib/format'
import { printerStateTone, type Tone } from '../lib/semantics'

/**
 * 打印管理页：手动添加打印机 / 别名 / 忽略。
 *
 * 数据诚实原则的落点：
 *  - 手动添加的打印机探活失败 → 如实显示 offline（"添加了但设备不响应"必须可见）
 *  - 被忽略的打印机从监控与告警中整体移除，本页列出 id 供恢复
 *  - 别名只改显示名，不覆盖原始队列名（告警对账仍用原名）
 */

function fmtAddedAt(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function ignoredLabel(id: string): string {
  const raw = id.replace(/^prn-(?:queue-)?/, '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** IPv4 即时校验：形如 a.b.c.d 且每段 0-255（审计 P0：此前任意字符串都会发 IPC） */
function isValidIpv4(v: string): boolean {
  if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(v)) return false
  return v.split('.').every((seg) => Number(seg) <= 255)
}

/** 耗材摘要（task-024）：仅有电平读数的条目进摘要；一个读数都没有 → '—'（不编造）。 */
function consumableSummary(p: Printer): string {
  const parts = p.consumables
    .filter((c) => c.levelPct !== null)
    .map((c) => `${c.label || CONSUMABLE_LABEL[c.kind] || c.kind} ${c.levelPct}%`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

interface PrinterManageViewProps {
  printers: Printer[]
  refreshing: boolean
  refreshError: string | null
  onRefresh: () => void
}

type StatusFilter = 'all' | 'abnormal' | 'offline'

function requireOk(result: { ok: boolean; error?: string | null }, fallback: string): void {
  if (!result.ok) throw new Error(result.error ?? fallback)
}

export function PrinterManageView({ printers, refreshing, refreshError, onRefresh }: PrinterManageViewProps) {
  const [config, setConfig] = useState<PrinterManageConfig | null>(null)
  const [ip, setIp] = useState('')
  const [note, setNote] = useState('')
  const [editingIp, setEditingIp] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const [aliasDraft, setAliasDraft] = useState<Record<string, string>>({})
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [confirmTest, setConfirmTest] = useState<{ id: string; queueName: string } | null>(null)
  /** 两态删除确认：当前处于"确认删除？"态的手动条目 IP（3 秒无操作自动还原） */
  const [confirmRemoveIp, setConfirmRemoveIp] = useState<string | null>(null)

  const hasApi = typeof window !== 'undefined' && window.lanApi !== undefined
  const visiblePrinters = useMemo(() => {
    const search = query.trim().toLowerCase()
    const compactMac = search.replace(/[:-]/g, '')
    return printers.filter((p) => {
      if (status === 'offline' && p.state !== 'offline') return false
      if (status === 'abnormal' && !['offline', 'warning', 'error'].includes(p.state)) return false
      return (
        !search
        || [p.name, p.alias, p.model, p.ip, p.mac].some((value) => value?.toLowerCase().includes(search))
        || (/^[0-9a-f]+$/.test(compactMac) && !!p.mac?.replace(/[:-]/g, '').toLowerCase().includes(compactMac))
      )
    })
  }, [printers, query, status])
  const testTarget = confirmTest
    ? visiblePrinters.find((p) => p.id === confirmTest.id && p.queueName === confirmTest.queueName && p.source !== 'simulated')
    : undefined

  useEffect(() => {
    if (confirmTest && !testTarget) setConfirmTest(null)
  }, [confirmTest, testTarget])

  useEffect(() => {
    if (confirmTest) document.getElementById('cancel-printer-test')?.focus()
  }, [confirmTest])

  const reload = useCallback(async () => {
    if (!hasApi) return
    try {
      setConfig(await window.lanApi.printerGetManageConfig())
      setLoadErr(null)
    } catch (err) {
      setLoadErr(err instanceof Error ? err.message : String(err))
      setMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
    }
  }, [hasApi])

  useEffect(() => {
    void reload()
  }, [reload])

  /** 删除确认 3 秒无操作自动还原（切目标时重置计时） */
  useEffect(() => {
    if (confirmRemoveIp === null) return
    const t = setTimeout(() => setConfirmRemoveIp(null), 3000)
    return () => clearTimeout(t)
  }, [confirmRemoveIp])

  /** 统一错误出口（审计 M-2：IPC 抛错此前零感知，列表不刷新、无提示） */
  const fail = useCallback((err: unknown) => {
    setMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
  }, [])

  const onAdd = useCallback(async () => {
    if (!hasApi || busy) return
    const trimmed = ip.trim()
    if (!trimmed) {
      setMsg({ tone: 'warn', text: '请输入 IP 地址' })
      return
    }
    if (!isValidIpv4(trimmed)) {
      // 审计 P0：格式不合法就不发 IPC，提交前就地给出可读文案
      setMsg({ tone: 'crit', text: 'IP 格式不正确（示例 192.168.2.100）' })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.lanApi.printerAddManual(trimmed, note.trim() || null)
      if (res.ok) {
        setMsg({
          tone: 'ok',
          text: editingIp ? `已保存 ${trimmed} 的备注` : `已添加 ${trimmed}，离线设备也会保留并如实标注`,
        })
        setIp('')
        setNote('')
        setEditingIp(null)
        await reload()
      } else {
        setMsg({ tone: 'crit', text: res.error ?? (editingIp ? '备注保存失败' : '添加失败') })
      }
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }, [hasApi, busy, ip, note, editingIp, reload, fail])

  const onRemove = useCallback(
    async (targetIp: string) => {
      if (!hasApi || busy) return
      setConfirmRemoveIp(null)
      setBusy(true)
      setMsg(null)
      try {
        requireOk(await window.lanApi.printerRemoveManual(targetIp), '删除手动条目失败')
        setMsg({ tone: 'ok', text: `已删除手动条目 ${targetIp}` })
        if (editingIp === targetIp) {
          setEditingIp(null)
          setIp('')
          setNote('')
        }
        await reload()
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
      }
    },
    [hasApi, busy, editingIp, reload, fail],
  )

  const onToggleIgnore = useCallback(
    async (p: Printer) => {
      if (!hasApi || busy || p.manual) return
      setBusy(true)
      setMsg(null)
      try {
        requireOk(await window.lanApi.printerSetIgnored(p.id, true), '忽略打印机失败')
        setMsg({ tone: 'ok', text: `已忽略 ${p.alias ?? p.name}，可用下方列表恢复` })
        await reload()
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
      }
    },
    [hasApi, busy, reload, fail],
  )

  const onRestore = useCallback(
    async (printerId: string) => {
      if (!hasApi || busy) return
      setBusy(true)
      setMsg(null)
      try {
        requireOk(await window.lanApi.printerSetIgnored(printerId, false), '恢复监控失败')
        setMsg({ tone: 'ok', text: '已恢复监控，下一轮刷新出现' })
        await reload()
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
      }
    },
    [hasApi, busy, reload, fail],
  )

  const onSaveAlias = useCallback(
    async (p: Printer) => {
      if (!hasApi || busy) return
      const draft = (aliasDraft[p.id] ?? p.alias ?? '').trim()
      setBusy(true)
      setMsg(null)
      try {
        requireOk(await window.lanApi.printerSetAlias(p.id, draft || null), '保存别名失败')
        setAliasDraft((d) => ({ ...d, [p.id]: draft }))
        setMsg({ tone: 'ok', text: draft ? `别名已保存：${draft}` : `已清除 ${p.name} 的别名` })
        await reload()
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
      }
    },
    [hasApi, busy, aliasDraft, reload, fail],
  )

  /** 设为默认打印机（task-024） */
  const onSetDefault = useCallback(
    async (p: Printer) => {
      if (!hasApi || busy || p.queueName == null || p.source === 'simulated') return
      setBusy(true)
      setMsg(null)
      try {
        const res = await window.lanApi.printerSetDefault(p.queueName)
        setMsg(
          res.ok
            ? { tone: 'ok', text: `已将 ${p.alias ?? p.name} 设为默认打印机` }
            : { tone: 'crit', text: res.error ?? '设置默认打印机失败' },
        )
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
      }
    },
    [hasApi, busy, fail],
  )

  /** 打印测试页（task-024） */
  const onTestPage = useCallback(
    async (p: Printer) => {
      if (!hasApi || busy || p.queueName == null || p.source === 'simulated') return
      if (confirmTest?.id !== p.id || confirmTest.queueName !== p.queueName) return
      setConfirmTest(null)
      setBusy(true)
      setMsg(null)
      try {
        const res = await window.lanApi.printerPrintTestPage(p.queueName)
        setMsg(
          res.ok
            ? { tone: 'ok', text: `已向 ${p.alias ?? p.name} 发送测试页，任务将进入队列` }
            : { tone: 'crit', text: res.error ?? '测试页发送失败' },
        )
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
      }
    },
    [hasApi, busy, confirmTest, fail],
  )

  /** 内置浏览器打开打印机 Web 管理页（task-024）；未知 IP 不发 IPC */
  const onOpenAdmin = useCallback(
    async (p: Printer) => {
      if (!hasApi || busy || p.ip === null || p.source === 'simulated') return
      setBusy(true)
      setMsg(null)
      try {
        const res = await window.lanApi.printerOpenAdmin(p.ip)
        setMsg(
          res.ok
            ? { tone: 'ok', text: `已在内置浏览器打开 ${p.ip} 的管理页` }
            : { tone: 'crit', text: res.error ?? '管理页打开失败' },
        )
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
      }
    },
    [hasApi, busy, fail],
  )

  if (!hasApi) {
    return (
      <div className="card">
        <EmptyState icon="warn" title="未连接主进程" desc="打印管理需要主进程提供 window.lanApi。" />
      </div>
    )
  }

  const manualList = config?.manual ?? []
  const ignoredList = config?.ignored ?? []

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">打印管理</div>
          <div className="view-desc">
            手动添加、设置别名或忽略设备。首次发现时间仅属于本次运行，不持久化；启动或新增的存量异常不立即通知，满 30 分钟后由新采集样本触发提醒。
          </div>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={onRefresh}
          title="仅刷新打印机状态与队列，不扫描全网"
        >
          <Icon name="refresh" size={12} className={refreshing ? 'is-spinning' : undefined} />
          {refreshing ? '刷新中…' : '刷新打印机'}
        </button>
      </div>
      {refreshError && <div className="router-msg" data-tone="crit" role="alert">{refreshError}</div>}

      {/* —— 手动添加 —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">{editingIp ? '编辑手动打印机备注' : '添加网络打印机'}</span>
          <span className="card__hint">{editingIp ? '保存将更新同一 IP 的备注，不创建新条目' : '协议识别与端口探活；耗材按实际结果展示'}</span>
        </div>
        <form
          className="manage-add"
          onSubmit={(e) => {
            e.preventDefault()
            void onAdd()
          }}
        >
          <input
            className="input"
            type="text"
            placeholder="打印机 IP（如 192.168.2.213）"
            aria-label="打印机 IP"
            value={ip}
            readOnly={editingIp !== null}
            disabled={busy}
            onChange={(e) => setIp(e.target.value)}
            autoComplete="off"
          />
          <input
            id="manual-printer-note"
            className="input"
            type="text"
            placeholder="备注 / 显示名（可选）"
            aria-label="打印机备注"
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            autoComplete="off"
          />
          <button type="submit" className="btn" disabled={busy || !ip.trim()}>
            {busy ? '处理中…' : editingIp ? '保存备注' : '添加'}
          </button>
          {editingIp && (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => {
                setEditingIp(null)
                setIp('')
                setNote('')
              }}
            >
              取消编辑
            </button>
          )}
        </form>
        {msg && (
          <div className="router-msg" data-tone={msg.tone} role={msg.tone === 'crit' ? 'alert' : 'status'}>
            {msg.text}
          </div>
        )}

        {config === null ? (
          loadErr ? (
            // 审计 P0：配置加载失败必须可见，不能静默渲染成空列表
            <EmptyState
              icon="warn"
              title="配置加载失败"
              desc={loadErr}
              actions={
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void reload()} disabled={busy}>
                  重试
                </button>
              }
            />
          ) : (
            <div className="router-empty-line">正在读取打印管理配置…</div>
          )
        ) : (
          manualList.length > 0 && (
            <table className="conn-table manage-table">
              <thead>
                <tr>
                  <th>IP</th>
                  <th>备注</th>
                  <th>添加时间</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {manualList.map((m) => (
                  <tr key={m.ip}>
                    <td className="mono">{m.ip}</td>
                    <td>{m.note ?? '—'}</td>
                    <td>{fmtAddedAt(m.addedAt)}</td>
                    <td>
                      <div className="manage-actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busy}
                          onClick={() => {
                            setEditingIp(m.ip)
                            setIp(m.ip)
                            setNote(m.note ?? '')
                            setMsg(null)
                            document.getElementById('manual-printer-note')?.focus()
                          }}
                        >
                          编辑
                        </button>
                        {confirmRemoveIp === m.ip ? (
                          <button
                            type="button"
                            className="btn btn--danger btn--sm"
                            disabled={busy}
                            onClick={() => void onRemove(m.ip)}
                          >
                            确认删除？
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={busy}
                            onClick={() => setConfirmRemoveIp(m.ip)}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>

      {/* —— 监控中的打印机：别名 / 忽略 —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">监控中的打印机</span>
          <span className="card__hint">{visiblePrinters.length} / {printers.length} 台（已忽略的不在此列）</span>
        </div>
        <div className="toolbar manage-filters">
          <label className="field">
            <Icon name="search" size={13} />
            <input
              className="field__input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称、别名、型号、IP、MAC"
              aria-label="搜索打印机名称、别名、型号、IP、MAC"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="segmented" role="group" aria-label="打印机状态筛选">
            {([
              ['all', '全部'],
              ['abnormal', '异常'],
              ['offline', '离线'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className="segmented__item"
                aria-pressed={status === key}
                title={key === 'abnormal' ? '离线、警告或故障的打印机' : label}
                onClick={() => setStatus(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {testTarget && (
          <div className="router-msg manage-confirm" data-tone="warn" role="alert">
            <div>向「{testTarget.alias ?? testTarget.name}」打印一张测试页？这会产生实际打印任务。</div>
            <div className="u-105">本机队列：{testTarget.queueName}</div>
            <div className="manage-actions mt-10">
              <button id="cancel-printer-test" type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setConfirmTest(null)}>
                取消
              </button>
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void onTestPage(testTarget)}>
                确认打印一张测试页
              </button>
            </div>
          </div>
        )}
        {printers.length === 0 ? (
          <EmptyState icon="printer" title="暂无监控中的打印机" desc="自动发现为空时，可在上方手动添加。" />
        ) : visiblePrinters.length === 0 ? (
          <EmptyState
            icon="search"
            title="没有匹配的打印机"
            desc="请调整搜索内容或状态筛选。"
            actions={
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setQuery(''); setStatus('all') }}>
                清除筛选
              </button>
            }
          />
        ) : (
          <div className="manage-table-scroll">
            <table className="conn-table manage-table manage-printers-table">
              <thead>
                <tr>
                  <th>名称 / 型号 / 来源</th>
                  <th>IP / MAC</th>
                  <th>状态</th>
                  <th>耗材</th>
                  <th>本机队列</th>
                  <th>默认</th>
                  <th>别名</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visiblePrinters.map((p) => {
                  const canUseQueue = p.queueName != null && p.source !== 'simulated'
                  const unavailableReason = p.source === 'simulated' ? '演示数据不可执行实际操作' : '未安装本机队列'
                  return (
                    <tr key={p.id}>
                      <td>
                        <span className="manage-name" title={p.alias ?? p.name}>{p.alias ?? p.name}</span>
                        {p.alias && <span className="manage-name__orig" title={p.name}>{p.name}</span>}
                        <span className="manage-name__orig" title={p.model ?? '型号未知'}>{p.model ?? '型号未知'}</span>
                        <span className="src-badge" data-sim={p.source === 'simulated' ? 'true' : undefined}>
                          {PRINTER_SOURCE_LABEL[p.source] ?? p.source}
                        </span>
                        {p.manual && <span className="chip chip--plain">手动</span>}
                      </td>
                      <td className="mono">
                        {p.ip ?? '—'}
                        <span className="manage-name__orig">{fmtMac(p.mac) ?? 'MAC 未知'}</span>
                      </td>
                      <td>
                        <StatusPill tone={printerStateTone(p.state)}>
                          {PRINTER_STATE_LABEL[p.state] ?? p.state}
                        </StatusPill>
                        {p.firstObservedAt != null && Number.isFinite(p.firstObservedAt)
                          && p.source !== 'simulated' && !p.id.startsWith('sim-') && p.connection !== 'virtual' && (
                          <span className="manage-name__orig" title="非设备真实故障起点；恢复后清除，未知状态保留。">
                            本次运行首次发现异常：<br />
                            <time dateTime={new Date(p.firstObservedAt).toISOString()}>{fmtDateTime(p.firstObservedAt)}</time>
                          </span>
                        )}
                      </td>
                      <td className="u-105" title={consumableSummary(p)}>
                        {consumableSummary(p)}
                      </td>
                      <td title={p.queueName ?? '未安装本机队列'}>
                        <span>{p.queueName != null ? '已安装' : '未安装本机队列'}</span>
                        {p.queueName != null && <span className="manage-name__orig">{p.queueName} · {p.jobs.length} 项</span>}
                      </td>
                      <td>{p.isDefault && p.queueName != null ? <span className="chip chip--plain">默认</span> : '—'}</td>
                      <td>
                        <input
                          className="input manage-alias-input"
                          type="text"
                          maxLength={30}
                          placeholder={p.name}
                          aria-label={`${p.name} 的别名`}
                          disabled={busy}
                          value={aliasDraft[p.id] ?? p.alias ?? ''}
                          onChange={(e) => setAliasDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              void onSaveAlias(p)
                            }
                          }}
                        />
                      </td>
                      <td>
                        <div className="manage-actions">
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={busy || !canUseQueue}
                            title={canUseQueue ? `向本机队列 ${p.queueName} 发送 Windows 测试页（需确认）` : unavailableReason}
                            onClick={() => {
                              if (canUseQueue && p.queueName != null) setConfirmTest({ id: p.id, queueName: p.queueName })
                            }}
                          >
                            测试页
                          </button>
                          {!p.isDefault && (
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={busy || !canUseQueue}
                              title={canUseQueue ? `将本机队列 ${p.queueName} 设为系统默认打印机` : unavailableReason}
                              onClick={() => void onSetDefault(p)}
                            >
                              设默认
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={busy || p.ip === null || p.source === 'simulated'}
                            title={p.source === 'simulated' ? unavailableReason : p.ip === null ? '未知 IP，无法打开管理页' : `在内置浏览器打开 ${p.ip}`}
                            onClick={() => void onOpenAdmin(p)}
                          >
                            管理页
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={busy}
                            onClick={() => void onSaveAlias(p)}
                          >
                            保存别名
                          </button>
                          {!p.manual && (
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={busy}
                              onClick={() => void onToggleIgnore(p)}
                            >
                              忽略
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* —— 已忽略 —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">已忽略</span>
          <span className="card__hint">不显示、不产生告警</span>
        </div>
        {ignoredList.length === 0 ? (
          <div className="router-empty-line">没有已忽略的打印机。</div>
        ) : (
          <table className="conn-table manage-table">
            <thead>
              <tr>
                <th>条目</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ignoredList.map((id) => (
                <tr key={id}>
                  <td className="mono">{ignoredLabel(id)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy}
                      onClick={() => void onRestore(id)}
                    >
                      恢复监控
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
