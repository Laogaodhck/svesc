import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Device, Snapshot } from '../shared/types'
import { AppShell } from './components/AppShell'
import { OverviewView } from './views/OverviewView'
import { DevicesView } from './views/DevicesView'
import { PrintersView } from './views/PrintersView'
import { PrinterManageView } from './views/PrinterManageView'
import { RouterView } from './views/RouterView'
import { DiagnosticsView } from './views/DiagnosticsView'
import { TerminalView } from './views/TerminalView'
import { SettingsView } from './views/SettingsView'
import { DeviceDetailDrawer } from './views/DeviceDetailDrawer'
import { WatchesView } from './views/WatchesView'
import { EmptyState } from './components/atoms/EmptyState'
import { TableSkeleton } from './components/atoms/Skeleton'
import { Icon } from './components/Icon'
import type { ViewKey } from './components/shell/Sidebar'
import { useLiveFeed } from './hooks/useLiveFeed'
import { publishPerf, recordPerf, settleSnapshotRender } from './lib/perf'

const NO_DEVICES: Device[] = []
const NO_PRINTERS: Snapshot['printers'] = []

export function App() {
  const feed = useLiveFeed()
  const { snapshot, apiMissing } = feed

  const [view, setView] = useState<ViewKey>('overview')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [localAuto, setLocalAuto] = useState<boolean | null>(null)
  /** 打印机跳转定位（PrintersView 滚动 + 高亮；进入其它视图时清除） */
  const [focusPrinterId, setFocusPrinterId] = useState<string | null>(null)
  /** 诊断中心预填目标：设备详情"网络诊断"跳转时携带，进入诊断页消费一次后清除 */
  const [diagPresetTarget, setDiagPresetTarget] = useState<string | null>(null)
  // 虚拟打印机开关（审计后持久化到 JsonStore.settings；本地态保证切视图/刷新不丢）
  const [showVirtualPrinters, setShowVirtualPrinters] = useState(false)
  /** 应用版本（settingsGet 注入），侧边栏 footer 展示 */
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined)
  const renderMsRef = useRef<HTMLSpanElement | null>(null)
  const lastSnapshotRef = useRef<Snapshot | null>(null)

  const system = snapshot?.system
  const devices = snapshot?.devices ?? NO_DEVICES
  const printers = snapshot?.printers ?? NO_PRINTERS

  const autoScan = localAuto ?? system?.autoScan ?? false
  const scanning = system?.scan?.active ?? feed.progress?.active ?? false
  // 下一次深度扫描（端口/指纹采集轮）的绝对时间戳；实时探测由 5s 心跳负责，与此无关
  const nextScanAt =
    snapshot && system && system.nextScanInMs !== null && system.autoScan
      ? snapshot.ts + system.nextScanInMs
      : null

  const detailDevice = detailId ? devices.find((d) => d.id === detailId) ?? null : null

  /* -------- 渲染耗时：IPC 回调打点 → React commit 结算 -------- */
  useLayoutEffect(() => {
    if (!snapshot || snapshot === lastSnapshotRef.current) return
    lastSnapshotRef.current = snapshot
    const ms = settleSnapshotRender()
    if (ms === null) return
    recordPerf(ms)
    publishPerf()
    if (renderMsRef.current) renderMsRef.current.textContent = ms.toFixed(1)
  }, [snapshot])

  /* -------- 持久化设置初值：虚拟打印机开关 + 版本号（失败静默用默认值） -------- */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.lanApi) return
    window.lanApi
      .settingsGet()
      .then((s) => {
        setShowVirtualPrinters(s.showVirtualPrinters)
        setAppVersion(s.appVersion)
      })
      .catch(() => {
        /* 主进程未就绪时用默认值，下一次设置页/打印机页操作会再对齐 */
      })
  }, [])

  /* -------- __ready：首个快照提交后置 true（不用 rAF，离屏/无头环境可能不派发） -------- */
  useEffect(() => {
    if (!snapshot) return
    if (window.__ready === true) return
    const id = window.setTimeout(() => {
      window.__ready = true
    }, 0)
    return () => window.clearTimeout(id)
  }, [snapshot])

  /* -------- 实时监控开关：乐观更新，快照回来后对齐 -------- */
  useEffect(() => {
    if (localAuto !== null && system && system.autoScan === localAuto) setLocalAuto(null)
  }, [system, localAuto])

  const navigate = useCallback((next: ViewKey) => {
    setView(next)
    setDetailId(null)
    setFocusPrinterId(null)
    setDiagPresetTarget(null)
    document.getElementById('main-content')?.scrollTo({ top: 0 })
  }, [])

  /* -------- 冒烟钩子（冻结契约，无条件暴露） -------- */
  useEffect(() => {
    window.__setView = (v: ViewKey, deviceId?: string) => {
      // 复用 navigate 的清理逻辑（清 focus/diag + 滚回顶部 + 关抽屉），
      // 再按参数重开设备抽屉——smoke 依赖 deviceId 打开设备详情。
      navigate(v)
      setDetailId(deviceId ?? null)
    }
  }, [navigate])

  /** PrintersView 消费完高亮后回调——useCallback 固化引用，避免扫描期间高亮定时器被反复重置 */
  const consumeFocus = useCallback(() => setFocusPrinterId(null), [])

  const openDetail = useCallback((id: string) => setDetailId(id), [])
  const closeDetail = useCallback(() => setDetailId(null), [])

  /** 虚拟打印机开关：本地即时 + 持久化（设置页与打印机页共用同一状态） */
  const toggleVirtualPrinters = useCallback(() => {
    setShowVirtualPrinters((prev) => {
      const next = !prev
      void window.lanApi?.settingsUpdate({ showVirtualPrinters: next }).catch(() => {
        /* 持久化失败静默：下一次开关操作会再同步 */
      })
      return next
    })
  }, [])

  const toggleAutoScan = useCallback(() => {
    const next = !autoScan
    setLocalAuto(next)
    feed.setAutoScan(next)
  }, [autoScan, feed])

  const content = (() => {
    if (!snapshot) {
      return (
        <div className="card">
          {apiMissing ? (
            <EmptyState
              icon="warn"
              title="未连接主进程"
              desc={
                <>
                  预加载桥 window.lanApi 不可用，渲染层无法获取快照。
                  <br />
                  请确认 Electron 主进程已注入 preload，而不是在普通浏览器里打开页面。
                </>
              }
            />
          ) : (
            <>
              <div className="card__head">
                <span className="card__title">正在等待首帧快照</span>
                <span className="card__hint">主进程推送 5s 心跳 · 首屏用 getSnapshot 取一次</span>
              </div>
              <TableSkeleton rows={8} />
            </>
          )}
        </div>
      )
    }

    switch (view) {
      case 'devices':
        return (
          <DevicesView
            devices={devices}
            selectedId={detailId}
            onOpenDetail={openDetail}
            scanning={scanning}
            totalDevices={snapshot.system.totalDevices}
            watches={snapshot.watches ?? []}
          />
        )
      case 'printers':
        return (
          <PrintersView
            printers={printers}
            scanning={scanning}
            now={snapshot.ts}
            showVirtual={showVirtualPrinters}
            onToggleVirtual={toggleVirtualPrinters}
            onRefresh={feed.refresh}
            focusId={focusPrinterId}
            onFocusConsumed={consumeFocus}
          />
        )
      case 'printermanage':
        return <PrinterManageView printers={printers} />
      case 'settings':
        return (
          <SettingsView
            showVirtualPrinters={showVirtualPrinters}
            onShowVirtualChange={setShowVirtualPrinters}
          />
        )
      case 'router':
        return <RouterView devices={devices} onOpenDetail={openDetail} />
      case 'watches':
        return (
          <WatchesView
            watches={snapshot.watches ?? []}
            devices={devices}
            onOpenDetail={openDetail}
            onNavigate={navigate}
          />
        )
      case 'diagnostics':
        return (
          <DiagnosticsView
            presetTarget={diagPresetTarget}
            onPresetConsumed={() => setDiagPresetTarget(null)}
          />
        )
      case 'terminal':
        return <TerminalView />
      case 'overview':
      default:
        return (
          <OverviewView
            snapshot={snapshot}
            now={snapshot.ts}
            scanning={scanning}
            onOpenDetail={openDetail}
            onOpenDevice={openDetail}
            onNavigate={navigate}
          />
        )
    }
  })()

  return (
    <>
      <AppShell
        topbar={{
          subnet: snapshot?.subnet ?? null,
          dataSource: snapshot?.dataSource ?? 'unknown',
          updatedAt: snapshot?.ts ?? null,
          lastScanAt: system?.lastScanAt ?? null,
          autoScan,
          autoScanIntervalSec: system?.autoScanIntervalSec ?? 30,
          scanning,
          warnings: snapshot?.warnings ?? [],
          onRefresh: feed.refresh,
          onExport: feed.exportReport,
          onToggleAutoScan: toggleAutoScan,
        }}
        sidebar={{
          view,
          counts: {
            devices: devices.length,
            // 审计 M-5：恒用非虚拟口径（虚拟开关在打印机页内，副作用不应漂移到侧边栏）
            printers: printers.filter((p) => p.connection !== 'virtual').length,
          },
          onNavigate: navigate,
          version: appVersion,
        }}
        statusbar={{
          snapshotTs: snapshot?.ts ?? null,
          nextScanAt,
          autoScan,
          scanning,
          dataSource:
            snapshot?.dataSource === 'live'
              ? '实时'
              : snapshot?.dataSource === 'demo'
                ? '演示'
                : snapshot?.dataSource === 'mixed'
                  ? '混合'
                  : '未知',
          renderMsRef,
        }}
        drawer={
          <DeviceDetailDrawer
            deviceId={detailId}
            device={detailDevice}
            now={snapshot?.ts ?? 0}
            watches={snapshot?.watches ?? []}
            onClose={closeDetail}
            onRunDiagnostics={(ip) => {
              // 跳转诊断中心并预填目标自动 ping（navigate 顺带关抽屉 + 滚回顶部 + 清 focus/diag）
              navigate('diagnostics')
              setDiagPresetTarget(ip)
            }}
          />
        }
      >
        {feed.error && (
          <div className="banner" role="alert">
            <Icon name="warn" size={14} />
            <span className="banner__text">{feed.error}</span>
            <button
              type="button"
              className="banner__close"
              onClick={feed.dismissError}
              aria-label="关闭错误提示"
              title="关闭"
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        )}
        {content}
      </AppShell>
    </>
  )
}
