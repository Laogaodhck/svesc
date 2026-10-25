# Plan — 已知边界闭环（task-002）

**背景**：task-001 收尾报告中列了三条 KNOWN_ISSUES，本任务逐条闭环，产出验证证据。

| # | 边界 | 目标 | 责任阶段 |
|---|------|------|----------|
| B-1 | engine-check「扫描 ≤ 12s」临界断言（实测 10.7~16s 波动） | 找到根因：断言阈值与引擎真实预算机制（SCAN_BUDGET_MS=10000）的关系；改为不抖动的判据 | Phase 1 调查 → Phase 2 修复 → Phase 3/4 复验 |
| B-2 | ubus 通道仅 transport 注入单测覆盖，无端到端验证 | 用 node:http 起本地"ubus 形状"服务器，对真实 HTTP/JSON-RPC 全链路（UbusClient + httpRequest）做集成测试 | Phase 1 可行性 → Phase 3 测试（Tess） |
| B-3 | safeStorage.isEncryptionAvailable 弃用警告 | 迁移到 Electron 45 推荐的 isAsyncEncryptionAvailable + 异步加解密；保持既有凭据文件兼容 | Phase 1 确认 API → Phase 2 修复 → Phase 4 验证 |

**约束**（与 task-001 一致）：
- 引擎层（src/main/engine/**）禁止 import electron；router-store.ts 在主进程侧可用 electron。
- 数据诚实原则：拿不到的数据一律 null，绝不填 0。
- 测试为冻结契约风格：断言即规格，修实现不迁就实现；若发现断言本身矛盾（如 task-001 的 exec-fallback 测试2），须经队长确认后修正并注释理由。

**成功判据**：
1. engine-check 连续 3 次运行全 PASS 且断言判据与预算机制自洽（不再依赖墙钟运气）。
2. 新增 ubus 端到端集成测试（真实 socket，非注入），覆盖 login→call→logout 与错误路径。
3. router-store 使用非弃用 API，运行无弃用警告；既有加密文件可正常解密。
4. vitest 全量 + tsc 双配置 + build 保持绿；smoke 不回退。
5. Ray 审查无 critical/high 问题。

---

## 追加决策记录（Phase 3 期间，队长裁决）

| # | 决策 | 理由 |
|---|------|------|
| D-011 | ubus 会话失效（call 语境 -32002）必须自清会话 + UI 不撒谎 | Tess e2e 用例③逼出。真实语义：-32002 在调用路径唯一表示 sid 被拒；瞬时故障走 res.error/HTTP 分支永远到不了 -32002，"怕误伤"前提不成立。不修的后果：UI 永远显示"已登录"而所有调用失败，用户无路重登——典型静默失败，违反数据诚实原则 |
| D-012 | 只清 -32002：`result:[6]`（单对象 ACL）、超时、非 200、非法 JSON、传输异常一律不清会话 | 前者是细粒度权限问题、后者是瞬时故障；清了会把抖动放大成持续故障 |
| D-013 | RouterManager.status.session.loggedIn 改查 `this.ubus.loggedIn`（非仅 `!== null`）；doRefresh 收集 sessionInvalid 写入 session.error；RouterView 渲染该 error（队长授权的单行渲染层改动，知会 Max-2） | 让"会话已死"在 UI 可见且可恢复 |
| D-014 | e2e 用例⑧的 id 断言改集合语义（连续且不重复），禁断言绝对到达顺序 | 三个并发 HTTP 请求到达顺序不确定，原断言约 1/3 概率红——抖动守卫比没有守卫更糟 |
| D-015 | Max-1 新建的 `scripts/fixes-check.mjs`（36 断言）暂留，由 Ray 审查评估去留/迁入 tests/ | 授权清单外产物，需审查质量与归属 |
| D-016 | arp2 根治项（readArp 加 fallback 参数）不列入本次：scheduler 侧等价保护已实测有效（arp2 9~11s → ~145ms） | 风险收益不匹配，记录为后续小任务 |

| D-017 | caps.openwrt 与登录态解耦：进程内只置 true 不置 false；登出/会话过期不影响 caps | Tess 双向锁死的"下轮=false"断言随之失效——那是把疏漏当设计锁死。设计裁决升级：能力（协议支持）正交于会话（登录态），UI CapRow 的 note 分支已能表达"未登录"。**Max-1 修复落地后 Tess 必须更新用例②的下轮断言为 true 并补 logout 场景**——这是随设计裁决升级的断言更新，不是放宽（新断言更强：caps 不得撒谎） |
