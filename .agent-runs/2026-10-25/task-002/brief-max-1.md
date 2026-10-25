# Brief — 实现工程师 Max-1（task-002 Phase 2）

**任务**：按 Vera 调查报告（`.agent-runs/2026-10-25/task-002/investigation-report.md`）闭环三条边界。以下是队长合成的完整规格——**以本规格为准**，报告仅作背景。

## B-1 扫描预算机制修复（三个文件）

### 1. `src/main/engine/exec.ts` — taskkill 风暴源头治理（收益最大）

现状：`sweepTreeByPid` 在 close 收尾时对**所有**被强杀进程 spawn `taskkill /T /F`。Vera 受控实验证明：每次强杀 spawn taskkill 使 ping 扫描从 5.5s 恶化到 10.0s（进程创建拥塞正反馈）。

修改：
- `RunOptions` 增加 `sweepTree?: boolean`。
- close 处理器改为：`if (timedOut && opts.sweepTree) sweepTreeByPid(child.pid)`。
- `runPowerShell` 调用 `runNative` 时传 `sweepTree: true`（PowerShell 才会派生 conhost 进程树，R-05 的教训场景）；`runNative`/`runGbkNative` 默认不传（ping/arp/netstat 是无子进程的叶进程）。

**回归红线（必须亲自验证）**：
- `npx vitest run tests/exec-fallback.test.ts` 4 条全绿。特别注意测试 2：第一个 runPowerShell 超时后 FakeChild 不派发 close → 不得 spawn taskkill（spawnMock 必须恰 2 次）。
- 超时路径本身**不得** spawn taskkill（保持立即 settle 语义）。

### 2. `src/main/engine/scheduler.ts` — ports/hostnames 接入 deadline

- ports 阶段（约 :478）：进入前建 `const abort = new AbortController()`；`const abortTimer = setTimeout(() => abort.abort(), Math.max(0, deadline - Date.now()))`；`probeHosts(probeTargets, PROBE_PORTS, 24, { timeoutMs: TIMEOUTS.portConnect, signal: abort.signal })`（ports.ts:69-70 的 opts 已支持 signal）；probeHosts 返回后 `clearTimeout(abortTimer)`。
- hostnames 阶段（约 :505-512）：改为相对剩余预算——`Promise.race([resolveHostnames(...), new Promise(r => setTimeout(r, Math.max(300, deadline - Date.now())))])`，剩余为 0 时直接跳过（保持"拿不到就 null"的诚实语义，不得填默认值）。
- arp2 回退保护（Vera 方案第 4 条）：若已过 deadline 且 arp2 的 `arp -a` 读数为空（entries.size===0 或 source!=='arp'），跳过 Get-NetNeighbor PowerShell 回退，沿用 this.arp。若实现后发现 risk 大（改 arp.ts 接口），可跳过此项并在实现报告中说明理由。

### 3. `scripts/engine-check.mjs` + `src/main/engine/check.ts` — 断言从常量推导

- `src/main/engine/check.ts` 加一行 re-export：`export { SCAN_BUDGET_MS } from '../../shared/constants';`
- `scripts/engine-check.mjs:115`：把 `<= 12000` 改为 `<= (mod.SCAN_BUDGET_MS + 2500)`，标签改为 `扫描 ≤ 预算+2.5s`；禁止硬编码数字。
- 新增两条分段 Tripwire（打印 PASS/FAIL，不计入退出码）：
  - `ping ≤ 预算+1500`
  - `hostnames ≤ 1600`
  退出码逻辑维持原样（devices>0 && printers>0），但控制台要把 4 条断言都打出来。

## B-2 ubus 登录 sid 修复（`src/main/engine/router/openwrt.ts`）

真 bug：uhttpd 的 `uh_ubus_allowed` 只接受 32 位零 null-session 调 session.login；现状发字面量 `'session'` → 真机必返 -32002 且文案误导为"用户名或密码错误"。

1. 导出 `export const UBUS_NULL_SESSION = '0'.repeat(32);`
2. `login` 改发 `raw([UBUS_NULL_SESSION, 'session', 'login', { username: user, password, timeout: 3600 }])`。
3. 错误文案语境化：`ubusErrorMessage(code: number, context: 'login' | 'call' = 'login')`：
   - -32002：login→`用户名或密码错误`；call→`会话已过期或无权限，请重新登录`
   - 6→`权限被拒绝（UBUS_STATUS_PERMISSION_DENIED）`
   - -32000→`方法不存在（该固件未编译此 ubus 对象）`；-2→`参数无效`；-1→`无权访问`（**保留**，注释注明"真实 ubus 不返回此码，为兼容旧行为保留"）；default→`ubus 错误码 ${code}`
   - `raw()` 内部按 `params[1]==='session' && params[2]==='login'` 判 login 语境，其余走 call——**不改 raw/transport 签名**。
4. （可选，低风险）`raw()` 校验响应 `id`：若响应含数字 `id` 且 ≠ 请求 `id` → 返回 `{ok:false, error:'响应 id 不匹配（可能是串流污染）'}`。

**回归红线**：`npx vitest run tests/router-openwrt.test.ts` 12 条全绿（现有断言 `ubusErrorMessage(-32002)` 含"用户名或密码错误"依赖 login 默认语境；`-1` 含"无权访问"必须保留）。

## B-3 safeStorage 异步迁移（`src/main/router-store.ts` + 2 处调用方）

按 Vera 报告 B-3 的迁移代码实施（报告中已给完整目标代码，逐行照做）：
- `canPersistCredentials`/`saveCredentials`/`loadCredentials` 改 async，用 `isAsyncEncryptionAvailable`/`encryptStringAsync`/`decryptStringAsync`；`decryptStringAsync` 返回 `{shouldReEncrypt, result}` 对象，取 `.result`。
- `clearCredentials` 保持同步不变。
- `src/main/ipc.ts` routerLogin handler：`const saved = await saveCredentials(...)`（handler 本就 async）；返回结构 `{ok,error,persisted,persistError}` 不变。routerLogout 不动。
- `src/main/index.ts` bootstrap：`const saved = await loadCredentials();`（在 async 函数内）。
- `ARCHITECTURE.md` §10.2 中"safeStorage.encryptString"表述更新为异步 API 表述。
- 顺手：`shouldReEncrypt === true` 时用新密文重存（key rotation，3 行内，超出就跳过）。

## 完成判据（自查后才算完）

1. `npx tsc --noEmit -p tsconfig.node.json` 0 error；`npx tsc --noEmit -p tsconfig.web.json` 0 error。
2. `npx vitest run` 全量绿（当前基线 342 条，B-1/B-2 不得有回归）。
3. 把实现报告写入 `.agent-runs/2026-10-25/task-002/implement-report.md`：每项改了什么（file:line）、为什么、自查命令输出摘要、跳过项及理由。
4. 最终回复只返回状态块：STATUS / 报告路径 / 各文件一行变更摘要。禁止倒过程日志。

**授权编辑范围**：`src/main/engine/exec.ts`、`src/main/engine/scheduler.ts`、`src/main/engine/check.ts`、`scripts/engine-check.mjs`、`src/main/engine/router/openwrt.ts`、`src/main/router-store.ts`、`src/main/ipc.ts`、`src/main/index.ts`、`ARCHITECTURE.md`。不得改动其他文件（测试由 Tess 负责）。