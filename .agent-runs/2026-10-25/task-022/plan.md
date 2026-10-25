# task-022 计划：路由器登录与设备识别增强

日期：2026-10-25　队长：Horizon　团队：crew-lan-monitor

## 用户需求（原文要点）
1. 路由器登录功能：支持**记住密码与自动登录**（本地安全存储凭据，可随时关闭）。
2. 登录后通过抓包/分析路由器管理接口，获取**更精准的局域网设备列表**：每台设备的**厂商、型号、设备类型（手机/电脑等）、操作系统（Android/iOS/Windows/Linux 等）**。
3. 尽可能接入路由器的**更多局域网管理与侦测功能**（设备上下线监测、流量统计等），并在设备列表界面清晰展示。

## 已知项目现状（来自 task-001/002 经验，待调查确认）
- 项目已有 RouterManager + OpenWrt ubus 通道（task-002 修过登录 32 位 challenge、sessionInvalid、openwrtCapable 粘性位）；RouterView 已有登录 UI 与状态展示。
- 凭据已有持久化目录（electron-builder.yml 注释提到 userData 下 router-credentials，task-002 B-3 涉及 safeStorage）。
- 引擎侧设备识别已有 OUI/主机名/端口/mDNS 四通道（task-019/020/021）。

## 与 task-021 的并行边界
- task-021 的 Max-2 正在改渲染层（AlarmsView/SettingsView/DevicesView/OverviewView/Drawer/format.ts/views.css/App.tsx）。
- **task-022 调查阶段为只读，可并行**；但 RouterView.tsx / router 相关文件未被 021 占用。
- task-022 实现阶段必须等 task-021 验证通过后再开（避免渲染层文件冲突），除非调查结论证明改动面完全不相交。

## 阶段计划
- Phase 1 调查（Vera-2，只读，立即启动）：现有 router 链路全貌、凭据存储机制、ubus 可拿到的数据面、用户四项诉求的差距与方案。
- Phase 2 实现（待 021 验证通过后分派）。
- Phase 3 测试（Tess）→ Phase 4 验证（Vic）→ Phase 5 审查（Ray）。

## 预判（待调查确认）
- 登录/凭据：现有 router-credentials 可能已存密码——查清是否用 Electron safeStorage 加密、是否有"记住密码/自动登录"开关语义。
- 设备列表增强：OpenWrt ubus 可拿 DHCP 租约、无线 assoclist（含信号强度/协商速率）、ARP 表——厂商可由 MAC OUI 出、型号多数拿不到（诚实红线：拿不到显示 '—'）；OS 判定继续走既有指纹管线（路由器数据只补充主机名/厂商，不臆造 OS）。
- 上下线监测： AssocList 出现/消失即上线/下线事件，可接既有告警机制（DEVICE_NEW 模式）。
- 流量统计：OpenWrt 侧 per-host 计数器固件差异大，可能只有接口级——调查需给出"哪些数据真实可得"，严禁伪造分摊（task-021 F4 已裁定过的红线）。
