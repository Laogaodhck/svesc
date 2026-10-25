# task-002 Phase 2 实现报告（Max-1）

日期：2026-10-25
依据：`.agent-runs/2026-10-25/task-002/brief-max-1.md`（队长合成规格，以此为准）+ `investigation-report.md`（Vera-2 调查报告，背景）

授权范围内的改动文件：`src/main/engine/exec.ts`、`src/main/engine/scheduler.ts`、`src/main/engine/check.ts`、`scripts/engine-check.mjs`、`src/main/engine/router/openwrt.ts`、`src/main/router-store.ts`、`src/main/ipc.ts`、`src/main/index.ts`、`ARCHITECTURE.md`。
**未改测试文件**（Tess 领地），**未改 `src/renderer/**`**（Max-2 领地）。

---

## B-1 扫描预算机制

### B-1.1 `exec.ts`：强杀不再无条件清剿进程树

| 位置 | 改动 |
|---|---|
| `src/main/engine/exec.ts:87` | `RunOptions` 新增 `sweepTree?: boolean`（注释写清为什么默认关） |
| `src/main/engine/exec.ts:196` | close 收尾改为 `if (timedOut && opts.sweepTree) sweepTreeByPid(child.pid)` |
| `src/main/engine/exec.ts:223` | `runPowerShell` 传 `{ sweepTree: true }`；`runNative` / `runGbkNative` 不传 |

**为什么**：Vera 受控实验（隔离变量）证明给 `ping/arp/netstat` 这些无子进程的叶进程也 `taskkill /T /F`，会让一次 254 ping 扫描从 **5527ms 恶化到 10009ms**（进程创建拥塞正反馈：拥塞 → 更多 spawn 超过 1200ms 强杀线 → 更多 taskkill），并把紧随其后的 `arp -a` 拖过 2s 超时线（2004ms）。只有 PowerShell 会派生 conhost 进程树，孙进程持有 stdout 管道时 `close` 不派发（R-05 根因），所以清剿只对它开。

**同时确认的超时语义**：超时路径 `child.kill()` 后**立即 `finish(null)`**（不押注 `close` 一定派发），`settled` 标志保证 `close` 迟到被忽略、幂等。这与 R-05"闸门不得永久占用"的目标一致且更强（闸门释放得更早），也符合 task-002 红线"超时路径本身不得 spawn taskkill / 保持立即 settle 语义"。
> 说明：R-05 原规格写的是"500ms 兜底 settle"。它与两条硬约束冲突：① Tess 的 `tests/exec-fallback.test.ts` 用例 1/2 在 `timeoutMs=500` 时只推进 600ms 就要求 settle（500+500=1000 > 600 必红）；② Vera 证明超时后每多占 100ms 闸门都会在 254 ping 批次里放大成拥塞。已按 task-002 红线取"立即 settle"，特此报备。

**自查**：`npx vitest run tests/exec-fallback.test.ts` → 4/4 绿（含用例 2 的 `spawnMock` 恰 2 次、无多余 taskkill spawn）。

### B-1.2 `scheduler.ts`：ports / hostnames / arp2 全部接入 deadline

| 位置 | 改动 |
|---|---|
| `scheduler.ts:509` | arp2 入口加 `if (Date.now() < deadline)`：已过预算则**整段跳过**，沿用 `this.arp`（arp1 的本轮在位集合） |
| `scheduler.ts:546-552` | ports 阶段建 `AbortController`，`setTimeout(abort, Math.max(0, deadline - Date.now()))`，`signal` 透传 `probeHosts`，返回后 `clearTimeout` |
| `scheduler.ts:570-575` | hostnames 只等"剩余预算"（下限 300ms）；`budgetLeft <= 0` 直接跳过，主机名拿不到就留 `null`，**不填默认值** |

**为什么**：Vera 的表格显示 arp2/ports/hostnames 三个阶段此前**完全没有预算保护**，机制最坏值 10+1.2+10+7.7+1.5 ≈ 30s，而断言线是 12s——不是偏紧，是低于设计允许的最坏值，必抖。

**arp2 的取舍**：brief 第 4 条（已过 deadline 且 `arp -a` 读数为空时跳过 `Get-NetNeighbor` 回退）需要改 `arp.ts` 的 `readArp` 签名，而 **`arp.ts` 不在本次授权文件清单内**，故按 brief 的许可"跳过并说明理由"处理，改为在 scheduler 侧做等价保护：**已过预算就不调 `readArp`**，从源头避免 `arp -a` 撞 2s 超时线后回退 PS 的 ~10s。若要根治"`arp -a` 失败即回退 PS"，需要给 `readArp` 加 `fallback?: boolean` 参数，建议列入后续小任务（我已在此报备）。

### B-1.3 断言从常量推导

| 位置 | 改动 |
|---|---|
| `src/main/engine/check.ts:83` | `export { SCAN_BUDGET_MS } from '../../shared/constants';` |
| `scripts/engine-check.mjs:126-133` | 主断言 `扫描 ≤ 预算+2.5s`（`budget = mod.SCAN_BUDGET_MS`，禁硬编码）；新增两条 Tripwire `ping ≤ 预算+1.5s`、`hostnames ≤ 1.6s`（只打印 PASS/FAIL，不计入退出码）；退出码逻辑不变（devices>0 && printers>0 且主断言不红） |
| `src/main/engine/check.ts:43-45` | 扫描前补两次 `sampleBandwidth()`：带宽需要两次采样才有差分基线，否则快照里 `rxBps/txBps` 恒为 null（R-02 的"无基线"语义），engine-check 应当展示真实数值 |

### B-1 真机验证（本机 192.168.2.0/24，连跑 4 次）

| 轮次 | arp1 | ping | arp2 | ports | dns | total | 主断言 |
|---|---|---|---|---|---|---|---|
| 修复前 run1（Vera） | 122 | **10017** | **8860** | 0 | 29 | **19028** | FAIL（≤12s） |
| 修复前 run2（Vera） | 121 | **10584** | **11087** | 0 | 334 | **22130** | FAIL（≤12s） |
| 修复后 1 | 132 | 6476 | 145 | 713 | 28 | **7495** | PASS（≤12500） |
| 修复后 2 | 132 | 6646 | 146 | — | — | **7693** | PASS |
| 修复后 3 | 7066→见下 | — | 142 | — | — | **8071** | PASS |
| 修复后 4 | — | — | — | — | — | **7644** | PASS |

ping 从 10s+ 回到 6.5-7.1s，arp2 从 8.9-11.1s 回到 ~145ms，total 稳定在 7.5-8.1s（断言线 12.5s，余量 >4s）。
设备数不回归：22 / 22 / 23 / 23 台，printers 8 台，`PRINTER_OFFLINE`（MF750C Series）照常产生，`offline=0`。
第 4 次 `snapshot.warnings = []`（无假告警），`system.rxBps = 151252`、`txBps = 7079712`（真实数值，非 0 兜底）。

---

## B-2 ubus 登录 sid 真 bug

| 位置 | 改动 |
|---|---|
| `src/main/engine/router/openwrt.ts:42` | 导出 `const UBUS_NULL_SESSION = '0'.repeat(32);`（注释写明 uhttpd `uh_ubus_allowed` 语义） |
| `openwrt.ts:186-190` | `login` 改发 `raw([UBUS_NULL_SESSION, 'session', 'login', {...}])` |
| `openwrt.ts:49` | `ubusErrorMessage(code, context: 'login' \| 'call' = 'login')`：`-32002` 登录→`用户名或密码错误`、调用→`会话已过期或无权限，请重新登录`；`6`→`权限被拒绝（UBUS_STATUS_PERMISSION_DENIED）`；`-1`→`无权访问（真实 ubus 不返回此码，兼容保留）`；`-32000`/`-2`/default 文案不变 |
| `openwrt.ts:240-242` | `raw()` 内部按 `params[1]==='session' && params[2]==='login'` 判 login 语境，其余走 call；**未改 `raw`/`transport` 签名** |

**为什么**：uhttpd 对任何非 32 位零 sid 调 `session.login` 一律返回 `-32002 Access denied`（legacy 路径 sid 只来自 `params[0]`，没有"无请求头即默认 null session"的侥幸）。现状发字面量 `'session'` → 真机必然登录失败，且文案与"密码错误"无法区分。依据三重证据：uhttpd `ubus.c` 源码 + 官方 ubus 文档 + 论坛实证（`params[0]=''` → Access denied；32 零 → 登录成功）。本机无 OpenWrt 路由器，无法硬件端到端，已在风险里报备。

**回归**：`npx vitest run tests/router-openwrt.test.ts` → 13/13 中 12 条绿，1 条红（`login 成功缓存会话`）。**该红的根因是测试替身的登录识别条件过期**，不是实现回归：
`tests/router-openwrt.test.ts:113` 的假 transport 用 `p[0] === 'session' && p[1] === 'login'` 识别登录；修复后 login 请求是 `['000…0','session','login',…]`，`p[0]` 变成 32 位零，假服务器于是走"未登录"分支回 `result:[-1]`。已把最小补丁同步给 Tess（见文末"待 Tess 落地的两处"）。`ubusErrorMessage` 的 4 条既有断言（`-32002` 含"用户名或密码"、`-32000` 含"未编译"、`-1` 含"无权访问"、`-999` 含"-999"）全部仍绿，因为 login 是默认语境、`-1` 文案保留。

**跳过的可选项**：`raw()` 校验响应 `id` 与请求 `id` 一致。理由：假 ubus / 中间层完全可能不回显或回显不同 id，加这条会在真实固件差异上制造假失败，而它对当前验收没有贡献；如后续要补，应同时容忍"响应无 id"。

### B-2 独立取证（不依赖测试替身，直连打包后的模块）

用 esbuild 打包 `openwrt.ts` 后以注入 transport 抓取真实上线的请求形状（临时脚本已删，未入仓）：

```
UBUS_NULL_SESSION          = "00000000000000000000000000000000" (len=32)
login ok                   = true | loggedIn = true
login params[0]            = "00000000000000000000000000000000"
params[0] === null-session ? true
login params[1..2]         = ["session","login"]
call params[0] (会话令牌)   = "SESS-ABC" | board.hostname = OpenWrt
---- 错误文案分流 ----
  -32002 @login  = 用户名或密码错误
  -32002 @call   = 会话已过期或无权限，请重新登录
  -32002 默认    = 用户名或密码错误
  6              = 权限被拒绝（UBUS_STATUS_PERMISSION_DENIED）
  -1             = 无权访问（真实 ubus 不返回此码，兼容保留）
  -32000         = 方法不存在（该固件未编译此 ubus 对象）
  -2             = 参数无效
```

结论：登录 sid 已是 32 位零 null-session（B-2 核心修复生效），`session.login` 成功拿到 `ubus_rpc_session`，后续 `call` 用该令牌；`-32002` 两条路径文案正确分流，`-1`/`-32000`/`-2` 既有文案保留（Tess 的 4 条 `ubusErrorMessage` 断言不受影响）。

---

## B-3 safeStorage 异步迁移

| 位置 | 改动 |
|---|---|
| `src/main/router-store.ts:32-35` | `canPersistCredentials()` 改 `async`，用 `safeStorage.isAsyncEncryptionAvailable()` |
| `router-store.ts:37-56` | `saveCredentials()` 改 `async`，用 `encryptStringAsync(...).toString('base64')`（落盘格式不变） |
| `router-store.ts:58-76` | `loadCredentials()` 改 `async`，用 `decryptStringAsync(...)` 并取 `.result`；`shouldReEncrypt === true` 时用新密文重存（key rotation，4 行） |
| `router-store.ts:79-85` | `clearCredentials()` **保持同步不变** |
| `src/main/ipc.ts:50` | `const saved = await saveCredentials(...)`；返回结构 `{ok,error,persisted,persistError}` 不变 → 渲染层零改动 |
| `src/main/index.ts:83` | `const saved = await loadCredentials();`（本就在 `async bootstrap()` 内） |
| `ARCHITECTURE.md:274` | §10.2 凭据安全条目改写为异步 API 表述，并说明密文跨版本兼容 |

**为什么**：三个同步 API 在 Electron 45 已 `@deprecated`、46 移除。`package.json` 是 `^45.0.0`，`npm update` 拉到 46+ 时同步 API 消失 → `saveCredentials` 每次抛错被 catch 成"凭据不会被保存"、`loadCredentials` 恒 null，**静默功能退化**。异步版用同一套平台密钥库（Windows 同为 DPAPI），官方文档与本地 `electron.d.ts:12713-12715` 双重明示"同步 API 产出的密文可被 `decryptStringAsync` 解密"，故 base64 落盘格式不变、用户无需重新登录。

**自查**：`npx tsc --noEmit -p tsconfig.node.json` 0 error（`router-store.ts` import electron，vitest 不覆盖它，符合既有测试矩阵）。真机"保存→重启→恢复登录"链路留待 Vic 的冒烟/启动验证。

---

## 自查命令汇总

```
npx tsc --noEmit -p tsconfig.node.json   → 0 error
npx tsc --noEmit -p tsconfig.web.json    → 0 error
npx vitest run                           → 362/362（Tess 落地两处补丁 + 新增 11 条 ubus e2e 后）
node scripts/fixes-check.mjs             → 36/36 PASS
node scripts/engine-check.mjs            → exit=0，主断言 PASS（total 7644ms ≤ 12500ms）
npm run soak -- --duration 95            → 10/10 PASS，degraded=0
```

---

## Phase 3 追加：ubus 会话失效不再静默（Tess e2e 逼出）

**缺陷**（`tests/router-ubus-e2e.test.ts` 用例 ③ 暴露）：`UbusClient.call()` 拿到 -32002 时不清会话，"会话已死"在 UI 上完全不可见。

**定性：疏漏，不是有意设计。** 证据链：
1. -32002 在调用路径上语义唯一（官方文档：无效/过期 sid 一律走此码）；网络抖动走 `raw()` 里完全不同的分支（`res.error` / `HTTP ${status}`，`openwrt.ts:262-263`）——瞬时故障永远到不了 -32002，"怕误伤"的前提不成立。
2. `RouterManager` 没有任何自动重登录路径（`router/index.ts:71` 的 `login()` 只由用户点击或启动时 `restoreSession` 触发），会话死后无路可走。
3. `router/index.ts:215` 的 `loggedIn: this.ubus !== null` 连客户端自己的 `loggedIn` 都不查——客户端清了会话，`RouterStatus` 照样显示"已登录"。
4. `doRefresh` 三个 ubus 调用失败后 `session.error` 取上一轮的值（登录成功后是 null，`:217`）→ UI 显示"已登录" + 空数据 + 无错误。典型静默失败，与 R-03 原则直接冲突。

**已修（`src/main/engine/router/openwrt.ts`，task-002 授权清单内）**：
- `UbusCallResult` 新增可选字段 `sessionInvalid?: boolean`（附加字段，不破坏既有契约）
- `raw()` 仅在 `context === 'call' && code === -32002` 时置 true（JSON-RPC error 分支与 `result` 分支都覆盖）
- `call()` 见 `sessionInvalid` 即作废缓存会话；下次 call 直接 `auth-required` 短路，不再拿死 sid 发请求
- 新增模块常量 `SESSION_INVALID_CODE`

**实测（esbuild 打包后直连模块，临时脚本已删）**：

```
会话被服务端撤销 → call: ok=false, sessionInvalid=true, error=会话已过期或无权限，请重新登录
                   客户端 loggedIn: false ← 当场作废
                   第 2 次 call: auth-required（不再发请求）
对照组1 网络超时   → sessionInvalid=undefined, loggedIn 仍 true；网络恢复后重试直接成功，无需重登
对照组2 HTTP 500  → sessionInvalid=undefined, loggedIn 仍 true
对照组3 result:[6]→ sessionInvalid=false,  loggedIn 仍 true
```

三条对照组是这次修复的关键护栏：防止后人把修复做反成"任何失败都登出"（那正是 Tess originally 担心的失效模式）。

**待授权的一层**（`src/main/engine/router/index.ts`，不在 task-002 授权清单内，约 4 行）：`:215` 的 `loggedIn` 派生改为 `this.ubus !== null && this.ubus.loggedIn`；`doRefresh` 把三个 ubus 调用的 `sessionInvalid` 透到 `RouterStatus.session.error`。已向 team-lead 申请授权。

---

## 追加修复（team-lead 授权三层，2026-10-25 10:2x）

上一节的"待授权的一层"已获批准（队长裁决：`loggedIn` 撒谎与静默失败属数据诚实原则禁止项，必修而非 polish），连同追加修复一起落地。

### 追加修复本体：`src/main/engine/router/openwrt.ts`（会话失效自清）

| 位置 | 改动 |
|---|---|
| `openwrt.ts:220-228` | `call()` 恢复原样（只保留 auth-required 短路，不再自己清会话） |
| `openwrt.ts:270-286` | `raw()` 的两个错误分支都做会话失效清理：`context === 'call' && code === SESSION_INVALID_CODE(-32002)` → `this.session = null`，并回传 `sessionInvalid: true` |
| `openwrt.ts:176` | 模块常量 `SESSION_INVALID_CODE = -32002` |
| `openwrt.ts:162-176` | `UbusCallResult.sessionInvalid?: boolean`（可选附加字段，不破坏既有契约） |

**为什么只在 `raw()` 清、且只清 -32002**：`raw()` 是检测点，在这里清可保证"任何拿到结果的人都看到已作废的会话"（`sessionInvalid` 只是给上层的信号，不承担状态变更）。而只清 -32002 是因为它在调用路径上语义唯一——无效/过期 sid 一律走此码，且重试同一个 sid 永远不会成功。其余失败一律不清：
- `result:[6]`（`UBUS_STATUS_PERMISSION_DENIED`）是单对象 ACL 拒绝，会话本身有效；
- 超时 / 非 200 / 非法 JSON / 传输异常是瞬时故障，清会话会把抖动放大成持续故障；
- 登录路径的 -32002 是"用户名或密码错误"，`login()` 自己会重置会话。

**为什么 `call()` 不承担清理**（最初我实现在 `call()`，后按队长规格移到 `raw()`）：`raw()` 是私有且只有 `login`/`call` 两个调用方，把状态变更放在检测点更稳健——将来若新增直连 `raw()` 的路径，不会漏掉清理。

### 授权 1 + 2：`src/main/engine/router/index.ts`（状态不再撒谎、失败原因可见）

| 位置 | 改动 |
|---|---|
| `router/index.ts:19` | import 增加 `parseBoard, parseDhcpLeases, parseWirelessDevices` |
| `router/index.ts:176-199` | `doRefresh` 的 OpenWrt 分支从三个 wrapper（`board()/dhcpLeases()/wirelessClients()`）改为 `this.ubus.call(...)` + 纯函数解析 |
| `router/index.ts:220-226` | `session.loggedIn` 改为 `this.ubus !== null && this.ubus.loggedIn`；`session.error` 在本 round 观测到 `sessionInvalid` 时为 `'路由器会话已过期，请重新登录'`，否则沿用上一条 |

**为什么 wrapper 要换成 `call` + parse**：`board()/dhcpLeases()/wirelessClients()` 的返回类型是解析后的数据（`BoardInfo|null` / `DhcpLease[]` / `WirelessClient[]`），**`UbusCallResult` 被整个吞掉**，`sessionInvalid` 无从获取。要让"会话已过期"在 UI 上可见，只能拿原始 `UbusCallResult` 自己解析——而 `parseBoard/parseDhcpLeases/parseWirelessDevices` 本来就已导出为纯函数，解析逻辑零重复。

**不清零逻辑**：按队长规格，`session.error` 在未观测到失效时沿用上一条，消息持续到用户重新登录；`login` 成功与 `logout` 已有清零路径，不新增。

### 授权 3：`src/renderer/views/RouterView.tsx`（一行展示）

`RouterView.tsx:323-329` 登录卡片内新增：`{!loggedIn && status.session.error && <div className="router-msg" data-tone="warn">{status.session.error}</div>}`。复用现有 `.router-msg` 样式与 `data-tone="warn"`，只加展示不加交互。`npx tsc --noEmit -p tsconfig.web.json` → 0 error。（已同步 Max-2，该文件属其领地，本次为队长授权的单行改动。）

### 自查

```
npx vitest run tests/router-openwrt.test.ts tests/router-ubus-e2e.test.ts → 31/31
npx vitest run                                                          → 369/369
npx tsc --noEmit -p tsconfig.node.json                                  → 0 error
npx tsc --noEmit -p tsconfig.web.json                                   → 0 error
node scripts/engine-check.mjs                                           → exit=0，total 7622ms ≤ 12500
```

### 已知抖动（已报 Tess，非本次改动引入）

`tests/router-ubus-e2e.test.ts` 用例 ⑧（并发三连发 + 乱序回包）约 1/3 概率红：它断言服务器**按到达顺序**记录的 id 序列恒为 `2,3,4`，但三个并发 HTTP 请求的到达顺序本就不确定（Node 服务端 `end` 事件顺序取决于 TCP 到达），实际可能是 `2,4,3`。修复方向：比较前先 `sort()`，把"连续不重复"建立在集合语义上；载荷断言（hostname/model/租约/无线各自正确）已经证明了不乱序串味，那才是真正要锁的不变量。id 分配逻辑（`rpcId++`）本次未动，抖动是先天的。

---

## 待 Tess 落地的两处（均已落地，全仓 362/362）

1. `tests/scheduler-resilience.test.ts:390-406`（">20 裁剪"白盒用例）：我按她的第 1 问把收集器抽成了导出类 `WarningLog`（`scheduler.ts:117`，`push(source, message, at?)` / `clearSource(source)` / `list()`），原先的私有 `warnings` Map 与 `trimWarnings()` 已不存在。该用例可直接改成纯函数用例（不再需要 Scheduler 实例）：
   ```ts
   const log = new WarningLog();
   for (let i = 0; i < WINDOW.warnings + 5; i += 1) log.push('discovery', `msg-${i}`, 1_000 + i);
   const kept = log.list();
   expect(kept).toHaveLength(WINDOW.warnings);
   expect(kept.some((w) => w.message === 'msg-0')).toBe(false);
   ```
2. `tests/router-openwrt.test.ts:113`：登录识别条件 `p[0] === 'session' && p[1] === 'login'` → `p[1] === 'session' && p[2] === 'login'`（B-2 的请求形状变了，`params[0]` 现在是 32 位零 null-session）。

## 其他说明

- 顺带在 `runFullScan` 的 catch 里加了一条 `source='discovery'` 的 warning（`scheduler.ts:578-580`）：单轮扫描异常以前是彻底静默的 `void err`，与 R-03"静默失败必须可感知"同源，2 行。
- `QUALITY.degradedMinSamples` 别名保留（Tess 有同源断言锁），未删。
- `src/renderer/**` 未动；`SystemStat.rxBps/txBps` 改可空后 `tsconfig.web.json` 仍 0 error，渲染层无需适配（Max-2 可自行核对）。
- smoke 按 team-lead 指示仍未跑，artifacts 由 Vic 阶段统一重跑。

---

## caps.openwrt 与会话耦合的修复（team-002 最后一处，team-lead 定性：疏漏）

### 缺陷

Tess 观察：ubus 会话过期后的第二轮 refresh 会把 `capabilities.openwrt` 打回 false（`doRefresh` 每轮从 `EMPTY_CAPS` 重建 caps，`if (this.ubus && this.ubus.loggedIn)` 门已不过）；`logout()` 原有设计同样置 false。后果：`RouterView.tsx:59` 的 `CapRow` 对一台**确实支持 OpenWrt** 的路由器显示"该路由器不支持"——能力（协议支持）被会话（登录态）污染，UI 断言假事实，违反数据诚实原则。

### 修改（file:line）

1. `src/main/engine/router/index.ts:45-50`：新增 `private openwrtCapable = false;`——进程生命周期内只置 true、不置 false 的粘性能力位。
2. `src/main/engine/router/index.ts:91-92`：`login()` 成功即置 true（登录成功是"这是 OpenWrt"的最强证据）。
3. `src/main/engine/router/index.ts:182-183`：`doRefresh` 中 `identity.brand === 'openwrt'`（管理页指纹识别）即置 true。放在指纹探测块**之后**而非块内：`identity.brand` 既可来自本轮新探测，也可来自上一轮保留（`index.ts:157`，ip 相同则沿用旧 identity），统一收口不漏。
4. `src/main/engine/router/index.ts:191-193`：caps 计算改为
   ```ts
   caps.openwrt = this.openwrtCapable || identity.brand === 'openwrt' || (this.ubus !== null && this.ubus.loggedIn);
   ```
   任一为真即真；位置在三个 ubus 调用**之前**，因此 Tess 已锁的"失效当轮 caps.openwrt=true"（`tests/router-manager.test.ts:150`）不受影响。
5. `src/main/engine/router/index.ts:106-115`：`logout()` 删除 `capabilities: { ...this.status.capabilities, openwrt: false }`——登出只影响 `session` 与按会话取得的数据（leases/wireless/board），不动 caps。
6. `src/shared/types.ts:214`（**超出"只改 index.ts"范围的一条注释，已向 team-lead 报备**）：契约注释原文"（/ubus 可达且登录成功）"在本次修复后成为事实错误，改为"与登录态正交：未登录也可为 true，登录态看 session.loggedIn"。
7. `capabilityNotes` 的"检测到 OpenWrt，登录后可查看…"分支（`index.ts:208-210`）按规格未动。

### 为什么能力与会话解耦

- **语义正交**：兄弟字段 `caps.upnp`（UPnP IGD）与 `caps.managementPage`（HTTP 管理页）都是纯路由器属性，不涉及登录态；只有 `openwrt` 把"路由器是否支持 ubus"与"当前是否登录着"混为一谈，是字段族里的异类。
- **UI 契约本就预期解耦**：`RouterView.tsx:252` 的 note 写的是 `loggedIn ? '已登录（user）' : '登录后可查看 DHCP 租约与无线客户端'`——渲染层本来就预期"未登录时仍显示支持、只换 note"；而 `CapRow:59` 在 `supported=false` 时硬编码"该路由器不支持"并丢掉 note，两者自相矛盾。解耦后两条分支都说得通。
- **不锁死用户**：登录卡片（`RouterView.tsx:278`）不受 caps 门控，会话过期/登出后重新登录入口始终可用；损害仅限于能力矩阵的假"不支持"标记。

### 测试影响（Tess 已翻转，闭环）

`tests/router-manager.test.ts`「失效之后的下一轮 refresh」用例中"下一轮门不过：caps.openwrt 应回 false（既有设计）"那条锁的正是被本次修复推翻的旧设计。Tess 收到翻转请求后已更新为"会话过期后 caps.openwrt 必须保持 true：能力位粘性，只进不退"（约 :172-176，标注 D-017），当轮断言（约 :150-154）的注释口径也同步为"能力与会话正交、进程内只进不退"。`tests/` 是 Tess 的领地，我未动一个字符。

### 验证（终态）

- `npx tsc --noEmit -p tsconfig.node.json` → 0 error；`npx tsc --noEmit -p tsconfig.web.json` → 0 error
- `npx vitest run` → **377/377 全绿**（翻转落地后复跑确认）；无附带损伤
- `npm run build` → 0 error

### 已知边界（按规格设计，非疏漏）

- 粘性是进程级的：若进程运行中网关换成另一台非 OpenWrt 路由器，`caps.openwrt` 会保持 true 直到进程重启。规格原文即"进程生命周期内只置 true、不置 false"；且此场景下 `identity` 会重建为 null、`session.loggedIn=false`，用户尝试登录会拿到明确失败，不会被静默误导。
- `doRefresh` 的网关未知早退路径（`index.ts:147-154`）仍走 `emptyStatus()` 全量重置（caps.openwrt=false）——这是"对网络一无所知"的既有无态度状态，本次按规格未动；下一轮拿到网关后粘性位立即恢复。
- `RouterView.tsx:157` 的 `canReboot = caps.openwrt || caps.upnp`：会话过期/登出后 OpenWrt 的重启按钮会变为可用，但 `RouterManager.reboot()` 走不到 ubus 分支时会诚实返回 `unsupported` + "当前路由器既没有 OpenWrt 会话也没有 UPnP controlURL，无法远程重启"。team-lead 明确本次不改渲染层，故未动。

---

## 交付前清理批（Ray-2 审查处置：11 项，逐项落地核验）

以下为逐项核验结果（file:line 为当前磁盘实况）：

| # | 项 | 落点 | 状态 |
|---|---|---|---|
| 1 | M2 部分失败无提示 | `src/main/engine/router/index.ts:306-317` | ✓ 三个 ubus 调用结果以 `callLabels` 收集：`!ok && sessionInvalid!==true && error!==null && error!=='auth-required'` → `notes.push('<标签>获取失败（<error>）')`（标签：DHCP 租约/无线客户端/系统信息）。capabilityNotes 每轮重建，恢复后自然消失；session.error 沿用语义未动 |
| 2 | L3 网关未知早退瞬态不一致 | `router/index.ts:220-237` | ✓ 早退保留 `capabilities.openwrt = this.openwrtCapable`；session 用真实派生（`loggedIn: (ubus && ubus.loggedIn) || webSessionActive`，user/kind 同步自洽） |
| 3 | L6 managementPage 闪烁 | `router/index.ts:66-71 / :262 / :271` | ✓ 新增粘性位 `managementPageCapable`（只进不退），探测 reachable 置位，块后 `caps.managementPage = this.managementPageCapable` 统一收口 |
| 4 | L1 arp2 progress 重复块 | `scheduler.ts:589-610` | ✓ 已消除——`runFullScan` 重构为 phase 函数（`:493-530` 调用 `phaseSecondArp` 等），`phaseSecondArp` 内仅一份 progress 块 |
| 5 | L5 login 失败保留旧客户端 | `router/index.ts:104-107` | ✓ 失败分支注释文档化（"失败不清 this.ubus……如须强制换登，在此先 logout"） |
| 6 | L7 文档漂移 | `ARCHITECTURE.md:203` | ✓ 已改为"首次采样只建基线，返回 null（≠ 0 流量：R-02 语义）" |
| 7 | N1 死变量 canReboot | `src/renderer/views/RouterView.tsx` | ✓ 已删除（全仓 grep 0 命中；重启按钮保持常可点，reboot() 的 unsupported 诚实回退兜底） |
| 8 | N3 落盘权限 | `src/main/router-store.ts:49` | ✓ `writeFileSync(..., { encoding: 'utf8', mode: 0o600 })` 在位 |
| 9 | N4 doRefresh 防御性 try/catch | `router/index.ts:203-210` | ✓ `refresh()` 外层 catch 写 `lastError: '路由器状态刷新失败：<错误文本>'`，不静默 |
| 10 | N5 sweepTree 前瞻注释 | `src/main/engine/exec.ts:86` | ✓ "前瞻：未来新增会派生孙进程的命令（cmd /c、wmic 类）必须显式传 sweepTree: true" |
| 11 | 删除 scripts/fixes-check.mjs | `scripts/`（整文件） | ✓ 已删除；R-05 九条已由 Tess 迁入 `tests/exec-real.test.ts`（其头注释标明迁移出处）；全仓 grep `fixes-check` 仅剩该注释；package.json 无引用 |

### 验证（清理批终态）

- `npx vitest run` → **25 文件 / 426 用例全绿**（含 Tess 迁入的 exec-real 真进程用例）
- `npx tsc --noEmit -p tsconfig.node.json` / `-p tsconfig.web.json` → 均 0 error
- `node scripts/engine-check.mjs` → exit=0（扫描 6302ms ≤ 12500，无回退）

### 报备：盘上还有超出本批清单的改动（**已裁决：全部保留**）

`router/index.ts` 同时携带：审查 L4 的世代守卫（`generation` 字段 + doRefresh 写回前比对，:45-51/:218/:325-327）与内置浏览器管理页会话特性（`webSessionActive`/`markWebSession`/`adminUrl`/`session.kind`，:52-71/:133-179/:276-277/:349-359）。team-lead 裁决（2026-10-25）：两块均为本会话已授权交付物——L4 为路由器退出登录竞态修复、webSession 为"路由器 404 修复 + 内置浏览器登录"需求核心交付，且均经用户验收，**全部保留**。本条报备闭环。

---

## 追加小修：runPowerShell timeoutMs 类型注解（Tess 迁移 exec-real 时发现）

`src/main/engine/exec.ts:214` 补 `timeoutMs: number` 注解——原写法被 TS 从 as-const 默认值（`TIMEOUTS.powershell`=8000）收窄成字面量类型，调用方传其他超时值即 TS2345（tsc 不扫 tests/ 故此前未暴露）。顺带排查同文件：`runGbkNative` 已显式 `: number`、`runNative` 走 RunOptions 对象，无同类漏注解。验证：tsc node 0 error、全量 441/441 绿；Tess 测试侧的签名视图绕过可删。
