# brief-vera2（task-022 调查任务书）

你是调查员 Vera-2，只读调查，禁止修改任何文件。项目根：C:/github/svesc。先读 `.agent-runs/2026-10-25/task-022/plan.md`。

用户四项诉求：①路由器登录支持记住密码+自动登录（本地安全存储、可随时关闭）②登录后从路由器管理接口拿更精准的设备列表（厂商/型号/设备类型/操作系统）③接入更多路由器管理侦测功能（上下线监测、流量统计）④在设备列表界面清晰展示。

对每项回答：现状（文件:行号）/ 差距 / 建议方案（可执行到函数级）/ 风险 / 数据诚实红线评估。

## 调查清单

### A. 现有路由器链路全貌（基础）
- RouterManager 与 ubus 通道：`src/main/router-manager.ts`（或实际路径）、`src/main/engine/router/index.ts`、`openwrt.ts`、`src/main/engine/router/*` 全部文件——登录流程（challenge/hash）、会话管理、sessionInvalid、openwrtCapable、RouterView 消费的 status 数据形状。
- RouterView.tsx 现有登录 UI（输入框/保存/状态）、ipc.ts 与 channels.ts 里 router 相关通道全表。
- RouterManager 的可扩展点：新增 ubus 调用的现有模式（call+parse）。

### B. 凭据存储与"记住密码/自动登录"（诉求①）
- 现有 router-credentials 持久化（搜 router-credentials、safeStorage）：存了什么、是否加密、何时读写。
- 差距：有没有"记住密码"开关（关=用完即弃不落盘）？"自动登录"语义（应用启动/会话失效时静默重登）？现状是每次手动输还是已自动？
- safeStorage 可用性检测与降级（B-3 修过什么）、失败文案现状。

### C. 路由器侧设备数据面（诉求②③的数据基础）
- OpenWrt ubus 真实可拿：DHCP 租约（dhcp ipv4lease）、wireless assoclist（MAC/信号/速率/关联时间）、ARP/conntrack、system board（型号/固件）、接口统计。逐项标注：项目已接/未接、数据字段形状、非 OpenWrt 固件的降级。
- 这些数据能支撑什么：主机名补充（→既有指纹管线的 hostname 通道）、厂商（MAC OUI 已有 lookupVendor）、**型号**（多数家用设备路由器侧拿不到——如实评估）、OS（路由器侧拿不到——如实评估，结论应是"继续走既有指纹管线，路由器数据只做输入补充"）。
- **抓包/分析管理接口**：用户提到抓包——评估是否需要、现有 ubus 是否已覆盖；非 ubus 固件（如小米/华硕）的 Web API 是否值得接（工作量与维护性，给结论不拍板）。

### D. 上下线监测与流量统计（诉求③）
- 上下线：现有 DEVICE_NEW 告警模式（alarms.ts）；assoclist/DHCP 租约的出现与消失能否映射"路由器视角的上下线"？与现有 ARP/heartbeat 上下线判定的关系（重复告警？互补？）。给方案。
- 流量：路由器侧 per-host 字节计数哪些固件真有（ubus 是否有）、拿不到时如何诚实呈现。**红线：严禁伪造分摊**（对照 bandwidth.ts attributable 语义与 task-021 F4 裁定）。

### E. 设备列表展示（诉求④）
- DevicesView 列结构与数据源（device 对象字段）、RouterView 与 DevicesView 的关系（两处展示还是合并）、新增路由器侧数据（信号强度/关联时长/租约到期等）在 UI 的落点建议。

## 输出
写入 `.agent-runs/2026-10-25/task-022/investigation-report.md`：每项一节（现状/差距/方案/文件:行号/风险/红线评估），末尾给"实现分期建议"（哪些先做/哪些依赖路由器实机/哪些明确不做及理由）。回我简短状态块（完成与否+报告路径+每项一句话）。注意：Max-2 正在并行改渲染层部分文件，你读到中间态属正常，router 相关文件不受影响。
