# task-002 调查报告：三条 KNOWN_ISSUES 根因与修复方案

调查人：调查员 Vera-2（只读调查，未修改任何源文件）
日期：2026-10-25
方法：读码取证（file:line）+ 官方文档/源码核验 + 本机实测复现（engine-check ×2、受控实验 ×2、arp/PS 基线计时）

## 总览

| 项 | 结论 | 严重度 |
|---|---|---|
| B-1 | 12s 断言线比机制最坏值还低 1.6~2.5 倍；本机 2/2 复现 FAIL（19.0s / 22.1s）。根因是 taskkill 清剿风暴把 ping 推满 10s 预算，随后无预算保护的 arp2 劣化到 9~11s | 高（断言必抖） |
| B-2 | 协议形状 95% 正确，但**登录 sid 用错**（'session' 而非 32 位零 null-session）——真机登录必然失败；本地 node:http 假 ubus e2e 完全可行且能抓住该 bug（若假服务器严格复刻） | 高（功能缺陷） |
| B-3 | 三个同步 safeStorage API 在 Electron 45 已弃用、46 移除；迁移面约 10 行 + 2 处 await；既有 DPAPI 密文跨 API 版本兼容，无需重新登录 | 中（技术债，有明确升级触发点） |

---

## B-1 engine-check 扫描耗时断言抖动

### 现状证据

- 断言点：`scripts/engine-check.mjs:115` — `扫描 ≤ 12s : (timings?.total ?? Infinity) <= 12000`；打印口径见 `:73`（"扫描阶段合计" = `timings.total`）。
- `timings.total` 来源：`src/main/engine/check.ts:51` 取 `engine.scheduler.lastTimings`；`lastTimings` 在 `src/main/engine/scheduler.ts:522`（finally）赋值，`total` 在 `:521` 计算 = **arp1 + ping + arp2 + ports + hostnames + 阶段间开销**。之后的 `safeRefreshPrintersIfNeeded`（`:526`）与 SNMP/打印机采集**不计入** total（check.ts:42-48 单独计 printerMs）。
- 预算机制：`SCAN_BUDGET_MS = 10000`（`src/shared/constants.ts:57`），`deadline = startedAt + SCAN_BUDGET_MS`（`scheduler.ts:397`）。
- **各阶段受预算保护情况**：

| 阶段 | 代码位置 | 预算保护 | 本机典型耗时 | 机制最坏值 |
|---|---|---|---|---|
| arp1 | scheduler.ts:416-418 | 无 | 121-122ms | 2000ms（`arp -a` 超时）+ 8000ms（PS 回退） |
| ping | scheduler.ts:431-445 → ping.ts:137-151 | **有**（deadline 传入，到点后剩余主机立即判死；在途包跑完） | 10017 / 10584ms（吃满预算） | 10000 + 1200（pingKill 在途余量） |
| arp2 | scheduler.ts:461-463 → arp.ts:119-166 | **无** | **8860 / 11087ms（异常）** | 2000 + 8000 = 10000ms |
| ports | scheduler.ts:478（仅入口判 `Date.now() < deadline`）→ ports.ts:65-87 | **仅入口**，一旦开始无 deadline | 0ms（被跳过） | ceil(候选/24) × 700ms；254 候选 ≈ 7.7s |
| hostnames | scheduler.ts:505-512 | 无（固定 1500ms 硬帽，与剩余预算无关） | 29 / 334ms | 1500ms |

- 端口探测其实**已有** AbortSignal 支持（`ports.ts:10,30-37`）但 scheduler 未使用。
- `smoke.ts:59` 的 35s 数据等待线可容纳当前慢扫描（仅打日志，无断言）。

### 实测复现（本机，192.168.2.0/24）

engine-check 两次（各约 32s / 35s）：

```
run1: arp1=122  ping=10017  arp2=8860  ports=0  hostnames=29   printers=5304  total=19028  断言 FAIL
run2: arp1=121  ping=10584  arp2=11087 ports=0  hostnames=334  printers=5393  total=22130  断言 FAIL
```

受控实验（隔离变量，锁定根因）：

| 实验 | ping 扫描 | 强杀数 | 洪水后 arp -a |
|---|---|---|---|
| A：254 ping（并发64，强杀1200ms），**无** taskkill | 5527ms | 83 | 149ms / 112ms，42 条（正常） |
| B：同上 + **每次强杀 spawn taskkill /T /F**（复刻 exec.ts:130-142） | **10009ms** | 152 | **2004ms（越过 2s 超时线）**，第二次 694ms |

基线：`arp -a` 单独执行 115-126ms；Get-NetNeighbor（PS）870-1069ms。

### 根因（完整因果链，已逐环实证）

1. **ping 阶段被 taskkill 风暴自我放大**：`ping -n 1 -w 800` 打不可达主机约 1-1.4s（等 ARP 解析失败），逼近 `TIMEOUTS.pingKill=1200ms` 强杀线；`exec.ts:186-188` 对每个被强杀的子进程 spawn `taskkill /T /F`（**不经令牌闸门、即发即忘**）。进程创建拥塞 → 更多 spawn 超过 1200ms → 更多强杀 → 更多 taskkill → 扫描从 5.5s 翻倍到 ~10s（实验 B 精确复现：10009ms）。**扫描因此吃满 10s 预算**，deadline 快失效按设计生效（剩余主机立即判死，ICMP 覆盖被牺牲，ARP 仍在位集合兜底：22 条 / 23 设备）。
2. **arp2 无预算保护且正撞风暴峰值**：`arp -a` 被进程拥塞拖过 `TIMEOUTS.arp=2000ms` → 强杀（0 条）→ 回退 Get-NetNeighbor PowerShell 同样被拖住 → 6.9-9.1s（本机实测 8.9-11.1s，两次稳定复现）。
3. **ports 被入口闸门跳过**（此时已 ~20s > deadline），但注意：**若 ping 较快，ports 一旦开始就无 deadline**（probeHosts 无 deadline 参数），候选多 + 防火墙主机丢包时最坏 ~7.7s，同样不计入预算。
4. **hostnames 1500ms 硬帽与预算无关**——即使严重超预算也照等。
5. `timings.total` = 以上之和 → 本机 19-22s；**机制最坏值 ≈ 10 + 1.2 + 10 + 7.7 + 1.5 ≈ 30s**。

**为什么实测在 10.7~16s（收尾报告口径）到 19-22s（本次）之间波动而断言是 12s**：波动来自 ①风暴强度（强杀数随机器负载变化，直接决定 ping 是否吃满预算）；②`arp -a` 是否幸存于 2s 线（幸存 ≈2s，被强杀+PS 回退 ≈9-11s，两者差 4-5 倍）；③ping 较快时 ports 的候选数×防火墙主机比例；④rDNS 可用性（hostnames 29ms~1500ms）。而 12s 断言线比机制最坏值低 1.6~2.5 倍——**它不是"偏紧"，是"低于设计允许的最坏值"，必抖**。另注：`scheduler.ts:7` 注释"254 × ping ≈ 6.0s"在本机已不成立（负载态 ~10s）。

### 修复方案

**第一层：机制修复（让指标有意义）**

1. **风暴源头治理（收益最大）**：`exec.ts` 的 `sweepTreeByPid` 只对可能派生孙进程的场景启用——`ping/arp/netstat` 是无子进程的叶进程，只有 `runPowerShell` 会派生 conhost 进程树。给 `runNative` 加显式开关（仅 `runPowerShell` 传 `sweepTree: true`）。预期：扫描回到 ~5.5s、强杀数减半、arp2 回到 ~120ms、单轮 total 降到 ~6.5s。
2. **ports 接入 deadline**：scheduler 在端口阶段前建 `AbortController` 并 `setTimeout(abort, deadline - now)`，把 `signal` 透传给 `probeHosts`（`ports.ts:30-37` 已实现 abort→finish(false)）。超预算即收尾，与 pingSweep 语义一致。
3. **hostnames 改为相对剩余预算**：`Promise.race([resolveHostnames, setTimeout(max(0, deadline - Date.now()))])`，可保 300ms 下限。
4. （可选）arp2 回退保护：已过 deadline 且 `arp -a` 无可用结果时跳过 PS 回退（arp1+ping 的在位集合已够出快照）。

修复后 `timings.total` 最坏 ≈ SCAN_BUDGET_MS + 1200（在途）+ 收尾 ≈ **11.5s**，且"超预算仍出快照"成为可断言的不变量。

**第二层：断言重设（灵敏且稳定）**

- 主断言改为**从常量推导**：`timings.total <= SCAN_BUDGET_MS + 2500`（即 12500）——高于修复后最坏值 11.5s，但任何"预算机制失效"的回归（无 deadline 的 ping/ports 会把 total 拉到 15-30s）都会被抓住。禁止硬编码数字。
- 保留分段打印；建议加两条Tripwire：`timings.ping <= SCAN_BUDGET_MS + 1500`、`timings.hostnames <= 1600`，便于分段定位。
- 可选增强（可测性）：给 `SCAN_BUDGET_MS` 加 env 覆盖（如 `LAN_SCAN_BUDGET_MS`），engine-check 可再跑一轮 2s 预算的强制超支扫描，确定性断言"超预算仍出含设备快照"。不改机制时也可用 fake-timer 单测覆盖 deadline 逻辑。

**若暂不动机制（不推荐）**：只能按分段推导——arp1/arp2 ≤ 2200、ping ≤ 11700、ports ≤ ceil(candidates/24)×700+1000、hostnames ≤ 1600、total ≤ 各段和+500。缺陷：arp2 回退路径合法耗时可达 ~10s，分段线分不清"慢"与"坏"。

### 风险

- exec.ts 为所有发现路径共享：sweepTree 开关收窄后，PowerShell 强杀场景的进程树清剿必须保留（R-05 教训），需回归 `runPowerShell` 超时路径。
- ports 中途 abort 意味着部分候选无端口数据：端口只作"增量在场证据"，状态机有 arpMissStreak TTL 缓冲，下一轮补全；可接受。
- 12500 断言线随 SCAN_BUDGET_MS 联动，改预算常量时必须同步（用常量推导即自动联动）。
- 真机验证：修复后连跑 3 次 engine-check 确认 total 稳定 < 11.5s 且 devices/printers 断言不回归。

---

## B-2 ubus 通道端到端验证可行性

### 现状证据

- 客户端：`src/main/engine/router/openwrt.ts` — `UbusClient`（:154-249）；构造 `gatewayIp: string`（:158-162，无端口类型约束）；`login` 发 `raw(['session','login',{username,password,timeout:3600}])`（:170）；`call` 发 `raw([session,object,method,params])`，无会话返回 `auth-required`（:190-193）；`raw` 拼 `http://${gatewayIp}/ubus` POST（:220），错误分支：transport 抛错→message、非 200→`HTTP ${status}`、JSON 解析失败→"ubus 响应不是合法 JSON"、`obj.error`→`ubusErrorMessage`、`result` 非数组或 `result[0]!==0`→错误文案（:224-247）。
- `defaultTransport`：`new URL(url)` 取 `port = Number(u.port) || 80`、`path = u.pathname`（:23-34）。
- `httpRequest`：node:http，超时即 destroy 并 settle，不悬挂（`httpx.ts:31-84`）。
- 生产实例化：`src/main/engine/router/index.ts:74` `new UbusClient(gw)`（gw 为引擎探测的网关 IP，无端口）；`:178-182` 刷新时 `Promise.all([dhcpLeases, wirelessClients, board])` **三路并发** ubus 调用。
- 既有测试：`tests/router-openwrt.test.ts` **全部 transport 注入**——`defaultTransport`/`httpRequest`/URL 拼装/超时路径**零覆盖**。

### 协议形状核验（对真实 OpenWrt ubus）

依据：uhttpd `ubus.c` 源码（`parse_call_params` / `uh_ubus_allowed` / `json_errors` 逐字）、openwrt.org 官方 ubus 文档、OpenWrt 论坛实证帖。

| 形状 | 客户端实现 | 真实 ubus | 判定 |
|---|---|---|---|
| 请求 | POST /ubus，`{jsonrpc:'2.0',id,method:'call',params:[sid,obj,method,data]}` | 同（legacy 路径 sid 取 params[0]） | ✅ 一致 |
| 登录 | `params[0]='session'`（openwrt.ts:170） | 必须为 **`'00000000000000000000000000000000'`**（32 位零 null-session，"just has enough access rights for the session.login call"） | ❌ **不一致（真 bug）** |
| 成功响应 | `{result:[0,data]}`，取 `result[1]` | 同；login 响应含 `ubus_rpc_session/timeout/expires` | ✅ 一致 |
| 错误响应 | `{error:{code}}` → ubusErrorMessage | 同；码表：-32000 Object not found / -32001 Session not found（定义但从未使用）/ **-32002 Access denied（无效 sid 一律走这里）** / -32003 timeout / -3260x JSON-RPC 标准 | ⚠️ 部分错位 |
| 错误码映射 | -32002→"用户名或密码错误"；-1→"无权访问"；-32000→"方法不存在"（:37-50） | -32002 同时表示**登录被拒与会话失效/无权**（官方文档：expired session → -32002）；真实从不返回 -1；固件还可能走 `result:[6,...]`（UBUS_STATUS_PERMISSION_DENIED） | ⚠️ 误导 + 死映射 |

**登录 sid 缺陷的实证**：uhttpd 对任何非 null-session 调 `session.login`，`uh_ubus_allowed` 向 session 守护进程查询 access 得 false → 返回 `{"error":{"code":-32002,"message":"Access denied"}}`（论坛实证：params[0]='' → Access denied；params[0]=32 零 → 登录成功）。且 legacy 路径下 sid **只**来自 params[0]（Authorization Bearer 头仅用于 `/ubus/call/` REST 路径），不存在"无请求头即默认 null session"的侥幸。**结论：按现状，真机 OpenWrt 登录必然以 -32002 失败，且错误文案显示为"用户名或密码错误"，与真密码错误无法区分。**

### 本地 ubus 形状 e2e：可行性评估

**完全可行，且是当前测试矩阵最值得补的一块。** 依据：

- `new UbusClient('127.0.0.1:<port>')` → `gatewayIp='127.0.0.1:PORT'` → `http://127.0.0.1:PORT/ubus` → `new URL()` 正确解析 → `httpRequest({hostname:'127.0.0.1', port:PORT, path:'/ubus'})` → **真实 node:http 全链路**（非注入）。`'host:port'` 写法与 `defaultTransport` 的 URL 拼装**兼容**（`Number(u.port)||80` 兜底也不受影响）。
- `node:http.createServer().listen(0)` 取随机端口，vitest beforeAll/afterAll 起停，纯 Node、不碰 Electron、无网络外联。
- **假服务器必须"严格"才有意义**：复刻 `uh_ubus_allowed` 语义——非 32 零 sid 调 `session.login` → -32002；未知 sid 调其他对象 → -32002。宽松假服务器会让上面的 login-sid bug 继续隐身（现有注入式测试正是如此）。

### 必须覆盖的边界清单

1. **login 成功**：32 零 sid → 下发 `ubus_rpc_session`；断言后续 call 的 `params[0]` 确实带上该 token。
2. **login 失败 -32002**（错密码）：`ok:false`、文案含"用户名或密码错误"、`loggedIn=false`、session 被清空。
3. **会话失效**：以未知/已销毁 sid 调 `system board` → -32002（真实语义）；若修好文案，断言 call 路径提示"会话过期/重新登录"。
4. **非 200**：服务器回 404/500 → `HTTP 404` / `HTTP 500`。
5. **非法 JSON**：回 `<html>...` → "ubus 响应不是合法 JSON"。
6. **对象/方法不存在 -32000** → "方法不存在"文案。
7. **`result:[6,...]` 权限拒绝路径** → 当前落 default 分支；补映射后断言友好文案。
8. **并发/串行时序**：RouterManager 式 `Promise.all` 三连发（board+getDHCPLeases+getWirelessDevices）→ 服务器**乱序回包**，客户端不串味；`rpcId` 逐次递增（1,2,3…）可断言。
9. **超时**：服务器 delay 3000ms > `ROUTER.ubusTimeoutMs(2500)` → `timeout after 2500ms`，且不悬挂（httpRequest 的 destroy+settle 路径）。
10. **auth-required 短路**：未登录 call 不发请求（服务器请求计数 = 0）；logout 后 call 同样短路；重新 login 可恢复。
11. **传输层回归网**（defaultTransport 专属）：断言服务器实际收到 POST `/ubus`、`Content-Type: application/json`、body 为合法 JSON-RPC（含 jsonrpc/id/method/params 四字段）。

### 修复方案

1. `openwrt.ts` 导出 `const UBUS_NULL_SESSION = '0'.repeat(32)`，`login` 改发 `raw([UBUS_NULL_SESSION, 'session', 'login', {...}])`（**核心修复**）。
2. `ubusErrorMessage` 语境化：login 路径 -32002 → "用户名或密码错误"；call 路径 -32002 → "会话已过期或无权限，请重新登录"；补 `6 → 权限拒绝`；`-1/-2` 加注释说明无真实来源（保留无害）。
3. 新增 `tests/router-ubus-e2e.test.ts`：严格假 ubus + 上述 11 条边界（其中 1/3/8/11 直接锁死 defaultTransport 与 sid 语义）。
4. （可选）`raw()` 校验响应 `id` 与请求 `id` 一致——真 ubus 会回显，当前忽略；一行断言的事。

### 风险

- login-sid 修复是**真机行为变更**：本机无 OpenWrt 路由器，无法硬件端到端；依据是 uhttpd 源码 + 官方文档 + 论坛实证三重证据，建议修复后找一台真机 OpenWrt 手验 login→board 一次。
- 假服务器是"形状复刻"而非完整语义（ACL 细节、`timeout/expires` 字段、`ubus_noauth` 模式差异），需在测试头注释声明。
- 并发断言依赖事件循环时序：用请求计数与 id 递增断言，避免 wall-clock 时序断言。

---

## B-3 safeStorage 弃用 API

### 现状证据

- `src/main/router-store.ts`（全文 66 行）四个导出：
  - `canPersistCredentials()` :24-30 → `safeStorage.isEncryptionAvailable()`（同步）
  - `saveCredentials()` :32-44 → `safeStorage.encryptString(password).toString('base64')`（同步）
  - `loadCredentials()` :46-57 → `safeStorage.decryptString(Buffer.from(passwordEnc,'base64'))`（同步；注意实际方法名是 `decryptString`）
  - `clearCredentials()` :59-65 → 纯 `fs.rmSync`，**无需改**
- Electron 版本：`package.json:24` `"electron": "^45.0.0"`。
- 本地权威类型（`node_modules/electron/electron.d.ts:12705-12793`，即 Electron 45）：三个同步方法均带 `@deprecated`；异步替代签名——
  - `isAsyncEncryptionAvailable(): Promise<boolean>`（:12774）
  - `encryptStringAsync(plainText: string): Promise<Buffer>`（:12743）
  - `decryptStringAsync(encrypted: Buffer): Promise<Electron.DecryptStringAsyncReturnValue>`（:12729），返回 **`{ shouldReEncrypt: boolean; result: string }` 对象而非字符串**（:12720-12728）
- 官方确认（Electron 45.0 release blog + breaking-changes 页 + safe-storage 文档）：同步 API 弃用，**Electron 46 移除**（跟随 Chromium 移除同步 OSCrypt 后端）；异步 API 使用**同一套平台密钥库**（Windows 同为 DPAPI，安全模型一致），另支持 key rotation（`shouldReEncrypt`）与临时不可用处理；d.ts:12713-12715 与文档双重明示：**"Data encrypted with safeStorage.encryptString can be decrypted with safeStorage.decryptStringAsync"**。
- Windows DPAPI 后端下同步 API 在 45 仍可用（弃用但功能正常）；移除点在 46。

### 迁移方案（router-store.ts，约 10 行）

```ts
export async function canPersistCredentials(): Promise<boolean> {
  try { return await safeStorage.isAsyncEncryptionAvailable(); } catch { return false; }
}
export async function saveCredentials(user: string, password: string): Promise<{ ok: boolean; error: string | null }> {
  if (!(await canPersistCredentials())) return { ok: false, error: '系统密钥环不可用，凭据不会被保存（每次启动需重新登录）' };
  try {
    const enc = (await safeStorage.encryptStringAsync(password)).toString('base64'); // 返回值仍是 Buffer，落盘格式不变
    fs.writeFileSync(storePath(), JSON.stringify({ user, passwordEnc: enc } satisfies StoredCredentials), 'utf8');
    return { ok: true, error: null };
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}
export async function loadCredentials(): Promise<{ user: string; password: string } | null> {
  if (!(await canPersistCredentials())) return null;
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const data = JSON.parse(raw) as StoredCredentials;
    if (typeof data.user !== 'string' || typeof data.passwordEnc !== 'string') return null;
    const { result } = await safeStorage.decryptStringAsync(Buffer.from(data.passwordEnc, 'base64')); // 注意：返回对象，取 .result
    return { user: data.user, password: result };
  } catch { return null; }
}
// clearCredentials 保持同步不变
```

细节：异步版失败是 **reject** 而非返回 null——现有 try/catch 已覆盖；`loadCredentials` 多一次 `await`（可用性检查+解密各一次），启动路径无感；`shouldReEncrypt === true` 时可顺手用新密钥重存（key rotation，可选增强）。

### 调用方联动（共 2 处，均 trivial）

- `src/main/ipc.ts:46-54` `routerLogin`：handler 本就 `async` → `const saved = await saveCredentials(...)`。**返回结构 `{ok,error,persisted,persistError}` 不变 → 渲染层 `RouterView.tsx:108` 零改动。**
- `src/main/ipc.ts:55-59` `routerLogout`：只调 `clearCredentials()`（仍同步）→ **无需改动**，保持同步 handler。
- `src/main/index.ts:83-84`：在 `async bootstrap()` 内 → `const saved = await loadCredentials(); if (saved) routerManager.restoreSession(saved.user, saved.password);`。
- `preload.ts` / `shared/types.ts` / `RouterView.tsx` / `router/index.ts`：**零改动**（IPC 边界与 RouterManager 接口不变）。全仓库无其他调用方（`smoke.ts` 不碰凭据）。

### 既有密文兼容性

**兼容，无需迁移、无需用户重新登录。** 同步 `encryptString` 产出的 DPAPI 密文可被 `decryptStringAsync` 解密（d.ts:12713-12715 + breaking-changes 双出处）；base64 落盘格式不变。解密失败（换机器/换 Windows 用户/文件损坏）走 catch → null → 提示重新登录，与现行为一致。

### 风险

- **不迁移才是最大风险**：`^45.0.0` 允许 npm update 拉入 46+，届时同步 API 被移除——`saveCredentials` 每次抛错被 catch 成"凭据不会被保存"、`loadCredentials` 恒 null，**静默功能退化**。建议随本次收尾迁移（diff 极小）。
- 测试缺口：`router-store.ts` import electron，现有 vitest 不覆盖——迁移无可跑单测；至少保证"密钥环不可用→拒绝落盘"文案不变，真机启动验证一次"保存→重启→恢复登录"链路。
- 平台差异（低相关）：Linux 下异步 API 用可插拔 key provider，无 secret service 时回退 basic_text（等价"不加密"）；macOS 下同步 API 的 Keychain 阻塞提示在异步版消失（纯收益）。本项目为 Windows 局域网应用（package.json description），影响面为零。
- 文档同步：`ARCHITECTURE.md:274` 仍写"必须经 safeStorage.encryptString"，迁移时顺手更新为异步 API 表述。

---

## 附：实测产物

- `.agent-runs/2026-10-25/task-002/artifacts/engine-run1.json`（total 19028ms，断言 FAIL）
- `.agent-runs/2026-10-25/task-002/artifacts/engine-run2.json`（total 22130ms，断言 FAIL）
- 受控实验原始输出见上文表格（未落盘；实验仅复用引擎自身的 spawn 行为，未写入任何项目文件）。
