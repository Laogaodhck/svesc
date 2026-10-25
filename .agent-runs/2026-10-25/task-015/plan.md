# task-015 告警管理完善（三态状态机 + 确认人 + 详情）

## 需求（用户原话转述）

1. 告警确认机制：确认后状态更新为"已确认"（已有 ackAt，补确认人/确认时间记录）。
2. 已确认且条件恢复的告警予以**清除**，清除后不再在列表中重复显示。
3. 补充功能：状态筛选、确认时间与确认人记录、告警详情查看。
4. 各状态（未确认、已确认、已清除）流转准确、界面展示清晰。

## 冻结设计（队长裁定，实现者不得偏离）

### 状态机（三态，判定逻辑抽共享纯函数）

| 状态 | 判定 | 说明 |
|---|---|---|
| 未确认 pending | ackAt===null && resolvedAt===null | 需要 `用户处理 |
| 已确认 acked | ackAt!==null && resolvedAt===null | 用户已处理，等条件恢复 |
| 已清除 cleared | resolvedAt!==null | 条件已恢复（无论是否 ack 过）；用户点名的"已确认且恢复"自然落入此态 |

- 流转：pending →(确认：记录 ackAt+ackBy)→ acked →(条件恢复)→ cleared；pending →(条件恢复)→ cleared；**cleared 不可逆**。
- 同因再触发 = 全新告警（现有 dedupeKey 机制已保证：resolve 时从 active map 删除，再发生创建新 id）——已清除告警绝不复活。
- DEVICE_NEW 事件型告警：ack 即收尾（resolvedAt=ackAt）→ 落 cleared，保持现状。
- 判定函数：新建 `src/shared/alarm-state.ts` 导出 `alarmStateOf(alarm): 'pending'|'acked'|'cleared'`，引擎/渲染层/测试三方共用，杜绝判定逻辑分叉。

### 数据模型

- `Alarm` 增加 `ackBy: string | null`（确认人）。
- 确认人来源：**主进程注入** `os.userInfo().username`（渲染层不可伪造——权限控制点；引擎层不 import os/electron）。ipc.ts 的 ackAlarm handler 里取，传 `engine.ackAlarm(alarmId, ackBy)`。
- 链路签名扩展：ipc → engine.ackAlarm(alarmId, ackBy?) → scheduler.ackAlarm(alarmId, ackBy?) → AlarmEngine.ack(alarmId, at?, ackBy?)。LanApi.ackAlarm(alarmId) 渲染层签名不变。
- store.ts 的 alarms 持久化校验器：保留 ackBy（string|null，缺省 null——旧落盘数据向后兼容）。

### UI（AlarmsView）

- 状态筛选 segmented 四项：**待处理**（默认 = pending+acked，两项计数）/ **已确认** / **已清除** / **全部**。"不再重复显示"= cleared 默认不出现，仅已清除/全部视图可查（历史可追溯，符合数据诚实）。
- 行内状态徽标三色：未确认(warn)/已确认(muted)/已清除(ok)；组结构改为按筛选动态（现有 GROUPS 按严重度分组保留，组内行带状态徽标）。
- 行操作：pending → "确认"按钮；acked/cleared → 无确认按钮。全部确认口径不变（只作用于 pending）。
- **详情查看**：每行新增"详情"展开按钮（aria-expanded + chevron），展开区显示完整 message、detail、触发时间（绝对+相对）、确认时间+确认人、清除时间、目标类型/ID、code。与"点击行主体跳转目标页"互不冲突。
- Sidebar/Overview 的活跃告警计数口径不变（resolvedAt===null）。

## 执行计划

| 阶段 | 成员 | 内容 |
|---|---|---|
| 1 调查 | 已由队长完成（本轮摸底） | ack 链路：alarms.ts:126 ack / scheduler.ts:995 / index.ts:219 / ipc.ts:47；store 校验器 alarms 过滤器；AlarmsView 现状（task-009 后已有 scope 筛选+批量确认） |
| 2 实现 | Max-1 | 全部代码改动（文件清单见 brief-max1.md） |
| 3 测试 | Tess | tests/alarm-state.test.ts + store 持久化 roundtrip 补断言 |
| 4 验证 | Vic | vitest/tsc/build/SMOKE + 告警页截图（三态筛选与详情展开） |

## 风险

- 旧持久化 alarm 数据无 ackBy → 校验器必须缺省 null，不能让旧数据被丢弃。
- AlarmsView 现有"仅活动/全部"筛选（task-009）被四态筛选**替换**，语义迁移要在 UI 文案里讲清楚。
- ackBy 取 os username 失败（理论上不失败）→ 兜底 '未知用户'。
