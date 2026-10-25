/**
 * 内联 SVG 图标集 —— 线性风格，stroke 1.5，24×24 viewBox，继承 currentColor。
 * 禁止引入图标库（brief 硬约束）。
 */

import type { ReactNode } from 'react'

export type IconName =
  | 'overview'
  | 'devices'
  | 'printer'
  | 'alarm'
  | 'search'
  | 'refresh'
  | 'export'
  | 'close'
  | 'activity'
  | 'network'
  | 'info'
  | 'warn'
  | 'check'
  | 'wifi-off'
  | 'cpu'
  | 'chevron-right'
  | 'arrow-down'
  | 'arrow-up'
  | 'clock'
  | 'shield'
  | 'router'
  | 'wrench'
  | 'terminal'

interface IconProps {
  name: IconName
  size?: number
  className?: string
  /** 装饰性图标默认 aria-hidden，标题图标传 label 走 role=img */
  label?: string
}

const PATHS: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="4.5" rx="1.5" />
      <rect x="13.5" y="10.5" width="7.5" height="10.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  devices: (
    <>
      <rect x="2.5" y="4" width="19" height="12.5" rx="1.8" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </>
  ),
  printer: (
    <>
      <path d="M7 8.5V3.5h10v5" />
      <rect x="3" y="8.5" width="18" height="7.5" rx="1.8" />
      <path d="M7 13h10v7.5H7z" />
      <path d="M17.5 11.5h.01" />
    </>
  ),
  alarm: (
    <>
      <path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5Z" />
      <path d="M10.3 19a2 2 0 0 0 3.4 0" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.4 15.4 4.6 4.6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4.5V10h-5.5" />
    </>
  ),
  export: (
    <>
      <path d="M12 15.5V3.5" />
      <path d="m7.5 8 4.5-4.5L16.5 8" />
      <path d="M4 15v4.5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V15" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  activity: <path d="M2.5 12h4l2.5-7 4 14 2.5-7h6" />,
  network: (
    <>
      <circle cx="12" cy="4.5" r="2.2" />
      <circle cx="5" cy="19" r="2.2" />
      <circle cx="19" cy="19" r="2.2" />
      <path d="M12 6.7v5.3M12 12H5v4.8M12 12h7v4.8" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.8h.01" />
    </>
  ),
  warn: (
    <>
      <path d="M10.6 3.9 2.5 18a1.6 1.6 0 0 0 1.4 2.4h16.2A1.6 1.6 0 0 0 21.5 18L13.4 3.9a1.6 1.6 0 0 0-2.8 0Z" />
      <path d="M12 9v4.5M12 17h.01" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  'wifi-off': (
    <>
      <path d="M3 3l18 18" />
      <path d="M8.6 12.4a5.5 5.5 0 0 1 6.8.4M5 9a10 10 0 0 1 4-2.3M2 5.5A14 14 0 0 1 7 3" />
      <path d="M12 19h.01" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="1.6" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" />
      <path d="M9.5 2.5v3M14.5 2.5v3M9.5 18.5v3M14.5 18.5v3M2.5 9.5h3M2.5 14.5h3M18.5 9.5h3M18.5 14.5h3" />
    </>
  ),
  'chevron-right': <path d="m9.5 5 7 7-7 7" />,
  'arrow-down': <path d="M12 4.5v15M6.5 14 12 19.5 17.5 14" />,
  'arrow-up': <path d="M12 19.5v-15M6.5 10 12 4.5 17.5 10" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 2.8 4.5 6v6c0 4.4 3.1 7.7 7.5 9.2 4.4-1.5 7.5-4.8 7.5-9.2V6L12 2.8Z" />
      <path d="m8.8 12 2.2 2.2 4.2-4.4" />
    </>
  ),
  router: (
    <>
      <rect x="2.5" y="12.5" width="19" height="8" rx="1.8" />
      <path d="M6.5 16.5h.01M10 16.5h.01" />
      <path d="M17 16.5h2" />
      <path d="M12 12.5V9" />
      <path d="M8.2 6.2a5.4 5.4 0 0 1 7.6 0" />
      <path d="M5.8 3.6a9 9 0 0 1 12.4 0" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  terminal: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="1.8" />
      <path d="m6.5 9 3.5 3-3.5 3M12.5 15.5h5" />
    </>
  ),
}

export function Icon({ name, size = 16, className, label }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
