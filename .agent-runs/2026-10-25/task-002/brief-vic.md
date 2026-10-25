# Brief — 验证员 Vic（task-002 Phase 4）

**任务**：独立验证 task-002 三条边界修复。**你是第一道独立验证——不许采信 Max-1 的自查结论**，全部命令亲自跑，输出原始证据。项目：C:/github/svesc。

**待验证实现**（Max-1 报告 `.agent-runs/2026-10-25/task-002/implement-report.md`，测试报告 Tess 产出 `test-report.md`）：
- B-1：exec.ts sweepTree 开关（只对 runPowerShell 开）；scheduler.ts ports/hostnames/arp2 接入 deadline；engine-check 断言从 SCAN_BUDGET_MS 常量推导 + 2 条 Tripwire；check.ts 导出 SCAN_BUDGET_MS 且扫描前补两次带宽采样。
- B-2：openwrt.ts UBUS_NULL_SESSION（32 位零）login；ubusErrorMessage 语境化；新增 tests/router-ubus-e2e.test.ts（node:http 严格假 ubus，真实全链路）。
- B-3：router-store.ts 异步 safeStorage；ipc.ts / index.ts 两处 await。

## 验证清单（逐项给证据）

1. **全量测试**：`npx vitest run` → 记录文件数/用例数/失败数。任何红都要定位到 file:line 并判断是实现缺陷还是替身问题（**不许**顺手改任何文件，只报告）。
2. **类型与构建**：`npx tsc --noEmit -p tsconfig.node.json`、`npx tsc --noEmit -p tsconfig.web.json`、`npm run build` → 全部 0 error。
3. **engine-check 稳定性（B-1 核心）**：`node scripts/engine-check.mjs` **连跑 3 次**，记录每次 total 与主断言/两条 Tripwire 结果。判据：3/3 主断言 PASS 且 total 均 < SCAN_BUDGET_MS+2500；devices/printers 断言不回归（~19-23 设备 / 8 打印机 / PRINTER_OFFLINE 仍在）。若任一 FAIL：**调查根因**，不许归因为"网络波动"了事。
4. **断言推导核实**：读 `scripts/engine-check.mjs` 确认主断言由 `mod.SCAN_BUDGET_MS` 推导（无硬编码 12000/12500），Tripwire 仅打印不计退出码。
5. **smoke 全链路（B-3 运行时证据）**：`npm run smoke` → exit 0；截图 6 张齐全含 router.png；devices/printers 数不回归。**重点：stderr 不得再出现 `safeStorage.isEncryptionAvailable is deprecated` 警告**（B-3 修复的直接证据；若仍在，说明迁移不彻底——即使测试全绿也要报 FAIL）。
6. **B-3 静态核实**：`grep -rn "isEncryptionAvailable\|encryptString(\|decryptString(" src/` 只应命中异步 API（isAsyncEncryptionAvailable / encryptStringAsync / decryptStringAsync）；确认 router-store.ts 的 shouldReEncrypt 重存逻辑存在且 clearCredentials 仍同步。
7. **B-2 e2e 真实性核实**：读 tests/router-ubus-e2e.test.ts 确认 ①用 `listen(0)` 随机端口 ②`new UbusClient('127.0.0.1:'+...)` ③覆盖 brief 的 11 条边界（对照 brief-tess.md）④无 wall-clock 时序断言（超时用例用服务器 delay + 客户端常量）。**抽查复跑**：`npx vitest run tests/router-ubus-e2e.test.ts` 单独跑一次确认稳定。
8. **R-05 回归红线**：`npx vitest run tests/exec-fallback.test.ts` 4/4 绿；读 exec.ts 确认超时路径仍立即 settle 且 sweepTree 只对 runPowerShell 开（grep sweepTree）。
9. **fixes-check.mjs 评估**（Max 授权清单外新建的脚本）：跑 `node scripts/fixes-check.mjs`；判断其 36 条断言是否真实有效（抽查 3 条改坏实现能否被抓到——**只许临时改、跑完立即还原**，或从断言文本论证），在报告中给出"保留/迁移进 tests//删除"建议。
10. **诚实性抽查**：engine-check 产出的 snapshot.json 里 `system.rxBps/txBps` 有真实数值；`snapshot.warnings` 无假告警（应为 [] 或合理降级文案）。

## 输出

- 报告写入 `.agent-runs/2026-10-25/task-002/verify-report.md`：每项 = 命令 + 原始输出摘要 + PASS/FAIL/BLOCKED 结论。
- 最终裁决只允许三选一：**PASS / FAIL / BLOCKED**，禁止"原则上可以"。
- FAIL 时给出最小修复建议（指出 file:line 与改法方向，不亲自改）。
- 最终回复只回状态块：VERDICT / 报告路径 / 各项一行结论。禁倒过程日志。