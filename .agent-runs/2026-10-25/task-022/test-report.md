# task-022 测试报告（Tess）

日期：2026-10-25
范围：① 旧契约断言翻转（4 条）；② B-2 自动重登状态机用例（9 条）；③ C-1 hostname 回填边界用例（5 条）。
红线遵守：只写 `tests/**`，未动 `src/**` 与 `scripts/**`。

## 验收结果

- 全量 vitest：**532/532 全绿**（32 文件；含其他队友并发新增的用例与修复验证新增第 10 条）。翻转前 499/503（4 红均为旧契约锁定），翻转后回绿，且只增不减。
- 新增用例 3 连跑：18/18 稳定。
- tsc 独立检查（tsconfig.base 口径：module ESNext / moduleResolution Bundler / strict）：3 个改动文件 0 error（初查抓出 1 处 `afterEach` 未 import，已补）。

## ① 旧契约断言翻转（Max-1 给的 4 坐标）

| 文件:行 | 改动 | 依据 |
|---|---|---|
| `tests/router-web-session.test.ts:109` | session `toEqual` 补 `invalidatedAt: null` | B-2 有意扩展契约；markWebSession spread 保留该字段，web 会话初始无失效事实 |
| `tests/router-web-session.test.ts:142`（含同用例 :146 logout 断言） | 同上，logout 后 4 字段 + `invalidatedAt: null` | logout 是唯一合法清除路径之一 |
| `tests/settings.test.ts:57` | 旧版本文件迁移读取断言补 `rememberRouterPassword: true` | 迁移读取 `?? true`：旧数据升级后行为不变（Max-1 设计：保持 true 兼容老用户） |
| `tests/settings.test.ts:69` | `defaultState()` 契约断言补 `rememberRouterPassword: true` | 同上 |

翻转前已读实现确认语义（router/index.ts 全部 8 处 session 字面量、store.ts 迁移读取）。

## ② B-2 自动重登状态机（`tests/router-web-session.test.ts` 追加 describe，10 条）

复用文件内既有 httpx mock / rpcOk / rpcErr / scriptAllOk 基础设施；fake timers 驱动退避 timer，`vi.advanceTimersByTimeAsync` flush 异步链。

1. **invalidatedAt 生命周期**：失效轮置位为 -32002 观测时刻（T0，钉钟断言 `=== T0`）；下一轮无调用轮粘性沿用（既不新增也不清除），error 文案持续。
2. **瞬时故障不置位**：HTTP 500 轮 `invalidatedAt` 严格 null、无过期文案（只有 -32002 算失效）。
3. **清除时机三段**（按 team-lead 裁定）：login 失败粘性保留 → 手动登录成功清 null → 再造失效 → logout 清 null。
4. **幂等**：失效后连续 10 次 `scheduleRelogin()`（模拟 10 轮轮询），advance 60s 后 provider 恰 1 次（timer 不得叠加成重登风暴）。
5. **退避序列**（轮询驱动，见「缺陷发现」）：第 1 跳 60s 精确（59_999 无 / 1ms 触发）；第 2 跳 ≥120s、第 3 跳 ≥240s（2ⁿ 下界锁死）；3 次失败后 advance 20min + 再触发不得第 4 次；停用文案 `'已停止自动重登（凭据可能已失效），请手动登录'`。
6. **重登成功**：会话恢复 / user 回填 / invalidatedAt 清 null / 后续不再触发。
7. **provider null 静默停不计失败**：返回 null 后无后续 timer、无新增错误文案（过期提示粘性沿用是既有语义）；换有效 provider 后第一跳仍是 60s（若计了失败会是 120s——此断言锁死"不计失败"）。
8. **logout 取消挂起 timer**：schedule 后 logout，advance 10min provider 0 次（不得背着用户的退出意愿自动登录）。
9. **停用后复活**：3 次失败停用 → 手动登录成功 → 再造失效，第一跳回 60s 起步且重登成功（计数确已清零）。
10. **纯内部调度零轮询**（修复验证新增）：全程仅一次外部触发，三跳自续 60s→120s→240s 直到停用——锁死 runRelogin 自续修复语义。

### 缺陷发现：runRelogin 内部退避链自续断裂（低危，已修复并验证）

- **现象**：`runRelogin()` 在 `finally` 清 `reloginInFlight` **之前**调用 `scheduleRelogin()`（router/index.ts:482），而 `scheduleRelogin()` 的守卫 `reloginTimer !== null || reloginInFlight`（:453）此刻必拦截 → **纯内部调度下第二跳永远挂不出来**（探针证实：schedule 一次后 advance 20min，provider 仍只 1 次）。
- **生产遮蔽**：主进程轮询每 10s 拿 invalidatedAt 粘性字段再触发 scheduleRelogin，此时 inFlight 已清、failures 对应的 delay（2ⁿ）计算正确 → 退避语义在生产中近似成立（起点从"失败时刻"漂移到"下一次轮询触发时刻"，最多 +10s）。
- **裁决**（team-lead）：以 Max-1 修复后的新语义为准——`runRelogin` 用 `retry` 标志，`finally` 内先清 `reloginInFlight` 再自续 `scheduleRelogin()`，下一跳在**失败时刻直接挂出**（无轮询漂移）；轮询重挂/推迟的调和方案会活锁，不采用。
- **修复验证**（本节收口）：
  1. 退避序列用例按新起点微调：跳1 @60s → 跳2 @180s（60+120）→ 跳3 @420s（+240）→ 停用；中间轮询步骤保留，恰好验证幂等守卫在 timer 挂起期间拦截重复调度（不推迟、不重挂）。
  2. **新增第 10 条**「纯内部调度零轮询」：全程仅一次外部 `scheduleRelogin()`，三跳自续 60s→120s→240s 直到 3 次停用——锁死修复语义。该断言在修复前实现下必红（第二跳挂不出），牙齿由"修复前红"天然证明，未做 src 变异验证（避免污染 Max-1 刚落地的修复现场）。
  3. 「复活」用例时间量在新时间线下天然覆盖（advance 120_000: 70→190s 含跳2@180s；advance 240_000: 190→430s 含跳3@420s），仅修正注释口径。

## ③ C-1 hostname 回填边界（新建 `tests/router-hints.test.ts`，5 条）

注入方式与 scheduler-resilience.test.ts 相同：vi.mock 替换 arp/ping/ports/spooler/ReverseDnsCache + runFullScan 造记录 + setRouterHints + buildDevices 黑盒断言。

1. **MAC 大小写归一**：双向（ARP 大写+租约小写 / 反向）都能对上。
2. **rDNS 已有值不覆盖**：io.rdns 桩返回 FQDN → hostname/displayName 均取 rDNS 值（租约只兜底）。
3. **不猜三连**：未登录空 hints / 租约 hostname 空串 / null → 全部保持 null（数据诚实红线）。
4. **回填进指纹管线**：租约 hostname='oneplus-9' → kind='mobile' + osHint='手机（主机名特征）'——证明 effectiveHostname 真的喂进 inferFingerprint，不只改展示字段；且前置断言回填前不得误判。
5. **投影不是污染**：hints 撤掉（下一轮未登录）后回填干净回退为 null——`不 mutate records` 的行为锁。

### 踩坑（对后续写 scheduler 测试的人有用）

- `phaseFingerprint` 的预算 race 里另一侧是 `augmentDeviceIdentity()`，其内部 `discoverMdnsDevices`（discovery/mdns-devices）与 `queryNetbiosNames`（discovery/netbios）是**真实网络出口**——不 mock 时每条用例 ~14s（mDNS 1s 窗口 + nbtstat spawn 全真跑）。补两个 mock 后 5 条 16ms。
- 顺带观察：**scheduler-resilience.test.ts 未 mock 这两个出口**，其 R-06 段单条 ~18s（全量 146s 的主要贡献者之一）。不属本任务范围未动，建议后续单独收口。

## 裁定执行说明

- **huawei 误伤边界**：按裁定不锁回归断言，保持"已定性风险 + 报告说明"现状（fingerprint.test.ts G7 无 huawei 相关断言，维持）。
- **rememberRouterPassword true→false 翻转沿清凭据**：落在 `src/main/ipc.ts` settingsUpdate handler（electron 主进程层，rmSync 依赖 userData 路径），纯 Node 测试环境不可加载 electron——按现状说明，不做引擎层断言。登录不落盘分流同理（ipc routerLogin handler）。

## 计数对账

503（翻转前总数）− 0 + 9（B-2）+ 5（C-1）= 517 本侧期望；实测 531，差 14 条来自其他队友并发交付（非本文件），全量绿即收。
