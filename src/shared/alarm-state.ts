/**
 * 告警三态判定（task-015 冻结设计）——引擎、渲染层、测试三方共用的唯一判定源，
 * 杜绝判定逻辑分叉。
 *
 * 状态机（plan.md 裁定）：
 *   pending 未确认  ackAt===null && resolvedAt===null   需要用户处理
 *   acked   已确认  ackAt!==null && resolvedAt===null   用户已处理，等条件恢复
 *   cleared 已清除  resolvedAt!==null                   条件已恢复（无论是否确认过）
 *
 * cleared 不可逆；同因再触发由 dedupeKey 机制产生全新告警（新 id），已清除记录绝不复活。
 */
import type { Alarm } from './types';

export type AlarmState = 'pending' | 'acked' | 'cleared';

export function alarmStateOf(alarm: Pick<Alarm, 'ackAt' | 'resolvedAt'>): AlarmState {
  if (alarm.resolvedAt !== null) return 'cleared';
  return alarm.ackAt !== null ? 'acked' : 'pending';
}

export const ALARM_STATE_LABEL: Record<AlarmState, string> = {
  pending: '未确认',
  acked: '已确认',
  cleared: '已清除',
};
