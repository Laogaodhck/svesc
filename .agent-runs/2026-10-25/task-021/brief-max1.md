# brief-max1（task-021 实现任务书：引擎 + 主进程 + 共享契约）

你是实现工程师 Max-1。项目根 C:/github/svesc。先读 `.agent-runs/2026-10-25/task-021/investigation-report.md`（Vera 调查，含全部文件:行号）与同目录 plan.md 的"队长裁定"节。

**你的文件边界（只许改这些，渲染层 .tsx/.css/format.ts 一律不碰）**：
`src/shared/types.ts`、`src/shared/channels.ts`、`src/shared/global.d.ts`、`src/main/ipc.ts`、`src/main/preload.ts`、`src/main/engine/alarms.ts`、`src/main/engine/scheduler.ts`、`src/main/engine/index.ts`、`src/main/engine/discovery/fingerprint.ts`、以及 `tests/` 下与上述相关的既有测试文件的**配套更新**（新用例由 Tess 写，你只保证既有用例过）。

项目铁律：引擎层不 import electron；数据诚实（失败给中文文案）；503/503 基线不得破坏。

═══ F1 告警清除（语义 A + 冷静期）═══

1. `types.ts`：`AlarmTraceEntry.type` 增加 `'cleared-by-user'`（types.ts:239-244 区段）。
2. `alarms.ts` 新增公开 API：
   - `clear(id, by: string): boolean`：查找 alarms[]（id 类型以现有 Alarm.id 为准）；不存在或已 cleared（resolvedAt!==null）返回 false。成功：置 resolvedAt=now、pushTrace('cleared-by-user', by)、active.delete、**记录 manualClears.set(key, now)**、返回 true。recentByKey 保持原样（不摘除）。
   - `clearMany(ids, by): number`：逐条调 clear，返回成功数。
   - **冷静期**：新增 `private manualClears = new Map<key, timestamp>()`。evaluate() 的 raise 路径（:217-234 抑制窗口判定**之前**）：若 key 在 manualClears 且 now-ts < ALARM_THRESHOLDS.suppressWindowMs → **完全静默 return**（不新建、不重开、不推送、不进 reopened）；已过窗 → 删除该 manualClears 条目后走正常流程。顺带在 evaluate 入口清理过期条目防膨胀。
   - trace type 为宽容解析（hydrate :117-126 未知 type 不崩），无需迁移代码。
3. `engine/index.ts`：门面加 `clearAlarm(id, by)` / `clearAlarms(ids, by)`（仿 ackAlarm :259-261）；stop 路径 :236-237 无需改（记录仍存在）。
4. `scheduler.ts`：仿 ackAlarm（:1055-1060）加 `clearAlarm(id, by)` / `clearAlarms(ids, by)`，成功后 `emitSnapshot()` 立即推帧。
5. `channels.ts`：`alarmsClear: 'alarms:clear'`（payload = ids 数组，单条也是数组）。
6. `ipc.ts`：handler 仿 ackAlarm（:49-58），by 注入 os.userInfo().username，调 scheduler.clearAlarms(ids, by)。
7. `preload.ts` + `global.d.ts`/types.ts LanApi：`alarmsClear(ids: Alarm['id'][]): Promise<void>`。

═══ F2 开机自启动（主进程链路）═══

1. `channels.ts`：`launchAtLoginSet: 'settings:launch-at-login'`（payload { on: boolean } → { ok: boolean; error: string | null }）。
2. `ipc.ts`：
   - settingsGet（:108-123）返回值注入 `launchAtLogin: app.getLoginItemSettings().openAtLogin` 与 `launchAtLoginAvailable: app.isPackaged`（照抄 appVersion 注入模式；**不要进 store/settingsUpdate 白名单**——OS 是唯一事实源）。
   - 新 handler：`app.isPackaged` 为 false → 返回 `{ ok: false, error: '开发模式下不可用，请使用安装版开启开机自启' }`；否则 `app.setLoginItemSettings({ openAtLogin: on })` 后**立即回读** `getLoginItemSettings().openAtLogin` 比对，不符返回 `{ ok: false, error: '设置未生效（可能被系统策略限制）' }`，相符返回 `{ ok: true, error: null }`。
3. `types.ts`：settingsGet 返回类型（SettingsPayload 或实际类型名，调查报告 :159-163 区段）增加上述两字段；LanApi 增加 `setLaunchAtLogin(on: boolean): Promise<{ ok: boolean; error: string | null }>`。
4. `preload.ts` / `global.d.ts` 同步。托盘 tray.ts 不改（读 OS 状态天然同步）。

═══ F3 手机识别（识别层）═══

`fingerprint.ts`：
1. `RE_MOBILE_HOST`（:52）补充高置信品牌词根：`oneplus|realme|nokia|zenfone|huawei|sm-[a-z]\d{3}`（三星机型 SM-G991B 等）。**禁** `moto` 泛匹配（误伤 motorola 路由器）。每加一条想清楚误伤面。
2. 主机名命中 mobile 的返回（:105-107）osHint 由 null 改为 `'手机（主机名特征）'`（与 camera/printer 路径风格一致）。
3. **mDNS 表（mdns-devices.ts）一个字都不动**（_apple-mobdev 未实测，宁缺勿滥）。

═══ F4 ═══
引擎零改动，你不参与。

═══ 完成标准 ═══
- `npm run typecheck` 零错误；`npx vitest run tests/alarms.test.ts tests/alarm-state.test.ts tests/fingerprint.test.ts tests/settings.test.ts` 全绿（既有用例如有语义冲突，允许最小修正并在报告说明）；全量 `npx vitest run` 跑一遍确认 503 基线只增不减。
- 实现报告写入 `.agent-runs/2026-10-25/task-021/implement-report-max1.md`：改动文件清单（文件:行号级）、API 形状落地情况（与 plan.md 冻结形状逐条对照）、既有测试修正说明、遗留风险。
- 回我简短状态块即可。完成后不要碰渲染层文件。
