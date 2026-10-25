import type { Tone } from '../../lib/semantics'

export interface StatusDotProps {
  tone: Tone
  size?: 'sm' | 'md'
  /** 持续脉冲（用于"心跳/故障"这类需要被注意的状态） */
  pulse?: boolean
  title?: string
}

/** 8px 状态点 + 3px 光晕；crit 状态 1.8s 呼吸。 */
export function StatusDot({ tone, size = 'md', pulse = false, title }: StatusDotProps) {
  return (
    <span
      className={['dot', size === 'sm' ? 'dot--sm' : ''].filter(Boolean).join(' ')}
      data-tone={tone}
      data-live={pulse && tone === 'accent' ? 'true' : undefined}
      title={title}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
    />
  )
}
