# task-015 实现报告（Max-1）

日期：2026-10-25 · 实现者：实现工程师 Max-1 · 权威规格：`plan.md`（冻结三态状态机）+ `brief-max1.md`

## CHANGED_FILES（10 个）

| 文件 | 改动一句话 |
|---|---|
| `src/shared/types.ts` | `Alarm` 加必填字段 `ackBy: string \| null`（ackAt 与 resolvedAt 之间，注释注明"主进程注入、渲染层不可伪造；null=未确认或升级前旧数据"） |
| `src/shared/alarm-state.ts` | **新建**：`alarmStateOf(alarm)` 三态判定 + `ALARM_STATE_LABEL` 文案表——引擎/渲染层/测试三方共用的唯一判定源（cleared 不可逆语义写入头注释） |
| `src/main/engine/alarms.ts` | `ack()` 第三参 `ackBy`，与 ackAt 一起落账；`raise` 字面量补 `ackBy: null`；`hydrate` 循环内 `alarm.ackBy ?? null` 迁移规整（store 校验器之外的直喂路径兜底） |
| `src/main/engine/scheduler.ts` | `ackAlarm(alarmId, ackBy?)` 透传 `Date.now()` 与 `ackBy ?? null` 给 `alarms.ack` |
| `src/main/engine/index.ts` | `Engine.ackAlarm` 接口与实现均加 `ackBy?: string \| null` 透传 |
| `src/main/engine/store.ts` | alarms 持久化校验器在 filter 后 `.map` 规整 `ackBy: typeof a.ackBy === 'string' ? a.ackBy : null`——旧落盘数据缺字段 → null，**绝不因校验丢弃旧告警** |
| `src/main/ipc.ts` | `import os from 'node:os'`；ackAlarm handler 内主进程注入 `os.userInfo().username`（空串/异常兜底 `'未知用户'`），渲染层签名 `LanApi.ackAlarm(alarmId)` 不变、preload 未动 |
| `src/renderer/views/AlarmsView.tsx` | 筛选重构为四段（`pending` 默认=pending+acked / `acked` / `cleared` / `all`，segmented 带计数）；判定全部走 `alarmStateOf`（删除本地 `statusOf`）；行内三态徽标（pending→warn/acked→muted/cleared→ok）；确认按钮只在 pending 渲染；每行"详情"展开（`expandedId` 单开、切筛选重置、aria-expanded），展开区复用既有 `card/dl/mono/dim/chip` 类显示 message/detail/触发/确认时间+确认人/清除时间/目标/code；空态文案按筛选分流；view-desc 与 meta 换三态口径（"待处理 N · 全部 M"） |
| `tests/alarm-state.test.ts` | **新建** 9 条：三态全分支（双 null/仅 ackAt/仅 resolvedAt/双有 cleared 优先）+ 标签表；store roundtrip（ackBy:'tester' 保真、旧形状规整为 null 不丢记录）；hydrate 直喂旧数据迁移；ack 落账与重复 ack 拒绝 |
| `tests/alarms.test.ts` | 两处 Alarm 字面量补 `ackBy: null`（字段必填后 tsc 必需） |

## 与规格的偏差（3 处，均已尽量收敛）

1. **chevron 图标**：brief 要求"chevron 图标"，但 `Icon.tsx` 不在允许改动清单且图标集中没有 chevron。用文本字符 `▸/▾`（aria-hidden）实现同视觉，未新增 CSS、未碰 Icon.tsx。
2. **tests/alarm-state.test.ts 的归属**：`plan.md` 阶段表把它派给 Tess，`brief-max1.md` §9 把它派给我。按我的任务书已创建（9 条），并已同步 Tess 请她在此基础上增补而非重建，避免同文件双写。
3. **详情区"确认时间/确认人"的渲染口径**：brief 写"acked 才有；pending 显示'未确认'"。实现为 `ackAt !== null` 显示时间+确认人（`ackBy ?? '未知用户'`），否则显示"未确认 / —"——即 cleared-但从未确认的告警同样诚实显示"未确认"（不编造确认记录）。

## 自检命令输出摘要

```
npx tsc --noEmit -p tsconfig.node.json   → 0 error
npx tsc --noEmit -p tsconfig.web.json    → 0 error
npx vitest run                           → 26 文件 / 435 用例全绿（本任务新增 9 条）
npm run build                            → 0 error
```

未 commit（按任务书要求）。

## 已知边界

- `ackBy` 必填后，任何绕过 store 校验器与 hydrate 迁移、直接构造 Alarm 的代码需自带该字段（全仓已核对：引擎 1 处 raise 字面量 + 测试 3 处，均已补）。
- 确认按钮从"disabled"改为"不渲染"（brief 明确该选择更清晰）；批量确认在 acked/cleared 视图下自然为 0 条禁用。
