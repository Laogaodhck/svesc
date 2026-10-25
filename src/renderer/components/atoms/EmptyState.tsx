import type { ReactNode } from 'react'
import { Icon, type IconName } from '../Icon'

export interface EmptyStateProps {
  icon?: IconName
  title: string
  desc?: ReactNode
  actions?: ReactNode
}

/** 空态：线性图标 + 一句解释 + 主操作。绝不出现"暂无数据"了事。 */
export function EmptyState({ icon = 'info', title, desc, actions }: EmptyStateProps) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name={icon} size={30} />
      </span>
      <div className="empty__title">{title}</div>
      {desc && <div className="empty__desc">{desc}</div>}
      {actions && <div className="empty__actions">{actions}</div>}
    </div>
  )
}
