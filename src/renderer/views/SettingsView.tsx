import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { AppSettings, SettingsPayload, UpdateStatus } from '../../shared/types'
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

function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function updatePhaseText(s: UpdateStatus): string {
  switch (s.phase) {
    case 'disabled':
      return s.unavailableReason ?? '当前构建不支持自动更新'
    case 'idle':
      return '尚未检查更新'
    case 'checking':
      return '正在检查更新…'
    case 'downloading': {
      const version = s.availableVersion ? `v${s.availableVersion}` : '新版本'
      const pct = s.percent === null ? '' : ` ${s.percent.toFixed(1)}%`
      return `正在下载 ${version}${pct}`
    }
    case 'downloaded':
      return `${s.availableVersion ? `v${s.availableVersion}` : '新版本'} 已下载，请点击“重启并安装”；普通退出不会安装`
    case 'up-to-date':
      return `已是最新版本（v${s.currentVersion}）`
    case 'installing':
      return '正在退出并安装…'
    case 'error':
      return s.error ?? '检查更新失败'
  }
}

/**
 * 自动更新卡片：主进程是唯一状态源（检查/下载进度走推送），这里不发乐观状态。
 * 便携版/开发态由主进程返回 supported=false，按钮禁用并展示真实原因。
 */
function UpdateCard({
  autoUpdate,
  busy,
  onToggle,
}: {
  autoUpdate: boolean
  busy: boolean
  onToggle: () => void
}) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [installPending, setInstallPending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const statusRevision = useRef(0)
  const mounted = useRef(false)

  const hasApi = typeof window !== 'undefined' && window.lanApi !== undefined

  useEffect(() => {
    if (!hasApi) return
    mounted.current = true
    let alive = true
    const revision = statusRevision.current
    const off = window.lanApi.onUpdateStatus((s) => {
      if (!alive) return
      statusRevision.current += 1
      setStatus(s)
      setLocalError(null)
    })
    window.lanApi
      .updateGetStatus()
      .then((s) => {
        if (alive && statusRevision.current === revision) setStatus(s)
      })
      .catch((err: unknown) => {
        if (alive && statusRevision.current === revision) setLocalError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
      mounted.current = false
      off()
    }
  }, [hasApi])

  const supported = status?.supported ?? false
  const busyPhase =
    status?.phase === 'checking' || status?.phase === 'downloading' || status?.phase === 'installing'

  const onCheck = useCallback(async () => {
    if (!hasApi || pending || busyPhase) return
    setPending(true)
    setLocalError(null)
    const revision = ++statusRevision.current
    try {
      const next = await window.lanApi.updateCheck()
      if (mounted.current && statusRevision.current === revision) setStatus(next)
    } catch (err) {
      if (mounted.current && statusRevision.current === revision) setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setPending(false)
    }
  }, [hasApi, pending, busyPhase])

  const onInstall = useCallback(async () => {
    if (!hasApi || installPending) return
    setInstallPending(true)
    setLocalError(null)
    try {
      const res = await window.lanApi.updateInstall()
      if (mounted.current && !res.ok) setLocalError(res.error ?? '启动安装失败')
    } catch (err) {
      if (mounted.current) setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setInstallPending(false)
    }
  }, [hasApi, installPending])

  const phaseText = status ? updatePhaseText(status) : '正在读取更新状态…'
  const failed = Boolean(status?.error)
  const downloaded = status?.phase === 'downloaded'

  return (
    <div className="card">
      <div className="card__head">
        <span className="card__title">应用更新</span>
        <span className="card__hint mono">当前 v{status?.currentVersion ?? '—'}</span>
      </div>
      <div className="settings-stack">
        <Switch
          on={autoUpdate}
          onToggle={onToggle}
          label="自动检查并下载更新"
          hint={
            supported
              ? '启动后自动检查并在后台下载；安装前需手动确认，不会在退出时静默安装'
              : status?.unavailableReason ?? '仅安装版支持自动更新'
          }
          disabled={busy || !supported}
        />
        <div className="settings-row">
          <span className="u-115">更新状态</span>
          <span className={failed || localError ? 'u-11 u-crit' : 'u-11 dim'}>{localError ?? status?.error ?? phaseText}</span>
        </div>
        {status?.phase === 'downloading' && status.percent !== null && (
          <div
            className="update-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={status.percent}
            aria-label="更新下载进度"
          >
            <span className="update-progress__bar" style={{ width: `${status.percent}%` }} />
          </div>
        )}
        {status?.phase === 'downloading' && (
          <div className="u-11 dim">
            {formatSize(status.transferred)} / {formatSize(status.total)}
          </div>
        )}
        <div className="settings-row">
          <span className="u-11 dim">
            {supported
              ? '更新源：GitHub Releases；安装包未配置代码签名，Windows 可能提示未知发布者，请核对来源。'
              : '便携版请从 Releases 手动下载新版本；开发态不执行更新。'}
          </span>
          {downloaded ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void onInstall()}
              disabled={!supported || installPending}
            >
              <Icon name="arrow-down" size={13} />
              {installPending ? '正在启动安装…' : failed || localError ? '重试安装' : '重启并安装'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void onCheck()}
              disabled={!supported || pending || busyPhase}
            >
              <Icon name="refresh" size={13} />
              {pending || status?.phase === 'checking' ? '检查中…' : '检查更新'}
            </button>
          )}
        </div>
      </div>
    </div>
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
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [intervalDraft, setIntervalDraft] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportPath, setExportPath] = useState<string | null>(null)

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
        onShowVirtualChange(s.showVirtualPrinters)
      })
      .catch((err: unknown) => {
        if (alive) setMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      alive = false
    }
  }, [hasApi, loadAttempt, onShowVirtualChange])

  const update = useCallback(
    async (patch: Partial<AppSettings>, okText: string) => {
      if (!hasApi || busy) return
      setBusy(true)
      setMsg(null)
      try {
        const next = await window.lanApi.settingsUpdate(patch)
        setSettings(next)
        if (patch.autoScanIntervalSec !== undefined) setIntervalDraft(String(next.autoScanIntervalSec))
        if (patch.showVirtualPrinters !== undefined) onShowVirtualChange(next.showVirtualPrinters)
        setMsg({ tone: 'ok', text: okText })
      } catch (err) {
        setMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
      } finally {
        setBusy(false)
      }
    },
    [hasApi, busy, onShowVirtualChange],
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
        onShowVirtualChange(s.showVirtualPrinters)
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
  }, [onShowVirtualChange])

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
        {msg ? (
          <>
            <EmptyState icon="warn" title="设置加载失败" desc={msg.text} />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
              setMsg(null)
              setLoadAttempt((attempt) => attempt + 1)
            }}>重试</button>
          </>
        ) : <EmptyState icon="info" title="正在读取设置…" desc="设置由主进程持久化，首帧稍候。" />}
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
          <Switch
            on={settings.printerAlerts}
            onToggle={() => void update({ printerAlerts: !settings.printerAlerts }, settings.printerAlerts ? '已关闭打印机异常提醒' : '已开启打印机异常提醒')}
            label="打印机异常提醒"
            hint="离线持续 30 秒且新采样确认后提醒；持续异常每 30 分钟提醒，已提醒异常恢复时通知；忽略项与演示数据不提醒"
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

      {/* —— 应用更新 —— */}
      <UpdateCard
        autoUpdate={settings.autoUpdate}
        busy={busy}
        onToggle={() =>
          void update(
            { autoUpdate: !settings.autoUpdate },
            settings.autoUpdate ? '已关闭自动检查更新' : '已开启自动检查更新',
          )
        }
      />

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
