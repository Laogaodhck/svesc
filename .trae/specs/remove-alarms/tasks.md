# Tasks：移除「告警」功能

- [x] T1 shared 层：`types.ts`/`channels.ts`/`constants.ts` 清理；删 `alarm-state.ts`
- [x] T2 engine 层：删 `alarms.ts`；`scheduler.ts`/`engine/index.ts`/`store.ts`/`db/sqlite.ts`/`db/migrations.ts`(v3 DROP)/`db-check.ts`/`report-html.ts`/`soak.ts` 剥离；删 `notify/webhook.ts`（含 scripts/engine-check/db-check/soak-check 同步清理）
- [x] T3 main 层：`ipc.ts`/`preload.ts`/`index.ts`/`tray.ts`/`smoke.ts` 剥离
- [x] T4 renderer 层：`App.tsx`/`Sidebar.tsx`/`OverviewView.tsx`/`PrintersView.tsx`/`useLiveFeed.ts`/`SettingsView.tsx`/`Icon.tsx`/`views.css`/`global.d.ts`；删 `AlarmsView.tsx`
- [x] T5 tests：删 2 个专用文件；改写 7 个混合文件
- [x] T6 验证：npm test 全绿 + typecheck 双端 + engine 纯度 grep=0 + engine-check exit 0 + alarm 残留 grep
- [x] T7 ARCHITECTURE.md 更新（§3 快照结构、§7、§10 变更记录）
