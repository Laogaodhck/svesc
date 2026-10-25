# task-021 四项功能现状调查报告（Vera · 只读）

- 日期：2026-10-25　·　代码基线：当前工作树（503/503 测试通过，task-019/020 已合入）
- 方法：全部结论基于源码实读，行号以当前文件为准；未实测运行行为的地方已标注"未验证"。

---

## F1 告警清除机制（单个 + 批量）

### 现状

**生命周期（引擎）** — `src/main/engine/alarms.ts`：
- 内存模型三本账：`alarms[]`（全量历史，:79）、`active Map`（未清除，:80）、`recentByKey Map`（同因最近一条，抑制窗口索引，:82）。
- 手动操作只有 **ack**（`ack()` :171-184）：置 `ackAt/ackBy` + trace 记 `acked`；仅 DEVICE_NEW 会在 ack 时顺带 resolved（:179-182）。
- **resolve 没有任何手动入口**：`resolve()` 是 `evaluate()` 的内部闭包（:259-267），只能由"条件消失"触发（如 :283、:358、:375）；没有 `resolveAlarm(id)` 公开方法。
- 抑制窗口：raise 时若 `recentByKey` 里同因记录 `resolvedAt` 距今 < `ALARM_THRESHOLDS.suppressWindowMs`（10 分钟），**合并回原记录**（occurrences+1、trace 记 re-raised、不推送），见 :217-234。
- `trimHistory()`（:451-468）裁历史时会把 `recentByKey` 里指向被裁记录的条目同步摘除（:460-462）——这是"删除告警后必须同步摘索引"的现成范式。

**三态语义** — `src/shared/alarm-state.ts`：`pending → acked → cleared`；`cleared = resolvedAt !== null`（:16-18）；注释明言 **"cleared 不可逆；同因再触发产生全新告警"**（:10）。

**关键语义事实：UI 已经把 resolved 叫"清除"** — `AlarmsView.tsx:34`（`TRACE_LABEL.resolved = '清除'`）、`:110-111`（"清除时间"）、`:24`（"已清除"徽标）。即：**用户口径的"清除"与系统现有"已清除"（条件恢复自动 resolve）撞名**，但现有系统**没有"用户手动清除"这个动作**。

**对外链路**：
- 引擎门面 `engine/index.ts:259-261` 仅 `ackAlarm`；`stop()` 时 `exportAlarmState → store.setAlarmHistory`（:236-237）。
- scheduler `ackAlarm`（`scheduler.ts:1055-1060`，成功后 `emitSnapshot()`）。
- IPC：`CH.ackAlarm`（`channels.ts:8`）→ `ipc.ts:49-58`（ackBy 由主进程注入 OS 用户名）→ preload `preload.ts:40`。**没有 resolve/clear 通道**。
- 持久化：`sqlite.ts` 只有 `upsertAlarm`（:456-471）与 `setAlarmHistory`（:425-453，INSERT OR REPLACE 全量兜底），**没有 DELETE alarms 的任何 API，alarms 表也没有软删列**（见 migrations 建表；`get()` :290 全量读回）。

**UI 现状** — `AlarmsView.tsx`：
- 操作按钮：单条"确认"（pending 时渲染，:320-331）+ "详情"展开（:332-341）；**没有"清除/解决"按钮**。
- 批量：只有"全部确认（N）"（:225-238），口径 = 当前筛选范围内 pending 的 id（:151），App 侧串行逐条 IPC（`App.tsx:151-164`）。
- **表格无多选**（无 checkbox 列，行主体是打开详情的按钮 :280-284）；四态筛选 pending/acked/cleared/all（:47、:142-148）。

### 缺口

用户要"单个 + 批量清除"，系统现状是"清除"= 自动机 resolve，且不可手动。缺口 = **一个用户主动清除动作**，而它有**两种互斥语义**需要 team-lead 定夺：

- **语义 A（推荐）：手动 resolve**。清除 = 立即置 `resolvedAt`（+trace 记新类型 `cleared-by-user`），记录保留在"已清除/全部"可追溯。与三态模型、trace 审计、`"cleared 不可逆"` 完全兼容，改动面最小。
  - **必须处理的坑**：手动清除后条件仍在（如设备还离线），下一轮 `evaluate()` 的 raise 走抑制窗口分支（alarms.ts:219-234）会把这条**合并重开**——用户刚清掉 1 秒后告警"复活"。方案：(a) 手动清除时把该 key 从 `recentByKey` 摘除 → 重开变成新告警（符合"用户已表态，再有变化是新鲜事"，但 10 分钟窗口保护失效，可能闪断刷屏）；(b) 给 Alarm 加 `clearedByUser` 标记，抑制窗口对用户清除的记录**延长或跳过**——(a) 简单但改变抑制语义，需在 trace 里能看出区别。二选一须明示。
- **语义 B（硬删/软删）**：从列表移除（连"已清除"也看不到）。需要 engine `deleteAlarms(ids)` + sqlite `DELETE FROM alarms WHERE id IN (...)` + hydrate 不受影响 + trimHistory 的 recentByKey 同步摘除范式（:460-462）。**与现有数据诚实/可追溯设计冲突**（trace 账目残缺、"已清除"视图失去意义），且 `setAlarmHistory` 全量 REPLACE 兜底（stop 时）会把删掉的记录重新写回——**必须同时改 stop 路径**（engine/index.ts:236-237），否则重启后复活。

### 建议方案（按语义 A）

1. 引擎：`AlarmEngine.resolveById(id, { by })`（校验存在、置 resolvedAt、pushTrace 新类型 `'cleared-by-user'`、active.delete、按语义 A 决定是否摘 recentByKey）+ `resolveByIds(ids)` 批量；`alarm-state.ts` 不变（cleared 判定天然成立）。
2. 持久化：清除后逐条 `store.upsertAlarm(alarm)`（现成，:456-471）——**不需要新 SQL**。
3. 链路：`channels.ts` 新增 `alarmsClear`/`alarmsClearAll` → `ipc.ts` handler（仿 ack，:49-58；如需记录操作人可复用 os.userInfo 注入）→ `engine/index.ts` 门面 → `scheduler.resolveAlarm(s)`（仿 :1055-1060，成功后 `emitSnapshot()` 立即推帧）→ preload 暴露。
4. UI：`AlarmsView.tsx` 行内加"清除"按钮（pending/acked 均可清）+ 工具栏"清除当前范围（N）"（仿"全部确认" :225-238，App.tsx 仿 onAckAll 串行 :151-164）；不做 checkbox 多选（现列表无多选基建，"范围批量"已覆盖用户诉求且实现成本低）。文案必须区分：**"确认"= 我知道了；"清除"= 关闭这条告警**（trace 与详情面板如实记录 `cleared-by-user` + 时间）。
5. 测试：`alarms.test.ts` 补 resolveById/批量/抑制窗口交互三组。

### 涉及文件
`alarms.ts`（+API）、`types.ts`（AlarmTraceEntry.type 加 `'cleared-by-user'`，types.ts:239-244）、`channels.ts`、`ipc.ts`、`engine/index.ts`、`scheduler.ts`、`preload.ts`、`AlarmsView.tsx`、`App.tsx`、`alarm-state.ts`（仅文案）、`tests/alarms.test.ts`、`tests/alarm-state.test.ts`。

### 风险
- 抑制窗口与手动清除的交互（见上），测试不覆盖会变成"清了又弹"。
- 若选语义 B，`stop()` 的全量 REPLACE 兜底会复活已删记录（engine/index.ts:236-237）。
- trace type 是契约：加枚举值需同步 `AlarmsView.TRACE_LABEL`（:30-35）与旧数据 hydrate 迁移路径（alarms.ts:117-126 对未知 type 是宽容的，不会崩，但显示会回退英文）。

---

## F2 开机自启动（设置页开关）

### 现状

- **托盘已实现同款能力**：`src/main/tray.ts:53-57` `toggleLoginItem()`（`app.setLoginItemSettings({ openAtLogin })`）；`:67` 状态读取 `app.getLoginItemSettings().openAtLogin`；**:79-84 托盘菜单勾选项，但 `enabled: app.isPackaged`——开发态禁用并显示"开机自启（仅安装版可用）"**。
- 设置持久化：`PersistedSettings`（`store.ts:12-25`，现 7 字段，默认值 :74）；SQLite 读写 `sqlite.ts:243-266 / :336-351`（JSON 序列化逐 key 存储，**加字段无需迁移**，`pick()` 对未知 key 是宽容的）。
- 引擎门面：`getSettings/updateSettings`（`engine/index.ts:204-228`）；IPC `settingsGet/settingsUpdate`（`ipc.ts:108-123`，**白名单字段列表在 :111-119**）。
- 设置页：`SettingsView.tsx` 有现成 `Switch` 组件（:17-49）与 `update()` 提交助手（:91-108），"通用"卡片就是落点（:155-215）。
- 主进程生命周期：`src/main/index.ts` `whenReady/bootstrap`（:89、:157）；**没有 requestSingleInstanceLock**（无单实例锁，全文 181 行无此调用）；`before-quit` :174。
- 注册名：打包名 `SVESC-LAN-Monitor`（`electron-builder.yml:11`，appId `cn.svesc.lan-monitor` :10）；`package.json` 无 productName（name=svesc，:2-3）。

### 缺口

1. 设置页没有开关；托盘开关只在打包版可用，且**两个入口状态可能不同步**（托盘读 OS 注册表，设置页若存 store 会分叉）。
2. `setLoginItemSettings` 返回 void，**不报错也不确认**；失败（权限/策略）只能靠回读 `getLoginItemSettings().openAtLogin` 验证。
3. dev 与打包行为差异：dev 下注册的是 `electron.exe`（开机启动的是空 Electron 而非本应用）——托盘已用 `isPackaged` 规避，设置页必须沿用同一策略并给中文文案（"开发模式下不可用"）。

### 建议方案

- **开关状态不进 store，以 OS 为唯一事实源**（托盘已如此）：`ipc.ts:108` 的 `settingsGet` 返回值里注入 `launchAtLogin: app.getLoginItemSettings().openAtLogin` 与 `launchAtLoginAvailable: app.isPackaged`（照抄 appVersion 注入模式，:108）；新增通道 `settings:launchAtLogin`（或复用 settingsUpdate 白名单 + ipc 层特判）在主进程直接调 setLoginItemSettings，**经引擎层**（引擎禁 import electron，engine/index.ts:4 注释是铁律）。
- 写后回读验证：`setLoginItemSettings()` 后立即 `getLoginItemSettings().openAtLogin` 比对，不符返回 `ok:false + 中文原因`；SettingsView 用现成 `msg` 条显示（:295-299 模式）。
- UI：`Switch` 组件直接复用（`<Switch on={settings.launchAtLogin} hint="开机后自动在后台启动并常驻托盘" disabled={!settings.launchAtLoginAvailable || busy}>`），放"通用"卡（SettingsView.tsx:160-214 区段）。
- 托盘 `refreshTray()`（tray.ts:60-100）不需改——它读的就是 OS 状态，天然同步。
- Windows 细节：setLoginItemSettings 默认写 HKCU Run，不需要管理员；`args` 不需要（应用单窗口，托盘常驻由 closeToTray 处理）。

### 涉及文件
`types.ts`（SettingsPayload 加 `launchAtLogin/launchAtLoginAvailable`，:159-163）、`channels.ts`、`ipc.ts`（:108-123 区段）、`SettingsView.tsx`、`tray.ts`（无需改或仅文案统一）、`preload.ts`/`global.d.ts`（API 形状）、`tests/settings.test.ts`（store 层不受影响；IPC 层逻辑建议抽纯函数测）。

### 风险
- dev 模式误注册 electron.exe（沿用 isPackaged 门控即可）。
- MSIX/权限受限环境下 setLoginItemSettings 静默失败——必须回读验证，不能写完就报成功（违反"失败必须有中文文案"铁律）。
- store 是否持久化 `launchAtLogin`：**不建议**（OS 已是事实源，双写会漂移）。

---

## F3 手机识别与标识展示

### 现状（识别层——已建成）

- 端口：`fingerprint.ts:88-90`，62078 → `{osHint:'iOS', kind:'mobile'}`。
- mDNS：`mdns-devices.ts:28` `_companion._tcp.local → mobile`；聚合优先级 mobile > iot > apple（:47-59）；fingerprint :95-99 mdnsKind='mobile' → `{osHint:'iOS 设备 (mDNS)', kind:'mobile'}`。调度接入：`scheduler.ts:205-206`（mdnsHints，phaseFingerprint 每轮刷新）。
- 主机名正则：`fingerprint.ts:52` `RE_MOBILE_HOST = /iphone|ipad|android|redmi|galaxy|pixel|mi-?\d|honor|oppo|vivo|harmony|mibox|xiaoai/i` → kind mobile、**osHint=null**（:105-107）。
- task-019/020 已完成判定链路（任务 #37 记录）。

### 现状（展示层——已展示，但是纯文字）

- 列表：`DevicesView.tsx:117` 类型列渲染 `KIND_LABEL[device.kind]`，mobile → **"移动端"**（`format.ts:139`）；类型筛选下拉同样用 KIND_LABEL（:389-394）。
- 详情：`DeviceDetailDrawer.tsx:209`（头部副标题）与 `:285`（"类型"行）同样显示"移动端"；操作系统行显示 osHint（:281）——"iOS 设备 (mDNS)" 在这里可见。
- 徽标：列表只有 网关/本机/IP 冲突 三种 `dev-badge`（`DevicesView.tsx:101-107`），**没有按 kind 的徽标或图标**。

### 结论（回答 brief 的判定问题）

**mobile 已识别且已展示**（文字层面），工作量**不在展示补缺，而在识别覆盖面 + 展示强化**。无"识别成 mobile 却显示英文"的不一致（KIND_LABEL 全覆盖 8 种 kind，format.ts:133-142）；也没有图标缺失问题（本来就没有图标体系）。

### 建议方案

1. **识别增强（低成本）**：`RE_MOBILE_HOST`（fingerprint.ts:52）补充常见品牌：`oneplus|realme|huawei|motorola|moto\s?\w|nokia|zenfone|sm-[a-z]\d{3}`（三星机型名 `SM-G991B` 等是常见 mDNS/NetBIOS 名）——**注意** `moto\s?\w` 有误伤 `motorola-router` 的可能，建议只加明确词根；华为需 `huawei`（谨慎：华为也有路由器/手表，但手机占比高，收益仍正）。每条加正则需同步 `tests/fingerprint.test.ts`。
2. **mDNS 映射查漏**：现表（mdns-devices.ts:21-31）缺的候选：`_apple-mobdev._tcp.local`（iOS 设备发现服务，置信 mobile）、`_touch-able._tcp.local`（iTunes/移动端配对，偏 apple）。**未验证——本机网段是否有设备广播这些服务未实测，收录前需 Vera-2 式实机确认，宁缺勿滥**（该文件 :7 注释的诚实原则）。
3. **展示强化（可选，Max-2）**：`DevicesView` 类型列从纯文字升级为"彩色 chip + 图标"（复用 `dev-badge` 样式族），mobile 用区别色；详情头（Drawer:209）同步。若做，建议给全部 8 种 kind 统一配色而非只给 mobile，避免"单点特判"。
4. osHint 空洞：主机名正则命中的 mobile osHint 为 null（:105-107），可给"手机（主机名特征）"补一句中文，与 camera/printer 路径风格一致（:109、:112）。

### 风险
- 正则误伤（`mi-?\d` 已有先例——`mi-` 可能撞 "mikrotik" 缩写之外的 'Mi Router'？实际 `mibox`/`mi\d` 尚可；新增词务必配测试样例）。
- mDNS 服务表是"高置信白名单"，加服务前必须实测其真实广播（未验证项）。

---

## F4 无流量归集（重点：语义查明）

### "流量归集"在代码里的确切对应物

**归集 = 把本机网卡总吞吐（netstat -e 差分）按"与各设备的 ESTABLISHED TCP 连接数占比"分摊到每台设备**。证据链：

1. 采集：`bandwidth.ts:84-96` `readByteCounters`（`netstat -e`）+ `readConnections`（`netstat -ano`）；`aggregateLanConnections`（:99-114）**只统计 `proto==='TCP' && state==='ESTABLISHED' && remoteIp 命中本网段`** 的连接数 → perDevice Map。
2. 分摊：`BandwidthMeter.statFor(ip)`（:198-215）：`share = 该设备连接数 / 全网连接总数`，`rxBps = 全网rx × share`；**`lanConnections<=0 或 connections<=0` 时返回 `attributable:false`**（:203-205）；空值工厂 `emptyBandwidth()`（:127-130）。
3. 契约：`types.ts:34-35` `attributable: boolean`，注释明文："false 时 rxBps/txBps 无意义，UI 必须显示'无流量归集'而不是 0"。
4. "无流量归集"**字面出处**：`bandwidth.ts:11` 注释（"本机与 LAN 的 TCP 连接实测仅 4 条 → 绝大多数设备 share≈0，此时 attributable=false，UI 显示'无流量归集'"，源自 task-001 实测 §2.9/§6-C.2）。
5. 挂接：`scheduler.ts:893` 每台设备 `bandwidth: this.meter.statFor(rec.ip)`；`:804-810` rtt history 附带 rxBps/txBps（不分 attributable）；`:959-971` 详情 history；SystemStat 全网 `rxBps/txBps`（types.ts:294-296，null=采样失败/无基线）。
6. 呈现：`DevicesView.tsx:134-152`（attributable ? ↓↑ 数值 : **"无流量归集"** 带解释 title）；`DeviceDetailDrawer.tsx:419-476`（同款分支 + "活跃连接/占比/推算"徽标）；`OverviewView.tsx:311-312`（KPI 只对 attributable 设备显示速率，否则不显示——**没有遗漏，是显式分支**）。
7. 模拟器也遵守契约：`simulator.ts:126-131`（share>0 才 attributable:true）；`soak.ts:80/98` 空闲态 attributable:false。

**结论：系统里不存在第二种"流量归集"实现；"无流量归集"是 `attributable:false` 的既定中文文案，不是 bug，是诚实设计。**

### "无流量归集"的成因（为什么大量设备无归集）

归集完全依赖**本机视角的 TCP 会话**（`aggregateLanConnections` 以本机为端点）。设备与设备之间的流量（A→B 传输）、设备对公网的流量、UDP 流量，本机 netstat **全部看不见**。本机实测（task-001 §2.9）：本机与 LAN 的 TCP 连接仅 4 条 → 53 台设备里最多 4 台可得归集。

### 两种扩展解释与影响面（供队长决策）

**解释 ①（引擎侧）：扩大"可归集"判定面——把归集从"本机 TCP 会话"扩展到"路由器侧视角"**
- 思路：项目已有 RouterManager（OpenWrt ubus，`src/main/engine/router/*`）。OpenWrt 侧可拿到接口级/（部分固件）主机级计数器；用网关流量 + ARP 主机表做二次分摊，或用 ubus 的 conntrack/ipt_stats。
- 影响面：`bandwidth.ts`（aggregateLanConnections 增加第二数据源）、`scheduler.ts`（喂 router 数据）、`router/*`（新 ubus 调用）、`BandwidthStat` 契约（建议加 `source: 'tcp-share'|'router'` 或维持 estimated:true）、`tests/bandwidth.test.ts`、router 系测试。
- 风险：**数据诚实红线**——路由器侧拿不到 per-host 字节就绝不能伪造分摊；固件差异大（task-002 只接了 OpenWrt ubus），非 OpenWrt 网关仍无解；工作量大，属"引擎+路由"联动。
- 备注：把 UDP/TIME_WAIT 也计入 aggregateLanConnections 是 30 分钟的廉价版（bandwidth.ts:99-114 放宽过滤），但 share 分母仍是本机会话，**改善有限且稀释精度**，只配作为兜底。

**解释 ②（渲染侧）：把"无流量归集"当作一等公民状态运营——筛选/汇总/说明**
- 思路：用户看到大片"无流量归集"不了解原因。扩展为：设备页加"流量状态"筛选（可归集/不可归集）、Overview 加"可归集设备 x/y"统计、详情页把 title 里的解释升级为常驻说明块（"该设备未与本机建立 TCP 会话，流量无法归集；流量统计仅覆盖与本机的会话"）。
- 影响面：纯渲染层 `DevicesView.tsx`、`OverviewView.tsx`、`DeviceDetailDrawer.tsx`、`views.css`；**零契约变更、零引擎改动**，503 测试不受影响。
- 风险：最低；但不改变"数据本身拿不到"的事实。

**解释 ③（额外候选，若用户本意是"设备间流量可见"）**：做"全网流量排行"但以 `estimated:true + attributable:false 可见` 呈现，即按连接数排序而非字节数排序（本机能拿到的只有连接数）。影响面同 ② + 排序逻辑（DevicesView:262-263 已按 rxBps+txBps 排，可加 fallback）。诚实且便宜。

**我的判断**：用户原文"扩展无流量归集能力，完善归集处理逻辑，确保无流量数据被正确识别和归集"最贴近**解释 ② + 解释 ③**的组合（识别 + 呈现 + 尽力归集），解释 ① 是重投入项且强依赖路由器固件，建议单独排期或降级为"OpenWrt 环境下的增强路径"。**此判定请 team-lead 裁定，我不预设。**

### 涉及文件（按解释 ②+③ 最小集）
`DevicesView.tsx`（:134-152 呈现、:262-263 排序 fallback、筛选区 :345-411）、`OverviewView.tsx`（:311 区段）、`DeviceDetailDrawer.tsx`（:419-476）、可选 `bandwidth.ts:99-114`（UDP/TIME_WAIT 放宽，需 Tess 补用例）。

### 风险
- 任何"放宽 aggregateLanConnections 过滤"都会稀释 share 分母精度（bandwidth.ts:203-206），必须有测试钉住语义。
- 绝不允许出现"无数据 → 显示 0 Kbps"的回归（types.ts:34 注释是契约级要求）。

---

## 实现分派建议（Phase 2 文件清单）

**Max-1（引擎 + 主进程）**
- F1：`alarms.ts`（resolveById/批量 + trace 新类型）、`scheduler.ts`（:1055 区段旁加 clearAlarm/clearAlarms）、`engine/index.ts`（门面 + 注意 stop 路径 :236-237）、`channels.ts`、`ipc.ts`、`preload.ts`、`types.ts`（AlarmTraceEntry.type）。
- F2：`ipc.ts`（settingsGet 注入 + 新 handler）、`types.ts`（SettingsPayload）、`preload.ts`/`global.d.ts`；**不进 store**。
- F4（若采纳解释 ① 或放宽过滤）：`bandwidth.ts`、`scheduler.ts`、`router/*`。

**Max-2（渲染层）**
- F1：`AlarmsView.tsx`（清除按钮 + 范围批量 + TRACE_LABEL/详情文案）、`App.tsx`（onClearAll 串行助手，仿 :151-164）。
- F2：`SettingsView.tsx`（Switch 行，复用 :17-49 组件与 :91-108 update 模式）。
- F3：`fingerprint.ts`（RE_MOBILE_HOST 扩充，严格说属引擎但纯函数零依赖，也可交 Max-1）+ `DevicesView.tsx`/`DeviceDetailDrawer.tsx`（kind chip 化，可选）。
- F4：`DevicesView.tsx`、`OverviewView.tsx`、`DeviceDetailDrawer.tsx`、`views.css`。

**Tess**：`alarms.test.ts`（清除/批量/抑制窗口/trace）、`alarm-state.test.ts`、`fingerprint.test.ts`（新正则样例）、`bandwidth.test.ts`（若放宽聚合）、`settings.test.ts`（若动 store）。

**共用顺序依赖**：F1 的 IPC 通道与 API 形状应先冻结（channels.ts + preload），Max-1 与 Max-2 才能并行；F2 建议直接由 Max-1 一并做完（ipc+设置页各 ~20 行）。
