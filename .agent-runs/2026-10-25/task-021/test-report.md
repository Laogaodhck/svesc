# 测试报告 — 测试工程师 Tess（task-021）

| 字段 | 值 |
|---|---|
| 范围 | 仅 `tests/**`（alarms / fingerprint / alarm-state 三文件增补）；**未修改任何 `src/**`** |
| 命令 | `cd C:/github/svesc && npx vitest run` |
| 自验 | 三文件定向 91/91 绿；全量 **517 用例 = 503 基线 + 14 新增**，其中 **4 条外部红**（见 §4，非我引入、非我领地） |
| 类型检查 | 三个改动文件按 tsconfig.base 配置独立复跑 → 0 error |
| 结论 | **引擎层 PASS**：F1/F3 实现与队长裁定逐条吻合，未发现引擎缺陷；全量"全绿"判据被 4 条**他人并发工作流的字段漂移红**挡住，需其所有者收口（§4） |

---

## 1. 新增用例清单（14 条）

### 1.1 `tests/alarms.test.ts` —「D. 手动清除与冷静期（task-021 F1）」7 条

| # | 用例 | 断言意图 | 对应的失效模式（断言如何咬人） |
|---|---|---|---|
| 1 | clear：置 resolvedAt、trace 记 cleared-by-user（含操作人）、移出 active、返回 true | `{resolvedAt, clearedTrace, activeLeft, critical}` 一次 toEqual，trace 条目逐字段比对 | 漏写 by / 忘删 active / 忘置 resolvedAt 任一 → 红 |
| 2 | clear 防御：重复 clear / 不存在的 id / 已自动 cleared 的都返回 false，且重复 clear 不追加 trace | 三类 false + trace 长度不变 | 幂等缺失（重复 clear 改写 resolvedAt 或追加 trace）→ 红 |
| 3 | clearMany：混合成功/失败返回成功数；全失败返回 0 | `2 成功 + 1 ghost → 2`；重跑全失败 → 0 | 返回值口径错（如返回总数而非成功数）→ 红 |
| 4 | **冷静期窗口内：条件仍满足 → evaluate 完全静默** | `{created, reopened, resolved}` 全空；总数/occurrences/resolvedAt/traceTypes/activeLeft 五项锁定 | "清了又弹"（新建或重开）→ 红；这是 F1 的核心防线 |
| 5 | **冷静期先于抑制窗口：条件消失又复现仍静默** | 旧记录 resolvedAt 保持清除时刻、occurrences 不变、trace 无 re-raised | 若实现把 manualClears 拦截放在抑制窗口判定**之后**，合并重开会拉回记录（occurrences+1 + re-raised）→ 红。锁定 `alarms.ts:253-260` 的**前置拦截次序** |
| 6 | **窗口过后条件仍满足 → 全新告警（新 id、独立 trace），不复活旧记录** | created 长度 1 且 id ≠ 旧 id、新记录 occurrences=1 独立 trace；旧记录五字段保持 cleared 原样 | 复活旧记录（重开路径）→ 红；窗口过后仍静默（丢"问题还在"的诚实性）→ 红 |
| 7 | trace 审计：raised → acked → cleared-by-user 顺序与操作人 | 全 trace 数组逐项 toEqual | trace 类型/顺序/by 任一错 → 红 |

**测试难点与解法**：`clear()` 内部用真实 `Date.now()`，而 `evaluate` 的 `now` 由测试注入——两条时间轴不同轴会导致"窗口内/窗口外"断言失真。解法：`clearAt()` 助手用 `vi.useFakeTimers + setSystemTime` 钉住 clear 时刻（try/finally 还原），使 clear 写入的 resolvedAt/manualClears 与 evaluate 的注入 now 同轴可比。既有用例不受影响（假时钟作用域仅在助手内部）。

### 1.2 `tests/fingerprint.test.ts` —「G7. 手机主机名词根扩充（task-021 F3）」6 条

| # | 用例 | 断言意图 |
|---|---|---|
| 1 | 新增高置信词根正样例 | oneplus/realme/nokia/zenfone/huawei/sm-G991B（三星机型，含大小写混合）→ mobile 且 **osHint==='手机（主机名特征）'**（锁定"不再为 null"的展示契约） |
| 2 | 误伤面反例：motorola-router | 必须判 `{osHint:'网络设备固件', kind:'router'}`——**禁 moto 泛匹配的回归锁**（主机名管线中 mobile 判定在 router 之前，若泛匹配则此条红） |
| 3 | 误伤面反例：sm-office | `sm-[a-z]\d{3}` 的位数约束必须拦住无数字词 → `{osHint:null, kind:'unknown'}` |
| 4 | 正常 PC 名不受影响 | desktop-01 → workstation |
| 5 | 既有通道回归：端口压过词根 | 445 开放时 SM-G991B 判 Windows (SMB)——端口优先铁律不因词根扩充松动 |
| 6 | 既有通道回归：62078 / mdnsKind=mobile 优先级 | iOS / mDNS 通道形状不变（G.端口优先 与 G6 的投影复核） |

### 1.3 `tests/alarm-state.test.ts` —「手动清除的状态投影（task-021）」1 条

| # | 用例 | 断言意图 |
|---|---|---|
| 1 | clear 后 alarmStateOf === cleared | 判定源唯一性：三态函数无需区分手动/自动清除，`resolvedAt!==null` 即 cleared——若有人给 cleared-by-user 单开状态分支导致判定分叉，此条红 |

## 2. F2（开机自启动）测试说明：跳过

`launchAtLogin` 全部链路在 `src/main/ipc.ts`（`import electron` + `app.getLoginItemSettings/setLoginItemSettings`）——纯 Node vitest 无法加载 electron 模块，且 store/settingsUpdate 白名单未动（Max-1 报告确认），无可测纯函数。渲染层开关行由 Vic 的 SMOKE 覆盖。**无需新增，非遗漏。**

## 3. 引擎层缺陷

**无**。14 条一次转绿（1 条是我自己首写时把单 device 当数组传给 run 助手的笔误，修正后绿——与实现无关）。F1 冷静期的三个语义（窗口内静默 / 前置拦截次序 / 窗口外全新告警）与 F3 的词根及误伤面约束，实现与 plan.md 裁定逐条吻合。

**huawei 词根边界观察（未写成断言，按 Max-1 遗留风险 3 处理）**：无特征端口 + 主机名含 huawei 的路由器会被判 mobile（裁定接受的风险，huawei 在 mobile 词根表内且先于 router 判定）。我**没有**锁 'huawei-router' → mobile 的断言——它锁的是已定性的误伤面，若后续做缓解（如 `huawei[-_]phone` 后缀约束）该断言会假红挡路。若 team-lead 希望把当前行为锁成回归基线，我可以补一条。

## 4. 阻塞项：全量"全绿"判据被 4 条外部红挡住（非我引入）

我的 14 条全绿；全量 517 中 4 条失败位于**我没有触碰、也不属于本任务书范围**的两个测试文件，均为**实现字段漂移、测试未跟上**：

| 文件 | 失败（2+2） | 实测差异 | 判断 |
|---|---|---|---|
| `tests/router-web-session.test.ts` | 2 条 | 实现侧 session 已是 5 字段（新增 `invalidatedAt`，`router/index.ts:96/124/140`），测试期望还是 4 字段 `{loggedIn, user, error, kind}` | 内置浏览器会话特性（含 `markWebSession`）的并发工作流，实现推进了、测试没跟上——**所有者应补期望字段或明确 invalidatedAt 语义后由我代补** |
| `tests/settings.test.ts` | 2 条 | store 默认值多出 `rememberRouterPassword: true`，测试期望没有该字段 | 同上：新增设置项的并发工作流 |

这 4 条在 Max-1 报告的 503 基线之后被引入（当前总量 517 = 503 + 我 14；两个红文件不在我的改动集内）。**处置建议**：由两个特性的所有者收口（他们最清楚 `invalidatedAt`/`rememberRouterPassword` 的预期语义）；若 team-lead 授权我代为更新期望字段，我需要先拿到这两个字段的语义裁定（尤其 invalidatedAt 的清除时机），否则机械补字段只是把断言拉齐，锁不住语义。
