# task-002 独立验证报告（验证员 Vic-2）

日期：2026-10-25
验证人：Vic-2（独立验证，**未修改任何 src/tests 文件**；item 9 的破坏实验为授权范围内的"临时改→立即还原"，还原前后均以 sha256 校验干净）
判据来源：`.agent-runs/2026-10-25/task-002/plan.md`（B-1/B-2/B-3 + D-011~D-017）+ 队长验证清单 12 项
**不采信任何实现者/测试者自查结论，以下全部为本人亲自跑的原始证据。**

---

## 0. 最终裁决

# **PASS**

12 项验证全部通过；两条破坏-还原实验证明关键断言"会咬人"且还原干净；无 FAIL/BLOCKED 项。

---

## 1. `npx vitest run` 全量测试

```
 RUN  v3.2.7 c:/github/svesc
 ✓ tests/router-ubus-e2e.test.ts (12 tests) 2695ms
 ✓ tests/router-manager.test.ts (9 tests) 28ms
 ✓ tests/scheduler-resilience.test.ts (37 tests) 139ms
 ✓ tests/router-openwrt.test.ts (19 tests) 20ms
 ✓ （其余 15 个文件全绿：fingerprint 13 / snmp-ber 34 / printer-mib 59 / quality 33 /
    alarms 38 / exec-fallback 4 / printer-service 19 / arp 18 / router-upnp 12 /
    bandwidth 15 / ping 16 / oui 14 / subnet 12 / router-detect 5 / scheduler 9）
 Test Files  19 passed (19)
      Tests  378 passed (378)
   Duration  4.25s
```

**19 文件 / 378 用例 / 0 失败 / exit 0。无红，无 file:line 需要定位。**

## 2. 类型检查与构建

```
npx tsc --noEmit -p tsconfig.node.json   → 0 error（exit 0，无任何输出）
npx tsc --noEmit -p tsconfig.web.json    → 0 error（exit 0，无任何输出）
npm run build                            → exit 0
  vite v7.3.7 ✓ 57 modules transformed，dist/renderer/index.html 0.42kB
  build:main   dist/main/index.cjs 170.5kb
  build:preload dist/main/preload.cjs 2.1kb
```

三项全部 0 error。

## 3. `node scripts/engine-check.mjs` 连跑 3 次（判据 3/3 PASS）

| 轮次 | 扫描合计 | 主断言 ≤12500 | ping ≤11500 | hostnames ≤1600 | devices | printers | PRINTER_OFFLINE | exit |
|---|---|---|---|---|---|---|---|---|
| run1 | 9378ms | **PASS** | 7692 PASS | 29 PASS | 25 | 8 | **PASS**（MF750C Series） | 0 |
| run2 | 10000ms | **PASS** | 8832 PASS | 27 PASS | 21 | 8 | **PASS**（MF750C Series） | 0 |
| run3 | 9393ms | **PASS** | 8250 PASS | 38 PASS | 21 | 8 | **PASS**（MF750C Series） | 0 |

**3/3 PASS。** total（9378/10000/9393）均 < SCAN_BUDGET_MS+2500 = 12500，余量 >2.5s。
不回归确认：devices 21~25（task-001 修复前基线 22~23；波动来自真实局域网在线主机增减，均 >0）；printers 8 台恒定；PRINTER_OFFLINE（MF750C Series）三次均产生；dataSource=live。
根因说明（非"网络波动"结案）：B-1 修复前 arp2/ports/hostnames 三阶段无预算保护（机制最坏 ~30s vs 断言线 12s，必抖）；修复后 arp2 从 8.9~11.1s 降到 122~263ms、ping 从 10s+ 降到 7.7~8.8s，预算机制真实生效。三次运行均在预算内收敛，是机制性修复而非运气。

## 4. `scripts/engine-check.mjs` 断言口径（代码级证据）

- `engine-check.mjs:112`：`const budget = mod.SCAN_BUDGET_MS ?? 10_000;`——主断言线由引擎常量推导（`src/shared/constants.ts:57` `SCAN_BUDGET_MS = 10000`，`check.ts:83`  re-export）；`10_000` 仅是导出缺失时的防御性兜底。
- `engine-check.mjs:130`：`assert('扫描 ≤ 预算+2.5s', timings?.total ?? +Inf, budget + 2500)`。全文件 grep 无硬编码 `12000`/`12500`。
- `engine-check.mjs:131-132`：两条 Tripwire（`ping ≤ 预算+1.5s`、`hostnames ≤ 1.6s`）只打印 PASS/FAIL；`:144` 退出码计算 `checks.filter((c) => !c.pass && !c.tripwire)` 显式排除 tripwire——**只打印不计退出码，符合要求**。

## 5. `npm run smoke`

```
npm run smoke -- --out .agent-runs/2026-10-25/task-002/artifacts --timeout 90000
→ electron exit=0 timedOut=false problems=0，smoke-exit=0
[smoke] snapshot: devices=22 printers=8 alarms=3 dataSource=live
截图完整性：overview 113049B / devices 130557B / detail 150101B /
           printers 109333B / alarms 72938B / router 84857B —— 6/6 OK（含 router.png）
```

- **stderr 重点核查：无 `safeStorage.isEncryptionAvailable is deprecated`。** 子进程合并输出中仅有一条 Electron CSP info 警告（renderer 控制台，与 safeStorage 无关），无任何 deprecated 字样；无 UnhandledPromiseRejection/uncaughtException。
- 附带加固证据：对构建产物 `dist/main/index.cjs` grep 同步 API（`isEncryptionAvailable|encryptString\b|decryptString\b`）→ **0 处命中**（B-3 在运行态同样干净）。
- devices=22 / printers=8 与 task-001 基线一致，不回归。

## 6. `grep -rn "isEncryptionAvailable\|encryptString(\|decryptString(" src/`

唯一命中：`src/main/router-store.ts:9`——**注释**（声明本文件只使用异步 API）。无任何同步 API 调用点。
实际使用均为异步 API：`isAsyncEncryptionAvailable()`（:32）、`encryptStringAsync(...)`（:47）、`decryptStringAsync(...).result`（:63），密文 base64 落盘格式未变。

## 7. ubus e2e 真实性

代码级确认（`tests/router-ubus-e2e.test.ts`）：
- `:191` `server.listen(0, '127.0.0.1', ...)`——随机端口；`:209` `new UbusClient(\`127.0.0.1:${port}\`)`——真实 defaultTransport → httpx → node:http 全链路，非注入。
- 假服务器严格复刻 uhttpd 门禁：login 只认 32 位零 null-session（:140）、非 login 的 sid 必须已下发（:155）、错密码 -32002、未知方法 -32000、权限拒绝 `result:[6,{}]`。
- 边界覆盖 11 条（①login sid/令牌 → ②错密码 → ③会话撤销+③-反 500/权限拒绝不清会话 → ④非 200 → ⑤非 JSON → ⑥-32000 → ⑦权限拒绝 → ⑧并发乱序集合语义 → ⑨超时 → ⑩auth-required 短路 → ⑪传输层回归网）。

稳定性实测：单独跑该文件 **5 次，每次 12/12 通过，0 红**。曾经的抖动用例⑧（并发 id 断言）现为集合语义（`:369-377` 排序后等于 '2,3,4'、unique、连续、恰好 3 个），5/5 稳定。

## 8. R-05 红线

- `npx vitest run tests/exec-fallback.test.ts` → **4/4 通过**（exit 0）。
- `src/main/engine/exec.ts` 代码确认：
  - 超时**立即 settle**：`:177-185` setTimeout 内 `child.kill()` 后直接 `finish(null)`，不押注 close 派发；`settled` 标志保证迟到 close 被忽略（幂等）。
  - sweepTree 仅 runPowerShell 开：`:196` close 收尾 `if (timedOut && opts.sweepTree) sweepTreeByPid(...)`；`:223` 仅 `runPowerShell` 传 `{ sweepTree: true }`；`runGbkNative`（:205-207）与其余 runNative 调用点均不传（默认关）。
- 旁证：`scripts/fixes-check.mjs` 的 R-05 真机断言（真实 spawn ping 强杀）实测 428ms 内 settle、闸门归零、无 taskkill 延迟，与代码语义互相印证。

## 9. D-011/D-012/D-017 测试有效性抽查（破坏-还原实验）

基线：`sha256sum` 记录两文件哈希；两个目标文件先跑 **28/28 绿**。

### 实验 A：sessionInvalid（tests/router-openwrt.test.ts）

选用用例：`调用路径 -32002 → sessionInvalid=true 且会话当场作废`（:239-248）。
破坏：临时将 `src/main/engine/router/openwrt.ts` raw() 两处 `if (sessionInvalid) this.session = null;` 改为 `if (false && sessionInvalid) ...`（模拟"实现回退：不清会话"）。

```
× 调用路径 -32002 → sessionInvalid=true 且会话当场作废
  AssertionError: expected { ok: false, …(3) } to deeply equal { ok: false, …(3) }
-   "loggedIn": false,
+   "loggedIn": true,
× 作废后再 call → auth-required 且不再发请求（不得拿死 sid 重试）
  （19 tests | 2 failed）
```

**断言咬人**：回退即红（loggedIn 实得 true）。还原后 `sha256sum -c` 两文件均 **OK**，复跑 **19/19 绿**。

### 实验 B：caps 粘性 D-017（tests/router-manager.test.ts）

选用用例：`失效之后的下一轮 refresh：错误消息必须持续，且不得再拿死 sid 发请求` 的 caps 断言（:176）。
破坏：临时将 `src/main/engine/router/index.ts:193` 的 `caps.openwrt = this.openwrtCapable || identity.brand === 'openwrt' || (this.ubus !== null && this.ubus.loggedIn)` 改回 D-017 前的旧设计 `caps.openwrt = this.ubus !== null && this.ubus.loggedIn`。

```
× 失效之后的下一轮 refresh：错误消息必须持续，且不得再拿死 sid 发请求
  → 会话过期后 caps.openwrt 必须保持 true：能力位粘性，只进不退: expected false to be true
× logout() 后连续两轮 refresh：caps.openwrt 粘性保持 true，session.loggedIn 为 false
  （9 tests | 2 failed）
```

**断言咬人**：回退即红（且当轮断言 :154 不受影响，双向锁定精确）。还原后 `sha256sum -c` 两文件均 **OK**，复跑 **28/28 绿**。

还原结论：两个临时破坏均已还原，哈希与基线逐字节一致，复跑全绿——**仓库当前状态干净，无我引入的残留**。

## 10. `node scripts/fixes-check.mjs` 质量与归属评估

运行结果：**36/36 PASS，exit 0**（R-06×8 / R-02×6 / R-03×8 / R-04×5 / R-05×9）。

**断言真实性评估：真实有效，无空转。** 抽样核实：
- R-06 用注入时钟（`Date.now` 替换）+ 真实 `Scheduler.buildSnapshot()`，三轮宽限明细 `[{round:1,streak:1,online},{round:2,streak:2,online},{round:3,streak:3,offline}]`，首次离线 180000ms——状态机真实被驱动。
- R-05 真实 spawn `ping -n 30` 强杀（428ms settle）、真实 `runPowerShell('Start-Sleep -Seconds 60', 600)` 超时后单飞闸门归零——真进程证据。
- R-02/R-03 驱动真实 `sampleBandwidth`/`WarningLog`/`replaceWarnings`，断言 null 语义与 warning 生命周期。

**归属问题（对应 D-015，Max-1 授权清单外产物）**：
1. **孤儿脚本**：`package.json` 无任何接线，全仓 grep `fixes-check` 零引用（无 npm script、无 CI、无文档）。不在 vitest 矩阵内 → 会随引擎演进而静默腐烂，届时比没有更糟（假的安全感）。
2. **与 tests/ 大面积重叠**：R-03 ↔ `scheduler-resilience.test.ts:396+`（WarningLog 10 条纯函数）；R-04 ↔ 同文件 `:503-541`（setAutoScan）；R-02 ↔ `bandwidth.test.ts`（15 条）；R-05 ↔ `exec-fallback.test.ts`（4 条，虽口径不同但同源）。

**建议：迁入 tests/（优先）**——36 条全部可用 vitest 直接 import 引擎模块复刻（注入时钟、spawn 均无障碍），归 Tess 领地，纳入 `npm test` 门禁；若短期内不想动，**至少接线到 package.json**（如 `"test:fixes": "node scripts/fixes-check.mjs"` 并在 smoke/CI 串联）。**不建议原样保留为无人调用的孤儿脚本。**（最终去留由 Ray 按 D-015 裁决，本条为验证侧输入。）

## 11. 诚实性抽查（snapshot 字段）

我本次 3 次 engine-check 的 snapshot（`/tmp/svesc-vic-engine-{1,2,3}.json`）：

| 轮次 | system.rxBps | system.txBps | warnings |
|---|---|---|---|
| run1 | 1998373 | 20326915 | `[]` |
| run2 | 125371 | 5882629 | `[]` |
| run3 | 1196213 | 13323550 | `[]` |

另核查 task-001 默认路径产物（`.agent-runs/2026-10-25/task-001/artifacts/engine-snapshot.json`，10:22）：rxBps=3729958、txBps=294886、warnings=`[]`。

**rxBps/txBps 均为真实非零数值**（`check.ts:44-45` 扫描前双采样建立差分基线生效，非 0 兜底、非 null 假扮）；**warnings 无假告警**（3/3 为空；告警区只有真实 DEVICE_NEW 与真实 PRINTER_OFFLINE）。

## 12. RouterView session.error 渲染（D-013 展示层）

- 代码级证据：`src/renderer/views/RouterView.tsx:329-333`
  ```tsx
  {!loggedIn && status.session.error && (
    <div className="router-msg" data-tone="warn">
      {status.session.error}
    </div>
  )}
  ```
- `npx tsc --noEmit -p tsconfig.web.json` 0 error 覆盖其编译。
- smoke 的 `router-status.json`（截图时刻）：`session.loggedIn=false, session.error=null`——**未登录态 error 为 null，router.png 无法展示该文案，符合预期**，此项以代码级证据 + 编译通过结案。
- 残余风险（如实注明）：该文案在"真实会话过期"场景的 UI 呈现无法在本环境闭环（无 OpenWrt 真机），其有效守卫是 `tests/router-manager.test.ts` 对 `status.session.error='路由器会话已过期，请重新登录'` 的编排层断言（item 9 实验 B 同文件已证明该文件断言有效）；渲染层本身为纯展示分支，风险剩余为"文案在极端窄宽度下的换行外观"类视觉问题，不影响功能正确性。

---

## 附：修复点与代码位置对照（验证中亲眼核对）

| 项 | 位置 | 状态 |
|---|---|---|
| B-1 sweepTree 仅 PowerShell | `exec.ts:87/196/223`（runGbkNative :205-207 不传） | ✅ |
| B-1 arp2 接入 deadline | `scheduler.ts:509` | ✅ |
| B-1 ports AbortController | `scheduler.ts:546-552` | ✅ |
| B-1 hostnames 只等剩余预算 | `scheduler.ts:570-575` | ✅ |
| B-1 断言从常量推导 | `engine-check.mjs:112/130` + `check.ts:83` | ✅ 无硬编码 |
| B-1 带宽双采样 | `check.ts:44-45` | ✅ snapshot 实测真实值 |
| B-2 32 位零 null-session | `openwrt.ts:42/196-201` | ✅ e2e ①服务器视角实证 |
| B-2 错误码语境化 | `openwrt.ts:49`（-32002 双语境 / 6 / -1 / -32000 / -2） | ✅ |
| B-2 真实全链路 e2e | `tests/router-ubus-e2e.test.ts:191/209`（listen(0) + 真客户端） | ✅ 5 连跑稳定 |
| B-3 异步 safeStorage | `router-store.ts:32/47/63` | ✅ grep 零同步 API、smoke stderr 零 deprecated |
| D-011/D-012 call 语境 -32002 清会话、其余不清 | `openwrt.ts:272-296`（两分支对称） | ✅ 破坏实验 A 证明断言咬人 |
| D-013 loggedIn 不撒谎 + error surfaced | `router/index.ts:220-242`、`RouterView.tsx:329-333` | ✅ |
| D-017 caps.openwrt 粘性解耦 | `router/index.ts:50/91-92/182-183/191-193/106-115` | ✅ 破坏实验 B 证明断言咬人 |

## 输出纪律声明

最终裁决三选一：**PASS**。无 FAIL 项，无最小修复建议需求。item 10 的迁入建议为改进项（D-015 授权 Ray 裁决），不影响本任务验收判据 1-4。
