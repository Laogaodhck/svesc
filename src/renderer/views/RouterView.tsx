import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { RouterStatus } from '../../shared/types'
import { StatusPill } from '../components/atoms/StatusPill'
import { EmptyState } from '../components/atoms/EmptyState'
import { Icon } from '../components/Icon'
import { fmtBitRate, fmtDateTime } from '../lib/format'
import type { Tone } from '../lib/semantics'

/**
 * 路由器管理视图。
 * 数据诚实原则的三态呈现：
 *  - 能力不支持 → 明确标注"该路由器不支持"，按钮禁用
 *  - 未登录     → 登录表单 + 说明"登录后可查看"
 *  - 数据拿不到 → "—"（绝不显示 0）
 */

const BRAND_LABEL: Record<string, string> = {
  openwrt: 'OpenWrt',
  tplink: 'TP-Link',
  xiaomi: '小米',
  asus: '华硕',
  huawei: '华为',
  netgear: 'NETGEAR',
  generic: '未知品牌',
}

function fmtBytes(n: number | null): string {
  if (n === null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i += 1
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

function secToDuration(sec: number | null): string {
  if (sec === null) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d}天${h}小时` : h > 0 ? `${h}小时${m}分` : `${m}分钟`
}

function phaseInfo(s: RouterStatus): { text: string; tone: Tone } {
  if (s.phase === 'probing') return { text: '探测中', tone: 'muted' }
  if (s.phase === 'unreachable') return { text: '不可达', tone: 'crit' }
  if (s.phase === 'ready') return { text: '已连接', tone: 'ok' }
  // 未知 phase 如实标注"未知"，绝不冒充"已连接"
  return { text: '未知', tone: 'muted' }
}

function CapRow({ supported, label, note }: { supported: boolean; label: string; note: string }) {
  return (
    <div className="router-cap" data-supported={supported}>
      <Icon name={supported ? 'check' : 'close'} size={14} className="router-cap__icon" />
      <div className="router-cap__text">
        <div className="router-cap__label">{label}</div>
        <div className="router-cap__note">{supported ? note : '该路由器不支持'}</div>
      </div>
    </div>
  )
}

export function RouterView() {
  const [status, setStatus] = useState<RouterStatus | null>(null)
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginMsg, setLoginMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const [adminBusy, setAdminBusy] = useState(false)
  const [adminMsg, setAdminMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const [rebootConfirm, setRebootConfirm] = useState(false)
  const [rebootBusy, setRebootBusy] = useState(false)
  const [rebootMsg, setRebootMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [probeErr, setProbeErr] = useState<string | null>(null)
  const [logoutBusy, setLogoutBusy] = useState(false)
  // task-022 B-1：记住密码开关（默认 true；登录前先同步到设置，主进程按当前设置决定是否落盘）
  const [remember, setRemember] = useState(true)

  // —— 重启确认框焦点管理（alertdialog 约定：默认焦点落安全动作"取消"，Esc 关闭，关闭后焦点还给触发按钮） ——
  const confirmRef = useRef<HTMLDivElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const rebootTriggerRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!rebootConfirm) return
    rebootTriggerRef.current = document.activeElement as HTMLButtonElement | null
    cancelBtnRef.current?.focus()
    confirmRef.current?.focus() // 兜底：容器可聚焦，保证 Escape 监听生效
    return () => {
      rebootTriggerRef.current?.focus()
      rebootTriggerRef.current = null
    }
  }, [rebootConfirm])

  const hasApi = typeof window !== 'undefined' && window.lanApi !== undefined

  // task-022 B-1：登录表单可用时回填持久化的记住密码开关
  useEffect(() => {
    if (!hasApi) return
    let alive = true
    void window.lanApi
      .settingsGet()
      .then((s) => {
        if (alive) setRemember(s.rememberRouterPassword)
      })
      .catch(() => {
        /* 读不到设置时保持默认 true，登录本身不受影响 */
      })
    return () => {
      alive = false
    }
  }, [hasApi])

  useEffect(() => {
    if (!hasApi) return
    let alive = true
    void window.lanApi.routerGetStatus().then((s) => {
      if (alive) {
        setStatus(s)
        setProbeErr(null)
      }
    }).catch((err: unknown) => {
      // 审计 M-3：此前 .then 无 catch，IPC 抛错时 status 永远 null，页面永久卡在"正在探测网关…"
      if (alive) setProbeErr(err instanceof Error ? err.message : String(err))
    })
    const off = window.lanApi.onRouterStatus((s) => {
      if (alive) {
        setStatus(s)
        setProbeErr(null)
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [hasApi])

  const onRefresh = useCallback(async () => {
    if (!hasApi) return
    setRefreshing(true)
    try {
      const s = await window.lanApi.routerRefresh()
      setStatus(s)
      setProbeErr(null)
    } catch (err) {
      // 审计 M-3：刷新失败必须可见，不能静默
      setProbeErr(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }, [hasApi])

  const onLogin = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      if (!hasApi || loginBusy) return
      const u = user.trim()
      const p = password.trim()
      if (!u || !p) {
        setLoginMsg({ tone: 'warn', text: '请输入用户名与密码' })
        return
      }
      setLoginBusy(true)
      setLoginMsg(null)
      try {
        // task-022 B-1：登录前先同步开关（true→false 会由主进程清盘上凭据），
        // 主进程按落定后的设置决定本轮登录是否保存凭据
        await window.lanApi.settingsUpdate({ rememberRouterPassword: remember })
        const res = await window.lanApi.routerLogin(u, p)
        if (res.ok) {
          setPassword('')
          setLoginMsg({
            tone: 'ok',
            text: res.persisted ? '登录成功，凭据已加密保存' : `登录成功（${res.persistError ?? '凭据未保存'}）`,
          })
        } else {
          setLoginMsg({ tone: 'crit', text: res.error ?? '登录失败' })
        }
      } catch (err) {
        setLoginMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
      } finally {
        setLoginBusy(false)
      }
    },
    [hasApi, loginBusy, user, password, remember],
  )

  const onOpenAdmin = useCallback(async () => {
    if (!hasApi || adminBusy) return
    setAdminBusy(true)
    setAdminMsg(null)
    try {
      const res = await window.lanApi.routerOpenAdmin()
      if (res.ok) {
        setAdminMsg({
          tone: 'ok',
          text: '已打开管理页窗口，请在页面中完成登录；登录成功后本页会自动检测到会话。',
        })
      } else {
        setAdminMsg({ tone: 'crit', text: res.error ?? '管理页打开失败' })
      }
    } catch (err) {
      setAdminMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setAdminBusy(false)
    }
  }, [hasApi, adminBusy])

  const onReboot = useCallback(async () => {
    if (!hasApi || rebootBusy) return
    setRebootConfirm(false)
    setRebootBusy(true)
    try {
      const res = await window.lanApi.routerReboot()
      if (res.status === 'ok') {
        setRebootMsg({ tone: 'warn', text: '重启指令已下发，路由器将在数十秒内恢复' })
      } else {
        setRebootMsg({ tone: 'crit', text: res.error ?? '重启失败' })
      }
    } catch (err) {
      // 审计 M-3：危险操作（重启路由器）失败必须让用户知道指令没有送达
      setRebootMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setRebootBusy(false)
    }
  }, [hasApi, rebootBusy])

  const onLogout = useCallback(async () => {
    if (!hasApi || logoutBusy) return
    setLogoutBusy(true)
    setLoginMsg(null)
    try {
      await window.lanApi.routerLogout()
      setLoginMsg({ tone: 'ok', text: '已退出登录' })
    } catch (err) {
      setLoginMsg({ tone: 'crit', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setLogoutBusy(false)
    }
  }, [hasApi, logoutBusy])

  if (!hasApi) {
    return (
      <div className="card">
        <EmptyState icon="warn" title="未连接主进程" desc="路由器管理需要主进程提供 window.lanApi。" />
      </div>
    )
  }

  if (status === null) {
    return (
      <div className="card">
        {probeErr ? (
          // 审计 P0：探测失败此前被"正在探测网关…"空态吞掉，错误永远不可见
          <EmptyState
            icon="warn"
            title="网关探测失败"
            desc={probeErr}
            actions={
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void onRefresh()} disabled={refreshing}>
                重试
              </button>
            }
          />
        ) : (
          <EmptyState icon="router" title="正在探测网关…" desc="路由器状态由主进程每 10 秒轮询一次，首帧稍候。" />
        )}
      </div>
    )
  }

  const phase = phaseInfo(status)
  const caps = status.capabilities
  const loggedIn = status.session.loggedIn
  /** ubus 数据卡（DHCP/无线）只在 ubus 会话下展示；管理页会话拿不到 ubus 数据，不得假装可看 */
  const ubusData = status.session.kind === 'ubus'

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">路由器</div>
          <div className="view-desc">
            能力自动探测：UPnP IGD 取 WAN 信息；OpenWrt（ubus）登录后可管理。不支持的功能如实标注，绝不假装可操作。
          </div>
        </div>
        <div className="toolbar__meta">
          <StatusPill tone={phase.tone}>{phase.text}</StatusPill>
          <button type="button" className="btn btn--ghost" onClick={() => void onRefresh()} disabled={refreshing}>
            <Icon name="refresh" size={14} className={refreshing ? 'spin' : undefined} />
            刷新
          </button>
        </div>
      </div>

      {status.phase === 'unreachable' && (
        <div className="card">
          <EmptyState
            icon="wifi-off"
            title="网关不可达"
            desc={status.lastError ?? '尚未完成首轮局域网扫描，暂时拿不到网关地址。完成扫描后本页会自动恢复。'}
          />
        </div>
      )}

      {status.phase !== 'unreachable' && (
        <>
          {/* —— 网关信息卡 —— */}
          <div className="card router-grid">
            <div className="router-kv">
              <div className="router-kv__label">网关 IP</div>
              <div className="router-kv__value mono">{status.identity?.ip ?? '—'}</div>
            </div>
            <div className="router-kv">
              <div className="router-kv__label">品牌 / 固件指纹</div>
              <div className="router-kv__value">
                {status.identity?.brand
                  ? `${BRAND_LABEL[status.identity.brand] ?? status.identity.brand}`
                  : '未识别'}
                {status.identity?.modelHint && (
                  <span className="router-kv__hint mono"> {status.identity.modelHint}</span>
                )}
              </div>
            </div>
            <div className="router-kv">
              <div className="router-kv__label">WAN IP（UPnP）</div>
              <div className="router-kv__value mono">{status.wan.ip ?? '—'}</div>
            </div>
            <div className="router-kv">
              <div className="router-kv__label">下行 / 上行</div>
              <div className="router-kv__value mono">
                {fmtBitRate(status.wan.rxBps)} <span className="router-kv__hint">/</span> {fmtBitRate(status.wan.txBps)}
              </div>
            </div>
            <div className="router-kv">
              <div className="router-kv__label">累计流量（设备计数器）</div>
              <div className="router-kv__value mono">
                ↓ {fmtBytes(status.wan.totalBytesRx)} · ↑ {fmtBytes(status.wan.totalBytesTx)}
              </div>
            </div>
            <div className="router-kv">
              <div className="router-kv__label">运行时间</div>
              <div className="router-kv__value">
                {status.systemBoard?.uptimeSec !== null && status.systemBoard !== null
                  ? secToDuration(status.systemBoard.uptimeSec)
                  : '—'}
              </div>
            </div>
          </div>

          {/* —— 能力矩阵 —— */}
          <div className="card">
            <div className="card__head">
              <span className="card__title">协议能力</span>
              <span className="card__hint">每项独立探测，逐次刷新</span>
            </div>
            <div className="router-caps">
              <CapRow
                supported={caps.upnp}
                label="UPnP IGD"
                note="WAN IP / 流量计数器 / 远程重启"
              />
              <CapRow
                supported={caps.managementPage}
                label="HTTP 管理页"
                note={status.identity?.brand ? `已识别（${BRAND_LABEL[status.identity.brand]}）` : '可达，品牌未识别'}
              />
              <CapRow
                supported={caps.openwrt}
                label="OpenWrt ubus"
                note={
                  status.session.kind === 'ubus'
                    ? `已登录（${status.session.user}）`
                    : status.session.kind === 'web'
                      ? '管理页会话已建立（不含 ubus 数据）'
                      : '登录后可查看 DHCP 租约与无线客户端'
                }
              />
            </div>
            {status.capabilityNotes.length > 0 && (
              <div className="router-notes">
                {status.capabilityNotes.map((n, i) => (
                  <div key={i} className="router-notes__item">
                    <Icon name="info" size={13} />
                    <span>{n}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* —— 登录 / 管理区 —— */}
          <div className="card">
            <div className="card__head">
              <span className="card__title">路由器登录</span>
              {status.session.kind === 'ubus' ? (
                <StatusPill tone="ok">已登录（{status.session.user}）</StatusPill>
              ) : status.session.kind === 'web' ? (
                <StatusPill tone="ok">管理页会话（Cookie 检测）</StatusPill>
              ) : (
                <StatusPill tone="muted">未登录</StatusPill>
              )}
            </div>

            <div className="router-login-web">
              <p className="router-login-web__desc">
                推荐：在应用内打开路由器管理页，直接在真实页面上完成登录——适用于所有品牌路由器。
              </p>
              <div className="router-session">
                <button type="button" className="btn" onClick={() => void onOpenAdmin()} disabled={adminBusy}>
                  <Icon name="router" size={14} />
                  {adminBusy ? '打开中…' : '打开管理页（内置浏览器）'}
                </button>
                {loggedIn && (
                  <button type="button" className="btn btn--ghost" onClick={() => void onLogout()} disabled={logoutBusy}>
                    {logoutBusy ? '退出中…' : '退出登录'}
                  </button>
                )}
                {/* 重启指令按能力路由（reboot() 内部 UPnP → ubus 依次尝试，都不支持则如实返回 unsupported）：
                    UPnP 重启不需要登录，ubus 重启需要 ubus 会话。 */}
                {(caps.upnp || status.session.kind === 'ubus') && (
                  <button type="button" className="btn btn--danger" onClick={() => setRebootConfirm(true)}>
                    <Icon name="warn" size={14} />
                    重启路由器
                  </button>
                )}
              </div>
            </div>

            <div className="router-login-divider">
              <span>OpenWrt ubus 账密登录（用于获取 DHCP 租约与无线客户端；非 OpenWrt 固件无此接口）</span>
            </div>

            {status.session.kind !== 'ubus' && (
              <form className="router-login" onSubmit={(e) => void onLogin(e)}>
                <input
                  className="input"
                  type="text"
                  maxLength={32}
                  placeholder="用户名（OpenWrt 默认 root）"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  autoComplete="off"
                />
                <input
                  className="input"
                  type="password"
                  maxLength={64}
                  placeholder="密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
                <button type="submit" className="btn btn--ghost" disabled={loginBusy}>
                  {loginBusy ? '登录中…' : 'ubus 登录'}
                </button>
                {/* task-022 B-1：记住密码开关（原生 checkbox；views.css 不可改，无自定义样式） */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    disabled={loginBusy}
                  />
                  记住密码（加密保存，下次启动自动登录）
                </label>
              </form>
            )}

            {adminMsg && (
              <div className="router-msg" data-tone={adminMsg.tone}>
                {adminMsg.text}
              </div>
            )}

            {loginMsg && (
              <div className="router-msg" data-tone={loginMsg.tone}>
                {loginMsg.text}
              </div>
            )}
            {/* 会话被服务端作废（-32002）：此前 loggedIn 恒为 true，用户看到"已登录"却什么数据都没有 */}
            {!loggedIn && status.session.error && (
              <div className="router-msg" data-tone="warn">
                {status.session.error}
              </div>
            )}
            {rebootMsg && (
              <div className="router-msg" data-tone={rebootMsg.tone}>
                {rebootMsg.text}
              </div>
            )}

            {rebootConfirm && (
              <div
                className="router-confirm"
                role="alertdialog"
                aria-modal="true"
                aria-label="确认重启路由器"
                tabIndex={-1}
                ref={confirmRef}
                onKeyDown={(e) => {
                  // Escape 关闭（busy 中不允许半途关闭——指令可能已发出）
                  if (e.key === 'Escape' && !rebootBusy) setRebootConfirm(false)
                }}
              >
                <div>
                  <strong>确认重启路由器？</strong>
                  <span>全网会断网 1-2 分钟，所有设备监控将出现离线告警。</span>
                </div>
                <div className="router-confirm__actions">
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => void onReboot()}
                    disabled={rebootBusy}
                  >
                    {rebootBusy ? '正在发送重启指令…' : '确认重启'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setRebootConfirm(false)}
                    disabled={rebootBusy}
                    ref={cancelBtnRef}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* —— DHCP 租约（OpenWrt 会话）—— */}
          <div className="card">
            <div className="card__head">
              <span className="card__title">DHCP 租约</span>
              <span className="card__hint">
                {ubusData ? `${status.dhcpLeases.length} 条` : 'ubus 登录后可见'}
              </span>
            </div>
            {ubusData ? (
              status.dhcpLeases.length === 0 ? (
                <div className="router-empty-line">当前无 DHCP 租约（或该固件未启用 luci-rpc）。</div>
              ) : (
                <table className="conn-table">
                  <thead>
                    <tr>
                      <th>主机名</th>
                      <th>IP</th>
                      <th>MAC</th>
                      <th>到期时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.dhcpLeases.map((l) => (
                      <tr key={`${l.mac}-${l.ip}`}>
                        <td>{l.hostname ?? '—'}</td>
                        <td className="mono">{l.ip}</td>
                        <td className="mono">{l.mac}</td>
                        <td>{l.expiresAt === null ? '无限期' : fmtDateTime(l.expiresAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : status.session.kind === 'web' ? (
              <div className="router-empty-line">管理页会话不提供 ubus 数据；OpenWrt 固件可用账密登录获取。</div>
            ) : (
              <div className="router-empty-line">该路由器不支持（或未登录）。</div>
            )}
          </div>

          {/* —— 无线客户端（OpenWrt 会话）—— */}
          <div className="card">
            <div className="card__head">
              <span className="card__title">无线客户端</span>
              <span className="card__hint">
                {ubusData ? `${status.wirelessClients.length} 台在线` : 'ubus 登录后可见'}
              </span>
            </div>
            {ubusData ? (
              status.wirelessClients.length === 0 ? (
                <div className="router-empty-line">当前无无线客户端关联（或该固件未提供 iwinfo 数据）。</div>
              ) : (
                <table className="conn-table">
                  <thead>
                    <tr>
                      <th>MAC</th>
                      <th>SSID</th>
                      <th>信号</th>
                      <th>速率（收/发）</th>
                      <th>已连接</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.wirelessClients.map((c) => (
                      <tr key={c.mac}>
                        <td className="mono">{c.mac}</td>
                        <td>{c.ssid ?? '—'}</td>
                        <td className="mono">{c.signalDbm !== null ? `${c.signalDbm} dBm` : '—'}</td>
                        <td className="mono">
                          {c.rxRateKbps !== null ? `${(c.rxRateKbps / 1000).toFixed(0)}M` : '—'} /{' '}
                          {c.txRateKbps !== null ? `${(c.txRateKbps / 1000).toFixed(0)}M` : '—'}
                        </td>
                        <td>{secToDuration(c.connectedForSec)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : status.session.kind === 'web' ? (
              <div className="router-empty-line">管理页会话不提供 ubus 数据；OpenWrt 固件可用账密登录获取。</div>
            ) : (
              <div className="router-empty-line">该路由器不支持（或未登录）。</div>
            )}
          </div>

          <div className="router-footer mono">
            最近刷新：{fmtDateTime(status.ts)} · 轮询周期 10s
            {status.lastError && <span className="router-footer__err"> · {status.lastError}</span>}
          </div>
        </>
      )}
    </>
  )
}
