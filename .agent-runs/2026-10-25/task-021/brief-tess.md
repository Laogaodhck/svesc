# brief-tess（task-021 测试任务书）

你是测试工程师 Tess，只写测试文件（tests/**），禁止改任何源码。项目根 C:/github/svesc。

先读两份实现报告（你要测的就是它们描述的行为）：
- `.agent-runs/2026-10-25/task-021/implement-report-max1.md`（引擎/主进程/契约）
- `.agent-runs/2026-10-25/task-021/implement-report-max2.md`（渲染层，无测试覆盖，仅作背景）
- 断言依据：`.agent-runs/2026-10-25/task-021/plan.md` 的"队长裁定"节。

**任务：为 task-021 的引擎层改动补齐测试**（渲染层无测试基建，由 Vic 的 SMOKE 覆盖）。用能暴露缺陷的断言，不是为通过而写。

═══ 覆盖清单 ═══

**1. alarms 清除机制（tests/alarms.test.ts 增补）**
- clear(id, by)：成功置 resolvedAt、trace 记 'cleared-by-user'（含操作人）、active 移除、返回 true。
- 幂等/防御：重复 clear 同一条返回 false；clear 不存在的 id 返回 false；已 cleared 的返回 false。
- clearMany(ids, by)：混合成功/失败返回成功数；全失败返回 0。
- **冷静期（最关键，"清了又弹"缺陷防线）**：
  - 手动清除后，条件仍满足 → 下一轮 evaluate **完全不产生**告警（不新建、不重开旧记录、occurrences 不变、无推送）——窗口内（10 分钟）静默。
  - 窗口过后条件仍满足 → 产生**全新告警**（新 id、独立 trace），而非复活旧记录。
  - 冷静期与抑制窗口共存：清除前有旧告警、窗口内再触发，不得走抑制窗口的"合并重开"路径（断言旧记录 resolvedAt 不变、trace 无 re-raised）。
- trace 审计：clear 的 trace 条目含 cleared-by-user 类型与 by；与 ack 的 trace 共存顺序正确。
- 参照既有用例风格（alarmState 驱动 evaluate：readArp/ping mock 等，同文件现成范式）。

**2. alarm-state（tests/alarm-state.test.ts 增补，如适用）**
- cleared 判定对手动清除天然成立（resolvedAt!==null）；如有状态推导纯函数，补 cleared-by-user 相关分支。

**3. fingerprint 手机识别（tests/fingerprint.test.ts 增补）**
- 新正则每条正反样例：oneplus/realme/nokia/zenfone/huawei/sm-G991B（三星机型）→ mobile；**误伤面反例必须有**：如 "motorola-router"（禁 moto 泛匹配的回归锁）、"sm-office"（sm-[a-z]\d{3} 不该命中无数字词）、正常 PC 名（desktop-01）不受影响。
- 主机名命中 mobile 时 osHint === '手机（主机名特征）'（不再为 null）。
- 既有通道回归：62078 端口、mdnsKind=mobile 优先级不变（G6 用例仍绿）。

**4. settings（如 store/ipc 纯函数可测的部分；store 未动则说明无需新增）**
- 若实现抽了可测纯函数（如 settingsGet 注入逻辑），按实际导出补；没有就跳过并在报告说明。

═══ 完成标准 ═══
- `npx vitest run` 全绿（基线 503 只增不减）；报告写入 `.agent-runs/2026-10-25/task-021/test-report.md`：新增用例清单（文件+用例名+断言意图）、跑数结果、发现的缺陷（如有——直接报我，不许自己改源码）。
- 回我简短状态块。
