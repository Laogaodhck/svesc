import { useCallback, useEffect, useState } from 'react'
import type { Printer, PrinterManageConfig } from '../../shared/types'
import { StatusPill } from '../components/atoms/StatusPill'
import { EmptyState } from '../components/atoms/EmptyState'
import { Icon } from '../components/Icon'
import { PRINTER_STATE_LABEL } from '../lib/format'
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

/** 忽略列表里的 id（prn-192.168.2.213 / prn-xxx-name）→ 人能读的展示文本 */
function ignoredLabel(id: string): string {
  const raw = id.replace(/^prn-/, '')
  return /^[0-9.]+$/.test(raw) ? raw : raw.replace(/-/g, ' ')
}

/** IPv4 即时校验：形如 a.b.c.d 且每段 0-255（审计 P0：此前任意字符串都会发 IPC） */
function isValidIpv4(v: string): boolean {
  if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(v)) return false
  return v.split('.').every((seg) => Number(seg) <= 255)
}

export function PrinterManageView({ printers }: { printers: Printer[] }) {
  const [config, setConfig] = useState<PrinterManageConfig | null>(null)
  const [ip, setIp] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const [aliasDraft, setAliasDraft] = useState<Record<string, string>>({})
  const [loadErr, setLoadErr] = useState<string | null>(null)
  /** 两态删除确认：当前处于"确认删除？"态的手动条目 IP（3 秒无操作自动还原） */
  const [confirmRemoveIp, setConfirmRemoveIp] = useState<string | null>(null)

  const hasApi = typeof window !== 'undefined' && window.lanApi !== undefined

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
        setMsg({ tone: 'ok', text: `已添加 ${trimmed}，正在探测（离线设备也会保留并如实标注）` })
        setIp('')
        setNote('')
        await reload()
      } else {
        setMsg({ tone: 'crit', text: res.error ?? '添加失败' })
      }
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }, [hasApi, busy, ip, note, reload, fail])

  const onRemove = useCallback(
    async (targetIp: string) => {
      if (!hasApi || busy) return
      setConfirmRemoveIp(null)
      setBusy(true)
      try {
        await window.lanApi.printerRemoveManual(targetIp)
        setMsg({ tone: 'ok', text: `已删除手动条目 ${targetIp}` })
        await reload()
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
      }
    },
    [hasApi, busy, reload, fail],
  )

  const onToggleIgnore = useCallback(
    async (p: Printer) => {
      if (!hasApi || busy) return
      setBusy(true)
      try {
        await window.lanApi.printerSetIgnored(p.id, !p.manual)
        setMsg({
          tone: 'ok',
          text: p.manual ? '手动条目不受忽略影响（请直接删除）' : `已忽略 ${p.name}，可用下方列表恢复`,
        })
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
      try {
        await window.lanApi.printerSetIgnored(printerId, false)
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
      const draft = (aliasDraft[p.id] ?? '').trim()
      setBusy(true)
      try {
        await window.lanApi.printerSetAlias(p.id, draft || null)
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
            手动添加自动发现不到的打印机；为监控条目设置别名或忽略不关心的设备。配置持久化保存。
          </div>
        </div>
      </div>

      {/* —— 手动添加 —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">添加网络打印机</span>
          <span className="card__hint">按 9100/631/515 探活；SNMP 可达时采集耗材</span>
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
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            autoComplete="off"
          />
          <input
            className="input"
            type="text"
            placeholder="备注 / 显示名（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoComplete="off"
          />
          <button type="submit" className="btn" disabled={busy || !ip.trim()}>
            {busy ? '添加中…' : '添加'}
          </button>
        </form>
        {msg && (
          <div className="router-msg" data-tone={msg.tone}>
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
          <span className="card__hint">{printers.length} 台（已忽略的不在此列）</span>
        </div>
        {printers.length === 0 ? (
          <EmptyState icon="printer" title="暂无监控中的打印机" desc="自动发现为空时，可在上方手动添加。" />
        ) : (
          <table className="conn-table manage-table">
            <thead>
              <tr>
                <th>名称 / 别名</th>
                <th>IP</th>
                <th>状态</th>
                <th>别名</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {printers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="manage-name">{p.alias ?? p.name}</span>
                    {p.alias && <span className="manage-name__orig">{p.name}</span>}
                    {p.manual && <span className="chip chip--plain">手动</span>}
                  </td>
                  <td className="mono">{p.ip ?? '—'}</td>
                  <td>
                    <StatusPill tone={printerStateTone(p.state)}>
                      {PRINTER_STATE_LABEL[p.state] ?? p.state}
                    </StatusPill>
                  </td>
                  <td>
                    <input
                      className="input manage-alias-input"
                      type="text"
                      maxLength={30}
                      placeholder={p.name}
                      value={aliasDraft[p.id] ?? ''}
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
              ))}
            </tbody>
          </table>
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
