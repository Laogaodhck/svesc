# 测试报告 — 测试工程师 Tess（task-002 Phase 3）

| 字段 | 值 |
|---|---|
| 范围 | 仅 `tests/**`；**未修改任何 `src/**`、`package.json`、`vitest.config.ts`** |
| 命令 | `cd C:/github/svesc && npx vitest run` |
| 自验 | **19 文件 / 378 用例 / 378 通过 / 0 失败 / exit 0 / 4.29s**；`tests/router-ubus-e2e.test.ts` 连跑 20 次 0 红 |
| 类型检查 | `npx tsc --noEmit -p tsconfig.node.json` → 0 error；改动/新增测试文件按 tsconfig.base 配置独立复跑 → 0 error |
| 结论 | **PASS**。Phase 3 三任务（替身适配 / 白盒转纯函数 / ubus e2e）+ sessionInvalid 语义两轮补断言（客户端层 6 条 + 编排层 9 条）+ ⑧ 抖动修复（集合语义，20 连跑 0 红）+ caps 解耦（D-017）后断言翻转与新增。未发现实现缺陷；2 条观察点均已闭环（见 §4） |

> 时间线说明：本报告 10:07 成稿时为 362/362。此后 Max-1 定性"调用失败不清会话"为疏漏并修复 `openwrt.ts`（sessionInvalid + `raw()` 内作废会话），我又补客户端层 6 条 + 编排层断言；10:37 按 team-lead 派单修掉 ⑧ 的到达顺序抖动（改集合语义，20 连跑 0 红）；10:46 按 D-017（caps 与会话正交）翻转 caps 断言并新增 logout 用例。team-lead/Max-1 早前看到的 348 基线与"e2e 文件不存在"是消息交错时的旧状态。当前总数 378 = 348（task-002 开工基线）+ 6（sessionInvalid 客户端层）+ 1（e2e ③-反）+ 9（RouterManager 集成）+ 14（Phase 3 其余：WarningLog 纯函数 10 条中 3 条净增、sid 显式断言等见 §1）。

---

## 1. 本阶段用例清单

| # | 文件 | 动作 | 用例数 | 结果 |
|---|---|---|---:|---|
| 1 | `tests/router-openwrt.test.ts` | **修**（替身下标 + 严格复刻 + sid 显式断言）→ **扩**（sessionInvalid 6 条） | 13 → 19 | 19 通过 |
| 2 | `tests/scheduler-resilience.test.ts` | **改**（白盒 → 纯函数） | 37（原 34：WarningLog 纯函数由 7 → 10，另 +1 集成） | 37 通过 |
| 3 | `tests/router-ubus-e2e.test.ts` | **新增** → **扩**（③ 补作废断言 + ③-反） | 11 → 12 | 12 通过 |
| 4 | `tests/router-manager.test.ts` | **新增**（RouterManager 集成，sessionInvalid 编排层投影）→ **扩**（D-017 后 caps 翻转 + logout 用例） | 9 | 9 通过 |
| | **合计** | | **378（全仓）** | **378 通过 / 0 失败** |

> 全仓 19 文件 / 378 用例。上一轮全仓 348 例里唯一的红（`router-openwrt.test.ts` 的 `login 成功缓存会话`）本轮归零。

---

## 2. 覆盖边界

### 2.1 任务 1：`tests/router-openwrt.test.ts`（B-2 替身适配）

| 改动 | 内容 |
|---|---|
| 登录识别下标 | `p[0]==='session' && p[1]==='login'` → `p[1]==='session' && p[2]==='login'`（params 形状是 `[sid, object, method, args]`）。**随协议形状更新的原因**：B-2 把 login 请求改成 `[32位零 sid, 'session', 'login', {...}]`（真实 OpenWrt uhttpd 只接受 32 位零 null-session，否则 -32002），替身必须按同一形状识别，否则永远命中"未登录"分支 |
| 替身升级为"严格复刻" | 非 32 位零 sid 的 login 一律回 `-32002`；错用户名/密码同样 `-32002`（原来只要命中 login 就无条件发令牌，B-2 bug 会被这条替身永久掩盖） |
| sid 形状显式断言（Max-1 建议） | `expect(calls[0]?.[0]).toBe(UBUS_NULL_SESSION)`，失败消息写明"uhttpd 的 uh_ubus_allowed 只接受它"。**为什么替身拒绝之外还要这一行**：替身拒绝只会让 `login.ok` 变 false，错误指向 -32002"用户名或密码错误"，排查方向会被带偏；显式断言直接点名"sid 形状不对" |
| 既有 12 条断言核对 | `ubusErrorMessage(-32002)` 默认 login 语境 = "用户名或密码错误" ✅；`-1` = "无权访问"（真实 ubus 不返回此码，兼容保留）✅；`logout`/`auth-required`/非法 JSON/网络失败四条在新实现下语义不变 ✅ |

### 2.2 任务 2：WarningLog 纯函数（白盒 → 导出 API）

原白盒用例 poke 的是私有 `warnings` Map + `trimWarnings()`，Max-1 重构后这两个已不存在（实测 `TypeError: Cannot read properties of undefined (reading 'bind')`）。改为直接构造 `WarningLog` 实例，共 10 条：

| 覆盖点 | 用例 |
|---|---|
| 去重键（`source:message`） | `同一 source + message 连续 5 次只保留 1 条`、`同 message 不同 source 不得互相覆盖` |
| `at` 刷新 | `重复触发时 at 必须刷新为最后一次` |
| `clearSource`（自愈 / replaceWarnings 的 clear 段） | `clearSource 只清该 source 的条目`、`clearSource 后再 push 同 message 必须重新出现`（对应 replaceWarnings 的 clear+push 两段式） |
| 多文案入参（replaceWarnings 的 messages 数组） | `同一轮的 messages 数组可携带多条不同文案` |
| `list()` 排序与裁切（snapshotWarnings 语义） | `list() 必须按 at 升序`、`超过 20 条裁剪到 20 条且丢最旧` |
| 防御 | `list() 返回副本（外部 push 不污染内部）`、`at 可省略（默认 Date.now）` |

### 2.3 任务 3：`tests/router-ubus-e2e.test.ts`（真实 node:http 全链路，非注入）

文件头声明"**形状复刻而非完整 ACL 语义**"。假服务器 `listen(0)` 随机端口，严格复刻 uhttpd 门禁：`session.login` 只认 32 位零 null-session；非 login 调用的 sid 必须已下发；错密码 `-32002`；未知对象/方法 `-32000`；权限拒绝 `result:[6,{}]`；回显请求 `id`；`system.hang` delay 3000ms。

| 边界 | 用例 | 断言要点 |
|---|---|---|
| ① | `login 成功（32 位零 sid）→ 后续 call 的 params[0] 确实带上会话令牌` | 服务器视角：login 请求 `params[0] === UBUS_NULL_SESSION`，call 请求 `params[0] === 'S1'` |
| ② | `错密码 → -32002 → ok:false、文案"用户名或密码错误"、loggedIn=false` | 三项一次 `toEqual` |
| ③ | `会话被撤销后 call → -32002 → call 语语文案` | `'会话已过期或无权限，请重新登录'`（同一错误码两种语境的分流）；**本轮补断言**：`sessionInvalid===true` + `client.loggedIn===false`（会话当场作废）+ 作废后再 `call` 返回 `auth-required` 且**服务器请求计数不变**（不再拿死 sid 重试） |
| ③-反 | **新增**：`HTTP 500` 与 `result:[6]` 不得作废会话 | `Boolean(sessionInvalid)===false` 且 `loggedIn===true`，下一轮正常调用仍成功（防"任何失败都登出"做反） |
| ④ | `非 200 → HTTP 404 / HTTP 500` | 服务器模式开关，两条一次跑完 |
| ⑤ | `非 JSON 响应体 → "ubus 响应不是合法 JSON"` | 回 `<html>…` |
| ⑥ | `未知对象/方法 → -32000 → "方法不存在"` | `toContain` |
| ⑦ | `result:[6,{}] → "权限被拒绝"` | `UBUS_STATUS_PERMISSION_DENIED` |
| ⑧ | `并发三连发 + 服务器乱序回包 → 不串味，rpcId 集合严格连续` | board 延迟 50ms 最后回包；三个方法各自解析结果（hostname/租约数/无线客户端数与速率）全对；服务器收到的 id **排序后**等于 '2,3,4'、unique、连续、恰好 3 个 |
| ⑨ | `超时：server delay 3000 > ROUTER.ubusTimeoutMs(2500) → timeout 文案且不悬挂` | 文案由客户端常量推导（`timeout after ${ROUTER.ubusTimeoutMs}ms`），vitest 默认超时前 settle |
| ⑩ | `未登录 call 不发请求（服务器计数=0）；logout 后短路；重新 login 恢复` | auth-required 短路不得产生任何网络流量 |
| ⑪ | `传输层回归网：POST /ubus + application/json + 合法 JSON-RPC 四字段` | method/path/content-type + `jsonrpc`/`id`/`method`/`params` 四字段 |

**时序纪律**：除 ⑨ 外无任何 wall-clock 断言；并发 ⑧ 只用"服务器记录的请求计数 + id 序列"证明，不用 `setTimeout` 猜测；⑨ 用服务器 delay(3000) 与客户端常量(2500)的**确定差**触发。

**⑧ 抖动修复记录**（10:37，Max-1 定位 + team-lead 派单）：原断言要求服务器**按到达顺序**记录的 id 恒等于 `'2,3,4'`，但三个并发 HTTP 请求的到达顺序不确定（Node 单线程但 I/O 回调交错，TCP 到达顺序也不保证）——`requests.push` 在 `end` 事件里，实测约 1/3 概率红。根因是断言了一个 HTTP 不保证的性质；该用例真正要锁的"乱序回包不错位"由载荷七项断言证明。修法：id 断言改为**集合语义**——排序后等于期望连续区间 '2,3,4'、unique、连续、恰好 3 个，不断言到达顺序。改完连跑 20 次 0 红。教训：**并发场景里"顺序"是不可断言的，能断言的只有集合与一一对应关系**；抖动守卫比没有守卫更糟（会训练团队"红了先重跑"）。

### 2.4 sessionInvalid 客户端层（`tests/router-openwrt.test.ts` 新增 6 条）

Max-1 定性"调用失败不清会话"为疏漏（非有意设计）并已修：`openwrt.ts` 的 `raw()` 在两个错误分支（JSON-RPC error 对象与 `result` 码）计算 `sessionInvalid = context==='call' && code===-32002`，为真时当场 `this.session = null`。语义边界：**只有调用路径上的 -32002 代表会话死亡**；网络错误（`res.error`）、HTTP 非 200、`result:[6]` 都不得作废。

| 用例 | 断言要点 | 对应的失效模式（断言如何咬人） |
|---|---|---|
| 调用路径 -32002 → `sessionInvalid=true` 且会话当场作废 | `{ok, error, sessionInvalid, loggedIn}` 四项一次 `toEqual`：`error='会话已过期或无权限，请重新登录'`、`loggedIn=false` | 若修复回退（不清 session），`loggedIn` 实得 `true` → 红 |
| 作废后再 call → `auth-required` 且不再发请求 | 二次 call 返回 `auth-required`，**服务器请求计数不变** | 若 `call()` 不短路，会拿死 sid 再撞一次 -32002 → 红 |
| 反向：网络错误 → `sessionInvalid` falsy 且仍保持登录 | `Boolean(sessionInvalid)===false`、`loggedIn===true` | 防"任何失败都登出"做反：网络抖动被放大成持续故障 → 红 |
| 反向：HTTP 非 200 → 同上 | 服务器回 500，会话保持 | 同上 |
| 反向：`result:[6]` 权限拒绝 → 同上 | 单对象 ACL 拒绝不清会话 | 同上 |
| 反向：登录路径的 -32002 是密码错，不得被当成会话失效 | login 失败后 `loggedIn=false`（login 自己重置）但**不走 sessionInvalid 口径**：`sessionInvalid` falsy | 防把 login 语境的 -32002 误接到 call 语义 |

**踩坑记录**：写完首跑 6 条中 2 条红（`sessionInvalid:true` 但 `loggedIn:true`）——原因是我跑测试与 Max-1 把"清 session"从 `call()` 移入 `raw()` 两个分支**在时间上交错**。重跑即绿，断言零改动。教训：跨成员并行编辑时，先重读 src 再定性红，不急着改断言。

### 2.5 sessionInvalid 编排层（`tests/router-manager.test.ts` 9 条）

Max-1 的 RouterManager 层三处修复（`index.ts`）：`:221` `loggedIn` 派生 `this.ubus !== null && this.ubus.loggedIn`（原来是独立谎言）；`:187` 三个 ubus 调用的 `sessionInvalid` 透到 `doRefresh`；`:225` 观测到失效时 `session.error='路由器会话已过期，请重新登录'`。

mock 策略：**不注入替身客户端**——detect / upnp / httpx 三模块替换，`RouterManager` 与 `UbusClient` 全走真实代码（UbusClient 默认 transport → 被 mock 的 `httpRequest`），要验的正是"真客户端 + 真编排"的拼接。脚本按 JSON-RPC 请求体分发：login 发令牌、数据调用按场景回 -32002 / 网络错误 / 正常 payload。

| 用例 | 断言要点 |
|---|---|
| 三个调用全部 -32002 → 界面必须看到"未登录 + 会话过期原因" | `{loggedIn:false, user:'root', error:'路由器会话已过期，请重新登录'}` 一次 `toEqual`；**`capabilities.openwrt===true`**（能力位粘性，D-017）；leases/wireless 空、board null（数据不编造） |
| 失效后的下一轮 refresh：消息持续且不拿死 sid 重试 | `error` 不变（持续到重新登录）；ubus 请求计数不增加；**`capabilities.openwrt 仍为 true`**（D-017 后翻转，见 §2.6） |
| 重新登录成功后错误清零、数据通道恢复 | `{loggedIn:true, error:null}`；board hostname / leases / wireless 真实出数 |
| 反向①：三个调用全部网络错误 | `{loggedIn:true, error:null}`；且换正常脚本后同一客户端直接恢复出数（无需重新登录） |
| 反向②：board 成功 + leases 网络错误 + wireless 成功 | 不置位失效、登录保持；board/wireless 照常出数，leases 空但不连带会话 |
| 反向③：`result:[6]` 权限拒绝 | `{loggedIn:true, error:null}` |
| 反向④：HTTP 500 | `{loggedIn:true, error:null}`；换正常脚本后直接恢复出数 |
| logout() 后连续两轮 refresh | `capabilities.openwrt` 粘性保持 `true` 且 `session.loggedIn===false`；ubus 计数不增；按会话取得的数据被清空（D-017 后新增，见 §2.6） |
| 未登录 refresh 零 ubus 流量 | ubus 请求计数 = 0 |

### 2.6 caps 解耦（D-017）后的断言更新

**经过**：我在 §2.5 初版把"会话过期后下一轮 `caps.openwrt===false`"锁成了断言（依据是当时转述的"既有设计"）。team-lead 随后重新定性：那是**疏漏不是设计**——"支持 OpenWrt 的路由器在会话过期/登出后显示为该路由器不支持"违反数据诚实原则。Max-1 落地修复：`openwrtCapable` 进程级粘性位（`index.ts:50`，登录成功或探测到 openwrt 指纹即置 true，只进不退），`logout()` 不动 capabilities，`doRefresh` 的 `caps.openwrt = openwrtCapable || identity.brand==='openwrt' || 会话活着`。

**为什么这是升级不是放宽**：新断言"会话过期后 caps.openwrt 必须保持 true"比旧断言"必须回 false"**更强**——
- 旧口径允许" caps 撒谎"（能力随登录态消失）；新口径要求 caps 只反映协议能力，会话维度交给 UI 的 CapRow note 分支（"已登录 / 登录后可查看"）表达。
- 断言数量净增（+1 logout 用例），且覆盖了两个旧断言没有的方向：logout 之后连续两轮仍 true（旧实现在 logout 后第一轮就会 false）。
- **变异验证**：把翻转后的断言期望临时改回 `false` 重跑，该用例立刻红（`expected true to be false`）——证明新断言真的钉住了修复后的行为，不是空转；随后还原。

**已按规格不测的边界**（Max-1 报备，设计使然）：粘性为进程级（运行中换网关时 caps 保持 true 至重启，但 identity 重建 + 登录会明确失败，不静默误导）；网关未知的早退路径仍全量重置 caps。

---

## 3. 运行输出摘要

```
 RUN  v3.2.7 C:/github/svesc
 ✓ tests/router-ubus-e2e.test.ts (12 tests) 2656ms
 ✓ tests/router-manager.test.ts (9 tests) 1.5s
 ✓ tests/scheduler-resilience.test.ts (37 tests) 21ms
 ✓ tests/router-openwrt.test.ts (19 tests) 2ms
 ✓ tests/alarms.test.ts / printer-mib.test.ts / printer-service.test.ts …
   （其余 15 个文件全绿）
 Test Files  19 passed (19)
      Tests  378 passed (378)
   Duration  4.29s
```

`tsc --noEmit -p tsconfig.node.json` → 0 error；三个改动/新增测试文件按 tsconfig.base 配置独立复跑 → 0 error。
`tests/router-ubus-e2e.test.ts` 修完 ⑧ 后连跑 20 次 → 0 红。

**红→绿证据**：
1. 开工前 `tests/router-openwrt.test.ts` 有 1 红（`expect(login.ok).toBe(true)` 实得 `false`）——替身 `p[0]==='session'` 与 `[32位零,'session','login',…]` 不匹配，落进未登录分支拿到 `result:[-1]`。修正下标并加固替身后 0 红，**断言方向未放宽**。
2. sessionInvalid 客户端层 6 条首跑 2 红（实现未同步，详见 §2.4 踩坑记录），Max-1 的修复到位后零改动转绿。
3. ⑧ 抖动修复：原断言到达顺序（约 1/3 概率红），改为集合语义后 20 连跑 0 红（详见 §2.3 修复记录）。
4. caps 断言翻转（D-017）：旧口径"下轮回落 false"改为"保持 true"，旧期望重跑立刻红（变异验证，详见 §2.6）。

---

## 4. 观察点（未写成断言，回报给 Max-1 / team-lead）

**观察点 1（已闭环）：`UbusClient` 调用失败不清会话**——Max-1 定性为疏漏并已修（sessionInvalid + `raw()` 内作废），Tess 已补客户端层 6 条 + 编排层 8 条断言（§2.4 / §2.5）。

**观察点 2（已闭环，且随设计裁决翻转过一次）：caps.openwrt 与登录态的正交性**——我最初报"会话过期后下一轮 caps 回落 false"疑为副作用，Max-1 与 team-lead 先确认为"既有设计"（我据此锁了双向断言）；随后 team-lead **重新定性为疏漏不是设计**（D-017：支持 OpenWrt 的路由器在会话过期/登出后显示为"不支持"违反数据诚实），Max-1 落地 `openwrtCapable` 进程级粘性修复。我随裁决把"下轮 false"断言翻转为"下轮仍 true"并新增 logout 两轮用例——**新断言比旧断言更强**（caps 只反映协议能力，会话维度交 UI 的 CapRow note 分支），且做了变异验证（旧期望重跑立刻红）。详见 §2.6。

---

## 5. 未覆盖项与理由

| 未覆盖 | 理由 |
|---|---|
| 完整 ubus ACL / 权限对象树 | 假服务器只做"形状复刻"（文件头已声明）；真机 ACL 需要 OpenWrt 设备 |
| 多会话并发与过期回收 | 单会话 'S1' 足够覆盖 sid 门禁；多会话是服务端行为，客户端无感 |
| `https` 自签证书路径（`rejectUnauthorized`） | 需要自签证书 fixture；`httpx` 的证书分支由 Max-1 的 `router-*` 用例覆盖 |
| UPnP / 路由器轮询（`router/index.ts` 等） | RouterManager 集成断言只覆盖 sessionInvalid 投影与 caps 粘性（§2.5 / §2.6）；UPnP 由 `router-upnp.test.ts` 覆盖，轮询定时器属主进程装配层 |
| `reboot()` 的 UPnP 分支 / `restoreSession()` 失败路径 | 与 sessionInvalid 语义无关，属既有 task-002 范围；`reboot` 的 OpenWrt 分支要求 `loggedIn` 已由 §2.5 反向①②③ 间接锁定 |

---

## 6. R-05 真进程断言迁入（`tests/exec-real.test.ts`，team-lead 追加任务）

**背景**：Ray-2 审查裁决 `scripts/fixes-check.mjs` 是孤儿（零引用、不在 vitest 门禁、27/36 与 tests/ 重复且 poke 私有字段），但其 R-05 九条走**真 spawn**（强杀、闸门、execStats 观测），是 `tests/exec-fallback.test.ts`（vi.mock spawn + fake timers）覆盖不到的真实缺口。迁移期间 Max-1 已把该脚本删除（重构为 `engine-check.mjs`，不含 R-05 块）；九条断言的原文以我迁移前留存的 grep 记录为准。

### 6.1 九条断言的迁移映射

| 原断言（fixes-check.mjs R-05 块） | 新用例（exec-real.test.ts） | 说明 |
|---|---|---|
| 超时子进程返回 timedOut=true | ① 超时子进程返回 timedOut=true 且 await 正常返回 | 命令从 cmd/c ping 换成保留的 cmd/c ping（既有用例） |
| 超时后立即 settle（**elapsed<4000**） | 拆解为三处行为断言（①②③），**wall-clock 断言删除** | 见 §6.2 |
| 收口后 execStats().children===0 | ② 强杀收口后子进程闸门归零 | 真实 Gate 计数，mock 覆盖不到 |
| 闸门已释放：紧随命令正常执行（'gate-ok'） | ③ 紧随其后的命令在宽超时内正常执行 | 替代 elapsed 断言的行为证明 |
| 超时路径不 spawn taskkill（叶进程） | ④ 负例 + ④ 阳性对照（两条） | 见 §6.3，这是本次迁移新增的观测能力 |
| PowerShell 单飞通道在超时后仍可用 | ⑦ Write-Output 1 → '1' | 既有用例 |
| PowerShell 超时也返回 timedOut | ⑤ Start-Sleep 60 + 600ms 超时 | 既有用例 |
| PowerShell 超时后 powershellBusy===0 | ⑥ 单飞闸门归零 | 与 ⑤ 合并为一条 |
| 正常退出路径未被兜底定时器污染（code=3） | ⑧ cmd /c exit 3 → code 3、timedOut=false | 既有用例 |

### 6.2 wall-clock 断言的改写

原 `elapsed<4000` / `<1500` 删除——它们测"本机快不快"，高负载机器必然抖动。替换为三层行为证明：
1. **不悬挂**：`await` 在 15s testTimeout 内返回即证明 settle（只 kill 不 settle 的旧缺陷会让 Promise 永久 pending 直接撞超时红）。
2. **闸门真的释放**：settle 后 `execStats().children===0`（②）。
3. **闸门可用**：settle 后紧接的命令在宽超时内完整执行拿到输出（③，10s 宽边界，任何环境抖动不触线）。

### 6.3 ④ 的观测通道（本次的核心工程决策）

**问题**：叶进程超时"没有 spawn taskkill"是个否定性事实，真进程侧如何可靠观测？

**探索过程（三条路，前两条实测走不通，记录避免复踩）**：
1. **孙进程死活**：子进程派生长跑孙进程，taskkill /T 会杀孙进程。实测本沙箱（WorkBuddy 环境）里子进程退出——**无论自然退出还是被 kill——都会连带收割孙进程**，孙进程死活不携带"有没有 taskkill"的信息。弃用。
2. **PATH 注入假 taskkill**：CreateProcess/libuv 的搜索序里 System32 硬编码在 PATH 之前，同名假 exe 永远赢不了。死路。
3. **当前目录拦截（可行，已校准）**：libuv 的可执行解析把**当前目录**排在 System32 之前（实测证实）。在临时目录放 node.exe 副本冒充 `taskkill.exe` + `NODE_OPTIONS --require` 钩子，把"我被调用了"连同实参写成标记文件。

**钩子匹配条件的一个坑**：exec.ts 传 `['/T','/F','/PID',pid]`，node 把 `/T` 解析成 `<盘>:\T`（argv[1] = `'C:\\T'`，**不是**字面 `'/T'`）——按字面匹配会静默不写标记，第一版阳性对照因此假红。修正为 `/\T$/i.test(argv[1]) && argv[2]==='/F' && argv[3]==='/PID'`。

**两侧断言**：
- 负例：默认 `runNative`（无 sweepTree）超时后宽限 2s，标记**不得出现**。
- 阳性对照：`{sweepTree:true}` 超时后标记**必须出现**且内容匹配 `swept … /F /PID \d+`（证明 taskkill 真的被 spawn 且携带清剿实参）。没有阳性对照的阴性断言是空转守卫——检测链路坏了它照样绿。

**作用域纪律**：chdir + NODE_OPTIONS + MARKER 的改动严格限制在两条 ④ 用例内部（try/finally 还原 cwd 与环境变量），不影响同文件其余用例（其间它们的清剿走真 taskkill）。

### 6.4 顺带发现与修复

| 项 | 处置 |
|---|---|
| 既有文件头声称"taskkill 覆盖由 exec-fallback.test.ts 用例 2 的 spawnMock 计数断言承担" | **不实**：该用例只数了两次 PS spawn，无任何 taskkill 计数。已改写头注释（否则会误导后人跳过真进程侧） |
| `runPowerShell` 的 `timeoutMs` 参数无类型注解，TS 从默认值（as const 的 8000）把参数类型收窄成字面量，传 600 编译错 | 测试侧用显式签名视图 `runPowerShellWithTimeout` 绕过（不放宽运行时行为）；**正解是 src 侧补 `: number`，已报 Max-1** |
| 独立 tsc（tsconfig.base strict 直查测试文件）此前从未覆盖 tests/** | 两个任务的测试文件均已过 strict 检查 0 error |

### 6.5 运行结果

```
npx vitest run tests/exec-real.test.ts → 8 passed（既有 6 + 新增 ④ 两条）
连跑 3 次 → 0 失败
npx vitest run（全量）→ 26 文件 / 441 用例 / 441 通过 / 0 失败 / exit 0
tsc（tests/exec-real.test.ts strict 独立检查）→ 0 error
```
