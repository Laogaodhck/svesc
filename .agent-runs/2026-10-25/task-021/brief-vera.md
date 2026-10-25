# brief-vera（task-021 调查任务书）

你是调查员 Vera，只读调查，禁止修改任何文件。项目根：C:/github/svesc（Electron 45 + React 19 + TS，引擎 src/main/engine/**，主进程 src/main/**，渲染层 src/renderer/**，测试 tests/**）。

先读 `.agent-runs/2026-10-25/task-021/plan.md`（四项需求与预判）。对以下四项各回答"现状是什么 / 缺口是什么 / 建议方案与涉及文件（带行号）/ 风险"。全部结论须给代码实证（文件:行号），不许臆测。

## F1 告警清除机制（单个+批量）
- 现状：src/main/engine/alarms.ts 的生命周期（raise/resolve/ack/pushTrace/trimHistory、recentByKey、suppressWindowMs 抑制窗口）；engine/index.ts 里 alarm 对外 API 与 onAlarm 推送；SqliteStore upsertAlarm 持久化路径（src/main/engine/db/sqlite.ts）；src/main/ipc.ts 现有 alarm 相关 IPC 通道（CH.*）；src/renderer/views/AlarmsView.tsx 现有操作按钮（确认/解决？）与分组结构。
- 要回答：现有"确认/解决"与用户要的"清除"语义差别；若做"清除=从列表移除"，需要动哪些层（engine API / PersistStore 删除与恢复 / IPC / UI 单个+批量入口）；批量清除的选中交互现状（表格是否支持多选）；清除后抑制窗口/recentByKey 是否要同步摘除（对照 trimHistory 现有做法）；数据诚实角度——清除是可恢复（软删）还是硬删更符合现有 store 结构（alarms 表有无软删条件）。

## F2 开机自启动
- 现状：设置持久化机制（store settings get/set、SqliteStore settings 表、SettingsView.tsx 现有开关行样式与保存交互、ipc.ts 设置相关通道）；src/main/index.ts 应用生命周期（app.whenReady、单实例锁等，主进程哪里适合处理 setLoginItemSettings）；package.json productName（自启动注册名）。
- 要回答：开关应存哪个字段、读写路径；setLoginItemSettings 在 dev（electron .）与打包后的行为差异、如何检测设置成功/失败并给中文文案；SettingsView 现有开关组件可直接复用吗（给出可复用的开关行示例位置）。

## F3 手机识别与标识展示
- 现状：识别层——fingerprint.ts 的 RE_MOBILE_HOST、62078 端口、mdnsKind=mobile（2.6 层）；mdns-devices.ts 的 _companion→mobile；KIND_LABEL（src/renderer/lib/format.ts）mobile 的中文标签；展示层——DevicesView.tsx 列表的 kind 徽标渲染方式（有哪些 kind 有徽标、样式类名）、DeviceDetailDrawer.tsx 详情页的设备类型/osHint 展示位置。
- 要回答：mobile 已识别时列表/详情**是否已展示**"手机"标识（这决定工作量在识别还是在展示）；识别覆盖面还有哪些低成本增强（主机名正则补充哪些常见品牌、mDNS 服务映射是否有遗漏的高置信 mobile 服务）；osHint "iOS 设备 (mDNS)" 在 UI 哪里可见；有没有"识别成 mobile 但显示英文/图标缺失"的不一致。

## F4 无流量归集（重点：先弄清这是什么）
- 现状：全局搜"流量/归集/traffic/bandwidth/attributable/统计"相关代码——bandwidth.ts 的采集机制与输出、engine/index.ts / scheduler.ts 里流量数据如何挂到设备或快照、src/shared/types.ts 里流量相关字段、OverviewView/DevicesView 里流量的展示、"无流量/不可归集"设备当前的呈现（是显示 '—' 还是被漏掉）。
- 要回答：系统里"流量归集"的确切对应物是什么（按适配器聚合？按设备归属？）；"无流量数据"的设备/场景现在如何处理；扩展"无流量归集"最合理的解释与方案候选（至少给两种解释并各自给出影响面，供队长决策）；数据流从采集→引擎→渲染每一环的文件:行号。

## 输出
写入 `C:/github/svesc/.agent-runs/2026-10-25/task-021/investigation-report.md`，结构：每项功能一节（现状/缺口/建议方案/涉及文件/风险），末尾给"实现分派建议"（引擎 vs 渲染层的文件清单）。回我只需简短状态块（完成与否 + 报告路径 + 每项一句话结论）。
