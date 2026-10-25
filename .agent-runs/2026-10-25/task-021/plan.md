# task-021 计划：四项功能改进

日期：2026-10-25　队长：Horizon　团队：crew-lan-monitor（复用既有成员）

## 用户需求（原文要点）
1. **F1 告警清除机制**：告警模块支持单个和批量清除，并同步更新告警状态。
2. **F2 开机自启动**：设置页添加开关，开启/关闭开机自动启动，并保存配置状态。
3. **F3 手机识别增强**：正确识别手机设备类型，并在设备列表/详情中展示相应标识。
4. **F4 无流量归集**：扩展无流量归集能力，完善归集处理逻辑，确保无流量数据被正确识别和归集。

## 项目铁律（全成员必守）
- 数据诚实：拿不到显示 '—'/null，不显示 0/假状态；失败必须有中文文案。
- 引擎层不 import electron；目录/能力由调用方注入。
- IPC 推送式架构（snapshot 5s 心跳 + 主动推送），渲染层不轮询。
- 测试基线：当前 503/503；任何改动不得破坏。
- 打包：环境安全层拦截批量删除 → 重打包必须换全新输出目录（本次不涉及）。

## 阶段计划
- Phase 1 调查（Vera，只读）：四项现状与缺口，产出 investigation-report.md。
- Phase 2 实现（Max-1 引擎+主进程，Max-2 渲染层，按调查结论分派）。
- Phase 3 测试（Tess，仅测试文件）。
- Phase 4 验证（Vic，tsc + vitest + build + SMOKE，PASS/FAIL 三选一）。
- Phase 5 审查（Ray，按需）→ final-summary.md。

## 各功能预判（待调查确认，不是定论）
- F1：现有告警生命周期为 raised→acked→resolved（alarms.ts raise/resolve/ack/pushTrace + SqliteStore upsertAlarm）。"清除"≠"resolve"——预计需要新增"从列表移除"语义：engine 新 API + 持久化删除 + IPC 通道 + AlarmsView 单个/批量入口。
- F2：设置持久化走 store settings（SqliteStore settings 表）；自启动预计用 Electron app.setLoginItemSettings({ openAtLogin })，主进程 IPC 接收开关状态，设置页加开关行。注意 dev 与打包后 execPath 差异，需在实现时如实处理失败文案。
- F3：task-019/020 已建 mobile 判定（62078 端口、主机名正则、mDNS _companion）。需确认 DevicesView/DeviceDetailDrawer 是否已有"手机"徽标展示；增强点在识别覆盖面（主机名规则、mDNS 服务映射）与展示一致性。
- F4："无流量归集"对应物待查：bandwidth.ts（Get-NetAdapterStatistics）、设备流量归集（attributable 字段？）、Overview 流量展示。需 Vera 查清现有归集数据流与"无流量"设备当前如何被处理，再定扩展方案。

## 队长裁定（依据 investigation-report.md，2026-10-25）

- **F1 = 语义 A（手动 resolve）+ 用户清除冷静期**。清除 = 置 resolvedAt + trace 新类型 `cleared-by-user`，记录保留可追溯（不做删除/软删——删除会被 stop 全量 REPLACE 复活且破坏 trace 账目）。"清了又弹"用 **manualClears 冷静期**解决：手动清除时记 key→时间，同因在 suppressWindowMs（10 分钟）内再触发**完全静默**（不重开、不新建、不推送），窗口过后条件仍满足才产生全新告警——既尊重用户意图又不丢"问题还在要提醒"的诚实性。不做 checkbox 多选，沿用"范围批量"（仿全部确认）。
- **F2 = OS 为唯一事实源**，不进 store；isPackaged 门控 + 写后回读验证 + 中文失败文案；设置页与托盘天然同源。Max-1 做主进程链路，Max-2 做设置页开关行。
- **F3 = 识别覆盖面 + 展示文案**：RE_MOBILE_HOST 补高置信品牌词根（每条配测试防误伤，禁泛匹配）；主机名命中 mobile 时 osHint 补"手机（主机名特征）"；KIND_LABEL mobile '移动端'→'手机'。**mDNS 表不动**（_apple-mobdev 等候选未实测，宁缺勿滥）。不做整套图标化（避免超范围）。
- **F4 = 解释②+③ 组合，引擎零改动**：设备页"流量状态"筛选（可归集/不可归集）、Overview"可归集 x/y"统计、详情常驻说明块、排序 fallback（无归集时按活跃连接数降序）。**不做**解释①（路由器侧归集，固件依赖强+诚实红线风险）与 aggregateLanConnections 放宽（稀释精度）。
- **接口形状冻结**（Max-1 落地类型，Max-2 按此消费）：
  - `LanApi.alarmsClear(ids: Alarm['id'][]): Promise<void>`（单条传 [id]）
  - settingsGet 返回增加 `launchAtLogin: boolean; launchAtLoginAvailable: boolean`
  - `LanApi.setLaunchAtLogin(on: boolean): Promise<{ ok: boolean; error: string | null }>`
  - `AlarmTraceEntry.type` 增加 `'cleared-by-user'`

## 风险
- F1 删除语义与历史 trace/抑制窗口交互（recentByKey 索引同步摘除）。
- F2 打包后路径/dev 环境自启动行为差异，失败必须可见。
- F3 勿把"已识别但未展示"与"未识别"混为一谈——先查展示层现状。
- F4 语义不明是最大风险，以调查结论为准，禁止臆测实现。
