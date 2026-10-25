import { Fragment, useState } from 'react'
import type { Alarm } from '../../shared/types'
import { alarmStateOf, ALARM_STATE_LABEL } from '../../shared/alarm-state'
import type { AlarmState } from '../../shared/alarm-state'
import { StatusPill } from '../components/atoms/StatusPill'
import { EmptyState } from '../components/atoms/EmptyState'
import { Icon } from '../components/Icon'
import { severityTone } from '../lib/semantics'
import { SEVERITY_LABEL, fmtDateTime, relTime } from '../lib/format'

export interface AlarmsViewProps {
  alarms: Alarm[]
  now: number
  onAck: (alarmId: string) => void
  /** 批量确认当前筛选范围内的未确认活动告警（App 侧串行逐条调 IPC） */
  onAckAll: (ids: string[]) => void
  /** 手动清除单条（task-021 F1）：置 resolvedAt + trace 记录操作人，10 分钟冷静期内同因静默 */
  onClear: (alarmId: string) => void
  /** 批量清除当前筛选范围内 pending+acked 的告警（App 侧串行逐条调 IPC） */
  onClearRange: (ids: string[]) => void
  onOpenTarget: (alarm: Alarm) => void
  acking: string | null
  /** 批量确认进行中：单条与批量按钮统一禁用 */
  ackingAll: boolean
  /** 清除操作进行中的单条 id（busy 防重入） */
  clearing: string | null
  /** 批量清除进行中 */
  clearingAll: boolean
}

const GROUPS: Array<{ key: 'critical' | 'warning' | 'info' }> = [
  { key: 'critical' },
  { key: 'warning' },
  { key: 'info' },
]

/** 流转账目类型 → 中文（task-017 可追溯时间线）。 */
const TRACE_LABEL: Record<string, string> = {
  raised: '触发',
  're-raised': '再次触发（窗口内合并）',
  acked: '确认',
  resolved: '清除',
  'cleared-by-user': '手动清除',
}

const TARGET_LABEL: Record<string, string> = {
  device: '设备',
  printer: '打印机',
  system: '系统',
}

/**
 * task-015 三态筛选。默认 'pending'（待处理）= 未确认+已确认两项之和——
 * "已清除不再重复显示"由默认视图不包含 cleared 实现，历史经「已清除 / 全部」可追溯。
 */
type AlarmScope = 'pending' | 'acked' | 'cleared' | 'all'

/** 行内状态徽标：未确认(warn)/已确认(muted)/已清除(ok)，判定一律走 alarmStateOf。 */
const STATE_TONE: Record<AlarmState, 'ok' | 'warn' | 'muted'> = {
  pending: 'warn',
  acked: 'muted',
  cleared: 'ok',
}

const FILTER_EMPTY: Record<AlarmScope, { title: string; desc: string }> = {
  pending: {
    title: '暂无待处理告警',
    desc: '未确认与已确认的告警会显示在这里；已清除的不再重复出现。',
  },
  acked: {
    title: '暂无已确认告警',
    desc: '确认后的告警会出现在这里，条件恢复后自动清除。',
  },
  cleared: {
    title: '暂无已清除的告警记录',
    desc: '条件恢复（无论是否确认过）的告警会出现在这里，历史可追溯。',
  },
  all: {
    title: '暂无告警记录',
    desc: '设备离线、打印机故障、耗材不足或网络质量下降时会在这里出现。',
  },
}

/**
 * 行内详情展开区（task-015）：只复用既有排版类（card/dl/mono/dim/chip），不新增 CSS。
 * 展示完整 message、detail、触发/确认/清除时间与确认人、目标与告警码。
 */
function AlarmDetail({ alarm }: { alarm: Alarm }) {
  const trace = alarm.trace.slice().reverse()
  return (
    <div className="card">
      <dl className="dl">
        <dt>告警码</dt>
        <dd>
          <span className="chip chip--plain mono">{alarm.code}</span>
        </dd>
        <dt>目标</dt>
        <dd>
          {TARGET_LABEL[alarm.targetType] ?? alarm.targetType} · {alarm.targetName}
          <span className="mono dim"> {alarm.targetId}</span>
        </dd>
        <dt>内容</dt>
        <dd>{alarm.message}</dd>
        <dt>补充信息</dt>
        <dd>{alarm.detail ?? '无补充信息'}</dd>
        <dt>首次触发</dt>
        <dd>{new Date(alarm.raisedAt).toLocaleString('zh-CN')}</dd>
        <dt>最近触发</dt>
        <dd>
          {new Date(alarm.lastRaisedAt).toLocaleString('zh-CN')}
          {alarm.occurrences > 1 && (
            <span className="chip chip--plain mono alarm-row__occ">触发 {alarm.occurrences} 次</span>
          )}
        </dd>
        <dt>确认时间</dt>
        <dd>{alarm.ackAt !== null ? new Date(alarm.ackAt).toLocaleString('zh-CN') : '未确认'}</dd>
        <dt>确认人</dt>
        <dd>{alarm.ackAt !== null ? (alarm.ackBy ?? '未知用户') : '—'}</dd>
        <dt>清除时间</dt>
        <dd>{alarm.resolvedAt !== null ? new Date(alarm.resolvedAt).toLocaleString('zh-CN') : '—'}</dd>
        <dt>流转记录</dt>
        <dd>
          {trace.length === 0 ? (
            <span className="na">—</span>
          ) : (
            <ol className="alarm-trace">
              {trace.map((t, i) => (
                <li key={`${t.at}-${t.type}-${i}`}>
                  <span className="mono dim">{fmtDateTime(t.at)}</span>
                  <span className="alarm-trace__type">{TRACE_LABEL[t.type] ?? t.type}</span>
                  {(t.type === 'acked' || t.type === 'cleared-by-user') && t.by ? <span>（{t.by}）</span> : null}
                </li>
              ))}
            </ol>
          )}
        </dd>
      </dl>
    </div>
  )
}

export function AlarmsView({
  alarms,
  now,
  onAck,
  onAckAll,
  onClear,
  onClearRange,
  onOpenTarget,
  acking,
  ackingAll,
  clearing,
  clearingAll,
}: AlarmsViewProps) {
  const [scope, setScope] = useState<AlarmScope>('pending')
  /** 详情展开：同时只展开一条；切筛选时重置 */
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const pendingCount = alarms.filter((a) => alarmStateOf(a) !== 'cleared').length
  const ackedCount = alarms.filter((a) => alarmStateOf(a) === 'acked').length
  const clearedCount = alarms.filter((a) => alarmStateOf(a) === 'cleared').length

  const visible = alarms.filter((a) => {
    const s = alarmStateOf(a)
    if (scope === 'pending') return s !== 'cleared'
    if (scope === 'acked') return s === 'acked'
    if (scope === 'cleared') return s === 'cleared'
    return true
  })

  // 批量确认口径不变：当前筛选范围内待确认（pending）的告警
  const ackableIds = visible.filter((a) => alarmStateOf(a) === 'pending').map((a) => a.id)
  const batchDisabled = ackingAll || acking !== null || ackableIds.length === 0
  // 批量清除口径（task-021 F1）：当前筛选范围内 pending+acked 的告警（cleared 不重复清除）
  const clearableIds = visible.filter((a) => alarmStateOf(a) !== 'cleared').map((a) => a.id)
  const clearDisabled = ackingAll || clearingAll || clearing !== null || clearableIds.length === 0

  /** 切筛选同时收起详情展开，避免展开区跨视图残留 */
  const switchScope = (s: AlarmScope) => {
    setScope(s)
    setExpandedId(null)
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">告警</div>
          <div className="view-desc">
            三态流转：未确认 →（确认，记录确认人）→ 已确认 →（条件恢复）→ 已清除；未确认直接恢复同样清除。
            也可手动「清除」（记录操作人；10 分钟内同因不再重复提示）。已清除默认不显示，切「已清除 / 全部」可追溯历史。
          </div>
        </div>
        <div className="toolbar__meta">
          待处理 <span className="mono">{pendingCount}</span> · 全部{' '}
          <span className="mono">{alarms.length}</span>
        </div>
      </div>

      {alarms.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="shield"
            title="暂无告警记录"
            desc="设备离线（ARP 连续 3 轮缺席）、打印机故障、耗材不足或网络质量下降时会在这里出现。"
          />
        </div>
      ) : (
        <>
          <div className="toolbar">
            <div className="segmented" role="group" aria-label="告警状态筛选">
              <button
                type="button"
                className="segmented__item"
                aria-pressed={scope === 'pending'}
                onClick={() => switchScope('pending')}
              >
                待处理
                <span className="segmented__count">{pendingCount}</span>
              </button>
              <button
                type="button"
                className="segmented__item"
                aria-pressed={scope === 'acked'}
                onClick={() => switchScope('acked')}
              >
                已确认
                <span className="segmented__count">{ackedCount}</span>
              </button>
              <button
                type="button"
                className="segmented__item"
                aria-pressed={scope === 'cleared'}
                onClick={() => switchScope('cleared')}
              >
                已清除
                <span className="segmented__count">{clearedCount}</span>
              </button>
              <button
                type="button"
                className="segmented__item"
                aria-pressed={scope === 'all'}
                onClick={() => switchScope('all')}
              >
                全部
                <span className="segmented__count">{alarms.length}</span>
              </button>
            </div>
            <button
              type="button"
              className="btn btn--sm"
              disabled={batchDisabled}
              onClick={() => onAckAll(ackableIds)}
              title={
                ackableIds.length === 0
                  ? '当前范围内没有待确认的告警'
                  : `逐条确认当前范围内的 ${ackableIds.length} 条未确认告警`
              }
            >
              <Icon name="check" size={12} />
              {ackingAll ? '批量确认中…' : `全部确认（${ackableIds.length}）`}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={clearDisabled}
              onClick={() => onClearRange(clearableIds)}
              title={
                clearableIds.length === 0
                  ? '当前范围内没有可清除的告警'
                  : `逐条清除当前范围内的 ${clearableIds.length} 条告警（未确认与已确认均可）`
              }
            >
              <Icon name="close" size={12} />
              {clearingAll ? '批量清除中…' : `清除当前范围（${clearableIds.length}）`}
            </button>
          </div>

          {visible.length === 0 ? (
            <div className="card">
              <EmptyState
                icon="shield"
                title={FILTER_EMPTY[scope].title}
                desc={FILTER_EMPTY[scope].desc}
                actions={
                  <button type="button" className="btn" onClick={() => switchScope('all')}>
                    查看全部
                  </button>
                }
              />
            </div>
          ) : (
            <div className="alarm-groups">
              {GROUPS.map((g) => {
                const items = visible
                  .filter((a) => a.severity === g.key)
                  .sort((a, b) => b.raisedAt - a.raisedAt)
                if (items.length === 0) return null
                const tone = severityTone(g.key)
                return (
                  <section key={g.key}>
                    <div className="alarm-group__head">
                      <span className="alarm-group__title">{SEVERITY_LABEL[g.key]}</span>
                      <span className="alarm-group__count">{items.length}</span>
                    </div>
                    <div className="alarm-list">
                      {items.map((a) => {
                        const state = alarmStateOf(a)
                        const expanded = expandedId === a.id
                        return (
                          <Fragment key={a.id}>
                            <div
                              className="alarm-row"
                              data-tone={tone}
                              data-resolved={state === 'cleared' ? 'true' : undefined}
                            >
                              <span className="alarm-row__sev" />
                              <button
                                type="button"
                                className="alarm-row__main"
                                onClick={() => onOpenTarget(a)}
                              >
                                <span className="alarm-row__title">
                                  <span className="alarm-row__target">{a.targetName}</span>
                                  <span className="chip chip--plain alarm-row__code">{a.code}</span>
                                </span>
                                <span className="alarm-row__msg">{a.message}</span>
                                <span className="alarm-row__meta">
                                  <span>{TARGET_LABEL[a.targetType] ?? a.targetType}</span>
                                  <span>·</span>
                                  <span title={new Date(a.raisedAt).toLocaleString('zh-CN')}>
                                    {relTime(a.raisedAt, now)}
                                  </span>
                                  {a.occurrences > 1 && (
                                    <>
                                      <span>·</span>
                                      <span
                                        className="alarm-row__occ"
                                        title={`抑制窗口内合并统计；最近触发 ${new Date(a.lastRaisedAt).toLocaleString('zh-CN')}`}
                                      >
                                        已触发 {a.occurrences} 次
                                      </span>
                                    </>
                                  )}
                                  {a.detail && (
                                    <>
                                      <span>·</span>
                                      <span className="ellipsis" title={a.detail}>
                                        {a.detail}
                                      </span>
                                    </>
                                  )}
                                </span>
                              </button>
                              <div className="alarm-row__actions">
                                <StatusPill tone={STATE_TONE[state]}>{ALARM_STATE_LABEL[state]}</StatusPill>
                                {/* 只有待处理（未确认）才渲染确认按钮；已确认/已清除不渲染 */}
                                {state === 'pending' && (
                                  <button
                                    type="button"
                                    className="btn btn--sm"
                                    disabled={ackingAll || clearingAll || acking === a.id || clearing === a.id}
                                    onClick={() => onAck(a.id)}
                                    title="确认此告警（记录确认人与确认时间）"
                                  >
                                    <Icon name="check" size={12} />
                                    {acking === a.id ? '处理中' : '确认'}
                                  </button>
                                )}
                                {/* pending 与 acked 都可手动清除；cleared 无意义不渲染 */}
                                {state !== 'cleared' && (
                                  <button
                                    type="button"
                                    className="btn btn--sm"
                                    disabled={ackingAll || clearingAll || acking === a.id || clearing === a.id}
                                    onClick={() => onClear(a.id)}
                                    title="清除此告警（记录操作人；10 分钟内同因不再重复提示）"
                                  >
                                    <Icon name="close" size={12} />
                                    {clearing === a.id ? '处理中' : '清除'}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn btn--sm"
                                  aria-expanded={expanded}
                                  onClick={() => setExpandedId(expanded ? null : a.id)}
                                  title={expanded ? '收起详情' : '查看告警详情'}
                                >
                                  <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                                  详情
                                </button>
                              </div>
                            </div>
                            {expanded && <AlarmDetail alarm={a} />}
                          </Fragment>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            </div>
          )}
        </>
      )}
    </>
  )
}
