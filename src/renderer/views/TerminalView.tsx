import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalResult } from '../../shared/types'
import { EmptyState } from '../components/atoms/EmptyState'
import { Icon } from '../components/Icon'

/**
 * 内置受限终端（task-019）：侧边栏「诊断」下方入口。
 *
 * 交互：
 *  - 输入框回车提交（白名单命令：ping / tracert / ipconfig / arp / nslookup /
 *    netstat / route / hostname / getmac / systeminfo）；
 *  - ↑/↓ 在本会话历史命令间回填；Esc 清空输入；
 *  - 运行中禁用输入（主进程单飞闸门兜底），输出区自动滚到底；
 *  - 渲染层只做交互，白名单与字符校验全部在主进程二次执行（不可绕过）。
 * 权限：白名单命令均为普通用户权限，不请求管理员/UAC。
 */

interface TermEntry {
  id: number
  command: string
  result: TerminalResult
}

let seq = 0

export function TerminalView() {
  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<TermEntry[]>([])
  const [running, setRunning] = useState(false)
  const [historyIdx, setHistoryIdx] = useState(-1)
  const outRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  /** 提交序号：防并发提交（与主进程单飞双保险） */
  const busyRef = useRef(false)

  // 输出变化时滚到底
  useEffect(() => {
    const el = outRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  const submit = useCallback(
    async (cmd: string) => {
      const command = cmd.trim()
      if (!command || busyRef.current) return
      busyRef.current = true
      setRunning(true)
      setInput('')
      setHistoryIdx(-1)
      try {
        const result = await window.lanApi.terminalRun(command)
        setEntries((prev) => [...prev, { id: (seq += 1), command, result }])
      } catch (err) {
        // IPC 层异常（如主进程繁忙）：如实呈现，不静默
        const message = err instanceof Error ? err.message : String(err)
        setEntries((prev) => [
          ...prev,
          {
            id: (seq += 1),
            command,
            result: { command, startedAt: Date.now(), durationMs: 0, ok: false, summary: '调用失败', lines: [message], error: message },
          },
        ])
      } finally {
        busyRef.current = false
        setRunning(false)
        inputRef.current?.focus()
      }
    },
    [],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit(input)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setInput('')
      setHistoryIdx(-1)
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const history = entries.map((en) => en.command)
      if (history.length === 0) return
      e.preventDefault()
      const delta = e.key === 'ArrowUp' ? 1 : -1
      // ↑ 从最新往旧走；↓ 反向；越界停在边界
      const next = Math.min(history.length - 1, Math.max(0, historyIdx + delta))
      setHistoryIdx(next)
      setInput(history[history.length - 1 - next] ?? '')
    }
  }

  const lastId = entries.length > 0 ? entries[entries.length - 1].id : -1

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">终端</div>
          <div className="view-desc">
            受限诊断终端：仅支持 ping / tracert / ipconfig / arp / nslookup / netstat / route / hostname / getmac / systeminfo，
            不支持管道、重定向与通配符。普通用户权限即可运行，无需管理员。
          </div>
        </div>
        <div className="toolbar__meta">
          本会话 <span className="mono">{entries.length}</span> 条
        </div>
      </div>

      <div className="card terminal-card">
        {entries.length === 0 ? (
          <EmptyState
            icon="terminal"
            title="尚未执行命令"
            desc="在下方输入白名单命令并回车，例如：ping 192.168.2.1"
          />
        ) : (
          <div className="terminal-out" ref={outRef} aria-live="polite">
            {entries.map((en) => (
              <div key={en.id} className="terminal-block">
                <div className="terminal-cmdline">
                  <span className="terminal-prompt" aria-hidden="true">
                    ›
                  </span>
                  <span className="mono">{en.command}</span>
                  <span className="dim terminal-meta" title={new Date(en.result.startedAt).toLocaleString('zh-CN')}>
                    {en.result.summary}
                  </span>
                </div>
                <pre className="terminal-lines mono" data-failed={en.result.ok ? undefined : 'true'}>
                  {en.result.lines.length > 0 ? en.result.lines.join('\n') : '（无输出）'}
                </pre>
              </div>
            ))}
          </div>
        )}

        <div className="terminal-input-row">
          <span className="terminal-prompt" aria-hidden="true">
            ›
          </span>
          <input
            ref={inputRef}
            className="terminal-input mono"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={running ? '执行中…' : '输入命令，回车执行（↑/↓ 翻历史，Esc 清空）'}
            spellCheck={false}
            autoComplete="off"
            aria-label="终端命令输入"
            disabled={running}
          />
          <button
            type="button"
            className="btn btn--sm"
            disabled={running || !input.trim()}
            onClick={() => void submit(input)}
            title="执行（Enter）"
          >
            <Icon name="chevron-right" size={12} />
            {running ? '执行中…' : '执行'}
          </button>
        </div>
        {lastId >= 0 && <span className="sr-only">{entries[entries.length - 1].result.summary}</span>}
      </div>
    </>
  )
}
