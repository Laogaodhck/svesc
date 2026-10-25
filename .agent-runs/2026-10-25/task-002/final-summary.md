# FINAL STATUS — task-002：三条已知边界闭环

**日期**：2026-10-25 ｜ **模式**：团队流水线（Vera-2 → Max-1 → Tess → Vic-2 → Ray-2；中途 Max-1/Tess 各因上游 400 超时失败一次，清理批由队长按降级预案亲自完成）

## ✅ VERIFICATION（终态，全部亲自复跑）

| 验证项 | 结果 |
|---|---|
| `npx vitest run` | **20 文件 / 384 用例 / 384 全绿**（378 基数 + exec-real 真进程 6 条） |
| `tsc --noEmit` 双配置 | node 0 error / web 0 error |
| `node scripts/engine-check.mjs` | 主断言 PASS，total 7636ms ≤ 12500（预算+2.5s，常量推导）；devices 22 / printers 8 / PRINTER_OFFLINE 照常 |
| `npm run smoke` | **exit 0，problems=0**：20 设备 / 8 打印机 / 6 截图齐全；**stderr 无 safeStorage 弃用警告**（B-3 运行时证据） |
| Vic-2 独立验证 | **PASS 12/12**（含破坏-还原实验：移除清会话→红、caps 回退→红，sha256 校验还原干净） |
| Ray-2 审查 | **APPROVE-WITH-NITS**，critical/high 0 |

## 三条边界闭环

- **B-1 扫描耗时断言抖动**：根因是 exec.ts 对每个强杀进程都 spawn taskkill 造成进程创建拥塞正反馈（Vera 受控实验：ping 5.5s→10s），arp2/ports/hostnames 又无预算保护。修复：sweepTree 只对 PowerShell 开；三阶段全部接入 deadline；断言从 SCAN_BUDGET_MS 常量推导+2 条 Tripwire。**实测 total 19~22s（必 FAIL）→ 7.5~10s（稳定 PASS）**。
- **B-2 ubus 登录真 bug**：login sid 用了字面量 'session'，真实 OpenWrt（uhttpd 源码+官方文档+论坛三重证据）只接受 32 位零 null-session，真机必返 -32002。修复 + 错误码语境化 + 新增 tests/router-ubus-e2e.test.ts（node:http 严格假 ubus，真实全链路 12 用例）。
- **B-3 safeStorage 弃用**：迁移 isAsyncEncryptionAvailable/encryptStringAsync/decryptStringAsync（46 将移除同步 API）；密文跨版本兼容，用户无需重登；smoke 运行时零弃用警告。

## 期间追加修复（测试逼出的真缺陷）

- **D-011~013**：call 语境 -32002 自清会话（sessionInvalid）+ RouterManager loggedIn 不撒谎 + 失效原因 surfaced 到 UI（RouterView 渲染 session.error）。
- **D-017**：caps.openwrt 解耦登录态（粘性能力位，只进不退）；caps.managementPage 同族修复（L6）。
- **审查清理批**（队长执行）：M1 fixes-check.mjs 拆分（R-05 九条真进程断言迁入 tests/exec-real.test.ts，其余 27 条删除，孤儿脚本删除）；M2 非 -32002 调用失败汇入 capabilityNotes；L1 重复残留删除；L3 早退瞬态；L5 文档化；L7 文档漂移；N1 死变量；N3 0o600 落盘；N4 防御 catch；N5 前瞻注释。

## 📁 CHANGED_FILES（task-002）

```
src/main/engine/exec.ts            sweepTree 开关（B-1 风暴治理）
src/main/engine/scheduler.ts       arp2/ports/hostnames 接入 deadline；WarningLog 导出；L1 清理
src/main/engine/check.ts           SCAN_BUDGET_MS 导出；带宽采样
scripts/engine-check.mjs           断言常量推导 + Tripwire
src/main/engine/router/openwrt.ts  UBUS_NULL_SESSION；语境化文案；sessionInvalid
src/main/engine/router/index.ts    粘性能力位；call+parse；session.error；L3/L6/M2/N4
src/main/router-store.ts           safeStorage 异步迁移；0o600
src/main/ipc.ts / src/main/index.ts 两处 await
src/renderer/views/RouterView.tsx  session.error 渲染；N1
src/shared/types.ts                契约注释更新
ARCHITECTURE.md                    §7/§8/§10.2 同步
tests/                             +router-ubus-e2e(12) +router-manager(9) +exec-real(6)；改 2 文件
删除 scripts/fixes-check.mjs
```

## ⚠️ KNOWN_ISSUES（登记 task-003 backlog）

- **M3**：runFullScan ~158 行/圈复杂度 ~20，建议抽 phase 函数（重构 backlog）。
- **L4**：logout 与在途 doRefresh 交叠，status 写回有 ≤1 轮瞬态残留（世代号方案）。
- 假 ubus 是形状复刻而非完整 ACL 语义（文件头已声明）；真机 OpenWrt 端到端 login→board 仍建议手验一次。
- engine-check 主断言为"预算+2.5s"口径，改 SCAN_BUDGET_MS 时断言自动联动（常量推导）。

## 📂 REPORTS

`plan.md`（含 D-011~D-017 决策记录）｜ `investigation-report.md` ｜ `implement-report.md` ｜ `test-report.md` ｜ `verify-report.md` ｜ `review-report.md` ｜ artifacts：engine-run1/2.json（修复前 FAIL 证据）+ 本目录 task-001 artifacts（smoke 六图）
