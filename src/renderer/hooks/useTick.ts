import { useEffect, useState } from 'react'

/**
 * 低频时钟 —— 只给"相对时间/倒计时"用。
 * 刻意放在叶子组件（顶栏、状态条）内部，避免把整棵设备表拖进每秒重渲染。
 */
export function useTick(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])

  return now
}
