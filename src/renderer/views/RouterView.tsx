import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { RouterStatus } from '../../shared/types'
import { StatusPill } from '../components/atoms/StatusPill'
import { EmptyState } from '../components/atoms/EmptyState'
import { Icon } from '../components/Icon'
import type { Tone } from '../lib/semantics'

/**
 * 路由器登录视图（task-035 重构）。
 *
 * 本页只保留登录闭环，其余功能（网关信息 / WAN 流量 / 协议矩阵 /
 * DHCP 租约 / 无线状态与客户端 / 远程重启）已全部移除——DHCP 租约等
 * 数据仍由引擎层持续采集并回填到设备列表，只是不再在本页展示。
 *
 * 两条登录路径，共享同一会话状态：
 *  - 账密登录（OpenWrt ubus / Basic 认证自动适配）：表单校验 + 失败提示
 *  - 内置浏览器登录：页面内嵌 webview 打开管理页，主进程检测分区
 *    会话 Cookie 后自动置为「管理页会话」
 */

const BRAND_LABEL: Record<string, string> = {
  openwrt: 'OpenWrt',
  tplink: 'TP-Link',
  xiaomi: '小米',
  asus: '华硕',
  huawei: '华为',
  netgear: 'NETGEAR',
  // task-032：市面常见品牌（与 detect.ts 指纹表同步扩充）
  tenda: '腾达',
  zte: '中兴',
  h3c: 'H3C',
  ruijie: '锐捷',
  mercury: '水星',
  linksys: 'Linksys',
  dlink: 'D-Link',
  glinet: 'GL.iNet',
  generic: '未知品牌',
}

/** Electron <webview> 标签的导航能力（DOM 类型里没有，单独收窄声明）。 */
interface WebviewLike extends HTMLElement {
  goBack(): void
  goForward(): void
  reload(): void
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
}

function phaseInfo(s: RouterStatus): { text: string; tone: Tone } {
  if (s.phase === 'probing') return { text: '探测中', tone: 'muted' }
  if (s.phase === 'unreachable') return { text: '不可达', tone: 'crit' }
  if (s.phase === 'ready') return { text: '已连接', tone: 'ok' }
  // 未知 phase 如实标注"未知"，绝不冒充"已连接"
  return { text: '未知', tone: 'muted' }
}

export function RouterView() {
  const [status, setStatus] = useState<RouterStatus | null>(null)
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginMsg, setLoginMsg] = useState<{ tone: Tone; text: string } | null>(null)
  // task-032：管理页内嵌 webview 面板开关（不再弹独立窗口）
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminCurUrl, setAdminCurUrl] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [probeErr, setProbeErr] = useState<string | null>(null)
  const [logoutBusy, setLogoutBusy] = useState(false)
  // task-022 B-1：记住密码开关（默认 true；登录前先同步到设置，主进程按当前设置决定是否落盘）
  const [remember, setRemember] = useState(true)

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

  // task-032：页面内嵌管理页 webview（不再弹窗）。导航/就绪后通知主进程检测
  // 分区会话 Cookie（命中即 markWebSession，状态推送更新本页"已登录"展示）。
  const webviewRef = useRef<WebviewLike | null>(null)

  useEffect(() => {
    if (!adminOpen || !hasApi) return
    const el = webviewRef.current
    if (!el) return
    const check = (): void => {
      void window.lanApi
        .routerCheckWebSession()
        .catch(() => {
          /* 检测失败不算登录失败，下一次导航会再触发 */
        })
    }
    const trackUrl = (): void => {
      try {
        setAdminCurUrl(el.getURL())
      } catch {
        /* webview 已销毁 */
      }
    }
    el.addEventListener('dom-ready', check)
    el.addEventListener('did-navigate', check)
    el.addEventListener('did-navigate-in-page', check)
    el.addEventListener('did-navigate', trackUrl)
    el.addEventListener('did-navigate-in-page', trackUrl)
    el.addEventListener('dom-ready', trackUrl)
    return () => {
      el.removeEventListener('dom-ready', check)
      el.removeEventListener('did-navigate', check)
      el.removeEventListener('did-navigate-in-page', check)
      el.removeEventListener('did-navigate', trackUrl)
      el.removeEventListener('did-navigate-in-page', trackUrl)
      el.removeEventListener('dom-ready', trackUrl)
    }
  }, [adminOpen, hasApi])

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
        <EmptyState icon="warn" title="未连接主进程" desc="路由器登录需要主进程提供 window.lanApi。" />
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
  const loggedIn = status.session.loggedIn
  // task-032：管理页落点 URL（指纹探测的重定向落点优先，兜底 http://网关/）
  const adminUrl = status.identity?.adminUrl ?? (status.identity?.ip ? `http://${status.identity.ip}/` : null)

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">路由器</div>
          <div className="view-desc">
            {status.identity?.ip
              ? `网关 ${status.identity.ip}`
              : '尚未拿到网关地址，完成一轮局域网扫描后自动识别。'}
            {status.identity?.brand && ` · ${BRAND_LABEL[status.identity.brand] ?? status.identity.brand}`}
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

      {status.phase === 'unreachable' ? (
        <div className="card">
          <EmptyState
            icon="wifi-off"
            title="网关不可达"
            desc={status.lastError ?? '尚未完成首轮局域网扫描，暂时拿不到网关地址。完成扫描后本页会自动恢复。'}
          />
        </div>
      ) : (
        <>
          {/* —— 登录卡 —— */}
          <div className="card">
            <div className="card__head">
              <span className="card__title">路由器登录</span>
              {status.session.kind === 'ubus' ? (
                <StatusPill tone="ok">已登录（{status.session.user}）</StatusPill>
              ) : status.session.kind === 'web' ? (
                <StatusPill tone="ok">管理页会话（Cookie 检测）</StatusPill>
              ) : status.session.kind === 'basic' ? (
                <StatusPill tone="ok">Basic 认证（{status.session.user}）</StatusPill>
              ) : (
                <StatusPill tone="muted">未登录</StatusPill>
              )}
            </div>

            <div className="router-login-web">
              <p className="router-login-web__desc">
                推荐：在本页内直接打开路由器管理页完成登录——适用于所有品牌路由器（不再弹出独立窗口）。
              </p>
              <div className="router-session">
                <button type="button" className="btn" onClick={() => setAdminOpen((v) => !v)}>
                  <Icon name="router" size={14} />
                  {adminOpen ? '收起管理页' : '打开管理页（页面内嵌）'}
                </button>
                {loggedIn && (
                  <button type="button" className="btn btn--ghost" onClick={() => void onLogout()} disabled={logoutBusy}>
                    {logoutBusy ? '退出中…' : '退出登录'}
                  </button>
                )}
              </div>
            </div>

            <div className="router-login-divider">
              <span>
                账密登录（OpenWrt ubus；华硕等 Basic 认证路由器会自动按 Basic 方式验证）
              </span>
            </div>

            {status.session.kind !== 'ubus' ? (
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
                  {loginBusy ? '登录中…' : '账密登录'}
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
            ) : (
              <div className="router-empty-line">ubus 会话已建立。DHCP 租约与无线数据由引擎采集，回填至设备列表。</div>
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
          </div>

          {/* —— 内嵌管理页（task-032）：webview 挂 persist:router-admin 分区，
              与 Cookie 会话检测/管理页租约实验通道共享登录态；不再弹独立窗口 —— */}
          {adminOpen && (
            <div className="card">
              <div className="card__head">
                <span className="card__title">路由器管理页（内嵌浏览器）</span>
                <span className="card__hint mono">{adminCurUrl ?? adminUrl ?? '—'}</span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => webviewRef.current?.goBack()}
                  title="后退"
                >
                  ← 后退
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => webviewRef.current?.goForward()}
                  title="前进"
                >
                  → 前进
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => webviewRef.current?.reload()}
                  title="刷新"
                >
                  刷新
                </button>
                {adminUrl && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      // 回到管理页落点（登录页）：直接改 src，webview 会整页导航
                      const el = webviewRef.current
                      if (el) {
                        el.setAttribute('src', adminUrl)
                      }
                      setAdminCurUrl(adminUrl)
                    }}
                  >
                    回到登录页
                  </button>
                )}
              </div>
              {adminUrl ? (
                <webview
                  src={adminUrl}
                  partition="persist:router-admin"
                  // 管理页偶有 window.open（帮助页等）：允许弹窗，弹出的新窗口沿用同一分区
                  allowpopups={true}
                  style={{
                    width: '100%',
                    height: 560,
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    background: '#fff',
                  }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron webview 不是标准 DOM 元素
                  ref={(el: any) => {
                    webviewRef.current = el
                  }}
                />
              ) : (
                <div className="router-empty-line">网关地址未知，请先完成一次局域网扫描。</div>
              )}
              <div className="router-notes">
                <div className="router-notes__item">
                  <Icon name="info" size={13} />
                  <span>登录成功后（检测到会话 Cookie）上方登录卡会自动变为「管理页会话」；租约数据将回填至设备列表。</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}
