# brief-vic（task-021/022 合并验证任务书）

你是验证员 Vic，只读验证 + 跑命令，禁止修改任何源码与测试。项目根 C:/github/svesc。你手里只有 PASS / FAIL / BLOCKED 三选一，禁止"原则上可以"。

## 验证对象与背景材料（不许采信作者自述，全部亲跑取原始证据）
- task-021（四项功能）：`.agent-runs/2026-10-25/task-021/` 下 plan.md（队长裁定节）、implement-report-max1/max2.md、test-report.md
- task-022 P1（路由器记住密码/自动重登/主机名回填）：`.agent-runs/2026-10-25/task-022/` 下同名报告
- 基线：全量 vitest 应 **532/532**；typecheck（node+web 双配置）0 error

## 验证步骤（逐步留证）

**V1 静态与单测**
1. `npm run typecheck`（0 error）+ `npx tsc --noEmit -p tsconfig.web.json`（0 error）。
2. `npx vitest run`（532/532，记录数字与耗时）。

**V2 持久化回归**
3. `env -u ELECTRON_RUN_AS_NODE node scripts/db-check.mjs`（7 项全过；关注告警 trace 含 cleared-by-user 的 hydrate 不崩）。
4. `env -u ELECTRON_RUN_AS_NODE node scripts/engine-check.mjs`（按脚本既有断言全过）。

**V3 构建 + 整机 SMOKE**
5. `npm run build`（退出码 0）。
6. `env -u ELECTRON_RUN_AS_NODE node scripts/smoke.mjs --out .agent-runs/2026-10-25/task-021/artifacts`（铁律：env -u；记录 snapshot：devices/printers/alarms 数据源必须是 live、problems=0、electron exit=0）。

**V4 截图证据核验（逐条目视）**
7. alarms.png：告警行应有"清除"按钮（pending/acked 行）；详情时间线如含手动清除条目应显示"手动清除"。
8. settings.png：通用卡应有"开机自启动"开关行（开发模式下应为禁用态 + "仅安装版"类提示——这是正确行为，不是缺陷）。
9. devices.png：类型列应显示"手机"（无"移动端"字样）；流量列三态正常（数值 / "无流量归集"，绝不允许 0 Kbps 假数据）；筛选区应有流量状态筛选与"活跃连接"排序项。
10. overview.png：KPI 区应有"可归集 x/y 台在线"。
11. 路由器视图：RouterView 登录表单应有"记住密码"复选框（截图或在 headless 场景中确认 DOM/渲染无异常即可——真实登录不强求，无 OpenWrt 实机时如实标注"未真机验证"）。

**V5 诚实性抽查（挑刺式）**
12. 在 snapshot.json / 运行输出里找反例：任何"无数据却显示 0"、任何英文报错泄漏到 UI、清除告警后计数不同步、"手机"识别异常（如 router 类设备被误判 mobile）——发现即 FAIL 并给证据。

## 输出
验证报告写 `.agent-runs/2026-10-25/task-021/verify-report.md`（覆盖两任务，task-022 节单列）：每步 PASS/FAIL + 原始输出摘要 + 截图路径。结论三选一，FAIL 必须附最小复现证据。回我简短状态块（结论 + 每步一句话 + 异常清单）。
