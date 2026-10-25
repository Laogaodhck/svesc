import type { ReactNode } from 'react'

export interface HintProps {
  /** 说明文字（自绘气泡，2 行以内） */
  text: string
  children: ReactNode
}

/**
 * 悬停说明 —— 用于解释"为什么没有数据"。
 * 只在不会被 `overflow:hidden` 裁剪的容器里使用；表格单元格用原生 title。
 */
export function Hint({ text, children }: HintProps) {
  return (
    <span className="hint" tabIndex={0} title={text}>
      {children}
      <span className="hint__bubble" role="tooltip">
        {text}
      </span>
    </span>
  )
}
