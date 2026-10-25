# task-002 交付前审查报告（审查员 Ray-2）

日期：2026-10-25
审查人：Ray-2（只审不改；除本报告外未修改/创建任何文件）
审查对象：B-1 扫描预算 / B-2 ubus 登录 / B-3 safeStorage 异步迁移 + 期间追加两处缺陷修复（sessionInvalid 编排层投影 D-011~D-013、caps.openwrt 粘性解耦 D-017）
判据来源：`plan.md`（B-1/B-2/B-3 + D-011~D-017）+ 项目铁律 4 条 + 队长必答问题 Q1~Q6

---

## 0. 审查方式与现状复跑（只读）

- 通读全部受审文件：`engine/exec.ts`、`engine/scheduler.ts`、`engine/check.ts`、`engine/router/openwrt.ts`、`engine/router/index.ts`、`router-store.ts`、`ipc.ts`、`index.ts`、`scripts/engine-check.mjs`、`scripts/fixes-check.mjs`、`shared/types.ts`（注释）、`renderer/views/RouterView.tsx`、`ARCHITECTURE.md`，及 5 个测试文件（router-openwrt / router-manager / router-ubus-e2e / scheduler-resilience / exec-fallback）。
- 全局 grep 核验：`runNative|runGbkNative|runPowerShell` 全部调用点、`spawn(` 全部出口（src 内仅 exec.ts）、`fixes-check` 全仓引用、`openwrt|loggedIn` 全部消费点、`password` 全部出现点。
- 复跑验证矩阵（与 Vic-2 结论一致）：
  - `npx vitest run` → **19 文件 / 378 用例 / 0 失败**（router-ubus-e2e 12、router-manager 9、scheduler-resilience 37、router-openwrt 19）
  - `tsc --noEmit` 双配置 → **0 error**
- Vic-2 的破坏-还原实验（实验 A/B）我抽查了代码级对应物，断言确实"咬人"。

---

## 1. 必答问题逐条结论

### Q1 `scripts/fixes-check.mjs` 去留（D-015 授权裁决）

**36 条断言质量结论：真实有效、无空转，但归属与纪律双不合格。**

| 块 | 条数 | 质量评估 |
|---|---|---|
| R-06 注入时钟 | 8 | 状态机真被驱动；但 poke `sched.records`/`applyArpPresence` 私有成员，且 `SCHEDULE` 是脚本内硬编码副本（:52），`180_000` 是循环自洽值而非常量推导——`SCHEDULE.fullScan` 变更时脚本仍绿，标签是装饰性的 |
| R-02 | 6 | 与 `scheduler-resilience.test.ts` R-02  describe（6 例，含抛错路径）大面积重叠且 rigor 不优于后者 |
| R-03 | 8 | 与 WarningLog 纯函数 11 例 + 快照级用例重叠；仍在 poke `sched.warningLog`/`replaceWarnings` |
| R-04 | 5 | 与 R-04 describe（6 例，spy 公开方法）重叠；poke `sched.timers`/`scanTimer`/`running` |
| R-05 真进程 | 9 | **tests/ 覆盖不到的价值**：真 spawn ping/PowerShell 强杀、闸门归零、execStats 观测；`tests/exec-fallback.test.ts` 走 `vi.mock('node:child_process')`，真进程路径是既有缺口。但含两条 wall-clock 断言（:236 `elapsed<4000`、:237 `elapsed<1500`），违反测试纪律第 4 条，高负载机器有抖动风险 |

**孤儿确认**：全仓 grep `fixes-check` 仅命中其自身头部注释；`package.json` 无接线；不在 vitest `include` 矩阵。

**裁决：拆分处理——R-05 九条迁入 vitest，其余 27 条删除，脚本本体删除。**

1. **R-05 九条 → 迁入 vitest**（新文件如 `tests/exec-real.test.ts`）：vitest 即 Node 环境，spawn 真进程无障碍；两条 wall-clock 断言改写为行为断言（settle 后紧接命令可正常执行 + `execStats()` 归零即证明闸门释放；"无 taskkill 延迟"用"紧接命令在宽超时内完成"替代或删除），`testTimeout` 放宽。迁入即纳入 `npm test` 门禁，同时补齐"exec 真进程路径"这一既有缺口。
2. **其余 27 条 → 删除**：与 `tests/` 重复且被严格支配（R-02/03/04/06 在 tests/ 均有同等或更强守卫，且用 `ALARM_THRESHOLDS`/`SCHEDULE`/`WINDOW` 常量派生），继续保留只会双份维护 + 违反白盒纪律（本任务刚把 WarningLog 导出正是为了消灭 poke 私有字段，`scheduler-resilience.test.ts:392-395` 注释写明了这一点，fixes-check 却在反方向操作）。
3. **不接受"保留原位"**：孤儿脚本必腐烂，腐烂后比没有更糟（假的安全感）。
4. **不接受"接线 package.json"作为终态**：那只是给重复+违规的资产上了自动化的名义，延缓腐烂。若交付窗口确实排不进新测试文件，可作**临时**过渡（`"test:fixes"` + 注明"手动运行、非 CI、与 tests/ 已知重复"），但须登记为技术债。

### Q2 Max-1 scope creep 三项评审

| 项 | 裁决 | 理由 |
|---|---|---|
| `check.ts:44-45` 扫描前两次带宽采样 | **合理** | R-02 语义下单次采样 `intervalMs=0` → `rxBps/txBps` 恒 null；engine-check 是"引擎真能扫到东西"的证据源，快照展示真实差分值是其份内事。代价 ~400ms。Vic 三次实测 rxBps 真实非零、warnings 无假告警。无需补测试（脚本路径，snapshot 契约已有守卫） |
| `scheduler.ts:117` 导出 WarningLog | **合理** | 直接动因是 Tess 的测试需要（implement-report 文末"待 Tess 落地的两处"①），纯类 + `at` 可注入，把白盒测试从 poke 私有字段转移到导出 API，与本任务纪律同向。已有测试消费（scheduler-resilience.test.ts:122/398+） |
| `scheduler.ts:581-583` 扫描轮 catch 补 discovery warning | **合理，但应补测试** | 2 行、R-03"静默失败必须可感知"同源，方向正确。但当前四个 IO mock 全不抛，该 catch 分支**零覆盖**（grep 确认无用例驱动它）。补法：让 `readArp` mock 抛一次 → 断言 `snapshot.warnings` 出现 `source='discovery'` 且消息含"扫描轮异常" |

### Q3 正确性深审

**(a) 三个 ubus 并发调用的 sessionInvalid 收集与 session.error 沿用——无竞态，有一处测试缺口。**
`call()` 在入口读 `this.session`（三枪同一 sid），`raw()` 内 -32002 时置空是幂等的；`some()` 收集与"部分失败"语义正确：混合一成一败时当轮成功数据照常展示（诚实）、会话作废、下轮跳过调用（router-manager.test.ts:171 已锁"不得再拿死 sid 发请求"）。`session.error` 沿用逻辑的三条清零路径齐全：login 成功（index.ts:96）、logout（:111）、login 失败覆写（:85）；未观测到失效时沿用上一条直到用户动作，与 D-013 规格一致。
**缺口**：混合场景（board ok + leases -32002 + wireless ok）无编排层用例——现有反向对照②只覆盖"网络错误"的部分失败。建议补一条。

**(b) openwrtCapable 粘性位置位路径——完备。**
置位路径二条：login 成功（index.ts:92）、brand 探测（:183，且刻意放在指纹块**之后**，覆盖 identity 沿旧值的场景——implement-report:253 的设计说明准确）。无任何路径置 false：doRefresh 每轮从 `EMPTY_CAPS` 重建但被 :193 的 OR 收口；logout（:106-115）明确不动 caps。:193 第三析取项 `(this.ubus !== null && this.ubus.loggedIn)` 经推导是死代码（前两项已覆盖全部可达路径），无害，可留作防御。
**但 brand 探测置位路径（:183）无用例守卫**：router-manager.test.ts 的 detect mock 恒不可达，brand 恒 null，删掉 :183 全套件仍绿。真实场景（管理页识别出 OpenWrt、本次进程未登录过——如重启后无已存凭据）恰是其唯一生效路径，被删即复现 D-017 的"UI 撒谎"。建议补：detect mock 回 `brand='openwrt'` + 未登录 → `caps.openwrt===true`。

**(c) logout 删 caps 置 false 后的残留假设——全局 grep 无。**
`caps.openwrt===loggedIn` 的等价假设不存在于任何消费点：RouterView:250-252 的 CapRow 走 supported/note 正交分支；reboot() 门控用 `this.ubus.loggedIn`（:120）而非 caps；唯一引用 caps.openwrt 的 `canReboot`（:157）是死变量（见 N1）。D-017 的语义解耦在渲染层与引擎层均自洽。

### Q4 sweepTree 收窄遗漏场景——无遗漏。

src 内 spawn 出口唯一（exec.ts），逐一确认：

| 调用点 | 命令 | 孙进程风险 | sweepTree |
|---|---|---|---|
| arp.ts:121 | `arp -a` | 叶进程 | 不开 ✓ |
| bandwidth.ts:85/93 | `netstat -e` / `-ano` | 叶进程 | 不开 ✓ |
| ping.ts:99/167 | `ping` ×2 | 叶进程 | 不开 ✓ |
| subnet.ts:146 | `route print` | 叶进程 | 不开 ✓ |
| arp.ts:140 | PowerShell Get-NetNeighbor | 派生 conhost | runPowerShell 内部开 ✓ |
| spooler.ts:232/247/253/259/266 | PowerShell ×5 | 派生 conhost | 同上 ✓ |

`scripts/start.mjs`/`smoke.mjs` 的 spawn 是拉起 electron 本体（开发/冒烟脚本，非扫描路径）。收窄完整。遗留注意：`runNative` 是导出 API，未来新增"会派生的命令"（cmd /c、wmic 类）必须显式传 `sweepTree`——注释已说明只有 PowerShell 需要，建议补一句前瞻（N5）。

### Q5 安全

- **safeStorage 迁移无回归**：路径（`userData/router-credentials.json`）、格式（base64 DPAPI 密文）均未变；三个出口（save/load/canPersist）try/catch 全覆盖；密钥环不可用时拒绝落盘并如实上报，不降级明文（:42-44）；`shouldReEncrypt` 轮换重存路径正确取 `.result`。异步 API 与旧同步 API 同平台密钥库，既有文件可解密——Vic 对构建产物 grep 同步 API 零命中 + smoke stderr 零 deprecated 已实证。
- **密码无日志/回包泄露**：全局 grep `password` 全部出现点均为参数传递或类型声明，无 console/落盘明文；错误文案全部为固定串（`ubusErrorMessage` / "登录响应缺少会话令牌"），不回显用户输入；IPC 回包 `{ok,error,persisted,persistError}` 中 error 均源自上述固定文案。✓
- 小项见 N3（文件模式 0o600、重存失败忽略）——均为迁移前既存，非回归。

### Q6 文档一致性（抽查 3 处 + 附带 1 处）

| 抽查点 | 文档 | 实现 | 结论 |
|---|---|---|---|
| arp2 过预算整段跳过 | ARCHITECTURE.md:222 | scheduler.ts:509/518-525 | ✓ 一致 |
| sweepTree 仅 PowerShell | ARCHITECTURE.md:223 | exec.ts:196/223 + runGbkNative 不传 | ✓ 一致 |
| UBUS_NULL_SESSION + 错误码语境分流 | ARCHITECTURE.md:279 | openwrt.ts:42/49-65/196-201/272-296 | ✓ 一致 |
| （附带）safeStorage 异步 + 密文跨版本兼容 | ARCHITECTURE.md:281 | router-store.ts:32/47/63-67 | ✓ 一致 |

**不一致 1 处（低，既有漂移）**：§7:203 "首次采样只建基线，**返回 0**" 与 R-02 修复后的 null 语义不符（scheduler.ts:823-824/834-835：无差分基线 → `rxBps: null`）。task-001 起的文档漂移，建议改为"返回 null（≠ 0 流量）"。

---

## 2. 发现清单（按严重级）

| # | 严重级 | 位置 | 问题 | 建议改法 |
|---|---|---|---|---|
| M1 | medium | scripts/fixes-check.mjs（整文件） | 孤儿脚本（零引用、不在矩阵）且纪律违规：poke 私有字段、2 条 wall-clock 断言、SCHEDULE 硬编码副本；27/36 与 tests/ 重复并被严格支配 | 按 Q1 裁决：R-05 九条迁入 vitest（行为断言 + 宽超时），其余删除 |
| M2 | medium | router/index.ts:198-206 | 三个 ubus 调用中**非 -32002 的失败 error 被整体丢弃**（leaseRes/wirelessRes/boardRes.error 无消费点），部分失败在 UI 零提示——与 R-03"静默失败必须可感知"及 D-013"失败原因可见"原则相悖；对比引擎侧四源 warnings，路由器通道缺等价机制 | 非 sessionInvalid 的调用错误汇入 `capabilityNotes`（或 session.error 次级文案），如"DHCP 租约获取失败（HTTP 500）"；补一条混合失败用例 |
| M3 | medium | scheduler.ts:436-594 | `runFullScan` 单函数 ~158 行、圈复杂度 ~20，本次 +3 分支（arp2 if/else、ports 条件、hostnames 条件）；scheduler.ts 944 行。本次净增有限但延续既有趋势 | 后续小任务抽 phase 函数（arp2/ports/hostnames 各自成 private 方法），不阻塞本次交付 |
| L1 | low | scheduler.ts:501-507 | arp2 的 progress 块重复（注释+3 语句出现两次），`t0` 在 if 内重赋值故无害，编辑残留 | 删掉重复的 4 行 |
| L2 | low | router/index.ts:183 / scheduler.ts:581-583 | 测试缺口三处：① brand 探测置位路径无守卫（删 :183 全套件仍绿，见 Q3b）；② 扫描轮 catch 分支零覆盖（mocks 全不抛）；③ doRefresh 混合部分 -32002 无编排层用例 | 各补 1 条：detect→openwrt+未登录 caps=true；readArp 抛错→discovery warning；一成一败→当轮数据可见+下轮 loggedIn=false |
| L3 | low | router/index.ts:147-154 | 网关未知早退走 `emptyStatus()`：`session.loggedIn` 瞬态打 false（this.ubus 会话可能仍活着）、`caps.openwrt` 瞬态打 false（与粘性位矛盾）。UI 在 unreachable 时不渲染能力卡故不可见，下轮自愈 | 早退时保留 `openwrtCapable` 与真实 loggedIn 派生（或至少 caps 用粘性位收口） |
| L4 | low | router/index.ts:102-116 vs 145-246 | logout 与在途 doRefresh 交叠：在途轮次会把刚清掉的 `systemBoard` 重新写回 status，网关卡"运行时间"残留显示 ≤1 轮（数据卡片因 loggedIn 门控不可见） | logout 递增世代号，或 status 写回前校验 `this.ubus` 仍为当轮客户端 |
| L5 | low | router/index.ts:77-100 | login 失败不清 `this.ubus`：若有旧会话，重登失败后下一轮 doRefresh 以旧会话恢复取数并显示 loggedIn=true（旧用户），与用户刚看到的"用户名或密码错误"并存；login 成功替换客户端时旧客户端未显式 logout | 行为可辩护（旧会话真实有效）但应文档化；或在 login 入口统一先 logout 旧客户端 |
| L6 | low | router/index.ts:171-180 | `caps.managementPage` 仅在探测当轮置 true，而探测限频 60s（detectRetryMs）快于轮询 10s（pollMs）→ 已识别路由器每 6 轮有 5 轮显示"该路由器不支持"，能力矩阵闪烁。task-002 前既存，与 D-017 同族 | 与 openwrtCapable 同样做粘性（或由 `identity.brand !== null` 推导） |
| L7 | low | ARCHITECTURE.md:203 | "首次采样只建基线，返回 0" 与 R-02 后的 null 语义不符（task-001 起的漂移） | 改为"返回 null（≠ 0 流量）" |
| N1 | nit | RouterView.tsx:157 | `canReboot` 定义后无任何消费（死变量；tsconfig 未开 noUnusedLocals 故不报）；重启按钮实际未按能力门控，靠 reboot() 的 unsupported 诚实回退兜底（implement-report:283 已报备） | 删除死变量，或给按钮加 `disabled={!canReboot}` |
| N2 | nit | fixes-check.mjs:52/127 | SCHEDULE 硬编码副本 + `180_000` 自洽断言，与 shared/constants 无联动（随 M1 一并处理） | 迁入后改用常量派生 |
| N3 | nit | router-store.ts:49/66 | 落盘未显式 `0o600`（与迁移前一致，DPAPI 用户作用域可控，非回归）；`shouldReEncrypt` 重存失败被忽略（load 仍返回解密结果，下次启动重试） | 可择机加 `mode: 0o600`；重存失败可记一条日志 |
| N4 | nit | router/index.ts:145-246 | doRefresh 无外层 try/catch：理论上级联抛出会经 startPolling 的 async 回调变成 unhandledRejection（主进程有全局兜底，不致命；httpx/detect 现状均不抛） | 防御性加 try/catch，失败轮写 lastError |
| N5 | nit | exec.ts:80-88 | sweepTree 注释可补前瞻：未来新增会派生孙进程的命令必须显式开启 | 补一句注释 |

统计：**critical 0 / high 0 / medium 3 / low 7 / nit 5。**

## 3. 铁律符合性核验

1. 引擎层无 electron import：受审引擎文件零 import electron ✓（router-store.ts 在主进程侧，合规）。
2. 数据诚实：caps 不撒谎（D-017 后）、loggedIn 不撒谎（D-013 后）、失败可感知（warnings 四源 + session.error + 本次 catch）；唯一残余是 M2 的"部分失败无原因"与 L3/L4 的瞬态不一致，均不构成假状态呈现。
3. 并发安全：`refreshing` 合并标志覆盖 `refresh()` 全部重入；`login()`/`logout()` 不经该标志（L4/L5 的竞态残余均为瞬态、UI 多数路径不可见）；`runFullScan` 的 `scanInFlight`、各 `*InFlight` 单飞标志未受本次改动破坏。
4. 测试纪律：tests/ 内无 wall-clock 断言（e2e 超时用例用服务器 delay + 常量推导 ✓；D-014 集合语义 ✓）；白盒仅测导出 API（WarningLog 导出后 scheduler-resilience 已净化）——**唯一违议点在孤儿脚本 fixes-check.mjs（M1）**。

## 4. 最终裁决

# **APPROVE-WITH-NITS**

三条边界修复（B-1/B-2/B-3）与两处追加缺陷修复（D-011~D-013、D-017）实现正确、验证充分（378/378 + 双 tsc + engine-check 3/3 + smoke 零 deprecated，破坏实验证明断言咬人），无 critical/high 问题。
3 个 medium（fixes-check 归属、部分失败无提示、runFullScan 复杂度）均为交付后可跟进项，不阻塞发布：
- M1 按 Q1 裁决执行（R-05 迁入 vitest + 删除冗余），建议排入 task-003；
- M2/L2 建议同一批补齐（混合失败用例 + capabilityNotes  surfaced）；
- M3 建议登记为重构 backlog。

---

审查员 Ray-2 · 2026-10-25 · 只审不改
