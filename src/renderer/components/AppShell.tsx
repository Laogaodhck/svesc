import type { ReactNode } from 'react'
import { TopBar, type TopBarProps } from './shell/TopBar'
import { Sidebar, type SidebarProps } from './shell/Sidebar'
import { StatusBar, type StatusBarProps } from './shell/StatusBar'

export interface AppShellProps {
  topbar: TopBarProps
  sidebar: SidebarProps
  statusbar: StatusBarProps
  children: ReactNode
  /** 详情抽屉等覆盖层 */
  drawer?: ReactNode
}

/**
 * 应用骨架 —— 四区布局：
 *   顶栏 56px / 侧栏 200px + 主区 / 状态条 28px
 * 纯展示组件，不持有任何业务状态；所有数据由 App 注入。
 */
export function AppShell({ topbar, sidebar, statusbar, children, drawer }: AppShellProps) {
  return (
    <div className="app">
      <TopBar {...topbar} />
      <div className="shell">
        <Sidebar {...sidebar} />
        <main className="content" id="main-content">
          {children}
        </main>
      </div>
      <StatusBar {...statusbar} />
      {drawer}
    </div>
  )
}
