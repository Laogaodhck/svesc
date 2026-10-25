/**
 * 骨架屏 —— 首屏 <300ms 出现，形状与真实内容一致，避免加载完成后跳动。
 */

export function SkeletonLine({ width = '100%', height = 11 }: { width?: string | number; height?: number }) {
  return <span className="skel" style={{ width, height }} />
}

export function SkeletonBlock({ height = 64 }: { height?: number }) {
  return <span className="skel" style={{ width: '100%', height, borderRadius: 8 }} />
}

/** 详情抽屉骨架：行数与真实资料区一致（身份 5 行 + 质量 1 块 + 带宽 1 块）。 */
export function DrawerSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span className="skel" style={{ width: 92, height: 92, borderRadius: '50%' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
          <SkeletonLine width="62%" height={13} />
          <SkeletonLine width="40%" />
          <SkeletonLine width="52%" />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SkeletonLine width="30%" height={9} />
        <SkeletonLine width="88%" />
        <SkeletonLine width="76%" />
        <SkeletonLine width="82%" />
        <SkeletonLine width="64%" />
      </div>
      <SkeletonBlock height={96} />
      <SkeletonBlock height={72} />
    </div>
  )
}

/** 表格骨架：固定 8 行，行高与真实 44px 一致。 */
export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{
            height: 44,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '0 10px',
            borderBottom: '1px solid rgba(35,44,56,.66)',
          }}
        >
          <span className="skel" style={{ width: 8, height: 8, borderRadius: '50%' }} />
          <span className="skel" style={{ width: 96, height: 10 }} />
          <span className="skel" style={{ width: 130, height: 10 }} />
          <span className="skel" style={{ width: 110, height: 10 }} />
          <span className="skel" style={{ width: 70, height: 10 }} />
          <span className="skel" style={{ width: 46, height: 10 }} />
        </div>
      ))}
    </div>
  )
}
