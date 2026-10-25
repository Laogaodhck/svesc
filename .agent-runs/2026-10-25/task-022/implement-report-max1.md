# task-022 P1 实现报告（Max-1）

日期：2026-10-25
范围：B-1 记住密码开关 / B-2 会话失效自动重登 / C-1 DHCP 租约 hostname 回填

## 验收结果

- `tsc -p tsconfig.node.json`：0 error
- `tsc -p tsconfig.web.json`：0 error
- 全量 vitest：**499/503**，4 红（见「测试翻转通知」节，全部是锁定旧契约形状的断言，模式与 D-017 相同，待 Tess 翻转）
- 未跑 wall-clock 断言相关新测试（未新增测试文件，用例由 Tess 补）

## 文件级改动清单

### B-1 记住密码开关（默认 true，关闭即清盘上凭据）

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/shared/types.ts` | AppSettings | 新增 `rememberRouterPassword: boolean`（注释：默认 true；关闭即清除盘上凭据且后续登录不落盘；自动重登随之停用） |
| `src/main/engine/store.ts` | PersistedSettings 接口 | 新增同名字段 |
| `src/main/engine/store.ts` | defaultState() | settings 加 `rememberRouterPassword: true` |
| `src/main/engine/store.ts` | readFromDisk() 迁移读取 | `obj.settings?.rememberRouterPassword ?? true`（旧数据兼容） |
| `src/main/engine/db/sqlite.ts` | readSettings() | `pick('rememberRouterPassword', d.rememberRouterPassword)`（SQLite 主存储同步；round-trip 测试已验证通过） |
| `src/main/engine/index.ts` | getSettings() | 返回对象补字段 |
| `src/main/ipc.ts` | settingsUpdate 白名单 | 加 `'rememberRouterPassword'`；**true→false 翻转时立即 `clearCredentials()`**（rmSync force:true 幂等，文件不存在也安全，无需预查存在性） |
| `src/main/ipc.ts` | routerLogin handler | 登录成功后先查 `engine.getSettings().rememberRouterPassword`；false → 不落盘，返回 `persisted:false, persistError:'已关闭「记住密码」，凭据未保存'`（RouterView 既有 persistError 分支自动展示，渲染层零改动） |
| `src/renderer/views/RouterView.tsx` | 组件 | 新增 `remember` state（默认 true）+ settingsGet 回填 useEffect；onLogin 在 routerLogin **之前**先 `settingsUpdate({ rememberRouterPassword: remember })`（主进程按落定后的设置决定落盘与否，且 true→false 顺手清凭据）；登录表单追加原生 `<input type="checkbox">`（views.css 不许碰，用内联样式对齐，`disabled={loginBusy}`） |

设计说明：
- 清凭据只发生在 settingsUpdate 的 true→false 翻转沿；幂等操作不做预检查。
- RouterView 不直接调 lanApi 之外的清凭据通道——清凭据是主进程职责，渲染层只表达意愿。
- 回填 useEffect 失败静默保持 true：读不到设置不影响登录主链路。

### B-2 会话失效自动重登（invalidatedAt + 退避 + 3 次失败停用）

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/shared/types.ts` | RouterStatus.session | 新增 `invalidatedAt: number \| null`（注释：-32002 观测时刻，粘性保留直到重新登录成功或 logout） |
| `src/main/engine/router/index.ts` | 全部 8 处 session 字面量 | 全部带上 invalidatedAt：emptyStatus=null / login 失败=粘性保留（凭据错不改变"曾被服务端作废"的事实）/ login 成功=null + reloginFailures=0 / logout=null（并取消挂起 timer + 计数清零）/ markWebSession×2=spread 保留 / doRefresh unreachable=粘性保留（拿不到网关既非恢复也非失效证据）/ doRefresh 主路径=`sessionInvalid ? Date.now() : 粘性保留` |
| `src/main/engine/router/index.ts` | 新增 4 字段 | `reloginProvider`（凭据提供者，主进程注入）/ `reloginTimer` / `reloginFailures` / `reloginInFlight` |
| `src/main/engine/router/index.ts` | 新增 `setAutoRelogin(provider)` | 存 provider；provider 每次调用现读盘上密文，**引擎层不常驻明文密码** |
| `src/main/engine/router/index.ts` | 新增 `scheduleRelogin()` | 幂等守卫：provider null / timer 挂起 / 重登进行中 / ubus 已恢复 → 跳过；failures>=3 → 停用态只持续刷新 session.error='已停止自动重登（凭据可能已失效），请手动登录'；退避 `Math.min(60_000 * 2 ** failures, 10 * 60_000)`，timer unref |
| `src/main/engine/router/index.ts` | 新增 `runRelogin()` | finally 清 reloginInFlight；provider 返回 null → 静默停（开关关闭=用户退出，**不计失败**）；login 失败 → failures+1，<3 置 retry 标志，**finally 内清除 inFlight 之后**调 `scheduleRelogin()` 续链下一跳，=3 置停用文案。**打回修复（team-lead/Tess 探针）**：初版在 try 内、finally 清除之前调 scheduleRelogin()，被其 inFlight 幂等守卫拦截，纯内部调度下第二跳永远挂不出（退避链自续断裂，生产被 10s 轮询再触发遮蔽）。修复后 retry 标志在 finally 中 `reloginInFlight = false` 语句之后生效，内部链可自续；退避时长（60s×2ⁿ 封顶 10min）、3 次停用、logout 取消语义不变 |
| `src/main/index.ts` | bootstrap | `setAutoRelogin`：先查 `rememberRouterPassword` 再 `loadCredentials()`（每次现读）；startPolling 回调内 `invalidatedAt !== null && rememberRouterPassword` → `scheduleRelogin()`（粘性字段每轮触发，幂等守卫保证安全）+ `applyRouterHints` 灌 DHCP 租约 |

退避状态机说明：
- 触发源：主进程轮询回调（10s 一轮）。invalidatedAt 是粘性字段，会话失效后每轮都调 scheduleRelogin；幂等守卫（timer/in-flight/已恢复）防重复调度。
- 失败链：failures=0 → 等 60s → 失败 failures=1 → 等 120s → 240s → 480s → 600s（上限）→ 第 3 次失败即停用并置 error 文案（实际最多尝试 3 次）。
- 恢复路径：手动登录成功（login() 内）或自动重登成功（login() 内）都会 `reloginFailures = 0`；logout 取消挂起 timer 并清零计数（用户主动退出 ≠ 会话失效，重登违背用户意图）。
- 每轮重登都经 provider 现读凭据：用户中途关闭记住密码 → 下一轮 provider 返回 null → 静默停用，不残留明文。

### C-1 DHCP 租约 hostname 回填（仅 hostname 为空时）

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/shared/types.ts` | 新增 `RouterHints` | `{ leaseHostnames: DhcpLease[] }`（注释：单向提示、只读不持久化、绝不覆盖设备已有 hostname） |
| `src/main/engine/index.ts` | Engine 接口 + 实现 | `applyRouterHints(hints)` → `scheduler.setRouterHints(hints)` + `emitSnapshotNow()`（立即推一帧让回填马上可见） |
| `src/main/engine/scheduler.ts` | 新增字段/方法 | `routerHints`（内存态默认空）/ `setRouterHints()` / `leaseHostnameByMac()`（MAC toLowerCase 比对吸收大小写差异，空串视同 null） |
| `src/main/engine/scheduler.ts` | buildDevices() | `rec.hostname === null` 时查租约得 `leaseHostname`；`effectiveHostname` 单点回填，同时喂 `inferFingerprint` 的 hostname 与 Device.hostname/displayName（**不 mutate records**，rDNS/mDNS 已有值不覆盖） |
| `src/main/index.ts` | 轮询回调 | `engine.applyRouterHints({ leaseHostnames: status.dhcpLeases })`（未登录/web 会话时 dhcpLeases 天然为空数组，不猜） |

设计说明：
- DHCP 租约 hostname 是设备向路由器的自报，比 rDNS 权威；仅在设备自身 hostname 为空时生效，与 mDNS 实例名兜底显示名的优先级为 `effectiveHostname ?? mdnsHint?.name ?? null`。
- 回填同时进入指纹管线：手机/摄像头主机名正则（task-021 F3）立刻受益于租约数据。

## 与调查报告/计划逐条对照

- 调查报告 B 节「自动登录已存在、缺开关」：B-1 全量落地，且登录路径（ipc routerLogin 分流）、清盘路径（settingsUpdate 翻转沿）、自动重登联动（provider 查开关）三点闭环。
- 调查报告 C 节「DHCP 租约 hostname 按 MAC join 价值最高」：按 MAC join 落地，单点回填同时服务指纹与展示。
- plan.md 验收：typecheck 零错误 ✅；定向测试（settings round-trip 等）✅；全量只增不减——总数 503 未变，4 红为旧契约翻转（见下）。

## 测试翻转通知（Tess）

**2026-10-25 晚更新**：Tess 已把用例从 503 补到 531（invalidatedAt 生命周期/幂等/退避序列/成功清零等 B-2 状态机用例全部落地）。打回修复（runRelogin 内部链自续）后全量 **530/531**，唯一红：

- `tests/router-web-session.test.ts:263`（退避序列用例）：该用例建模的是**旧实现**的"轮询驱动挂出"起点（失败后 10s 轮询调 scheduleRelogin 时才挂 timer → 第 2 跳在失败+10s+120s=T+190s 触发）。内部链自续修复后，第 2 跳由 runRelogin 的 finally 在**失败时刻**直接挂出（T+60s+120s=T+180s），恢复更快且无轮询漂移；用例的 1ms 精确 advance 断言（:279-281 / :286-288）需按新起点微调。该用例中"失败后轮询再调 scheduleRelogin"步骤可保留——新语义下它恰好验证幂等守卫拦住重复调度、自续 timer 不受轮询影响。

早前的 4 条旧契约翻转（router-web-session :109/:142/:146、settings :57/:69）已由 Tess 完成。

建议 Tess 顺带补的内部链新断言：纯内部调度（失效后只调一次 scheduleRelogin、之后零轮询）下三跳链条完整自续到停用——这正是打回修复所保证的行为。

## 遗留风险

1. manualClears/reloginFailures 均为进程内存态：重启应用后自动重登计数从零开始（重登最多 3 次的预算每进程重置）——可辩护，重登风暴窗口有限。
2. scheduleRelogin 的退避基于"触发时刻"而非"会话失效时刻"：若 invalidatedAt 在退避等待期间已存在很久，第一跳仍是 60s——符合 brief 规格（60s 起步），不算缺陷。
3. RouterView 登录表单复选框使用内联样式（views.css 冻结不可改）；视觉与其它原生控件一致性由后续视觉轮统一。
4. `rememberRouterPassword` 开关不做设置页行（brief 明确不做）：当前唯一入口是路由器页登录表单；SettingsView 未加行，符合范围约束。
