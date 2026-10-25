import type { ReactNode } from 'react'
import type { Tone } from '../../lib/semantics'

export interface StatusPillProps {
  tone: Tone
  children: ReactNode
  title?: string
}

/** 紧凑状态胶囊：19px 高，10.5px 字，1px 同色边。 */
export function StatusPill({ tone, children, title }: StatusPillProps) {
  return (
    <span className="pill" data-tone={tone} title={title}>
      {children}
    </span>
  )
}
