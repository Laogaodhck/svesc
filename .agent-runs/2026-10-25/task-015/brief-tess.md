# brief-tess.md — 测试工程师 Tess 任务书（task-015）

项目根：`C:/github/svesc`。先读 `.agent-runs/2026-10-25/task-015/plan.md`（三态状态机裁定）与 `implement-report.md`（Max-1 的实现报告——按它的实际导出名定位，不要猜）。

## 使命

为告警三态状态机与 ackBy 持久化补齐**能暴露缺陷的**单元测试。只写 `tests/` 下的测试文件，不改任何源码（若测试暴露实现缺陷，报告缺陷而不是替 Max-1 修）。

## 覆盖清单

1. `tests/alarm-state.test.ts`（若 Max-1 已建则扩充，未建则新建）——`src/shared/alarm-state.ts` 的 `alarmStateOf`：
   - 双 null → pending；仅 ackAt → acked；仅 resolvedAt → cleared；两者都有 → **cleared 优先**（这是最容易写反的分支）
   - ALARM_STATE_LABEL 三键齐全
2. ack 链路 ackBy 记录（engine 层，纯 Node 可测）：
   - `AlarmEngine.ack(id, at, ackBy)` 后 alarm.ackAt === at 且 alarm.ackBy === ackBy
   - 不传 ackBy → ackBy === null（默认参数）
   - 重复 ack 第二次返回 false 且 ackBy 不被覆盖
   - DEVICE_NEW 事件型：ack 即 resolvedAt=ackAt → alarmStateOf 落 cleared
3. 持久化 roundtrip（JsonStore）：
   - 写入含 ackBy:'tester' 的 alarm → `setAlarmHistory` → 新 JsonStore 读回 ackBy === 'tester'
   - 写入**旧形状**（无 ackBy 字段）alarm → 读回 ackBy === null，且告警**不被丢弃**（数量守恒）
   - ackBy 为非 string（如数字 123）→ 读回 null（校验器规整）
4. 条件恢复流转（若引擎有可直测的 resolve 路径——如通过 evaluate 造条件消失场景）：pending → ack → 条件消失 → alarmStateOf === 'cleared' 且 ackAt/ackBy 保留。

## 写法要求

- 断言必须基于 plan.md 的状态机表格，不许为了通过而放宽。
- 定位真实导出名：读 implement-report.md 的"给 Tess 的清单"与 `src/main/engine/alarms.ts` / `src/shared/alarm-state.ts` 现状。
- 完成后 `npx vitest run` 全绿，报告写 `.agent-runs/2026-10-25/task-015/test-report.md`（用例清单 / 每条断言意图 / 全量运行结果 / 发现的缺陷如有）。回队长只发状态块。
