# brief-max1（task-022 P1 实现任务书：路由器记住密码/自动重登/设备名回填）

你是实现工程师 Max-1。项目根 C:/github/svesc。先读 `.agent-runs/2026-10-25/task-022/investigation-report.md`（Vera-2 调查，全部文件:行号以它为准）与同目录 plan.md。

**队长裁定**：本次只做 P1 三项；P2（Device.routerInfo 契约/wifi 佐证）等 task-021 验证通过后另派；明确不做项（私有 API 抓包/per-host 分摊/路由器侧型号与 OS/iwinfo）一个都不许做。RouterStatus.session 加 `invalidatedAt: number | null` 可选字段已批准（向后兼容）。

**文件边界（只许改这些）**：`src/shared/types.ts`、`src/main/engine/router/index.ts`、`src/main/engine/router-store.ts`（如需）、`src/main/engine/scheduler.ts`、`src/main/engine/index.ts`、`src/main/store.ts`、`src/main/ipc.ts`、`src/main/index.ts`、`src/renderer/views/RouterView.tsx`、相关既有测试的配套修正。
**不许碰**（Max-2 正在改，task-021 范围）：AlarmsView/App/SettingsView/DevicesView/OverviewView/DeviceDetailDrawer/format.ts/views.css。设置页的"记住密码"Switch 行不做（等 021 验证后 P1.5），本次开关落点只在 RouterView 登录表单复选框。

═══ B-1 记住密码开关 ═══
1. types.ts AppSettings 加 `rememberRouterPassword: boolean`（默认 **true**，兼容现状）；store.ts 两处默认/迁移读取（:74、:156-163）；ipc.ts settingsUpdate 白名单（:128-136）加该键。
2. 登录路径（ipc.ts:83-91）：仅 `res.ok && engine.getSettings().rememberRouterPassword` 才 saveCredentials；否则返回 `persisted:false, persistError:'已选择不记住密码'`。
3. 关闭即生效：settingsUpdate 里检测 `rememberRouterPassword` 由 true→false 且凭据文件存在 → `clearCredentials()`（当前会话保持，仅删盘上凭据，下次启动不自动登录）。
4. RouterView 登录表单（:417-439）加复选框"记住密码"，默认勾选，读写同一设置键；:156 的保存反馈文案自动适配（已选择不记住时如实显示）。

═══ B-2 会话失效自动重登 ═══
1. types.ts `RouterStatus.session` 加 `invalidatedAt: number | null`；router/index.ts:357 区段：sessionInvalid 时写 Date.now()，重新登录成功后清 null。
2. 主进程 main/index.ts 轮询回调里检测 invalidatedAt 有值且 rememberRouterPassword 开 → 重新 loadCredentials → routerManager.restoreSession（**每次重读凭据，主进程不常驻明文密码**）。
3. 防死循环：退避 60s 起 ×2、上限 10min；连续 3 次失败停用并置 session.error "已停止自动重登（凭据可能已失效）"；重登成功重置退避。逻辑建议收在 RouterManager 的私有方法（如 scheduleReconnect），主进程只喂开关与凭据。
4. 诚实性：自动重登成功静默（error 已清）；失败必须可见；**restoreSession 失败文案增强为"已用保存的凭据自动登录失败"**（调查报告 B-3 小项）。

═══ C-1 DHCP 租约 hostname 回填 ═══
1. shared/types.ts 加 `RouterHints` 类型：`{ leaseHostnames: { mac: string; ip: string; hostname: string; expiresAt: number | null }[] }`（P1 只要租约主机名；wireless 数组 P2 再加）。
2. Engine 接口（engine/index.ts:32-63 区段）加 `applyRouterHints(hints: RouterHints): void`；scheduler 加 `setRouterHints()` 存内存（每轮 10s 刷新节奏，主进程喂）。
3. scheduler buildDevices 合并：**仅当 rec.hostname 为 null 时**用租约 hostname（按 MAC join；租约自带 ip）回填——不覆盖 rDNS/nbtstat/别名任何已有来源；回填后自然进入既有指纹管线（RE_MOBILE_HOST/-pc$ 等命中率上升）。
4. main/index.ts：routerManager.startPolling 回调（RouterStatus 更新处）把 dhcpLeases 映射成 RouterHints 喂 engine.applyRouterHints；数据缺失（web 会话/未登录）喂空数组，不猜。
5. 数据诚实：hostname 为空的设备仍显示 '—'（现有行为），不许造占位名。

═══ 完成标准 ═══
- `npm run typecheck` 零错误；定向相关测试全绿；全量 vitest 只增不减（当前基线 503+021 新增）。
- 实现报告写入 `.agent-runs/2026-10-25/task-022/implement-report-max1.md`：文件:行号级改动清单、与调查报告方案逐条对照、B-2 退避状态机说明、遗留风险。
- 回我简短状态块。完成后不碰任何渲染层其他文件。
