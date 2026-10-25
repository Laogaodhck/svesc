/**
 * 系统托盘（Tray）：常驻图标 + 右键菜单 + 关闭到托盘 + 任务栏告警角标。
 *
 * 行为约定：
 *  - 托盘单击：窗口可见且有焦点 → 隐藏；否则显示并聚焦（Windows 习惯）
 *  - 右键菜单：显示主窗口 / 立即扫描 / 自动扫描开关 / 开机自启（仅打包版）/ 退出
 *  - 菜单随快照心跳（5s）重建，自动扫描勾选态与告警计数保持新鲜
 *  - "退出"是唯一真退出路径：markQuitting() 置位后窗口 close 不再拦
 *  - SMOKE 模式下主进程不创建托盘（秒退场景不留无常驻）
 */
import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import path from 'node:path'
import type { Engine } from './engine'

let tray: Tray | null = null
let engineRef: Engine | null = null
let getWindowRef: (() => BrowserWindow | null) | null = null
let quitting = false
let badgeImage: Electron.NativeImage | null = null

/** 真退出置位（tray 菜单"退出"与 before-quit 都会走这里）。 */
export function markQuitting(): void {
  quitting = true
}

/** 窗口 close 事件查询：已置位 = 放行关闭，否则按 closeToTray 设置决定。 */
export function isQuitRequested(): boolean {
  return quitting
}

function showWindow(): void {
  const win = getWindowRef?.() ?? null
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow(): void {
  const win = getWindowRef?.() ?? null
  if (!win || win.isDestroyed()) return
  if (win.isVisible() && win.isFocused()) win.hide()
  else showWindow()
}

function toggleAutoScan(): void {
  const engine = engineRef
  if (!engine) return
  const cur = engine.getSettings()
  engine.setAutoScan(!cur.autoScan)
}

function toggleLoginItem(): void {
  if (!app.isPackaged) return
  const next = !app.getLoginItemSettings().openAtLogin
  app.setLoginItemSettings({ openAtLogin: next })
}

/** 按当前引擎状态重建托盘菜单（快照心跳 5s 一次，开销可忽略）。 */
export function refreshTray(): void {
  if (!tray || !engineRef) return
  const engine = engineRef
  const settings = engine.getSettings()
  const snap = engine.getSnapshot()
  const activeAlarms = snap.alarms.filter((a) => a.resolvedAt === null).length

  const loginItemChecked = app.isPackaged ? app.getLoginItemSettings().openAtLogin : false
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWindow() },
    { label: '立即扫描', click: () => void engine.refresh() },
    {
      label: '自动扫描',
      type: 'checkbox',
      checked: settings.autoScan,
      click: () => toggleAutoScan(),
    },
    { type: 'separator' },
    {
      label: app.isPackaged ? '开机自启' : '开机自启（仅安装版可用）',
      type: 'checkbox',
      checked: loginItemChecked,
      enabled: app.isPackaged,
      click: () => toggleLoginItem(),
    },
    { type: 'separator' },
    {
      label: activeAlarms > 0 ? `退出（${activeAlarms} 条活跃告警）` : '退出',
      click: () => {
        markQuitting()
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(
    activeAlarms > 0
      ? `SVESC 局域网管理台 · ${activeAlarms} 条活跃告警`
      : 'SVESC 局域网管理台',
  )
}

/** 任务栏告警角标：>0 时叠红点，=0 清除。 */
export function updateBadge(win: BrowserWindow | null, activeAlarms: number): void {
  if (!win || win.isDestroyed()) return
  try {
    if (activeAlarms > 0 && badgeImage) {
      win.setOverlayIcon(badgeImage, `${activeAlarms} 条活跃告警`)
    } else {
      win.setOverlayIcon(null, '')
    }
  } catch {
    /* overlay 失败不影响主链路 */
  }
}

export function createTray(opts: {
  trayIconPath: string
  badgeIconPath: string
  getWindow: () => BrowserWindow | null
  engine: Engine
}): Tray {
  engineRef = opts.engine
  getWindowRef = opts.getWindow
  badgeImage = nativeImage.createFromPath(opts.badgeIconPath)

  const icon = nativeImage.createFromPath(opts.trayIconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromPath(path.join(process.resourcesPath || '', 'icon.png')) : icon)
  tray.on('click', () => toggleWindow())
  tray.on('double-click', () => showWindow())
  refreshTray()
  return tray
}

/** 退出前清理（before-quit）：先置位再销毁，避免 close 拦截竞态。 */
export function destroyTray(): void {
  markQuitting()
  tray?.destroy()
  tray = null
}
