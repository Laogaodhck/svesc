# brief-max2（task-021 实现任务书：渲染层）

你是实现工程师 Max-2。项目根 C:/github/svesc。先读 `.agent-runs/2026-10-25/task-021/investigation-report.md`（Vera 调查，含全部文件:行号）与同目录 plan.md 的"队长裁定"节。

**你的文件边界（只许改这些；types.ts/channels.ts/preload/global.d.ts/ipc/engine 一律不碰，由 Max-1 负责）**：
`src/renderer/views/AlarmsView.tsx`、`App.tsx`、`SettingsView.tsx`、`DevicesView.tsx`、`OverviewView.tsx`、`DeviceDetailDrawer.tsx`、`src/renderer/lib/format.ts`、`src/renderer/views.css`。

项目铁律：数据诚实（拿不到显示 '—'，失败必须有中文文案，绝不显示 0/假状态）；IPC 推送式，渲染层不轮询；操作失败必须可见。

**Max-1 正在并行落地以下冻结接口（你直接按形状写，类型编译会在他完成后通过；不要自己改类型文件）**：
- `window.lanApi.alarmsClear(ids: Alarm['id'][]): Promise<void>`（单条传 [id]；完成后 snapshot 推送自动刷新）
- `window.lanApi.setLaunchAtLogin(on: boolean): Promise<{ ok: boolean; error: string | null }>`
- settingsGet 返回增加 `launchAtLogin: boolean`、`launchAtLoginAvailable: boolean`
- `AlarmTraceEntry.type` 增加 `'cleared-by-user'`

═══ F1 告警清除 UI（AlarmsView.tsx + App.tsx）═══

1. 行内"清除"按钮：pending 与 acked 状态行显示（cleared 不显示），文案"清除"（与"确认"区分：确认=我知道了，清除=关闭这条告警）。点击调 `lanApi.alarmsClear([alarm.id])`，busy 防重入；失败给可见中文错误。
2. 工具栏"清除当前范围（N）"：仿"全部确认（N）"（AlarmsView.tsx:225-238），N = 当前筛选范围内 pending+acked 的条数；App.tsx 仿 onAckAll 串行逐条（:151-164）加 onClearRange。
3. `TRACE_LABEL`（:30-35）加 `cleared-by-user: '手动清除'`；详情时间线与操作人字段按 trace entry 现有展示模式渲染（时间线已倒序展示，新增类型自动进）。
4. 详情面板"清除时间"（:110-111）对 cleared 状态照常显示——手动清除与自动清除都置 resolvedAt，无需分支。

═══ F2 开机自启动 UI（SettingsView.tsx）═══

"通用"卡片（:155-215 区段）加一行：复用现成 Switch 组件（:17-49）与 update/msg 模式（:91-108、:295-299）。
- 开关 on = settings.launchAtLogin；`disabled={!settings.launchAtLoginAvailable || busy}`。
- `launchAtLoginAvailable === false` 时 hint 显示"开发模式下不可用，请使用安装版"；可用时 hint"开机后自动在后台启动并常驻托盘"。
- 切换调 `setLaunchAtLogin(next)`：ok:false 时 msg 条显示返回的中文 error；成功后用返回状态刷新开关（不本地乐观置位——以主进程回读结果为准）。
- **不写 store**（OS 是唯一事实源）。

═══ F3 手机标识（format.ts + 确认同步）═══

1. `format.ts:139` KIND_LABEL `mobile: '移动端'` → `mobile: '手机'`。列表类型列（DevicesView.tsx:117）、类型筛选下拉（:389-394）、详情（Drawer:209、:285）都走 KIND_LABEL，自动同步，改后全局检查无硬编码"移动端"残留。
2. 不做图标/徽标化（裁定：避免超范围）。

═══ F4 无流量归集一等公民化（DevicesView + OverviewView + Drawer + views.css）═══

1. **DevicesView 流量筛选**（筛选区 :345-411）：加"流量状态"筛选：全部 / 可归集 / 不可归集（按 `bandwidth.attributable` 判定，types.ts:34-35）。
2. **DevicesView 排序 fallback**（:262-263）：现按 rxBps+txBps 排——该排序下不可归集设备（数值无意义）排尾；保留该行为，但新增"按活跃连接"排序项（SortKey 加 'lanConnections'，降序，本机可拿到的真实数据，作为无归集时的有意义排序）。
3. **OverviewView 统计**（:311 区段）：KPI 区加"可归集设备 x / y"（x=attributable 台数，y=在线设备总数），副文案一句"仅统计与本机的 TCP 会话"。
4. **DeviceDetailDrawer 常驻说明**（:419-476）：把 title 里的悬浮解释升级为常驻说明块："该设备未与本机建立 TCP 会话，流量无法归集；流量统计仅覆盖与本机的会话"（attributable=false 时显示；true 时显示现有推算说明）。样式放 views.css，复用现有卡片/说明类 class 风格。
5. **红线**：任何分支不得出现"无数据 → 显示 0 Kbps"；'—' 与数值的现有分支（:134-152）不得回归。

═══ 完成标准 ═══
- Max-1 的类型落地后：`npm run typecheck` 零错误；`npx vitest run` 全绿（渲染层无测试，靠 Vic 的 SMOKE）。
- 自查：全局搜"移动端"无残留；操作均有失败文案；无轮询新增。
- 实现报告写入 `.agent-runs/2026-10-25/task-021/implement-report-max2.md`：改动文件清单（文件:行号级）、各功能 UI 落点、与冻结形状的对照结果、遗留风险。
- 回我简短状态块即可。
