# Brief — 测试工程师 Tess 追加（task-002，等 Max-1 caps 修复落地后执行）

**触发条件**：Max-1 完成 `src/main/engine/router/index.ts` 的 caps.openwrt 解耦修复（队长裁决 D-017：能力正交于会话，进程内只置 true 不置 false）。

**背景**：你在 `tests/router-manager.test.ts` 用例②把"下轮 caps.openwrt===false"锁成了断言（当时依据是我转述的"既有设计"）。我随后重新定性：那是疏漏不是设计——会话过期/登出后 UI 会把支持 OpenWrt 的路由器显示为"该路由器不支持"，违反数据诚实原则。Max-1 修复后行为变更：caps.openwrt 在失效当轮**及后续所有轮次**保持 true。

## 任务（只改 `tests/router-manager.test.ts`）

1. 用例②的"下轮 ===false"断言改为"下轮**仍为 true**"——理由写进注释：能力（协议支持）与会话（登录态）正交，UI 的 CapRow note 分支（"已登录/登录后可查看"）负责表达会话维度；caps 不得撒谎。
2. 新增一条：`logout()` 后连续两轮 `refresh()` → `capabilities.openwrt` 仍为 true，且 `session.loggedIn === false`。
3. 复核用例③/④与新行为无冲突（瞬时故障不清会话、重新 login 出数——不变）。

## 完成判据

- `npx vitest run` 全量绿（377 ± 你的改动，0 失败）。
- test-report.md 补一节"caps 解耦后的断言更新"（含为什么这是随设计裁决升级的断言更新、不是放宽）。
- 最终回复只回状态块。

**注意**：若 Max-1 尚未报告完成，等他完成后再动（他改 src 你改 tests，无文件冲突，但断言目标以实现落地后的行为为准）。
