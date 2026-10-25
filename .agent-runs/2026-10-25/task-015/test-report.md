# 测试报告 — 测试工程师 Tess（task-015）

| 字段 | 值 |
|---|---|
| 范围 | 仅 `tests/alarm-state.test.ts`（增补）；**未修改任何 `src/**`** |
| 命令 | `cd C:/github/svesc && npx vitest run` |
| 自验 | **26 文件 / 439 用例 / 439 通过 / 0 失败 / exit 0 / 6.15s**（Max-1 基线 435 + 增补 4） |
| 类型检查 | `tests/alarm-state.test.ts` 按 tsconfig.base 配置独立复跑 → **0 error**（含修复 3 处存量类型违规，见 §3） |
| 结论 | **PASS**。未发现实现缺陷；Max-1 的 9 条全部保留原样（含文案），本报告只增补 |

---

## 1. 增补用例清单（4 条）

按 brief 第 2-4 项通读 Max-1 的 9 条后查缺补位——以下四条是 brief 点名但 9 条未覆盖的：

| # | describe / 用例 | 断言意图 | 对应的失效模式（断言如何咬人） |
|---|---|---|---|
| 1 | ack 链路 / `不传 ackBy（默认参数）→ ackBy 为 null` | `engine.ack(id, at)` 两参调用后 `ackAt===at` 且 `ackBy===null` | 若实现把默认参数写成 `'未知用户'`（越权代劳 ipc 层职责——plan.md 明确"未知用户"是 ipc.ts 取 os username 失败时的兜底，引擎不得编造），`ackBy` 实得字符串 → 红 |
| 2 | ack 链路 / `DEVICE_NEW 事件型：ack 即 resolvedAt=ackAt → cleared 且不再计入活跃` | 用 `evaluate` 造真实 DEVICE_NEW（首轮做种、二轮新 MAC 触发）；ack 后 `alarmStateOf==='cleared'`、`resolvedAt===ackAt===ack 时刻`、`ackBy` 保留、移出活跃表、`counts().info===0` | 若实现漏掉事件型分支（ack 不写 resolvedAt）→ 状态实得 'acked' 红；若漏掉 `active.delete` → 活跃表/计数断言红；TTL 到期时间若被误写成 ack 时刻以外的值 → `toEqual` 红 |
| 3 | ackBy 持久化 / `ackBy 为非 string（数字 123）→ 读回 null，记录不丢` | 手写落盘状态文件（`ackBy: 123`），重开 store 后 `ackBy===null` 且 `toHaveLength(1)` | 若校验器没有 `typeof a.ackBy === 'string'` 规整（直接透传）→ `ackBy` 实得 123 红；若校验器把类型不符的记录整个丢掉 → 数量断言红 |
| 4 | 条件恢复流转 / `pending → ack → 条件消失 → cleared，ackAt/ackBy 保留` | NET_QUALITY 真实造警（poor 连续 2 轮，samples≥8 过置信门）→ `pending`；ack（ackBy:'tester'）→ `acked`；条件恢复（grade 回 excellent）→ 引擎 resolve 路径自动收尾 → `cleared`；**`{ackAt, ackBy, resolvedAt}` 三项一次 toEqual** | 若 resolve 路径把 ackAt/ackBy 一并清零（"清除就全清"是常见错误写法——历史将无法追溯"谁在何时确认过"）→ `toEqual` 红；若 cleared 判定被写反（ackAt!==null 优先于 resolvedAt）→ `alarmStateOf` 红 |

**可直测说明**：brief 第 4 项"若引擎有可直测的 resolve 路径"——有。`AlarmEngine.evaluate` 是纯注入式（devices/printers 由调用方给），NET_QUALITY 的 raise 与 resolve 都在 evaluate 内，无需起 scheduler 或网络，故第 4 条用 evaluate 直测了完整流转。

## 2. 未重建、未改动的部分（Max-1 的 9 条）

`alarmStateOf` 四分支 + 标签表、store roundtrip 两条（'tester' 保真 / 旧形状无 ackBy → null 不丢）、hydrate 迁移、ack 落账 + 重复 ack 拒绝——全部保留原断言与文案。查缺时确认它们已覆盖 brief 第 1 项全部与第 2/3 项的其余子项。

## 3. 顺带修复的 3 处存量类型违规（不改断言语义）

独立 tsc（按 tsconfig.base 的 strict 配置直查测试文件）暴露了 3 处存量问题——Max-1 自检用的 `-p tsconfig.node.json` 只 include `src/**`，测试文件从未被 tsc 扫过：

| 位置 | 问题 | 修法 |
|---|---|---|
| import 区 | 我增补时从 fixtures 引入 `T0` 与文件内本地 `const T0` 重名（TS2440） | 去掉 import 的 `T0`（本地值相同，都是 `1_700_000_000_000`） |
| 三处 `reopened.state.alarms` | 访问 `JsonStore` 的 private `state`（TS2341）——vitest/esbuild 不查所以测试能跑，但类型上是违规 | 改走公开 API `reopened.get().alarms` |
| `alarm() as Record<string, unknown>` | TS2352（Alarm 与 Record 索引签名不重叠） | `as unknown as Record<string, unknown>` 双段断言 |

**断言零改动**：三处修的都是"怎么读"，不是"读什么、比什么"。

## 4. 运行输出摘要

```
 RUN  v3.2.7 C:/github/svesc
 ✓ tests/alarm-state.test.ts (13 tests) 719ms   ← Max-1 的 9 条 + Tess 增补 4 条
   （其余 25 个文件全绿）
 Test Files  26 passed (26)
      Tests  439 passed (439)
   Duration  6.15s
```

`tsc`（tests/alarm-state.test.ts 独立 strict 检查）→ 0 error。

## 5. 发现的缺陷

无实现缺陷。四条增补全部一次转绿（前提是修复了我自己编辑时误吞 describe 开头的结构错误，见 §6 踩坑）——Max-1 的实现与 plan.md 状态机表逐条吻合：默认参数 null ✅、事件型 ack 即收尾 ✅、非 string 规整 ✅、resolve 不碰 ack 记录 ✅。

## 6. 踩坑记录

用 Edit 批量插入时 old_string 匹配到了"上一 describe 的收尾 `}` + 下一 describe 的开头"，新文本里漏带了 `describe('AlarmEngine.hydrate 的 ackBy 迁移', () => {` 这一行，导致两个 `it` 被甩到 describe 外（vitest 容忍但结构已坏）。靠通读文件尾段发现并补回。教训：**跨结构边界的 old_string 必须在 new_string 里完整重建两侧边界**，编辑后对被插入点两侧各读一次。
