# brief-max1.md — 实现工程师 Max-1 任务书（task-015 告警管理完善）

项目根：`C:/github/svesc`。权威规格：`.agent-runs/2026-10-25/task-015/plan.md`（先读，状态机与数据模型以它为准）。你只改下方"允许改动清单"内的文件。

## 允许改动清单（allowed_edit_scope）

1. `src/shared/types.ts` — Alarm 接口
2. `src/shared/alarm-state.ts` — **新建**
3. `src/main/engine/alarms.ts`
4. `src/main/engine/scheduler.ts`
5. `src/main/engine/index.ts`
6. `src/main/engine/store.ts`
7. `src/main/ipc.ts`
8. `src/renderer/views/AlarmsView.tsx`
9. `tests/` 下测试文件（为 roundtrip 补断言也可）

**不许碰**：useLiveFeed.ts / App.tsx / 其他视图 / css / preload.ts / tray.ts / router 相关。

## 改动明细

### 1. src/shared/types.ts
`Alarm` 接口（L205-217 附近）加字段：`ackBy: string | null`（确认人；null=未确认或旧数据）。

### 2. src/shared/alarm-state.ts（新建）
```ts
import type { Alarm } from './types'
export type AlarmState = 'pending' | 'acked' | 'cleared'
export function alarmStateOf(alarm: Pick<Alarm,'ackAt'|'resolvedAt'>): AlarmState {
  if (alarm.resolvedAt !== null) return 'cleared'
  return alarm.ackAt !== null ? 'acked' : 'pending'
}
export const ALARM_STATE_LABEL: Record<AlarmState, string> = { pending: '未确认', acked: '已确认', cleared: '已清除' }
```
引擎层、AlarmsView、测试三方共用这一个判定（铁律：判定逻辑不得分叉）。

### 3. src/main/engine/alarms.ts
- `ack(alarmId: string, at = Date.now())` → `ack(alarmId: string, at = Date.now(), ackBy: string | null = null)`；设置 `alarm.ackAt = at` 处同时 `alarm.ackBy = ackBy`。
- 检查本文件里所有创建 Alarm 对象的字面量（约 L180 `resolvedAt: null` 附近）补 `ackBy: null`。
- hydrate 迁移逻辑（L78-99 附近）读到的旧告警补 `ackBy: alarm.ackBy ?? null`。

### 4. src/main/engine/scheduler.ts
`ackAlarm(alarmId: string)`（L995）→ `ackAlarm(alarmId: string, ackBy?: string | null)`，透传给 alarms.ack。

### 5. src/main/engine/index.ts
Engine 接口 `ackAlarm(alarmId: string): boolean`（L37）→ `ackAlarm(alarmId: string, ackBy?: string | null): boolean`；实现（L219）透传。

### 6. src/main/engine/store.ts
alarms 持久化校验器（L88-98 附近的 filter）：在保留条件后**补 ackBy 规整**——映射为 `{ ...a, ackBy: typeof a.ackBy === 'string' ? a.ackBy : null }`（旧数据无该字段 → null，绝不能因校验丢弃旧告警）。

### 7. src/main/ipc.ts
ackAlarm handler（L47）改为：
```ts
ipcMain.handle(CH.ackAlarm, (_event, alarmId: string): { ok: boolean } => {
  // 确认人由主进程注入（渲染层不可伪造）；取 OS 用户名，失败兜底
  let ackBy: string | null
  try { ackBy = os.userInfo().username || '未知用户' } catch { ackBy = '未知用户' }
  return { ok: engine.ackAlarm(String(alarmId), ackBy) }
})
```
顶部 `import os from 'node:os'`。

### 8. src/renderer/views/AlarmsView.tsx（重构筛选 + 详情展开）

现状（task-009 后）：scope 两态筛选（'active'默认/'all'）、按严重度三分组、单条确认、全部确认、状态徽标 statusOf 本地函数。

改造：
- **筛选**：`scope: 'pending' | 'acked' | 'cleared' | 'all'`，默认 `'pending'`（= pending+acked，即"不再重复显示已清除"）。segmented 四项带计数：
  - 待处理 `pendingCount`（pending+acked 之和）
  - 已确认 `ackedCount`
  - 已清除 `clearedCount`
  - 全部 `alarms.length`
  - 过滤：pending → state!=='cleared'；acked → state==='acked'；cleared → state==='cleared'；all → 全部。状态判定一律走 `alarmStateOf`（import 自 '../../shared/alarm-state'），删除本地 statusOf。
- **空态文案**：alarms 总数为 0 → "暂无告警记录"；当前筛选为空 → 按筛选给文案（如已清除为空 → "暂无已清除的告警记录"）。原"查看全部"动作按钮保留语义（切到 all）。
- **状态徽标**：行内 StatusPill 用三态（pending→warn 未确认 / acked→muted 已确认 / cleared→ok 已清除）。
- **组头/分组**：保留按严重度三分组；已清除在 cleared/all 视图下仍按严重度分组展示。
- **详情展开**：每行 alarm-row__actions 或行尾加"详情"切换按钮（chevron 图标，aria-expanded，复用现有 btn btn--sm）；展开区（行内下方全宽块，复用现有卡片/排版类，禁止新 CSS——可用现有的 dl/.u-11 dim/mono 等既有 class）显示：
  - 完整 message、detail（无则"无补充信息"）
  - 触发时间：`new Date(raisedAt).toLocaleString('zh-CN')`
  - 确认时间 + 确认人：acked 才有（`ackBy ?? '未知用户'`；pending 显示"未确认"）
  - 清除时间：cleared 才有（resolvedAt 绝对时间；pending/acked 显示"—"）
  - 目标：类型 + targetName + targetId（mono）
  - code（chip chip--plain）
  - 展开状态用本地 `expandedId: string | null`（同时只展开一条；再次点击收起；切筛选时重置）。
- **确认按钮**：只在 pending 显示（acked/cleared 不渲染确认按钮——保留 disabled 语义改为不渲染更清晰；title 提示相应调整）。全部确认保持（口径=当前可见 pending，现有 ackableIds 逻辑已对，不必改）。
- 数据诚实：ackBy 为 null 的旧数据已确认告警显示"确认人：未知用户（升级前记录）"？——不，简单显示"未知用户"即可，别编造"升级前"。

### 9. tests
- 新建 `tests/alarm-state.test.ts`：alarmStateOf 三态全分支 + 边界（双 null=pending、仅 ackAt=acked、仅 resolvedAt=cleared、两者都有=cleared 优先）。
- 现有涉及 alarms 持久化的测试（grep tests/ 里 ackAt / setAlarmHistory / alarm）：补 ackBy roundtrip 断言（写入 ackBy:'tester' → 读回 'tester'；写入无 ackBy 旧形状 → 读回 null）。
- 如现有 AlarmsView 无组件测试则不新增组件测试（引擎层测试为准）。

## 自检与交付

完成后跑：`npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npx vitest run`（三项全绿；vitest 若有他人历史失败如实报告）。**不 commit**。

报告写入 `.agent-runs/2026-10-25/task-015/implement-report.md`：CHANGED_FILES / 每文件改动一句话 / 与规格的偏差（如有）/ 自检命令输出摘要。回队长只发状态块。
