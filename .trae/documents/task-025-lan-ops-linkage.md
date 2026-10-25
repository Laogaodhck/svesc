# task-025：局域网运维功能扩展 + 联动机制完善（实现计划）

> 状态：范围已经用户确认（2026-10-26，全部选项）。本文是实现蓝本。
> 上游审计结论见 §0；每项功能的契约与联动点见 §2；验证命令见 §4。

## 0. 链路审计结论（已完成）

**已打通（无阻塞）**：快照推送 / 扫描进度 / 告警全链（推送+日志环+SQLite+桌面通知+UI upsert）/ 路由器联动（状态推送 + DHCP 租约回填 hostname + 自动重登）/ 打印机联动（15s 刷新 + 操作后立即 refreshPrinters）/ 跨视图跳转（告警→抽屉/高亮，抽屉→诊断预填）。

**唯一断点（本任务修复）**：`DeviceDetailDrawer.tsx` L104-128 只在打开瞬间取一次 `getDeviceDetail`，抽屉打开期间端口/连接表/RTT 历史冻结不刷新。

**次要观察（不改）**：告警恢复靠 5s 快照帧对齐（设计使然）；设备 records Map 只增不减（上限 254，无风险）。

## 1. 范围（用户全选 12 项）

| # | 功能 | 分组 |
|---|---|---|
| 1 | 抽屉实时刷新修复（断点） | 联动修复 |
| 2 | WOL 网络唤醒 | 设备运维 |
| 3 | 持续 Ping 监控列表（宕机告警联动） | 设备运维 |
| 4 | 设备备注/标签（列表过滤联动） | 设备运维 |
| 5 | 自定义端口扫描器（诊断中心） | 设备运维 |
| 6 | 总带宽历史曲线（Overview，60 点） | 观测 |
| 7 | tracert 跳数表格化 | 观测 |
| 8 | 设备列表 RTT 迷你条 | 观测 |
| 9 | 告警 Webhook 通知 | 通知/报告 |
| 10 | HTML 导出报告 | 通知/报告 |
| 11 | 配置导出/导入 | 通知/报告 |

## 2. 实现方案（逐项契约）

### 2.1 抽屉实时刷新（#1）
`DeviceDetailDrawer.tsx`：现有 getDeviceDetail effect 改为「打开时立即取 + 打开期间每 5s 轮询重取」。实现：在现有 useEffect 内 `const t = setInterval(fetch, 5000)`，清理时 clearInterval；alive 标志沿用。静默失败：轮询失败保留旧数据，仅首次加载失败才 setError（数据诚实：不让轮询抖动清空已展示数据）。

### 2.2 WOL（#2）
- 新建 `src/main/engine/wol.ts`：`sendMagicPacket(mac, opts?)` 纯 Node dgram。报文 = 6×0xFF + 16×目标 MAC（广播 255.255.255.255:9，也向 7/9 端口各发一次尽力而为）。MAC 校验正则 `^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$`，非法返回 `{ok:false,error}`。发送即成功（UDP 无确认，**不承诺唤醒成功**，错误仅限 socket/bind 失败）。单测：报文字节构造断言（模拟 snmp-ber 测试风格）。
- 引擎门面 `Engine.wakeDevice(deviceId)`：从 scheduler.buildDevices() 找设备 → mac 为 null 时返回 `{ok:false,error:'未知 MAC，无法唤醒'}`；设备在本网段外/自己/网关时给出诚实错误。成功后 netlog.push('info','wol',...)。
- IPC：`CH.deviceWake = 'device:wol'`；ipc.ts 校验 deviceId 字符串。preload + LanApi 类型同步。
- UI：DeviceDetailDrawer 对 `state==='offline' && mac` 显示「网络唤醒」按钮；点击后 toast/内联提示「唤醒包已发送至 <MAC>，等待设备回转在线」（不自动确认在线，用户自己看状态）。

### 2.3 持续 Ping 监控列表（#3）
- 新建 `src/main/engine/watch.ts`：`WatchManager` 类。配置：`targets: { ip, addedAt, note? }[]`（持久化进 store）。行为：独立定时器 5s 一轮（复用 discovery/ping.ts 的 pingSweep，timeout 1000ms），维护每目标环形窗口 60 点 `{ts, alive, rttMs|null}`；统计 `upPct`（窗口内存活率）、`downSince`（连续宕机起始时间，恢复清 null）、连续宕机轮数。内存态统计不落库，只落 targets 列表。
- 告警联动：AlarmEngine 新增规则 `WATCH_DOWN`（severity 'critical'，targetType 'device'，targetId = watch 的 ip）。AlarmEngine 增加 `ingestExternal(code, targetId, targetName, message, severity)` 方法：复用既有 (code,targetId) 去重与恢复语义——active 已存在则不再 created；调用 `ingestResolve(code,targetId)` 收尾。WatchManager 每次 tick 后对比上轮状态，变迁时回调 `onTransition(down: boolean, target)`，由 engine/index.ts 组装时接线到 alarms.ingestExternal + scheduler.emitSnapshotNow()。
- 快照契约：`Snapshot.watches: WatchStatus[]`（新类型 `{ ip, addedAt, note, window: {ts,alive,rttMs|null}[], upPct: number|null, downSince: number|null, state: 'up'|'down'|'unknown' }`）。samples<1 时 state 'unknown'。
- 持久化：store 新键 `watchList`（SqliteStore/JsonStore 同构接口各加列/键——实现前先读 `store.ts` + `db/sqlite.ts` 决定用独立表还是 JSON 键；导出/导入见 #11）。
- IPC：`watchList`（列表+状态）、`watchAdd(ip, note?)`、`watchRemove(ip)`；ip 白名单校验同 validateDiagTarget。preload 同步。
- UI：新视图 `WatchesView`（侧边栏新增入口「监控」）：目标卡（状态灯、可用率、宕机时长、迷你窗口条）+ 添加/移除；`DevicesView` 行内与 `DeviceDetailDrawer` 加「加入监控」快捷按钮（联动：已加监控的设备在列表/抽屉显示监控徽标）。

### 2.4 设备备注/标签（#4）
- 持久化：store 新键 `deviceNotes: Record<id,string>`、`deviceTags: Record<id,string[]>`（与别名同表模式，实现前读 store 决定列方案）。
- IPC：`deviceSetNote(id, note|null)`、`deviceSetTags(id, tags[]|null)`（tags 归一化：trim、去空、去重、每标签 ≤24 字符、≤8 个）。成功后 `scheduler.emitSnapshotNow()` 立即生效。
- 快照：Device 增加可选字段 `note?: string | null`、`tags?: string[]`（applyAliases 处统一注入，改名或复用该函数为 applyDeviceMeta）。
- UI：抽屉内联编辑备注/标签；DevicesView 顶部标签过滤 chips（选中过滤列表，与搜索框并存）；有 note 的设备列表行显示备注图标（hover 显示）。

### 2.5 端口扫描器（#5）
- 新建 `src/main/engine/diag/portscan.ts`：`scanPortRange(ip, from, to, {concurrency=64, timeoutMs=700})`。约束：范围 1-65535，单次上限 1024 端口（超出如实报错拒绝）；net.connect；返回 `{ok, ports: {port, open}[], openPorts: number[], durationMs, error|null}`。目标校验复用 validateDiagTarget。
- IPC：`diagPortScan(ip, from, to)`。经 CH.diagPortScan。preload 同步。
- UI：DiagnosticsView 新增「端口扫描」卡：目标 + 起止端口 + 结果表（开放端口高亮）。默认常用范围预填（如 1-1024 或用户上次输入）。

### 2.6 总带宽历史曲线（#6）
- scheduler：新增 60 点环形 `bandwidthHistory: {ts,rxBps,txBps}[]`，sampleBandwidth 每次有效差分后 push（无效采样 null 值不入或入 null 点——取「入 null 点、曲线断开」以诚实呈现失败）。
- 契约：`Snapshot.system.bandwidthHistory`（或平级 `Snapshot.bandwidthHistory`，取 system 内）。
- UI：OverviewView 新增带宽曲线卡（内联 SVG 面积图，复用设备抽屉 RTT 曲线的绘制风格；空数据/全 null 显示「暂无采样」占位而非空图）。

### 2.7 tracert 跳数表格化（#7）
- `engine/diag/netdiag.ts`：runDiag('tracert') 在现有 lines 基础上新增结构化解析 `hops: {idx:number, ip:string|null, hostname:string|null, rtts:(number|null)[]}[]`（解析 Windows tracert 输出：`  1    <1 ms    1 ms     1 ms  192.168.2.1`；`* * *` 行 rtts 全 null、ip null）。解析失败时 hops 为空数组（诚实降级，文本 lines 仍在）。
- 契约：DiagResult 增加可选 `hops?`。
- UI：DiagnosticsView tracert 结果上方渲染跳数表（跳数/IP/主机名/三次延迟），下方保留原始文本（可折叠）。

### 2.8 RTT 迷你条（#8）
- DevicesView 行内加迷你 sparkline（数据源 device.rttHistory，快照已有）。内联 SVG，宽度 ~80px；null rtt 画断点；无样本显示「—」。复用/新建 `components/atoms/Sparkline.tsx`（若 PrinterManageView/抽屉已有类似实现则先查重用）。

### 2.9 告警 Webhook（#9）
- 新建 `src/main/engine/notify/webhook.ts`：`postWebhook(url, payload)`，node:http(s)，5s 超时，返回 `{ok, status?, error?}`；不重试、绝不抛。
- 设置：AppSettings 新增 `notifyWebhookUrl: string`（默认空 = 停用）。settingsUpdate 白名单加入。
- 触发点：engine/index.ts 组装处——告警 created 与 resolved（resolved 需 AlarmEngine 评估结果暴露 resolved 列表，evaluate 已返回；在 scheduler.buildSnapshot 的告警段把 resolved 也经新 hook `onAlarmResolved` 上抛）→ engine 内 fire-and-forget postWebhook，payload `{event:'alarm.created'|'alarm.resolved', alarm, ts}`；失败 push netlog（'warn','webhook'）。
- UI：SettingsView 新增 URL 输入 + 「发送测试」按钮（IPC `webhookTest` 调 postWebhook(url, {event:'test',...})，结果如实展示）。
- 诚实约束：URL 非法/发送失败只在日志环与测试按钮结果可见，不弹全局错误条（避免网络抖动刷屏）。

### 2.10 HTML 导出报告（#10）
- 新建 `src/main/engine/report-html.ts`：`buildHtmlReport(snapshot, extras) → string`。自包含（内联 CSS，无外链无 JS）：汇总头（网段/时间/数据源/告警计数）、设备表（状态/别名/厂商/质量/带宽）、打印机表、活跃告警表、降级 warnings 列表。中文标签。纯函数可单测（断言关键 id/转义：**所有动态文本必须 HTML 转义**，防备注/别名里的 `<` 注入）。
- 引擎：`exportReport(format: 'json'|'html', extras?)` 扩展现有方法（保持向后兼容缺省 json）。文件名 `svesc-report-*.json/.html`。
- IPC：exportReport 增加 format 参数；UI：Topbar 导出按钮改为下拉两项（JSON / HTML）。preload/useLiveFeed.exportReport 透传。

### 2.11 配置导出/导入（#11）
- 引擎：`exportConfig(): string`（JSON：settings + aliases + deviceNotes + deviceTags + watchList + printerManage + firstSeen，含 schemaVersion:1 与导出时间）、`importConfig(json): {ok, imported: string[], skipped: string[], error|null}`（逐键合并导入，schemaVersion 不符拒绝；非法值跳过该键并计入 skipped，绝不整包静默失败）。写入下载目录 `svesc-config-*.json`。
- IPC：`configExport` / `configImport`（import 渲染层传 JSON 文本，主进程解析）。设置页：导出/导入按钮 + 导入结果明细展示。

## 3. 执行顺序（新窗口按此推进）

1. **契约层**：types.ts（新类型/扩展字段）+ channels.ts（新通道）+ preload.ts + LanApi。
2. **引擎新模块**（每个带 Vitest 单测）：wol.ts / watch.ts / portscan.ts / report-html.ts / webhook.ts；netdiag hops 解析；AlarmEngine.ingestExternal + WATCH_DOWN。
3. **store 扩展**：先读 store.ts + db/sqlite.ts，加 deviceNotes/deviceTags/watchList 键（SqliteStore 与 JsonStore 同构）。
4. **scheduler/engine 接线**：带宽历史环、watch 定时器与告警接线、applyDeviceMeta（别名+备注+标签）、exportReport 扩展、exportConfig/importConfig。
5. **ipc.ts + 主进程**：新通道注册 + settingsUpdate 白名单 + Topbar 导出参数。
6. **UI**：抽屉刷新/WOL 按钮/备注标签编辑 → WatchesView + DevicesView 徽标过滤 → DiagnosticsView 扫描器+tracert 表 → OverviewView 带宽曲线 → DevicesView 迷你条 → SettingsView（webhook + 配置导入导出）→ App.tsx/Sidebar/Topbar 接线。
7. **验证**：`npm test`（基线 610 全绿，新增用例全部通过）+ `npm run typecheck` + `npx tsc --noEmit -p tsconfig.web.json`（renderer 不在 node tsconfig 内！）+ engine 纯度 `grep -r "from 'electron'" src/main/engine` 恒 0。
8. **文档**：ARCHITECTURE.md §2 模块表 + §10 增补 task-025 小节。

## 4. 铁律（全程遵守）

- 分层：`src/main/engine/**` 禁 import electron；Electron 能力由主进程注入。
- 数据诚实：无证据 null/unknown；失败进 warnings/netlog 不静默；UDP/HTTP 发送不承诺结果。
- 子进程：唯一出口 exec.ts；cmd/args 分离；打印机名/MAC/URL 等外部输入全部校验或转义。
- 引擎周期任务失败必须可感知（写 warnings），绝不静默失联。
- 打包：`npm run dist` 已固化 `--publish never`，不要移除。
- 提交：**未经用户确认不得 git commit/push**（工作区尚有 task-024 未提交改动 + 待推提交 7e3ccf2）。

## 5. 验证基线

- `npm test`：610/610（task-024 后基线），本任务预期新增 ~40-60 用例。
- `npm run typecheck`：node 侧零错误。
- `npx tsc --noEmit -p tsconfig.web.json`：renderer 侧零错误。
- `LAN_DEMO=1` 起应用人工过一遍新 UI（若条件允许）。
