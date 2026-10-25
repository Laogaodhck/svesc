# task-022 调查报告：路由器登录与设备识别增强

调查人：调查员 Vera-2（只读调查，未修改任何源文件）
日期：2026-10-25
前置：复用 task-002 的 router/ubus 链路上下文；本次全部重新读码核对（router 相关文件自 task-002 后已被大幅修改，含 UBUS_NULL_SESSION 登录修复、sessionInvalid、世代守卫、内置浏览器等——以本报告引用的 file:line 为准）。
并行说明：Max-2 正在改渲染层（task-021 范围），DevicesView/SettingsView 相关行号存在中间态可能；router 链路文件不受影响。

## 总览

| 项 | 一句话结论 |
|---|---|
| A | 链路完整且成熟：RouterManager 双会话（ubus/web 正交）+ 三通道数据面（UPnP/管理页指纹/ubus），扩展点明确（call+纯函数解析+doRefresh 汇聚） |
| B | **自动登录已存在**（启动时恢复+自动落盘），缺的是"记住密码"开关（当前强制保存、无退出选项）与"会话失效自动重登"（当前只提示） |
| C | OpenWrt 侧真实可得的增量数据 = DHCP 主机名、Wi-Fi 关联（信号/时长）、接口级计数器；**端设型号/OS 路由器侧根本不存在该数据**（红线：显示 '—'），OS 继续走既有指纹管线 |
| D | 上下线：assoclist 出现/消失可做权威佐证信号（不新增告警码，防重复）；流量：per-host 字节计数 OpenWrt 标准接口**拿不到**，严禁伪造分摊（F4 红线延续） |
| E | DevicesView 12 列结构与 Device 契约冻结；新增路由器侧字段的推荐落点 = Device 可选字段 + MAC join + 详情抽屉卡片；契约变更须走批准流程 |

---

## A. 现有路由器链路全貌

### 现状（文件:行号）

**文件清单**（`src/main/engine/router/` 5 文件 + 主进程 3 文件）：

| 文件 | 职责 |
|---|---|
| `router/index.ts`（438 行） | RouterManager 编排：能力探测 → 按能力取数 → 诚实降级 |
| `router/openwrt.ts`（309 行） | UbusClient：JSON-RPC over HTTP，null-session 登录，sessionInvalid 判定 |
| `router/httpx.ts`（85 行） | node:http 最小传输层，超时 destroy+settle 不悬挂 |
| `router/detect.ts`（89 行） | 管理页指纹：6 品牌 + generic，跟随 302，产出 adminUrl |
| `router/upnp.ts` | SSDP → 描述解析 → WANIPConnection SOAP（GetExternalIPAddress + GetTotalBytes*） |
| `router-browser.ts`（121 行） | 内置浏览器管理页登录：隔离分区 persist:router-admin，Cookie 会话检测 |
| `router-store.ts`（81 行） | 凭据持久化：async safeStorage（DPAPI），shouldReEncrypt 自动重存 |
| `main/index.ts:121-126` | RouterManager 装配 + 启动自动登录 |

**会话模型**（router/index.ts）：
- 双会话正交：`ubus`（账密，可取数）与 `web`（内置浏览器 Cookie 检测，不解锁 ubus 数据）。`RouterStatus.session.kind: 'ubus'|'web'|null`（types.ts:466-471）。
- 世代守卫：`generation` 自增于 logout（router/index.ts:139），doRefresh 捕获进入时世代，收尾比对不一致整体丢弃（:327）——防"登出后旧观测写回"。
- 粘性能力位：`openwrtCapable`（:65，只进不退）、`managementPageCapable`（:71）；探测限频 60s（ROUTER.detectRetryMs）快于轮询 10s（ROUTER.pollMs）。
- sessionInvalid：调用路径 -32002 → 自清会话 + `sessionInvalid:true`（openwrt.ts:176, 282-289, 297-304）；瞬时故障（超时/非200/非法JSON/result:[6] ACL 拒绝）**不**清会话。登录路径 -32002 = 密码错误（context 分流，openwrt.ts:49-54）。

**登录流程**（已含 task-002 修复）：
`RouterView 表单（:417-439）→ ipc routerLogin（ipc.ts:83-91）→ RouterManager.login（router/index.ts:98-131）→ UbusClient.login → raw([UBUS_NULL_SESSION,'session','login',{username,password,timeout:3600}])`（openwrt.ts:196-201）。成功 → `openwrtCapable=true` + `await refresh()`。**注意：32 位零是"null-session"，不是 challenge/hash**（plan.md 预判里的"challenge"表述不准；OpenWrt ubus 无 challenge 流程，那是 TP-Link 等私有协议的形态）。

**启动自动登录**：`main/index.ts:125-126` — `loadCredentials()` → `routerManager.restoreSession(user, password)`（router/index.ts:432-436，fire-and-forget，失败置 session.error 由 UI :454-458 显示）。

**数据面汇聚**（doRefresh，router/index.ts:216-363）：
1. UPnP 探测（probeUpnp :366-398）→ WAN IP + 累计计数器 + controlUrl（重启）。
2. 管理页指纹（:257-271，限频）→ brand/modelHint/adminUrl。
3. ubus 三连（:296-300，`Promise.all`）：`luci-rpc getDHCPLeases` / `luci-rpc getWirelessDevices` / `system board`——直接 `call()`+纯函数解析（:302-304），**不用包装方法**，因为要透传 sessionInvalid。
4. WAN 速率：≥2 个带计数器样本才差分（:322-332, :400-411），回绕/重启 → null。
5. 非 -32002 的调用失败写 capabilityNotes（:308-317）。

**RouterStatus 消费形状**：RouterView 消费 identity/capabilities/wan/dhcpLeases/wirelessClients/systemBoard/session/capabilityNotes/lastError（RouterView.tsx:291-594）；推送通道 `router:status`（channels.ts:47, ipc.ts:242-244）。

**通道全表**（channels.ts:14-20）：routerGetStatus / routerRefresh / routerLogin / routerLogout / routerReboot / routerOpenAdmin（6 个 invoke）+ routerStatus（1 个 push）。preload/types.ts LanApi :341-350 一一对应。

### 可扩展点（新增 ubus 调用的既有模式）

以 `getWirelessDevices` 为样板，新增一路数据 = 五步：
1. `openwrt.ts` 加纯函数 `parseXxx(payload): X[]`（形状防御到底，不认识返回 []）；
2. （可选）`openwrt.ts` 加包装方法（但 doRefresh 惯例是直接 `call()` 保留 sessionInvalid）；
3. `router/index.ts` doRefresh 的 `Promise.all` 加一路，失败进 callLabels；
4. `types.ts` RouterStatus 加字段（契约变更，需批准）；
5. RouterView 加展示卡（三态：ubus 有数据 / web 不提供 / 不支持-未登录）。
风险最低的挂点就是 `:296-300` 的 Promise.all——每轮 10s 轮询自动刷新。

---

## B. 凭据存储与"记住密码/自动登录"（诉求①）

### 现状

- **存储**：`router-store.ts` — `{user, passwordEnc: base64(DPAPI密文)}` 写 `userData/router-credentials.json`（mode 0o600，:49）。异步 safeStorage API（task-002 B-3 迁移已完成：isAsyncEncryptionAvailable/encryptStringAsync/decryptStringAsync），`shouldReEncrypt=true` 时自动用新密钥重存（:64-67）。不可用时拒绝落盘并如实报"系统密钥环不可用…"（:43）。
- **何时写**：**每次 ubus 登录成功必然落盘**（ipc.ts:87），无任何开关；UI 反馈"登录成功，凭据已加密保存"或 persistError（RouterView.tsx:156）。
- **何时读**：仅启动时一次（main/index.ts:125）。
- **何时删**：仅 routerLogout（ipc.ts:94，同时清管理页 Cookie :95）。
- **自动登录**：启动时已有（restoreSession）；会话失效（-32002）时**只**显示"路由器会话已过期，请重新登录"（router/index.ts:357），**不**自动重登。

### 差距（对照"记住密码+自动登录、可随时关闭"）

1. **无"记住密码"开关**：现状是强制记住（默认行为已等于"记住密码=开"），用户无法选"本次用完即弃"，也无法事后关闭。诉求里的"可随时关闭"不满足。
2. **会话失效不自动重登**：OpenWrt 登录 timeout=3600s（openwrt.ts:200），即最迟 1 小时后 ubus 会话过期，UI 变成"已过期请重新登录"并停在手动状态——对"自动登录"语义是半成品。
3. （小）restoreSession 的 catch 为空（router/index.ts:433-435）：恢复失败依赖 login 内部写 session.error 展示，无"自动登录失败"的专门标识——可接受，但增强时可带上"已用保存的凭据自动登录失败"文案。

### 建议方案（函数级）

**B-1 记住密码开关**：
- `types.ts` AppSettings 加 `rememberRouterPassword: boolean`（默认 **true**，与现状兼容，老用户行为不变）。
- 默认值：`store.ts:74` DEFAULT_SETTINGS + `store.ts:156-163` 迁移读取（两处都要加）。
- 白名单：`ipc.ts:128-136` settingsUpdate allowed 数组加该键。
- 语义（关闭 = 立即生效）：
  - 登录路径（ipc.ts:83-91）：`res.ok && engine.getSettings().rememberRouterPassword` 才 `saveCredentials`；否则返回 `persisted:false, persistError:'已选择不记住密码'`（UI 文案 RouterView.tsx:156 自动适配）。
  - 关闭开关时（ipc.ts settingsUpdate handler 或 engine.updateSettings）：若 `rememberRouterPassword===false` 且凭据文件存在 → `clearCredentials()`（"可随时关闭"= 关闭即删盘上凭据，下次启动不自动登录；当前会话保持）。
  - RouterView 登录表单（:417-439）加复选框"记住密码（默认开启）"，映射同一设置键；设置页（SettingsView，注意 Max-2 正在改，实现须等 021 验证）加 Switch 行（复用 task-021 的开关组件模式）。
- 安全说明保持现状文案：DPAPI 按 Windows 用户加密，同用户其他程序可解密（诚实，不夸大）。

**B-2 会话失效自动重登**：
- RouterStatus.session 加信号位 `invalidatedAt: number | null`（契约变更需批准；比比对 error 文案可靠）。router/index.ts:357 写 `sessionInvalid ? Date.now() : null`。
- 主进程 `main/index.ts:124` 的 `startPolling(onUpdate)` 回调里检测：`status.session.invalidatedAt` 有值且 `rememberRouterPassword` 开 → `routerManager.restoreSession(...)`（用 loadCredentials 再取一次，或 bootstrap 时缓存于主进程内存——**建议每次重新 loadCredentials**，避免主进程常驻明文密码）。
- 防死循环：重登间隔退避（60s 起 ×2，上限 10min）+ 连续 3 次失败后停用并置 session.error 提示"已停止自动重登（凭据可能已失效）"。落点可在 RouterManager 内加 `scheduleReconnect()` 私有方法（主进程只负责开关与喂凭据）。
- 诚实性：自动重登成功后 session.error 清空（login 成功路径已清，:127），UI 无感知；失败如实显示，绝不静默空转。

### 风险

- B-2 死循环风险已列（改密码后）：退避 + 次数上限 + 可见失败，闭环。
- B-1 默认值若改成 false 会让现有用户"升级后不自动登录"——**保持 true**。
- 凭据文件被手动删除/损坏：loadCredentials 返回 null（:69-71），现状已优雅。
- 与 task-021 的 SettingsView 冲突：实现期必须等 021 验证通过（plan.md 边界条款）。

---

## C. 路由器侧设备数据面（诉求②③的数据基础）

### 已接（RouterManager 已在取，但未进设备列表）

| 数据 | ubus 调用 | 形状 | 现状 |
|---|---|---|---|
| DHCP 租约 | `luci-rpc getDHCPLeases`（openwrt.ts:94-116） | `{ip, mac, hostname\|null, expiresAt}` | RouterView 表格展示（:506-543）；**未回填设备主机名** |
| Wi-Fi 关联客户端 | `luci-rpc getWirelessDevices`（:119-160） | `{mac, ssid, signalDbm, rxRateKbps, txRateKbps, connectedForSec}` | RouterView 表格（:546-588）；**未进设备列表** |
| 路由器型号/固件 | `system board`（:80-91） | hostname/model/firmware/uptime | 仅路由器自身卡片 |

### 真实可接但未接（按价值排序）

1. **DHCP 租约主机名 → 设备 hostname 回填**（价值最高）：现状设备 hostname 唯一来源是反向 DNS（discovery/index.ts:26-108，ReverseDnsCache，800ms 超时、失败即负缓存）——本机实测多数内网设备无 PTR 记录，engine-check 两次运行 hostnames 全空（task-002 复现数据）。DHCP 租约的 hostname 是设备 DHCP 请求时自报的，真实、权威。**join key = MAC**（租约有 mac+ip；设备记录有 mac）。
2. `luci-rpc getHostHints`（LuCI 的 MAC→{hostname,ip} 聚合，含 hosts 文件与 ARP 命名）：覆盖比租约更广（静态 IP 设备也有）。存在性可靠（luci-base 提供），**响应形状需实机取样或对照 LuCI 源码确认**——解析器无法凭空写死。
3. 接口级流量：`ubus call network.device status`（OpenWrt 标准对象，含每接口 `statistics.rx_bytes/tx_bytes`）→ 路由器 LAN 口总吞吐。真实存在，接口级非 per-host。
4. `iwinfo` 对象（`ubus call iwinfo assoclist {"device":"wlan0"}`）：比 luci-rpc getWirelessDevices 更细（noise、per-chain bitrate）。**增益有限**——luci-rpc 版本已够诉求④展示，不建议接（多一路探测多一分固件差异面）。

### 拿不到的（红线评估，如实结论）

- **端设型号**：OpenWrt 的 dnsmasq 租约只有 hostname/ip/mac/expires（getDHCPLeases 形状即证，openwrt.ts:100-113）；DHCP option 60（vendor class）不进租约文件也不进 luci-rpc。家用终端（手机/PC）不会向路由器上报型号字符串。**结论：型号列继续 '—'，严禁从 OUI/主机名"推测"型号文案**。路由器自身的型号（system board.model）已有，仅适用于网关设备。
- **操作系统**：路由器侧无任何 OS 字段。**结论：OS 识别继续走既有指纹管线**（fingerprint.ts:68-173：端口 → mDNS 自报 → 主机名特征 → OUI → TTL 弱提示），路由器数据只做**输入补充**——回填的 DHCP hostname 会直接提升 `RE_MOBILE_HOST`/`RE_CAMERA_HOST`/`-pc$` 等主机名通道的命中率，间接提升 kind/osHint 覆盖。这正是"路由器数据只补充、不臆造"的正确形态。
- **厂商**：已有 lookupVendor（oui.ts:169），MAC OUI 是权威来源，路由器数据无需参与。

### 抓包/分析管理接口：评估结论

- **OpenWrt：不需要**。ubus 已覆盖诉求全部数据面（DHCP/无线/board + 可选 network.device）；抓包无增益。
- **非 OpenWrt（小米/华硕/TP-Link 私有 Web API）：建议不接**。理由：①每品牌私有 token/登录流程 + 固件版本敏感，解析器易碎（一次固件升级即失效）；②维护成本与"探测失败必须可见"的诚实原则叠加后，UI 会挂满"该功能不可用"注记；③**内置浏览器登录（router-browser.ts）已经提供"用户能看到管理页"的兜底**，会话检测（Cookie 关键词 :20）是启发式但已如实标注"Cookie 检测"。若未来接，优先级最高是小米 miwifi（第三方实现文档最多），但工作量≈重写一个品牌的 RouterManager，建议单独立项而非塞进本任务。
- 非 OpenWrt 固件的降级现状已诚实：caps.openwrt=false → "该路由器不支持"；管理页会话 kind='web' → 明示"不含 ubus 数据"（RouterView.tsx:539, :584）。

---

## D. 上下线监测与流量统计（诉求③）

### 上下线

**现有机制**：
- DEVICE_NEW：新 MAC 首次出现（事件型，TTL 10min，首轮只做种）——alarms.ts:65, :336-352, scheduler 首轮种机制。
- DEVICE_OFFLINE：ARP 连续 3 轮缺席（ALARM_THRESHOLDS.offlineArpMisses）且 ICMP 无响应——alarms.ts:324；状态机 resolveLinkState（scheduler.ts:115-133）"ARP 老化 3 轮才判离线，ICMP 超时绝不判离线"。
- 心跳：5s 一轮 ARP 重读 + 轮转 ping 32 台（scheduler heartbeat）。

**路由器视角信号的真实语义**：
- `getWirelessDevices` 的 MAC 集合出现/消失 = **Wi-Fi 关联/解除关联**，是比本机 ARP 更权威的在线信号（设备可以禁 ICMP、可以不与本机通信，但只要连着 Wi-Fi 就在 assoclist 里）。
- DHCP 租约出现 = 入网/新设备信号；**租约消失 ≠ 离线**（租约有残留 TTL，dnsmasq 默认 12h+），不可作下线信号。
- 有线设备无 assoclist 信号——**字段必须三态**（关联 / 未关联 / 无数据），"无数据"不得显示成"未关联"。

**方案（不新增告警码，防重复告警）**：
- 同一设备入网，本机 ARP/首见 MAC 已会发 DEVICE_NEW；若再从路由器信号发一条，用户会看到双份。**建议把路由器信号作为在位判定与告警的佐证输入，而不是独立告警源**：
  1. RouterManager → 主进程 → engine 新方法 `applyRouterHints(hints: {wifiMacs: string[], leaseHostnames: Map<mac,{hostname,ip}>})`（每轮 routerStatus 更新时喂，10s 节奏）。
  2. scheduler：DeviceRecord 加 `wifiAssociated: boolean | null`（null=设备不在 Wi-Fi 视野或非无线）；heartbeat 的 `pickHeartbeatTargets`/`applyArpPresence` 把 wifiAssociated=true 视同在位（arpMissStreak 不推进，:571-583 的语义顺延"路由器确认在位"）。
  3. DEVICE_NEW 的 detail 可加"路由器无线关联确认"字样（单一告警，来源更可信）。
  4. 下线判定：assoclist 消失 + ARP 缺席 → 仍走 DEVICE_OFFLINE 既有 3 轮机制，不缩短（Wi-Fi 短暂漫游掉线不应立即告警——诚实且防抖）。
- UI 落点见 E（设备列表加无线信号列/徽标）。

### 流量统计

**红线前提（task-021 F4 裁定延续）**：bandwidth.ts 的 attributable 语义 = 只有存在可归集的 TCP 会话才把本机网卡计数器按连接占比摊给设备（bandwidth.ts:197-215），否则 `attributable:false` → UI 显示"无流量归集"（DevicesView.tsx:145-152）。**严禁伪造分摊**。

**OpenWrt 侧 per-host 计数的真实可得性**：
- 标准 ubus **没有** per-host 字节计数。conntrack（`luci-rpc getConntrackHelpers`）默认不含 per-flow/per-host 字节计数器（需要 nf_conntrack_netlink + accounting 内核选项，且默认关闭）。
- iptables ACCOUNT / conntrack accounting 需要改路由器配置（装包/加规则），超出"登录后即可用"的产品边界。
- **结论：per-host 流量拿不到，如实呈现**——现状 attributable 语义已经正确处理，路由器接入不改变它。任何"按 IP 分摊路由器总流量"的方案都是伪造，不做。
- **可诚实补的增量**：`network.device status` 的接口级统计 → RouterView 展示"路由器 LAN/无线口总吞吐"（与现有 UPnP WAN 计数器并排，如实标注"接口级"）。实现 = C-3 模式（新 parse + doRefresh 一路）。

---

## E. 设备列表展示落点（诉求④）

### 现状

- DevicesView 列（DevicesView.tsx:93-154）：状态 / IP（徽标：网关/本机/IP冲突） / 名称（displayName ?? hostname） / MAC / 厂商 / osHint / 类型（KIND_LABEL） / 首次接入 / 延迟 / 丢包 / 质量条 / 流量（attributable 三态）。数据源 `Device`（types.ts:39-62）。
- 行组件 memo 比较 `sameRow`（:41-68）**逐字段显式比较**——新增字段必须同步加进比较函数，否则 UI 永不刷新（易踩坑）。
- RouterView 与 DevicesView 完全独立：路由器页两张表（DHCP/无线）按 MAC 展示原始条目；设备页按 Device（IP 主键）。**两处数据当前零交叉**——"路由器看到的那台手机"与"设备列表里的 192.168.2.23"无法对上，这正是诉求④要解决的。
- DeviceDetailDrawer：身份区 :281-285（osHint/vendor/kind），端口/连接/历史卡已有。

### 数据流打通方案（核心前置）

RouterStatus 在主进程 RouterManager 手里，引擎（scheduler）拿不到。打通路径（不改引擎不 import electron 的铁律）：
```
RouterManager.refresh 完成（或 startPolling onUpdate）
  → 主进程把 { dhcpLeases, wirelessClients } 喂 engine
  → engine.applyRouterHints(hints) 存入 scheduler（内存，10s 刷新节奏）
  → scheduler 组装快照时按 MAC 合并
```
落点函数级：
1. `Engine` 接口（engine/index.ts:32-63）加 `applyRouterHints(hints: RouterHints): void`；
2. `RouterHints` 类型（shared/types.ts）：`{ leaseHostnames: {mac,ip,hostname,expiresAt}[]; wireless: {mac,signalDbm,connectedForSec}[] }`；
3. scheduler 加 `setRouterHints()` + buildDevices 合并逻辑：
   - hostname 为 null 时用租约 hostname 回填（**保持 rDNS 结果优先**：rDNS 是 FQDN 更完整；或反向，建议 rDNS 优先、租约兜底，二者都是真实数据）；
   - MAC→IP：租约自带 ip；无线客户端只有 MAC，需经租约或本机 ARP（scheduler.arp Map 已有 mac→ip 反查能力，arp.ts:169-176 findIpByMac 已存在可直接复用）。
4. 主进程 main/index.ts 在 routerManager.startPolling 回调里 `engine.applyRouterHints(...)`。

### 展示落点（两档方案）

**方案 1（推荐，满足诉求④完整语义）**：Device 加可选字段（契约变更，走批准流程）：
```ts
routerInfo?: {
  signalDbm: number | null;      // Wi-Fi 信号；非无线/无数据 = null
  connectedForSec: number | null; // 关联时长
  source: 'router';               // 数据来源标注（诚实）
} | null
```
- DevicesView：IP 列徽标区加"Wi-Fi"小徽标（有 routerInfo 时），title 显示 `信号 xx dBm · 已关联 x 小时`；**不建议加新列**（现 12 列已宽，200+ 行虚拟分页在压力下）。
- DeviceDetailDrawer 身份区加一行"无线信号/关联时长"，非无线设备显示 '—'。
- **关键实现细节**：sameRow（:41-68）必须加 `x.routerInfo === y.routerInfo`（或字段级比较）；kind 列已由 DHCP hostname 回填间接受益（mobile/printer 命中率上升）。
- 契约冻结警示：types.ts:2-3 "任何人不得单方修改"——加可选字段属于向后兼容扩展，仍需队长批准（流程同 R-03 先例）。

**方案 2（最小改动，不动 Device 契约）**：
- 只做 DHCP hostname 回填（hostname 本来就是 Device 既有字段，零契约变更）——设备列表"名称"列立即从"普遍 —"变为"普遍有名字"，这是本次增强 80% 的用户价值；
- 信号/关联时长/租约到期留在 RouterView 的既有无线表与 DHCP 表里。
- 诉求④的"在设备列表清晰展示"只满足主机名一半；信号强度展示仍隔一页。

建议：方案 2 先行（P1，零契约风险），方案 1 作为 P2 契约扩展随后。

---

## 实现分期建议

**P1（先行，零契约变更 / 引擎与主进程为主，可不等 021）**
1. **B-1 记住密码开关**（AppSettings + store 默认值 + ipc 白名单 + RouterView 复选框 + 关闭即清凭据）——渲染层只动 RouterView（021 未占用）。
2. **C-1 DHCP 租约 hostname 回填**（applyRouterHints 数据流 + scheduler 回填 + rDNS 优先）——设备列表名称列覆盖率跃升，性价比最高。
3. **B-2 会话失效自动重登**（invalidatedAt 信号 + 退避重登 + 停用提示）——依赖契约加一个可选字段（向后兼容，风险低）。

**P2（依赖：021 验证通过 + 契约变更批准）**
4. **E 方案 1**：Device.routerInfo + DevicesView 徽标 + Drawer 卡片 + sameRow 同步。
5. **D 上下线佐证**：wifiAssociated 进 DeviceRecord + heartbeat 在位判定加权 + DEVICE_NEW detail 标注。

**P3（可选增强，依赖路由器实机）**
6. `network.device status` 接口级吞吐进 RouterView（新 parse 函数；形状按 OpenWrt 源码可写，实机验证一次）。
7. `luci-rpc getHostHints` 主机名补充（**形状必须实机取样**，不建议盲写解析器）。

**明确不做（及理由）**
- 抓包接小米/华硕/TP-Link 私有 Web API——易碎、维护成本高、内置浏览器已兜底（详见 C）。
- per-host 流量分摊——OpenWrt 标准接口无此数据，伪造即触红线（F4）。
- 端设型号/OS 从路由器获取——数据不存在；型号显示 '—'，OS 走既有指纹管线，路由器数据仅作 hostname 输入补充。
- iwinfo 原生对象——luci-rpc 版本已够，避免多一路固件差异面。

**依赖路由器实机的验证项**（P1/P2 落地后）：UBUS_NULL_SESSION 登录真机首验（task-002 修复至今未真机验证过）；自动重登的 3600s 过期场景；assoclist/DHCP 在真机的实际刷新节奏；P3 的 getHostHints/network.device 形状取样。
