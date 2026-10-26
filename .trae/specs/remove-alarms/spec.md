# Spec：移除「告警」功能

## 目标
将 SVESC 局域网监控台中的告警（alarms）子系统整体移除：引擎、持久化、IPC、推送、通知、Webhook、UI 全链路。功能行为等价于"告警从未存在"。

## 边界决策（已定）
| 项 | 决策 | 理由 |
|---|---|---|
| 告警引擎/视图/推送/通知/Webhook | 移除 | 用户指令主体 |
| 持续 Ping 监控（watches） | **保留**，仅去告警联动 | 独立功能；`handleWatchTransition` 改为仅 `emitSnapshotNow()`，宕机仍在 WatchesView 显示 down 状态，不再产生告警/通知 |
| 设备离线判定 | 保留 | `ALARM_THRESHOLDS.offlineArpMisses(4)` 迁移为 `HEARTBEAT_PROBE.offlineArpMisses`，`resolveLinkState` 逻辑不变 |
| IP 冲突侦测与设备徽标 | 保留 | 冲突解析在 `arp.ts`，`ipConflict` 字段不依赖告警引擎 |
| warnings（R-03 降级信息） | 保留 | 与告警无关 |
| firstSeen 持久化 | 保留 | 仅失去 DEVICE_NEW 时的实时固化时机，stop 落盘兜底仍在 |
| 打印机 state='error' 展示 | 保留 | 仅不再产生告警 |
| SQLite alarms/known_device_keys 表 | 追加迁移 v3 DROP | 旧版本启动会 `CREATE TABLE IF NOT EXISTS` 重建，回滚安全 |

## 删除的文件
- `src/main/engine/alarms.ts`
- `src/shared/alarm-state.ts`
- `src/renderer/views/AlarmsView.tsx`
- `src/main/engine/notify/webhook.ts`（postWebhook，若 notify/ 目录仅此文件则目录一并删）
- `tests/alarms.test.ts`、`tests/alarm-state.test.ts`

## 修改清单（按层）

### shared
- `types.ts`：删 `AlarmSeverity`、`AlarmTraceEntry`、`Alarm`、`SystemStat.alarmCounts`、`Snapshot.alarms`、`LanApi.ackAlarm/alarmsClear/onAlarm/webhookTest`、`AppSettings.notifyDesktop/notifyWebhookUrl`
- `channels.ts`：删 `ackAlarm`、`alarmsClear`、`webhookTest`、`alarm` 四通道
- `constants.ts`：删 `ALARM_THRESHOLDS`（offlineArpMisses 迁入 HEARTBEAT_PROBE）、`WINDOW.alarmHistory`、`ALARM_TRACE_MAX`、`NEW_DEVICE_TTL_MS`

### engine
- `scheduler.ts`：删 `alarms: AlarmEngine` 字段、构造参数 `alarmEngine`、`handleWatchTransition` 告警注入（保留推帧）、`alarmEngine` getter、`ackAlarm/clearAlarm/clearAlarms`、`exportAlarmState/hydrateAlarmState`、`alarmEvaluation` getter、`lastAlarmEval`、`buildSnapshot` 的 evaluate 块与 `Snapshot.alarms` 字段、hooks `onAlarm/onAlarmResolved`、`Alarm/AlarmEvaluation/AlarmEngine/ALARM_CODES` imports；`ALARM_THRESHOLDS` 引用改 `HEARTBEAT_PROBE`
- `engine/index.ts`：删 `fireWebhook`、hooks `onAlarm/onAlarmResolved`（含 netlog 告警入环、upsertAlarm、DEVICE_NEW→setFirstSeen 联动）、`hydrateAlarmState` 调用、stop 中 `exportAlarmState/setAlarmHistory`、接口与实现 `ackAlarm/clearAlarm/clearAlarms/webhookTest`、re-export `AlarmEngine/ALARM_CODES/dedupeKey`
- `store.ts`：`PersistedState.alarms/knownDeviceKeys` 删、`defaultState` 清理、normalize 白名单删两字段、`setAlarmHistory` 删、Store 接口 `upsertAlarm?` 删
- `db/sqlite.ts`：`alarmFromRow/parseTrace` 删、`get()` 不再 SELECT alarms、`setAlarmHistory/upsertAlarm` 删、legacy JSON 导入跳过 alarms（knownDeviceKeys 同）
- `db/migrations.ts`：追加 version 3 `DROP TABLE IF EXISTS alarms; DROP TABLE IF EXISTS known_device_keys;`
- `db-check.ts`：`alarmRestored` 字段与 upsertAlarm 检查删
- `report-html.ts`：活跃告警节（activeAlarms/alarmRows/表头/meta 计数）删
- `soak.ts`：`checkNewDeviceLifecycle` 及 `SoakSample`/`SoakReport` 告警字段（alarmCounts/deviceNewActive/deviceNewResolved/batchResolved/maxSameMsResolved）删，保留质量长跑部分
- `watch.ts`：不动

### main
- `ipc.ts`：`ackAlarm/alarmsClear/webhookTest` handlers 删、`pushAlarm` 导出删
- `preload.ts`：`ackAlarm/alarmsClear/onAlarm/webhookTest` 桥接删
- `index.ts`：`pushAlarm/updateBadge` import 删、`onAlarm` hook（推送+桌面通知）删、快照回调中角标计数块删
- `tray.ts`：`activeAlarms` 计数、`updateBadge` 导出、badgeImage 生成删；退出菜单文案与 tooltip 简化
- `smoke.ts`：`SmokeView` 去 `'alarms'`、对应 capture 段删、结果 `alarms` 计数删

### renderer
- `App.tsx`：AlarmsView import/case、`alarms/activeAlarms/criticalAlarms` 派生、`onAck/acking/ackingAll/onClear/clearing/clearError/onClearRange/openAlarmTarget`、`NO_ALARMS`、Sidebar counts 传参、PrintersView `alarms` prop 删
- `components/shell/Sidebar.tsx`：ViewKey 去 `'alarms'`、导航项、`counts.alarms/criticalAlarms` props 删
- `views/OverviewView.tsx`：活跃告警 KPI 卡、最新告警卡（timeline）、`onOpenAlarm` prop、`onNavigate` 类型收窄 `'devices'|'printers'`、`sevCounts/pulse` 删
- `views/PrintersView.tsx`：`alarms` prop 与「活动告警」计数删
- `hooks/useLiveFeed.ts`：`onAlarm` 订阅合并、`ackAlarm` 方法删
- `views/SettingsView.tsx`：Webhook 区块（draft/test/save/UI）与 `notifyDesktop` 开关删
- `components/Icon.tsx`：`'alarm'` 图标删
- `styles/views.css`：告警专属类清理（timeline 若仅剩告警使用则一并清）
- `shared/global.d.ts`：ViewKey 中 `'alarms'` 删

### tests
- 删：`alarms.test.ts`、`alarm-state.test.ts`
- `audit-fixes.test.ts`：AlarmEngine 用例删，保留非告警审计项
- `task017-features.test.ts`：AlarmEngine 用例删；保留 IP 冲突 arp 解析、store firstSeen 等非告警项
- `printer-service.test.ts`：AlarmEngine detail 文案用例删
- `sqlite-store.test.ts`：告警持久化用例删
- `task025-lan-ops.test.ts`：G 节 ingestExternal/ingestResolve、webhook 用例删；保留 watch/wake/notes/tags/config
- `scheduler-resilience.test.ts`：`offlineAlarms` 断言改为 `buildDevices()` 的 `state==='offline'`；`ALARM_THRESHOLDS` import 改 `HEARTBEAT_PROBE`
- `settings.test.ts`：fixture 中 `alarms/knownDeviceKeys` 字段随 normalize 白名单移除

## 验证
1. `npm test` 全绿（用例数下降属预期）
2. `npm run typecheck`（node + web 双端，以 package.json 实际脚本为准）
3. engine 纯度：`src/main/engine` 内 `import electron` grep = 0
4. `node scripts/engine-check.mjs` exit 0（若脚本引用告警字段则同步修改）
5. `grep -ri alarm src/` 残留仅允许存在于历史注释/无关词（目标 0 处功能性引用）

## 交付约束
- 不 commit / 不 push，完成后汇报待确认
- 版本号 bump 与打包不在本任务范围
