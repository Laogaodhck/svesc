import { Icon, type IconName } from '../Icon'

export type ViewKey =
  | 'overview'
  | 'devices'
  | 'printers'
  | 'printermanage'
  | 'router'
  | 'watches'
  | 'diagnostics'
  | 'terminal'
  | 'settings'

export interface SidebarProps {
  view: ViewKey
  counts: { devices: number; printers: number }
  onNavigate: (view: ViewKey) => void
  version?: string
}

const ITEMS: Array<{ key: ViewKey; label: string; icon: IconName }> = [
  { key: 'overview', label: '总览', icon: 'overview' },
  { key: 'devices', label: '设备', icon: 'devices' },
  { key: 'printers', label: '打印机', icon: 'printer' },
  { key: 'printermanage', label: '打印管理', icon: 'wrench' },
  { key: 'router', label: '路由器', icon: 'router' },
  { key: 'watches', label: '监控', icon: 'activity' },
  { key: 'diagnostics', label: '诊断', icon: 'activity' },
  { key: 'terminal', label: '终端', icon: 'terminal' },
  { key: 'settings', label: '设置', icon: 'info' },
]

export function Sidebar({ view, counts, onNavigate, version }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="主导航">
      <div className="sidebar__group-label">监控</div>
      {ITEMS.map((item) => {
        const count =
          item.key === 'devices'
            ? counts.devices
            : item.key === 'printers'
              ? counts.printers
              : null
        return (
          <button
            key={item.key}
            type="button"
            className="sidebar__item"
            aria-current={view === item.key ? 'page' : undefined}
            onClick={() => onNavigate(item.key)}
          >
            <Icon name={item.icon} size={15} className="sidebar__icon" />
            <span className="sidebar__label">{item.label}</span>
            {count !== null && <span className="sidebar__count">{count}</span>}
          </button>
        )
      })}

      <div className="sidebar__footer">
        <div>推送式快照 · 5s 心跳</div>
        <div>带宽采样 · 2s</div>
        <div>浩玥工作室 · 老高 846193</div>
        {version && <div className="mono">v{version}</div>}
      </div>
    </nav>
  )
}
