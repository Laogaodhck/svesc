# Brief — 测试工程师 Tess（task-002 Phase 3）

**背景**：Max-1 完成三条边界的实现（报告：`.agent-runs/2026-10-25/task-002/implement-report.md`）。实现侧 vitest 340/342，2 条红在**你的文件**里，属"替身过期"而非实现回归。本阶段你只写/改测试文件。

**先读**：`src/main/engine/router/openwrt.ts`（Max 改后的现状）、`src/main/engine/scheduler.ts:110-180`（WarningLog 新形状）、`tests/router-openwrt.test.ts`、`tests/scheduler-resilience.test.ts`。

## 任务 1：修 `tests/router-openwrt.test.ts:113` 附近（B-2 必然结果）

Max 把 ubus login 请求从 `['session','login',{...}]` 改为 `['000…0(32位)','session','login',{...}]`（真实 OpenWrt 只接受 32 位零 null-session，否则 -32002）。文件中假 transport 用 `p[0]==='session' && p[1]==='login'` 识别登录，已失效。改为 `p[1]==='session' && p[2]==='login'`。同步确认 12 条既有断言在新实现下语义正确（尤其 `ubusErrorMessage(-32002)` 默认 login 语境含"用户名或密码错误"、`-1` 含"无权访问"保留）。

## 任务 2：`tests/scheduler-resilience.test.ts:390-406` 白盒用例适配

Max 把 WarningLog 从私有方法重构为导出的纯函数类（`src/main/engine/scheduler.ts:117` 附近）。读该类真实 API 后，把原白盒用例改写为**纯函数单测**：直接构造 WarningLog 实例，覆盖 replaceWarnings / trimWarnings（上限 20）/ snapshotWarnings 排序与裁切 / 去重键。不得再通过 Scheduler 私有内部路径断言。

## 任务 3（重点）：新建 `tests/router-ubus-e2e.test.ts` —— 真机协议端到端

**目标**：用 node:http 在 `127.0.0.1` 起"严格复刻 uhttpd 语义"的假 ubus 服务器（`listen(0)` 取随机端口），`new UbusClient('127.0.0.1:' + port)` 走**真实 defaultTransport + node:http 全链路**（非注入）。这正是 task-001 报告中"未端到端验证"边界的闭环。

**假服务器必须严格的点**（宽松会让 login-sid bug 继续隐身）：
- `session.login` 只接受 `params[0] === '0'.repeat(32)`；其他 sid 一律回 `{error:{code:-32002,message:'Access denied'}}`。
- 非 login 调用：`params[0]` 必须是已下发会话 → 否则 `{error:{code:-32002}}`。
- 登录成功：校验用户名密码（root/secret），回 `{result:[0,{ubus_rpc_session:'S1',timeout:3600,expires:3600}]}`；错密码回 `{error:{code:-32002}}`。
- 未知对象/方法回 `{error:{code:-32000}}`；权限拒绝路径回 `{result:[6,{}]}`。
- 回显请求 `id`；支持一个特殊方法（如 `system.hang`）delay 3000ms 后再回，用于超时测试。

**必须覆盖的 11 条边界**：
1. login 成功（32 零 sid）→ 后续 call 的 `params[0]` 确实带上会话令牌（服务器记录请求体断言）。
2. login 失败 -32002（错密码）→ `ok:false`、文案含"用户名或密码错误"、`loggedIn=false`。
3. 会话失效：以未下发 sid 调 `system board` → -32002 → 文案为"会话已过期或无权限，请重新登录"（call 语境）。
4. 非 200：对某路径回 404/500 → 错误文案 `HTTP 404` / `HTTP 500`。
5. 非法 JSON：回 `<html>...` → "ubus 响应不是合法 JSON"。
6. -32000 → "方法不存在"文案。
7. `result:[6,{}]` → "权限被拒绝"文案。
8. 并发时序：`Promise.all([board, dhcpLeases, wirelessClients])`，服务器**乱序回包**（如 board 延迟 50ms）→ 客户端不串味；rpcId 逐次递增（服务器记录 id 序列断言 1,2,3）。
9. 超时：`system.hang` delay 3000ms > ROUTER.ubusTimeoutMs(2500) → 错误含 `timeout after 2500ms`，且不悬挂（vitest 默认超时前必须 settle）。
10. auth-required 短路：未登录 call 不发请求（服务器请求计数=0）；logout 后同样短路；重新 login 恢复。
11. 传输层回归网：服务器实际收到 POST `/ubus`、`Content-Type: application/json`、body 为合法 JSON-RPC（含 jsonrpc/id/method/params 四字段）。

**约束**：禁 wall-clock 时序断言（除超时用例用服务器 delay + 客户端常量推导）；并发断言用请求计数与 id 序列；文件头注释声明"形状复刻而非完整 ACL 语义"。

## 完成判据

- `npx vitest run` 全量绿（当前 340/342 + 你新增后应 ≥ 353 全绿）。
- 测试报告写入 `.agent-runs/2026-10-25/task-002/test-report.md`：新增/修改用例清单、每条覆盖的边界编号、运行输出摘要。
- 若测试暴露实现 bug：**不改实现**，在报告中记录并回给队长。
- 最终回复只回状态块（STATUS / 报告路径 / 用例数），禁倒过程日志。
