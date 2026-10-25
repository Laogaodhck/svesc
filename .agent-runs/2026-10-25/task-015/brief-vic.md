# brief-vic.md — 验证员 Vic 任务书（task-015）

项目根：`C:/github/svesc`。任务：独立验证 task-015（告警三态管理）交付。**不许采信任何实现者/测试者自述，全部亲自跑，输出原始证据。**

## 背景材料（理解意图用，不作证据）

`.agent-runs/2026-10-25/task-015/plan.md`、`implement-report.md`、`test-report.md`

## 验证清单（逐项判定，证据落盘）

1. **单测**：`npx vitest run` —— 记录总数与通过数；特别确认 tests/alarm-state.test.ts 存在且覆盖 cleared 优先分支。
2. **类型**：`npx tsc --noEmit -p tsconfig.node.json` 与 `-p tsconfig.web.json` —— 零错误。
3. **构建**：`npm run build` —— 成功。
4. **SMOKE**：`env -u ELECTRON_RUN_AS_NODE SMOKE=1 npx electron .` —— JSON 断言 ok:true，errors 空，八页截图齐全。
5. **功能证据（SMOKE 截图人工级检查）**：
   - 告警页截图（`/.agent-runs/2026-10-25/task-001/artifacts/alarms.png`）：确认 segmented 四项筛选（待处理/已确认/已清除/全部）渲染、默认落在"待处理"、已清除告警默认不可见。
   - 展开一条告警详情：验证展开区含触发时间/确认时间/确认人/清除时间字段（若 SMOKE 截图不含展开态，用 executeJavaScript 驱动 UI 或如实报告"展开态无法无头验证"——不许编造）。
6. **数据诚实抽查**：读 `src/renderer/views/AlarmsView.tsx` 现状——确认状态判定 import 自 `src/shared/alarm-state.ts`（判定不分叉）；确认"已清除"视图下确认按钮不渲染；确认 ackBy null 显示"未知用户"而非编造。

## 环境注意事项（前任验证员实测，务必遵守）

- **必须 `env -u ELECTRON_RUN_AS_NODE`** 跑 electron（宿主注入该变量会让 Electron 变纯 Node 模式，SMOKE 秒崩 app undefined）。
- 环境安全层禁止批量删除目录：**不要**删除任何 release*/win-unpacked 目录，不要跑清理脚本。
- 打包（electron-builder）不在本次验证范围，不要跑。

## 结论

PASS / FAIL / BLOCKED 三选一，报告写 `.agent-runs/2026-10-25/task-015/verify-report.md`（每项：命令 + 原始输出摘要 + 判定）。回队长只发状态块。
