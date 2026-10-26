import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { AppSettings, SettingsPayload } from '../../shared/types'
import { EmptyState } from '../components/atoms/EmptyState'
import { Icon } from '../components/Icon'
import type { Tone } from '../lib/semantics'

/**
 * 设置页：实时监控、打印机采集源、数据导出、关于。
 * 所有开关落盘即生效（autoScan 重挂定时器；打印机源下一轮刷新生效，≤15s）。
 *
 * 关于卡片是作者署名的唯一权威展示位（需求方指定：浩玥工作室 · 老高 QQ 846193）。
 */

const AUTHOR = '浩玥工作室'
const CONTACT = '老高 QQ 846193'

function Switch({
  on,
  onToggle,
  label,
  hint,
  disabled,
}: {
  on: boolean
  onToggle: () => void
  label: string
  hint: string
  /** busy 期间禁用并给出可感知的视觉（"点了没反应"必须变成"看得见不可点"） */
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="switch-field"
      aria-pressed={on}
      onClick={onToggle}
      disabled={disabled}
      title={hint}
    >
      <span className="switch" data-on={on} aria-hidden="true">
        <span className="switch__knob" />
      </span>
      <span>
        <span className="u-115">{label}</span>
        <span className="u-11 dim" style={{ display: 'block' }}>{hint}</span>
      </span>
    </button>
  )
}

/**
 * 开机自启（task-021 F2）：OS（注册表 Login Item）是唯一事实源，**不写 store**。
 * 切换后用 settingsGet 回读刷新开关——不本地乐观置位，避免"显示已开启但系统里没写上"。
 */
function LaunchAtLoginSwitch({
  available,
  initialOn,
  busy,
  onBusy,
  onMsg,
}: {
  available: boolean
  initialOn: boolean
  busy: boolean
  onBusy: (b: boolean) => void
  onMsg: (m: { tone: Tone; text: string } | null) => void
}) {
  const [on, setOn] = useState(initialOn)
  const [pending, setPending] = useState(false)

  // 父级重新拉到 settings 时对齐（含初次载入）
  useEffect(() => setOn(initialOn), [initialOn])

  const onToggle = useCallback(async () => {
    if (pending || busy) return
    setPending(true)
    onBusy(true)
    onMsg(null)
    const next = !on
    try {
      const res = await window.lanApi.setLaunchAtLogin(next)
      if (!res.ok) {
        onMsg({ tone: 'crit', text: res.error ?? '设置开机自启失败' })
        return
      }
      // 以主进程回读为准（写后回读验证是主进程链路的一半，这里消费结果）
      const s = await window.lanApi.settingsGet()
      setOn(s.launchAtLogin)
      onMsg({
        tone: 'ok',
        text: s.launchAtLogin ? '已开启开机自启' : '已关闭开机自启',
      })
    } catch (err) {
      onMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setPending(false)
      onBusy(false)
    }
  }, [on, pending, busy, onBusy, onMsg])

  return (
    <Switch
      on={on}
      onToggle={() => void onToggle()}
      label="开机自启"
      hint={available ? '开机后自动在后台启动并常驻托盘' : '开发模式下不可用，请使用安装版'}
      disabled={!available || busy || pending}
    />
  )
}

export function SettingsView({
  showVirtualPrinters,
  onShowVirtualChange,
}: {
  /** 虚拟打印机开关的提升态在 App（打印机页共用同一状态） */
  showVirtualPrinters: boolean
  onShowVirtualChange: (next: boolean) => void
}) {
  const [settings, setSettings] = useState<SettingsPayload | null>(null)
  const [intervalDraft, setIntervalDraft] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportPath, setExportPath] = useState<string | null>(null)

  // 告警 Webhook（task-025）
  const [webhookDraft, setWebhookDraft] = useState('')
  const [webhookTesting, setWebhookTesting] = useState(false)
  const [webhookMsg, setWebhookMsg] = useState<string | null>(null)
  const [webhookTone, setWebhookTone] = useState<'ok' | 'crit'>('ok')

  // 配置导入/导出（task-025）
  const [cfgBusy, setCfgBusy] = useState(false)
  const [cfgMsg, setCfgMsg] = useState<string | null>(null)
  const [cfgTone, setCfgTone] = useState<'ok' | 'crit'>('ok')
  const cfgFileRef = useRef<HTMLInputElement | null>(null)

  const hasApi = typeof window !== 'undefined' && window.lanApi !== undefined

  /** 扫描间隔即时校验：输入非法值时就地提示，不等点保存（输入为空不提示） */
  const intervalNum = Number(intervalDraft)
  const intervalInvalid =
    intervalDraft.trim() !== '' && (!Number.isInteger(intervalNum) || intervalNum < 30 || intervalNum > 3600)

  useEffect(() => {
    if (!hasApi) return
    let alive = true
    window.lanApi
      .settingsGet()
      .then((s) => {
        if (!alive) return
        setSettings(s)
        setIntervalDraft(String(s.autoScanIntervalSec))
        setWebhookDraft(s.notifyWebhookUrl ?? '')
      })
      .catch((err: unknown) => {
        if (alive) setMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      alive = false
    }
  }, [hasApi])

  const update = useCallback(
    async (patch: Partial<AppSettings>, okText: string) => {
      if (!hasApi || busy) return
      setBusy(true)
      setMsg(null)
      try {
        const next = await window.lanApi.settingsUpdate(patch)
        setSettings(next)
        if (patch.autoScanIntervalSec !== undefined) setIntervalDraft(String(next.autoScanIntervalSec))
        setMsg({ tone: 'ok', text: okText })
      } catch (err) {
        setMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
      } finally {
        setBusy(false)
      }
    },
    [hasApi, busy],
  )

  const onExport = useCallback(async () => {
    if (!hasApi || exportBusy) return
    setExportBusy(true)
    setMsg(null)
    try {
      const res = await window.lanApi.exportReport()
      if (res.ok) {
        setExportPath(res.path)
        setMsg({ tone: 'ok', text: `已导出：${res.path ?? '（路径未知）'}` })
      } else {
        setMsg({ tone: 'crit', text: res.error ?? '导出失败' })
      }
    } catch (err) {
      setMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setExportBusy(false)
    }
  }, [hasApi, exportBusy])

  /* -------- 告警 Webhook（task-025） -------- */
  const saveWebhook = useCallback(async () => {
    const url = webhookDraft.trim()
    if (url && !/^https?:\/\//i.test(url)) {
      setWebhookMsg('URL 需以 http:// 或 https:// 开头')
      setWebhookTone('crit')
      return
    }
    await update({ notifyWebhookUrl: url }, url ? 'Webhook 已保存' : 'Webhook 已清空（通知停用）')
  }, [webhookDraft, update])

  const testWebhook = useCallback(async () => {
    if (webhookTesting) return
    const url = webhookDraft.trim()
    if (!url) {
      setWebhookMsg('请先填写 Webhook URL')
      setWebhookTone('crit')
      return
    }
    setWebhookTesting(true)
    setWebhookMsg(null)
    try {
      const res = await window.lanApi.webhookTest(url)
      if (res.ok) {
        setWebhookMsg(`测试成功：服务端返回 ${res.status}`)
        setWebhookTone('ok')
      } else if (res.status !== null) {
        setWebhookMsg(`服务端返回 ${res.status}（非 2xx），消息未确认送达`)
        setWebhookTone('crit')
      } else {
        setWebhookMsg(`发送失败：${res.error ?? '未知原因'}`)
        setWebhookTone('crit')
      }
    } catch (err) {
      setWebhookMsg(err instanceof Error ? err.message : String(err))
      setWebhookTone('crit')
    } finally {
      setWebhookTesting(false)
    }
  }, [webhookDraft, webhookTesting])

  /* -------- 配置导入/导出（task-025） -------- */
  const onConfigExport = useCallback(async () => {
    if (cfgBusy) return
    setCfgBusy(true)
    setCfgMsg(null)
    try {
      const res = await window.lanApi.configExport()
      if (res.ok) {
        setCfgTone('ok')
        setCfgMsg(`配置已导出：${res.path ?? '（路径未知）'}`)
      } else {
        setCfgTone('crit')
        setCfgMsg(res.error ?? '导出失败')
      }
    } catch (err) {
      setCfgTone('crit')
      setCfgMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setCfgBusy(false)
    }
  }, [cfgBusy])

  const onConfigFile = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setCfgBusy(true)
    setCfgMsg(null)
    try {
      const text = await file.text()
      const res = await window.lanApi.configImport(text)
      if (res.ok) {
        setCfgTone('ok')
        setCfgMsg(
          `导入完成：更新 ${res.imported.length} 项${
            res.skipped.length > 0 ? `，跳过 ${res.skipped.length} 项（${res.skipped.join('、')}）` : ''
          }`,
        )
        // 导入可能改了扫描间隔等运行时设置：回读对齐
        const s = await window.lanApi.settingsGet()
        setSettings(s)
        setIntervalDraft(String(s.autoScanIntervalSec))
        setWebhookDraft(s.notifyWebhookUrl ?? '')
      } else {
        setCfgTone('crit')
        setCfgMsg(res.error ?? '导入失败')
      }
    } catch (err) {
      setCfgTone('crit')
      setCfgMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setCfgBusy(false)
    }
  }, [])

  if (!hasApi) {
    return (
      <div className="card">
        <EmptyState icon="warn" title="未连接主进程" desc="设置需要主进程提供 window.lanApi。" />
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="card">
        <EmptyState icon="info" title="正在读取设置…" desc="设置由主进程持久化，首帧稍候。" />
      </div>
    )
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">设置</div>
          <div className="view-desc">开关落盘即生效；打印机采集源在下一轮打印机刷新（≤15s）内生效。</div>
        </div>
      </div>

      {/* —— 通用 —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">通用</span>
          <span className="card__hint">实时监控</span>
        </div>
        <div className="settings-stack">
          <Switch
            on={settings.autoScan}
            onToggle={() => void update({ autoScan: !settings.autoScan }, settings.autoScan ? '已暂停实时监控（设备状态将冻结）' : '已开启实时监控')}
            label="实时监控"
            hint="5s 心跳实时探测设备上下线并滚动发现新设备；关闭后设备状态冻结，带宽/打印机观测继续"
            disabled={busy}
          />
          <Switch
            on={settings.notifyDesktop}
            onToggle={() => void update({ notifyDesktop: !settings.notifyDesktop }, settings.notifyDesktop ? '已关闭告警桌面通知' : '已开启告警桌面通知')}
            label="告警桌面通知"
            hint="新告警产生时弹 Windows 系统通知"
            disabled={busy}
          />
          <Switch
            on={settings.closeToTray}
            onToggle={() => void update({ closeToTray: !settings.closeToTray }, settings.closeToTray ? '已关闭最小化到托盘（点关闭即退出）' : '关闭窗口时将最小化到系统托盘')}
            label="关闭时最小化到托盘"
            hint="点关闭按钮隐藏到系统托盘常驻；托盘菜单「退出」始终真正退出"
            disabled={busy}
          />
          <LaunchAtLoginSwitch
            available={settings.launchAtLoginAvailable}
            initialOn={settings.launchAtLogin}
            busy={busy}
            onBusy={setBusy}
            onMsg={setMsg}
          />
          <div className="settings-row">
            <span className="u-115">深度扫描间隔（秒）</span>
            <div className="alias-edit">
              <input
                className="input alias-edit__input"
                type="number"
                min={30}
                max={3600}
                value={intervalDraft}
                onChange={(e) => setIntervalDraft(e.target.value)}
                disabled={!settings.autoScan}
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={busy || !settings.autoScan}
                onClick={() => {
                  const sec = Number(intervalDraft)
                  if (!Number.isInteger(sec) || sec < 30 || sec > 3600) {
                    setMsg({ tone: 'crit', text: '间隔需为 30-3600 之间的整数秒' })
                    return
                  }
                  void update({ autoScanIntervalSec: sec }, `深度扫描间隔已更新为 ${sec}s`)
                }}
              >
                保存
              </button>
            </div>
          </div>
          {intervalInvalid && (
            <div className="u-11 u-crit">间隔需为 30-3600 之间的整数秒</div>
          )}
        </div>
      </div>

      {/* —— 告警 Webhook（task-025） —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">告警 Webhook</span>
          <span className="card__hint">告警产生/恢复时 POST JSON；服务端返回 2xx 才算送达；留空停用</span>
        </div>
        <div className="settings-stack">
          <div className="settings-row">
            <span className="u-115">Webhook URL</span>
            <div className="alias-edit">
              <input
                className="input alias-edit__input"
                type="text"
                placeholder="https://example.com/hook"
                value={webhookDraft}
                onChange={(e) => {
                  setWebhookDraft(e.target.value)
                  setWebhookMsg(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveWebhook()
                }}
              />
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void saveWebhook()}>
                保存
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={webhookTesting} onClick={() => void testWebhook()}>
                {webhookTesting ? '发送中…' : '发送测试'}
              </button>
            </div>
          </div>
          {webhookMsg && <div className="u-11" data-tone={webhookTone === 'ok' ? undefined : 'crit'}>{webhookMsg}</div>}
        </div>
      </div>

      {/* —— 打印机采集 —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">打印机采集</span>
          <span className="card__hint">下一轮打印机刷新（≤15s）内生效</span>
        </div>
        <div className="settings-stack">
          <Switch
            on={showVirtualPrinters}
            onToggle={() => {
              const next = !showVirtualPrinters
              onShowVirtualChange(next)
              void update({ showVirtualPrinters: next }, next ? '打印机页将显示虚拟打印机' : '已隐藏虚拟打印机')
            }}
            label="显示本机虚拟打印机"
            hint="PDF / XPS / Fax 等本机队列，不参与网络监控（持久化保存）"
            disabled={busy}
          />
          <Switch
            on={settings.snmpEnabled}
            onToggle={() => void update({ snmpEnabled: !settings.snmpEnabled }, settings.snmpEnabled ? '已关闭 SNMP 采集（耗材只剩 IPP 与队列）' : '已开启 SNMP 耗材采集')}
            label="SNMP 耗材采集（UDP 161）"
            hint="关闭后耗材只剩 IPP 与打印队列；对不响应 SNMP 的设备可省去超时等待"
            disabled={busy}
          />
          <Switch
            on={settings.useMdns}
            onToggle={() => void update({ useMdns: !settings.useMdns }, settings.useMdns ? '已关闭 mDNS 发现' : '已开启 mDNS 发现（增强路径）')}
            label="mDNS 打印机发现"
            hint="辅助补齐无 IP 打印机的地址；默认关闭"
            disabled={busy}
          />
        </div>
      </div>

      {/* —— 数据 —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">数据</span>
          <span className="card__hint">报告导出 / 配置迁移</span>
        </div>
        <div className="settings-stack">
          <div className="settings-row">
            <span className="u-115">导出监控报告</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void onExport()}
              disabled={exportBusy}
            >
              <Icon name="overview" size={13} />
              {exportBusy ? '导出中…' : '导出'}
            </button>
          </div>
          {exportPath && <div className="u-11 dim mono">{exportPath}</div>}

          <div className="settings-row">
            <span className="u-115">导出配置</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void onConfigExport()}
              disabled={cfgBusy}
              title="设置、别名、备注、标签、监控目标、打印机管理与首次发现时间，打包为一个 JSON 文件"
            >
              <Icon name="export" size={13} />
              导出
            </button>
          </div>
          <div className="settings-row">
            <span className="u-115">导入配置</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => cfgFileRef.current?.click()}
              disabled={cfgBusy}
              title="选择此前导出的 JSON 配置文件；逐项合并，非法项跳过不会破坏现有配置"
            >
              <Icon name="refresh" size={13} />
              {cfgBusy ? '导入中…' : '选择文件导入'}
            </button>
            <input
              ref={cfgFileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => void onConfigFile(e)}
            />
          </div>
          {cfgMsg && <div className="u-11" data-tone={cfgTone === 'ok' ? undefined : 'crit'}>{cfgMsg}</div>}
        </div>
      </div>

      {/* —— 关于 —— */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">关于</span>
          <span className="card__hint mono">v{settings.appVersion}</span>
        </div>
        <div className="about-block">
          <div className="about-block__name">SVESC 局域网管理台</div>
          <div className="about-block__desc">
            设备发现 · 打印机监控 · 网络质量 · 告警 · 路由器管理
          </div>
          <dl className="dl mt-12">
            <dt>作者</dt>
            <dd className="about-block__author">{AUTHOR}</dd>
            <dt>联系</dt>
            <dd>{CONTACT}</dd>
          </dl>
        </div>
      </div>

      {msg && (
        <div className="router-msg" data-tone={msg.tone}>
          {msg.text}
        </div>
      )}
    </>
  )
}
