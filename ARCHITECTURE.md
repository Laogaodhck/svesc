# SVESC 局域网监控台 · 架构设计

> 当前实现说明更新于 2026-10-29，应用内部版本为 0.4.0。第 9.7 节与第 10.3～10.8 节保留历史演进记录，不代表所有旧功能仍存在。
> 历史真机耗时来自当时的 Windows 10 Pro 19045 环境，不是当前版本的性能承诺。本轮设备发现与双通道租约增强的自动化验证、未验证范围见第 11 节；管理页候选固件尚未逐台验证。

---

## 1. 分层架构

```text
Renderer（React 19 + Vite 7，src/renderer/**）
  总览 / 设备 / 打印 / 持续监控 / 诊断 / 设置 / 路由器登录
  展示快照、发起用户操作；不直接执行局域网探测
       ↕ contextBridge：src/main/preload.ts → window.lanApi
Main（src/main/** 中的 Electron 适配层）
  index.ts：生命周期、窗口、托盘、依赖注入
  ipc.ts：白名单操作与快照 / 路由器状态推送
  router-browser.ts：管理页 Cookie 分区、网关绑定与会话检测
  router-store.ts：safeStorage 异步加密与凭据操作修订
       ↕ 纯 Node 服务、注入的 Cookie / 凭据提供者和回调
Engine（src/main/engine/**）
  discovery：ARP / ICMP / TCP + mDNS / SSDP / WS-Discovery / 指纹
  router：UPnP / ubus / 管理页租约 → 规范化与合并
  scheduler / network / printers / watch / db / simulator
       ↕ child_process / net / dgram / http / node:sqlite
Windows 自带命令、局域网协议与本地 SQLite
```

**分层铁律**：`src/main/engine/**` 不导入 Electron。目录、Cookie 与凭据读取能力由主进程注入，引擎不直接访问 Electron 会话或密钥库。
纯 Node 引擎可在 Vitest 中测试；`scripts/engine-check.mjs` 会执行真实扫描。IPC 通道与接口以 [channels.ts](src/shared/channels.ts)、[preload.ts](src/main/preload.ts) 为准，不在文档中维护易过时的接口数量。

---

## 2. 模块职责

| 文件 | 职责 | 关键约束 |
|---|---|---|
| `engine/exec.ts` | **唯一子进程出口**。`runNative(cmd,args,enc,timeoutMs)`、`runPowerShell(code)`、`parsePsJson` | 编码按调用点声明；禁止调用点自行 `toString()`；全局并发 64；PowerShell 单飞；硬超时强杀后清 timer |
| `discovery/subnet.ts` | 从 `os.networkInterfaces()` 推导 /24 网段 + 默认路由（`route print -4`） | 排除 `vEthernet/WSL/Loopback/169.254.*`；网关读不到就是 `null`，不猜 |
| `discovery/arp.ts` | `arp -a`（GBK）主路径 + `Get-NetNeighbor` 回退 | 双 locale 正则；过滤组播/广播/全零 MAC；解析空 → `[]` + `parseWarning`，不抛错 |
| `discovery/ping.ts` | `ping -n 1 -w 800` 存活与 RTT；`ping -n 4` 质量采样 | 解析失败不抛错；`<1ms` 记 0；**禁止 `ping -a`** |
| `discovery/ports.ts` | `net.connect` 探活（700ms/端口），只对候选主机 | 端口集合以 `shared/constants.ts` 的 `PROBE_PORTS` 为准，受扫描剩余预算约束 |
| `discovery/oui.ts` | 手写主表 + IEEE 数据生成表，未命中返回 `null` | 主表优先；`isRandomizedMac` 识别本地管理位 MAC，不按概率猜厂商 |
| `discovery/oui-extended.ts` | `scripts/build-oui.mjs` 从 IEEE 注册库生成全量 24-bit MA-L 表；当前快照为 2026-10-26 的 40394 条 | 不再按厂商白名单截断；不收录无法仅凭前三字节区分的 MA-M / MA-S 细分块 |
| `discovery/mdns-devices.ts` | 服务类型与 TXT 型号转换为设备身份提示 | AirPlay 等共享生态服务不单独判手机；明确型号才细分；同类优先保留型号证据 |
| `discovery/wsdiscovery.ts` | ONVIF WS-Discovery（UDP 3702）组播与定向探测，解析明确的摄像头自报类型 | 地址由调度层限定在扫描范围内；失败不伪造身份 |
| `discovery/ssdp-devices.ts` | SSDP `ssdp:all` 查询与描述页，提取 deviceType / friendlyName | 不明确的设备类只给提示，不强行定类 |
| `discovery/http-fingerprint.ts` | 对已探明 80/8080 开放的候选（≤6 台/轮轮转）查询 title / Server | 恰好命中一类才定 kind；原文作提示，失败不拖垮扫描 |
| `discovery/fingerprint.ts` | 将网关事实、协议自报、端口、主机名、OUI 与 TTL 分层转换为 `kind` / `osHint` | TTL 只作弱提示；跨品类厂商结合管理端口等反证，主板品牌推断不冒充整机型号 |
| `network/quality.ts` | **纯函数**质量评分（公式冻结） | 系数、取整时机不允许改；`samples < QUALITY_MIN_SAMPLES(8)` → `grade='unknown'`（score 保留），`>=8` 才出 85/70/50 分级 |
| `network/monitor.ts` | 每设备滑窗（20 采样）+ RTT 历史（60 点） | 未响应只算丢包，不产生离线结论；数据源只有 `ping -n 4` 批量采样 |
| `network/bandwidth.ts` | `netstat -e` 差分 + `netstat -ano` 连接归集 | 不与网卡计数器混算；无归集时 `attributable:false` |
| `printers/snmp-ber.ts` | 手写 BER 编解码 + GET/GETNEXT 报文构造与响应解析 | 纯函数，可用构造字节单测 |
| `printers/snmp-client.ts` | UDP 161 会话、超时重试、walk | 失败返回 `ok:false`，不抛错 |
| `printers/printer-mib.ts` | RFC 3805 OID 常量与解析；`sanitizeModel` 纯函数清洗型号 | `maxCapacity<=0` → `levelPct:null`（-2/-3 是有语义的负数）；型号取首个 `;` 前、≤40 字符 |
| `printers/spooler.ts` | `Get-Printer` / `Win32_Printer` / `Get-PrintJob` 全量取回 + 纯映射函数 | 空队列空字符串 → `[]`；单条结果包成数组；打印机名绝不拼进命令 |
| `printers/ipp.ts` | IPP 2.0 `Get-Printer-Attributes`（opt-in 耗材通路，148 行 / 仅 `node:http`） | 只试 `/ipp/print`、`/ipp`；statusCode≠0x0000 立即放弃；`marker-levels<0` → `levelPct:null` |
| `printers/print-ops.ts` | 打印操作（task-024）：任务取消/暂停/恢复（PrintJob cmdlet）、测试页（rundll32 printui.dll）、设默认（CIM SetDefaultPrinter） | 打印机名 `'`→`''` 转义 + 拒绝换行/反引号/双引号（≤220 字符）；jobId 强制正整数；printui 走 args 数组分离（MUI 铁律）；失败如实 `{ok:false,error}` 不吞错 |
| `printers/printer-service.ts` | 三源合并 + **TCP 探活覆盖 state** + 耗材 provider 链（`snmp → ipp → unknown`，命中即短路） | `.213` 假在线必须被覆盖为 `offline`；网络不可达的打印机不查耗材（不为离线设备"猜"数据） |
| `printers/mdns.ts` | 打印机与全设备发现共用的 DNS 查询/解析层；压缩 PTR / SRV 与跨包 A / TXT 关联 | 缓存限于单次查询窗口；不以 UDP 来源地址冒充 SRV 目标；打印机 mDNS 来源开关与设备身份查询用途分开 |
| `scheduler.ts` | 分频调度、预算内扫描、质量采样、设备快照与租约名称投影 | `resolveLinkState` 为纯函数；质量窗口只由 15s `ping -n 4` 填充，租约补名不修改存活证据 |
| `router/index.ts` | 路由器能力探测、独立会话、并行刷新与双通道租约合并 | 同核心会话合并刷新；会话/网关改变后拒绝旧结果；租约先于 WAN 完成推送 |
| `router/leases.ts` | 两路租约与设备回填共用的规范化入口 | MAC + IP 去重、冲突名称置空、到期过滤、最多 512 条；不修改调用方数据 |
| `router/web-leases.ts` | 管理页表格 / 纯字符串数组的实验性租约解析与候选请求 | 不执行页面脚本；逐 URL 取 Cookie；总预算和取消守卫约束所有候选与重试 |
| `soak.ts` | 长跑取证（真实采样，质量/降级率稳定性统计） | 纯 Node，`npm run soak` 驱动 |
| `store.ts` | JsonStore，保留与主存储同构的设置与设备元数据接口 | 目录注入；300ms debounce；`normalizeTags` 归一化（≤8 个/单个 ≤24 字符） |
| `db/` | 当前主存储 SqliteStore，使用内置 `node:sqlite`，无需原生模块编译 | `svesc-state.db`；初始化失败降级内存模式并记录日志；v3 移除旧告警表 |
| `watch.ts` | 持续 Ping 监控：每 5s 探测目标，60 点窗口 | `tickInFlight` 防重入；变迁经 `onTransition` 即时推送快照，无样本为 `unknown`；不再接告警引擎 |
| `wol.ts` | WOL 网络唤醒（task-025）：Magic Packet（6×0xFF+16×MAC，102 字节）UDP 广播 9/7 端口 | 只承诺"包已发出"；本机/网关/跨网段/未知 MAC/演示设备诚实拒绝 |
| `diag/portscan.ts` | 自定义 TCP 端口扫描（task-025）：worker pool 并发 64，单次 ≤1024 端口 | `validateDiagTarget` 白名单校验；结果 `{ports,openPorts,durationMs}` |
| `report-html.ts` | HTML 巡检报告（task-025）：自包含单文件（内联 CSS），设备/打印机/降级三节 | `escapeHtml` 转义五字符；空数据占位「暂无」，不伪造内容 |
| `simulator.ts` | mulberry32 种子生成的 12 设备 + 4 打印机 | 与真实数据凭 `sim-` 前缀区分 |

---

## 3. 数据流

```text
全量扫描：单轮 10s 预算
  初读 ARP → ping 扫描 → 复读 ARP → 候选计算 → TCP → 主机名/定向指纹
       └→ mDNS / SSDP / WS-Discovery 并行 ─→ 范围校验 → 设备建册/早推帧

独立路由器轮询：默认 10s
  ubus 租约 ────────┐
  管理页租约 ──────┴→ 规范化/合并 → RouterManager.publish
                                      ├→ router:status
                                      └→ Engine.applyRouterHints
                                            └→ Scheduler.setRouterHints
                                                 有效名称变化则立即出帧

DeviceRecord + 协议身份 + 有效租约主机名投影
  → 质量/带宽/在线状态组装 → 别名覆盖/演示标识 → Snapshot
  → onSnapshot → ipc.pushSnapshot → lan:snapshot → 渲染层重绘
```

设备列表订阅快照，扫描进度单独推送；设备详情等页面可通过受控 IPC 定时取数，并非所有页面都完全无轮询。租约名称投影既供展示也供指纹分类，不更改原始设备记录中的存活证据。

**状态判定（以 `scheduler.resolveLinkState` 为准，按顺序匹配）**

| 序 | 条件 | 结果 |
|---|---|---|
| 1 | `isSelf` / `isGateway` | online；质量达到退化阈值时为 degraded |
| 2 | `arpPresent` / `portResponded` / `pingAlive` 任一为真 | online；质量达到退化阈值时为 degraded |
| 3 | 前两项不成立，且 ARP 连续缺席计数 ≥4 | offline（唯一判离线路径） |
| 4 | 前两项不成立，且 ARP 连续缺席计数 <4 | online，暂不下离线结论 |

质量退化要求 ≥8 个质量样本且丢包 ≥20% 或延迟 >150ms。质量采样与单次存活探测独立：禁 ping 不直接判离线，质量未采样或样本不足时为 `unknown`，不能把所有 ICMP 超时都等同于“未采样”。

历史本机观测中，ARP 表有 20-50 条而只有少数回 ICMP；按“ping 不通即离线”会产生大量假离线。心跳与扫描共用缺席账本，默认约 20 秒的判离耗时是正常观测下的量级，不是固定时限。

task-026 实时化补充：心跳每 5s 对**本轮真实观测**记账——ICMP 存活先全量归零、只有本轮回包才置 true（防陈旧证据粘滞）；缺席设备的陈旧端口响应证据同步失效（TCP 回包前提是 ARP 在位）；ARP 读失败的一轮不算观测、不推进缺席（缺席必须基于真实账本）。

---

## 4. 为什么手写 SNMP BER

**动机**
1. 项目选择用 Node 内置 UDP 与自有 BER 编解码实现有限协议能力，不额外引入 SNMP 运行时依赖或本地编译步骤。
2. SNMPv2c GET/GETNEXT 只需要 BER 的一个极小子集：`INTEGER / OCTET STRING / NULL / OID / SEQUENCE / 上下文标签 PDU`。
3. 纯函数 → 可以用构造字节在 Vitest 里精确断言编解码，不需要真实设备。

**结构**

```
encodeLength / decodeLength      长度域（短格式 + 0x80|n 长格式；不定长拒绝）
encodeInteger / encodeOctetString / encodeOid / encodeNull
encodeTlv(tag, value)            统一 TLV 组合
encodeSequence(items)            SEQUENCE 组合
decodeTlv / walkTlv / walkChildren   TLV 定位与同级遍历
decodeInteger / decodeUnsigned / decodeOid   值解码（有符号 vs Counter32/Gauge32）
buildGetRequest / buildGetNextRequest        SEQUENCE{version, community, PDU{reqId,0,0, varbinds}}
parseResponse                     GetResponse → {requestId, errorStatus, varbinds[]}
oidStartsWith / compareOid        walk 子树终止与前进判定
```

**真机实测结论（2026-10-25，192.168.2.0/24）**

| 能力 | OID / 方法 | 实测结果 |
|---|---|---|
| 单 GET（标量） | `sysDescr.0`（1.3.6.1.2.1.1.1.0）等 | **可用**。`.235` 276B 响应 3ms、`.170` 55B 响应 7ms，各重复 3 次全部成功 |
| GETNEXT walk（子树下行） | `prtMarkerSuppliesEntry` / `prtMarkerLifeCount` / `hrDeviceStatus` | **可用**。`.170` 取到 13 条耗材条目，`.235` 取到 black=75% |
| 耗材表（RFC 3805） | `prtMarkerSuppliesType/MaxCapacity/Level` | **可用**：`levelPct` 由 `Level/MaxCapacity` 计算；`MaxCapacity=-2/-3` → `levelPct:null` |
| 页计数 | `prtMarkerLifeCount` | **可用**。SHARP MX-B4621R = 117483 页（多 marker 取 max）；Xerox AltaLink C8055 = 17773 页 |
| 告警表（printer MIB alert） | `prtAlert*` | **未使用**：故障判定走 `hrDeviceStatus` + TCP 探活 + spooler state，避免 walk 大表（单次 walk 耗时不可控） |
| SNMPv1 | version=0 | **未实现**：只发 SNMPv2c（version=1），v1 设备会静默丢弃（本网段未遇到） |

**报文结构（字节级）**：`SEQUENCE{ INTEGER version=1, OCTET STRING community, [0] GET{ requestId, 0, 0, VarBindList } }`，
其中 `VarBindList = SEQUENCE OF SEQUENCE{ OID, NULL }` —— **varbind 必须再套一层 SEQUENCE**。
这是与 P1 调查报告冲突的根因：Vera 的探针少了一层 SEQUENCE（38B vs 正确 40B），设备按 BER 解析失败后静默丢包，
表现为"8 次 GET 全 timeout"；同一台设备用本实现的字段布局 3-7ms 即返回。证据见 `implementation-report.md`「与 P1 调查报告的冲突及澄清」。

**RFC 3805 语义处理**：`prtMarkerSuppliesMaxCapacity = -2` 表示"未知"、`-3` 表示"无限但有余量"。这类值**不能**换算成百分比，`levelPct` 一律 `null`，只保留 `current`/`maxCapacity` 原值 —— Xerox 的 13 条耗材全部属于此类，UI 显示"设备不报告"，这是正确结果而非缺陷。

---

## 5. 带宽估算：方法与精度边界

**方法**

1. `netstat -e`（~103ms，系统级汇总）取「字节 rx / tx」两列；
2. 每 2s 采样一次，`bps = Δbytes × 8 / Δt`；
3. `netstat -ano`（~83ms）按**远端 IP** 聚合 ESTABLISHED TCP 连接数；
4. 单设备吞吐 = 全网吞吐 × (该设备连接数 / LAN 内连接总数)，`estimated:true`、`share` 为占比。

**为什么只能估算（必须诚实说明）**

- 网卡计数器是**整机聚合**，Windows 不提供"某对端 IP 的字节数"（`Get-NetTCPConnection` 同样没有字节字段），所以按连接数分摊是唯一可行的近似。
- 分摊假设"每条连接速率相同"，实际上大文件传输与心跳连接差 3 个数量级，**单设备数值只能作为量级参考，不可用于计费或容量规划**。
- `netstat -e` 含虚拟网卡（WSL / Default Switch）。实测汇总 tx 比单卡大 4 倍，因此 `Get-NetAdapterStatistics`（按网卡、可排除 vEthernet）**不与 netstat 混算** —— 两者任选其一，本项目选 netstat（快 10 倍），并在文档与 UI 上标注"全网合计（含虚拟网卡）"。
- 本机与 LAN 的 TCP 连接实测仅 4 条，绝大多数设备 `share≈0`。此时 `attributable:false`，UI 必须显示"无流量归集"而**不是** `0.0 Kbps` —— 后者会被误读为"真实测得的零流量"。

**精度结论**：可用于"谁在跑流量"的相对排序与全网吞吐趋势；不可用于单机带宽承诺值。

---

## 6. 数据来源诚实原则（贯穿全项目）

| 情况 | 本项目做法 | 反例（明确禁止） |
|---|---|---|
| 打印机不报告耗材 | `consumables: []` + UI「设备不报告耗材」 | 填 0% / 随机数 |
| `maxCapacity=-2/-3` | `levelPct: null` + 保留原值 | 换算成 -2% |
| 页计数无来源 | `pageCount: null` | 估算或填入 job 累计 |
| 主机名反查失败 | `hostname: null` | 显示 IP 冒充主机名 |
| 厂商未命中 OUI | `vendor: null` | 按端口猜"HP" |
| 无法归集带宽 | `attributable:false` | 显示 0 bps |
| ICMP 禁 ping 主机 | `online` + `quality.grade='unknown'` + `samples=0` | 判离线并把评分算成 0 分 |
| 驱动是 Microsoft 通用驱动 | `model: null` | 当成真实型号展示 |
| SNMP `sysDescr` 含 `; SS/NC/UI/ME/CC/DF` 固件串 | `model` 取首个 `;` 前、≤40 字符（`sanitizeModel`）；原文进 `stateDetail` 前 80 字符 | 整段固件日志塞进"型号" |
| IPP `marker-levels` 为负（-1/-2/-3） | `levelPct: null`（RFC 8010 语义） | clamp 成 0%（＝"已耗尽"的假警报） |
| 真实设备 < 3 台 | `dataSource: 'demo'/'mixed'` + 顶部角标 | 静默展示演示数据 |

相关代码位置：`printer-mib.toLevelPct`、`spooler.modelFromDriver`、`bandwidth.emptyBandwidth`、`scheduler.resolveLinkState`、`scheduler.composeDevicesAndPrinters`。

---

## 7. 分频策略与延迟预算

| 任务 | 周期 | 实测耗时 | 说明 |
|---|---|---|---|
| 带宽 | 2s | ~190ms（netstat -e + -ano） | 首次采样只建基线，返回 null（≠ 0 流量：R-02 语义）且 `attributable:false` |
| 设备心跳（实时探测） | 5s | 最坏 ~2.4s（`arp -a` + ping：缺席确认 ≤32 ∪ 在线全量 ≤112 ∪ 未知 IP 滚动 ≤64，@64 并发） | task-026：上下线秒级感知；新设备 ARP 冒头 / 未知 IP ping 中 → 即时建册**早推帧**（不必等扫描结束）；缺席计数在此统一推进 |
| 质量采样 | 15s | ~6-10s（≤12 台 × `ping -n 4`，并发 8） | **质量窗口的唯一数据源**；扫描/心跳的单次存活 ping 不计入 |
| 打印机 | 15s | ~3-5s（3 次 PowerShell + TCP 探活 + SNMP；IPP 有负缓存且命中 SNMP 即短路） | PowerShell 单飞；SNMP 正/负缓存（负 5min） |
| 全量扫描 | 默认 60s | 历史约 8-10s；当前扫描预算 10s | 组播与 ping 并行，截止后停止接纳该轮协议身份，用已有结果出帧 |
| 路由器 | 10s | 与设备扫描独立；不承诺整轮固定耗时 | 管理页候选共用 6s 预算，失败退避；租约帧不等待 WAN |

**实测分解（engine-check，本机 192.168.2.0/24）**

```
arp(首次) 105ms → ping(254@64) 5816ms → arp(复读) 116ms → ports 712ms → dns 24ms
扫描阶段合计 ≈6773ms（预算 10000ms，未触发截断；多轮波动 6.3-10.0s）
printers 采集 4520ms（独立任务，不在扫描预算内；SNMP 命中即短路）
```

**延迟预算设计**

- 手动刷新（`lan:refresh`）：先 `emitSnapshot()` 再启动扫描 → UI 在 **1 个 IPC 往返内**看到进度条与既有数据，不等扫描结束。
- 首屏：不阻塞。首轮扫描完成前 `dataSource` 保持 `live`，设备列表为空由 UI 呈现骨架/空态（**不用演示数据填**，避免真实网段上启动即"演示数据 12 台"的观感）。
- 扫描期间不阻塞主线程：`ping` 走 `spawn` + 64 并发池，端口探测走 `net.connect` 异步，进度按批推送。
- **10s 扫描预算**（`SCAN_BUDGET_MS`）：ping 到点停止继续等待，不把未探测地址直接判离线；端口阶段用 `AbortController` 中止。主机名与定向身份阶段只等待剩余预算，协议身份写回另有截止/轮次守卫；它不等于强制取消所有已发出的 DNS 或系统调用。已过预算时跳过后续复读 ARP 等阶段，用已取得的证据组装快照。
- **强杀不做进程树清剿，除非 PowerShell**：`exec.ts` 的 `sweepTree` 开关只对 `runPowerShell` 打开。Vera 受控实验证明给 `ping/arp/netstat` 这些无子进程的叶进程也 `taskkill /T /F`，会让一次扫描从 5.5s 恶化到 10s（进程创建拥塞正反馈）；而 PowerShell 确实会派生 conhost 进程树，孙进程持有管道时 `close` 不派发，必须清剿。
- **超时立即 settle**：强杀后不押注 `close` 一定派发（Windows 上被强杀的进程、句柄卡住的 powershell 都可能静默），Promise 当场 resolve（`timedOut:true`），令牌闸门随之释放；`close` 迟到会被 `settled` 标志忽略，幂等。
- 引擎侧的"命令失败"一律写入 `snapshot.warnings`（`discovery`/`printers`/`bandwidth`/`system` 四源，同源同文案去重、上限 20 条、条件恢复即消失），绝不把失败静默成 0 或空列表。

**实时监控开关（autoScan，task-026 语义）**

- 开（默认）：5s 心跳实时探测 + 60s 深度扫描全量运行，设备上下线与新设备秒级感知。
- 关：心跳早退 + 全量扫描停 → 设备状态**冻结**（UI 明示"实时监控已暂停 · 设备状态冻结"）；带宽/打印机/质量采样/持续 Ping 属于本机观测，继续运行（R-04 语义）。

**错峰**：2s 带宽采样与 60s 全量扫描可能同 tick。两者都是短命子进程，全局子进程闸门 64 兜底；实测无争抢（扫描期间带宽采样仍稳定在 200ms 内）。

---

## 8. 降级路径

| 故障 | 表现 | 降级行为 |
|---|---|---|
| 无局域网 / 无法推导网段 | `detectSubnet()` 返回 null | `hosts=[]`，跳过扫描；`dataSource='demo'`（真实设备 0 台） |
| `arp -a` 解析失败（编码/locale 变化） | 0 条目 + `parseWarning` | 回退 `Get-NetNeighbor`（JSON）；仍失败则本轮不判离线，并在 `snapshot.warnings` 留一条 `source='discovery'` |
| 任一探测阶段失败（扫描轮异常 / `Get-Printer` 失败 / `netstat -e` 解析失败） | 命令返回空或抛错 | 写入 `snapshot.warnings`（上限 20 条、同源同文案去重、恢复即消失）；**不**把失败显示成 0 或"没有设备" |
| ICMP 大面积被禁 | ping 存活率极低 | ARP + 端口作为在线主信号；`quality.grade='unknown'`，**不判离线** |
| 无 spooler 权限 / 执行策略限制 | `Get-Printer` 失败 | 回退 `Get-CimInstance Win32_Printer` + `Win32_PrintJob`；再失败 `printers=[]` 且不影响设备面板 |
| SNMP 161 被封 | 全部 timeout | 负缓存 5min；`consumables: []`，不重试风暴 |
| 设备未启用 SNMP | `levelPct:null` | UI「设备不报告耗材」（`null ≠ 耗尽`） |
| 反向 DNS 全失败 | `hostname:null` | 展示 IP；失败结果也缓存，不反复超时 |
| GPU 进程崩溃（远程桌面/虚拟机） | Electron FATAL 退出 | 启动即 `disableHardwareAcceleration()` + `disable-gpu`（本机实测必须，否则应用起不来） |
| SQLite 打开或初始化失败 | 记录错误并报告存储降级 | 以默认内存状态继续运行，本次修改不落盘；不宣称已修复原数据库 |
| 真实设备 < 3 台 | — | 叠加 `Simulator`，`dataSource='mixed'/'demo'` + 角标 |

---

## 9. 扩展点

1. **IPP 耗材通路（opt-in，已实现）**：`printers/ipp.ts` 用 `node:http` 手写 IPP 2.0 `Get-Printer-Attributes`（operation 0x0009），单文件 148 行、零依赖。
   - 路径固定 `['/ipp/print', '/ipp']`，版本固定 2.0，超时 2500ms；HTTP 404/连接失败才换下一个路径；
   - **statusCode ≠ 0x0000 立即放弃**（不重试、不换路径重试），返回 null → provider 链落到 `unknown`；
   - `marker-levels` 的负值（RFC 8010：-1/-2/-3）一律 `levelPct:null`，绝不 clamp 成 0；
   - 负缓存 300s + "离线打印机不查耗材"两条策略，保证不支持 IPP 的设备不会每 15s 付 2.5s×2 的代价。
   - **实测（本机）**：`.235` 回 `0x0400`（100ms 内放弃），`.170` 的 `/ipp/print` 是 HTTP 404、`/ipp` 无有效响应（约 3.2s 放弃）→ 两台都拿不到 `marker-*`，因此本机耗材仍全部来自 SNMP。该模块的价值在支持 IPP 的现场机型。
2. **真实 ICMP（raw socket）**：当前用 `ping.exe`，进程开销决定了下限 ~0.5s/批。改 raw socket 可把 254 地址压到 1s 内，但需要管理员权限与 winpcap 类依赖（违背零原生依赖），暂不做。
3. **多网段**：`SubnetInfo` 已含 `iface/cidr/prefix/hosts`，把单条 `SchedulerConfig` 改成数组即可并行多网段；`DeviceRecord` 需加 `iface` 维度的 MAC 唯一性处理。
4. **Prometheus 导出**：`Snapshot` 即指标快照，加一个 30s 周期把 `system/devices/printers` 映射成 `/metrics` 文本即可；`engine-check` 的 phase 计时可直接映射成扫描耗时指标。
5. **历史时序**：目前每设备 60 点 RTT 在内存。若要长期留存，`store.ts` 可扩展为 append-only NDJSON（仍是零原生依赖）。

## 9.5 打印管理页

**导航**：独立“打印管理”视图（`PrinterManageView`），支持手动添加打印机、别名、忽略。配置通过 `PersistStore` 接口持久化，当前默认后端为 SqliteStore；JsonStore 保留同构接口。

- **手动添加**：IPv4 严格校验（`isValidIpv4`）+ 可选备注；同 IP 幂等更新备注。`collectPrinters` 按 IP 去重合并——自动发现已覆盖的 IP 不产生重复条目；**探活失败也保留并如实 offline**（`stateDetail` 标注"手动添加"），`reachable` 表同口径登记（保证状态口径与自动发现一致）。
- **忽略**：被忽略的自动发现条目在 `collectPrinters` 输出层过滤（不显示）；手动条目不受忽略影响（删除走 removeManualPrinter）。
- **别名**：复用 `store.aliases`（key = printer id）；`applyAliases` 对 devices（displayName）与 printers（alias 字段）统一投影。别名只改显示名。
- **刷新联动**：IPC 变更落盘后 `void scheduler.refreshPrinters()` 立即重采并推送快照。

## 9.6 打印操作通道（task-024）

四条新 IPC：`printer:jobAction` / `printer:printTestPage` / `printer:setDefault` / `printer:openAdmin`，引擎实现收敛在 `printers/print-ops.ts`。

- **任务操作**：`printerJobAction('cancel'|'pause'|'resume', printerName, jobId)` → PowerShell `Remove/Suspend/Resume-PrintJob`。UI（PrintersView）在队列行内联操作：取消需二次确认、暂停/恢复按任务状态动态出现、忙碌中单飞防重复；默认只展示 5 条任务，展开可看全队列。
- **测试页**：`rundll32 printui.dll,PrintUIEntry /k /n <name>`——MUI 程序铁律：不经 PowerShell、GBK 解码、args 数组分离。
- **设默认**：CIM `Win32_Printer.SetDefaultPrinter`（结构化 JSON 回包），`ReturnValue≠0` 如实透出 CIM 错误码。
- **打印机 HTTP 管理页**：`printerOpenAdmin(ip)` → `router-browser.ts` 以 `persist:printer-admin` 独立 partition 开 1024×720 窗口（contextIsolation + sandbox），与路由器内置浏览器的会话隔离。
- **安全边界**（打印机名是不可信字符串）：PowerShell 单引号转义（`escapePsSingleQuoted`：`'`→`''`）+ `isSafePrinterName` 拒绝换行/反引号/双引号；jobId 强制正整数（非数字不进命令）；IPC 层先做 action 白名单与 IPv4 格式校验。
- **管理页监控增强（PrinterManageView）**：耗材摘要（仅 `levelPct` 非 null 条目，缺失显示"—"）、队列长度列、默认打印机标识 + 测试页/设默认/管理页操作按钮，全部 busy 单飞 + 失败如实反馈。

### 9.6.1 状态历史与打印机异常提醒（2026-10-29）

- **在线历史**：`device_status_log` 原本只写转移记录，现由引擎门面（`engine/index.ts`）在 `getDeviceDetail` 中注入 `statusHistory`（新→旧最多 50 条）。调度器不持有存储依赖，仍返回空数组；JSON/降级后端如实为空。渲染器详情抽屉直接展示，不新增 IPC 通道或存储表。历史只在状态转移时写入，不是连续采样。
- **异常提醒**：`engine/printers/alerts.ts` 为纯 Node 判定器——`printerIssue()` 汇总 `offline/error/warning` 与耗材 ≤10%（`source != 'unknown'`），跳过演示与虚拟打印机；`PrinterAlertTracker` 首帧建基线不补弹存量故障，按打印机 10 分钟冷却，只有"通知过故障"的打印机才发恢复提醒，被忽略/移除的条目清账本。主进程 `onSnapshot` 每帧推进基线（即使开关关闭，避免重新开启时补弹），命中且 `settings.printerAlerts` 开启时经 `main/notify.ts` 弹 Electron `Notification`，点击唤起主窗口；`app.setAppUserModelId('cn.svesc.lan-monitor')` 与 electron-builder `appId` 对齐，保证 Windows toast 归属。
- **组件测试**：`vitest.config.ts` 启用 `esbuild.jsx='automatic'` 并纳入 `.tsx`；`tests/printer-manage-view.test.tsx` 在 jsdom 下 mock `window.lanApi`，锁定队列门控、测试页双步确认（确认前不发命令）与快照更新时别名草稿保留。新增依赖：jsdom、`@testing-library/react`、`@testing-library/dom`。

## 9.7 历史审计修复（2026-10-25）

本节保留当时的改动背景；告警相关功能现已移除，存储与路由器会话的当前实现分别见第 2、10 节。

- **世代号（L4）**：`RouterManager.generation` 在 logout 时自增；`doRefresh` 入口捕获、写回前比对，不一致整体丢弃——堵住"logout 后在飞一轮把旧会话数据写回 status"的竞态。
- **告警收尾**：`AlarmEngine.evaluate` 对"从监控集消失的打印机"（忽略/删除/拔除）统一 resolve 活跃告警；`printersCollected` 入参区分"启动早期空列表 tick"（绝不收尾）与"真实采集结果"。
- **store 可感知性**：落盘失败 → `onWriteError` 回调 → 快照 `warnings[source=store]` + 5s 重试定时器直到恢复（恢复也通报）；损坏文件 `console.error` + alarms 逐条形状校验。
- **设备别名补通**：引擎与持久化早已支持但无通道无 UI——新增 `lan:setDeviceAlias` 通道 + 详情抽屉别名编辑行；设备（displayName）与打印机（alias 字段）共用 `store.aliases`。
- **告警交互收口**：`onAlarm` 推送被订阅（增量合并进快照）；system 告警跳总览；printer 告警滚动 + 高亮定位目标卡；ack 失败经 banner 提示。
- **诚实化清理**：状态栏硬编码"引擎 4 个任务"删除；侧边栏打印机计数恒非虚拟口径；死代码（isVirtual/currentPrinters/alarmEvaluation/counts.router）移除。
- **健壮性**：heartbeat 补 catch → warnings（此前 spawn 失败会让快照静默停更）；手动刷新在扫描进行中如实返 `started:false`；`exportReport` 附 routerStatus + printerManage。
- **M3**：`runFullScan` 抽为 5 个 phase 方法（ScanCtx 共享上下文），预算语义逐行保留，engine-check 回归 PASS。

## 10. 路由器管理模块

当前 `RouterView` 只保留账号登录、退出、状态反馈和内嵌管理页。WAN、租约、无线状态、重启操作卡片已从该页移除；底层可用数据继续采集，租约名称供设备列表使用。引擎协议能力不等于当前页面提供对应操作入口。

### 10.1 能力与登录路径（彼此独立）

| 通道 | 实现 | 数据或状态 | 不支持时 |
|---|---|---|---|
| UPnP IGD | SSDP → 描述 XML → SOAP | WAN 地址、累计流量、连接状态/时长等底层能力 | 在能力说明中标注不可用；未返回的字段为 null |
| OpenWrt ubus | HTTP POST `/ubus`，JSON-RPC `session.login` | DHCP 租约、系统与无线数据，受 RPC 权限限制 | 返回登录或采集错误；无对应对象时不编造数据 |
| HTTP 管理页探测 | 80 / 8080 / 443 探测、重定向与品牌指纹 | `identity.adminUrl`、品牌提示、Basic 质询 | 未识别不猜品牌；同网关内已观测能力保留，换网关重置 |
| 内嵌管理页登录 | `RouterView` 的 `<webview>` 使用 `persist:router-admin` 分区 | 主进程检测会话 Cookie，维护独立 web 会话 | 启发式检测可能无法识别固件登录态；不等同于 ubus 认证 |
| 管理页租约（实验） | 已有 web 会话后，以逐 URL Cookie 请求候选页 | HTML 表格或纯字符串数组中的 MAC / IP / hostname | 失败或不可解析则返回原因并退避，不伪造成功空表 |
| Basic 认证 | ubus 登录失败且收到明确 Basic 质询后验证 | 仅建立 `kind='basic'` 登录状态 | 不解锁 ubus，也不凭 Basic 状态生成租约 |

### 10.2 关键实现决策

- **零依赖**：node:http / node:dgram 直用，不引 xml2js/soap 库；描述 XML 与 SOAP 用正则解析（`upnp.ts` 纯函数）。
- **transport 注入**：`UbusClient` 的网络出口是构造参数，测试通过注入 transport 提供协议形状的响应，不连接真实路由器。
- **ubus 登录 sid**：`session.login` 必须用 32 位零 null-session（`UBUS_NULL_SESSION`）——uhttpd 的 `uh_ubus_allowed` 只接受这种 sid 调登录，发字面量 `'session'` 会被当成不存在的会话，一律 -32002（真机必然登录失败，且文案与"密码错误"无法区分）。错误码文案按路径分流：`-32002` 在登录路径是"用户名或密码错误"，在调用路径是"会话已过期或无权限，请重新登录"。
- **会话失效当场作废**：调用路径上的 -32002 是唯一"证据确凿的会话死亡"信号（同一个 sid 重试永远不会成功），且与网络超时/HTTP 错误走完全不同的分支——所以 `UbusClient.call()` 见到它即清掉缓存会话，下次调用直接 `auth-required` 短路，不再拿死 sid 发请求；网络/HTTP/权限拒绝（`result:[6]`）**不**作废会话（`sessionInvalid` 为 falsy），瞬时故障不会把用户登掉。
- **凭据安全**：明文密码只存在内存；密码落盘必须经 Electron `safeStorage.encryptStringAsync` / 读取用 `decryptStringAsync`（Windows DPAPI，与旧同步 API 同一套平台密钥库，密文跨版本兼容）。密钥环不可用 → **拒绝落盘**并如实告知，绝不降级明文（`src/main/router-store.ts`）。同步 API（`isEncryptionAvailable`/`encryptString`/`decryptString`）自 Electron 45 弃用、46 移除，故主进程只走异步路径；`decryptStringAsync` 返回 `{shouldReEncrypt, result}`，平台密钥轮换时用新密文重存。
- **WAN 速率**：UPnP 计数器 ≥2 个样本才出 bps；计数器回绕（路由器重启）→ 丢弃样本返回 null。
- **统一发布链路**：`RouterManager.publish()` 递增状态时间戳，通过主进程回调同时推送 `router:status` 并调用 `engine.applyRouterHints`；有效名称变化立即生成设备快照，不另存一份主进程名称缓存。
- **会话正交性**：ubus、web 与 Basic 是独立事实；展示优先级为 ubus > web > basic，web 会话不点亮 OpenWrt 能力。一个通道登录失败不清掉另一个仍有效的会话；退出操作清全部通道。web 的独立修订不会取消在飞的 ubus 登录，也不会吞掉 ubus 的失效结果。
- **历史真机记录（本机网关 192.168.2.1）**：曾观测到管理页 302 落点 `/view/admin_login/tologin.html`、无 UPnP IGD、非 OpenWrt。该记录仅说明当时环境的探测结果，不代表本轮租约解析已在该固件验证成功。

以下第 10.3～10.8 节为历史变更记录，测试数量是当时快照；其中告警已移除（第 10.6 节），旧路由器数据卡和联动界面不再保留。当前租约、安全与验证规则见第 10.9～11 节。

### 10.3 task-024 增补（历史：打印与路由器页面功能增强）

- **UPnP GetStatusInfo**：`upnpQuery` 在流量计数器之后追加 GetStatusInfo——`NewConnectionStatus`/`NewUptime` 进 `wan.connectionStatus`/`wan.uptimeSec`；固件不支持该 action（HTTP 501 等）→ 两字段保持 null（不填 0）。
- **iwinfo 无线频段状态**：登录成功后第 4 个 ubus 调用 `iwinfo devices` → 逐设备（**最多 4 个**，防超时膨胀）`iwinfo info` → `wirelessStatus: WirelessBandStatus[]`（设备名/SSID/信道/关联客户端数）。语义三分：列表成功但空 = `[]`（无射频）；列表失败/未装 `rpcd-mod-iwinfo`（-32000）= `null` + capabilityNotes 说明——两种"空"不混用。解析器（`parseIwinfoDevices`/`parseIwinfoInfo`）为纯函数。
- **Basic-Auth 通用登录**：ubus 登录失败时若管理页给出 Basic 质询，账密经 `Authorization` 头 GET 验证一次，200 即 `kind='basic'` **进程内粘性**（`basicAuthOk`/`basicUser`，不存明文密码、不逐轮重验）；与 ubus/web 会话正交，合成优先级 ubus > web > basic；logout 全通道清除。**只看状态码不解析页面内容**——basic 会话不提供任何 ubus 数据（DHCP/无线卡在 basic 会话下展示引导文案，不硬凑）。`caps.openwrt` 不因 basic 会话置位（能力与会话正交）。
- **401 质询的 reachable 语义**：`detect.ts` 探测到 `401 + WWW-Authenticate: Basic` → `reachable:true`（网络层可达，内置浏览器可打开、Chromium 原生弹凭据框）但 `brand:null`——看不到正文不做指纹，且编排层不覆盖既有品牌；Digest 等非 Basic 质询 → `auth:null`，不猜。
- **login 返回值与状态一致（t8 测试抓到的真实 bug）**：登录失败分支原实现把组合后的"Basic 认证失败：…"写进 `status.session.error`，但 `return res` 带回的仍是 ubus 结果（"用户名或密码错误"）——UI 读返回值就显示错文案。修复后返回 `{ok:false, error: failError}` 与 status 同源。教训：**同一事实的两个出口必须说同一句话**。
- **设备联动**：RouterView 接收 `devices` 快照——DHCP 租约行按 IP、无线客户端行按 MAC 匹配设备，可点击行打开设备详情抽屉；匹配不到的行不可点击（不硬凑）。
- **WAN 流量趋势**：渲染侧 useRef 累积 60 点 rx/tx 速率序列，按 `status.ts` 去重（手动 refresh 与同轮轮询推送共享时间戳）；Sparkline 断线（null）画红点，全 null 画虚线基准。UPnP 计数器需 ≥2 次采样才出速率，UI 如实提示"等待速率样本"。
- **测试面扩展（+30 用例）**：`print-ops.test.ts`（转义/校验/cmdlet 映射/rundll32 args/CIM 返回码）；`router-upnp` GetStatusInfo 四态；`router-openwrt` iwinfo 解析防御；`router-manager` Basic-Auth 登录四投影（成功不编数据/401 文案以 Basic 为准/无质询不降级/logout 全通道清除）；`router-detect` 401 Basic 质询与 Digest 反例。

### 10.4 task-025（局域网运维功能与联动机制完善）

- **链路审计结论**：6 条主链路（快照推送/告警联动/打印操作/路由器采集/诊断中心/持久化）全通；唯一断点是设备详情抽屉只在打开时取一次 `getDeviceDetail`，端口/连接/RTT 历史冻结——已改为打开期间每 5s 重取（轮询失败保留旧数据，仅首次加载失败置错误）。
- **持续 Ping 监控（`engine/watch.ts`）**：`WatchManager` 每 5s 对目标 ICMP 探测，环形窗口 60 点；宕机/恢复经 `AlarmEngine.ingestExternal/ingestResolve` 注入 WATCH_DOWN（critical）告警，复用既有去重/冷静期/抑制窗口语义并走完整告警链路（推送/Webhook/确认）。`tickInFlight` 闸门防重入；目标持久化于 JsonStore 与 Sqlite v2 `watch_targets`（同构）。无样本诚实 `unknown`，不猜在线。
- **WOL 网络唤醒（`engine/wol.ts`）**：Magic Packet（6×0xFF + 16×MAC = 102 字节）UDP 广播至 255.255.255.255 端口 9+7 各一次。数据诚实边界：发送成功只承诺"包已发出"；本机/网关/跨网段/未知 MAC/`sim-` 演示设备直接拒绝并说明原因。
- **告警 Webhook（`engine/notify/webhook.ts`）**：告警产生/恢复时 `postWebhook` POST JSON（node:http/https，5s 超时，消费响应体）；服务端返回 2xx 才算送达，非 2xx 如实回传 status；URL 留空停用；失败进 netlog 不静默。设置页可保存 URL 并发送测试。
- **自定义端口扫描（`engine/diag/portscan.ts`）**：TCP connect 探测，worker pool 并发 64，单次 ≤1024 端口（1-65535 内），`validateDiagTarget` 白名单校验。诊断中心新增端口扫描卡（起止端口预填 1-1024）。
- **tracert 结构化（`parseTracertHopsDetailed`）**：跳数表（跳数/IP/主机名/三次延迟）；`<1 ms`→0、`*`→null（超时不伪造）；解析为空诚实降级只看原始输出（可折叠）。
- **全网带宽历史**：scheduler 带宽采样（2s）入 60 点环形历史 `system.bandwidthHistory`，失败轮入 null 点（曲线断开诚实呈现）；总览页新增 rx/tx 双曲线卡。
- **设备备注/标签**：store（Json+Sqlite v2 `device_notes/device_tags`）+ `normalizeTags`（trim/去空/去重/单个 ≤24 字符/≤8 个）；详情抽屉内联编辑，设备列表支持标签筛选 chips、备注图标、快照搜索覆盖 note/tags。
- **设备列表增强**：行内 RTT 迷你条（复用 Sparkline，null 断点红点）；「监控」列快捷加入/移出持续监控；监控中设备显示徽标。
- **监控页（WatchesView）**：目标表（状态灯/可用率/宕机时长/最近探测/RTT 迷你曲线）+ IP/备注添加表单（datalist 联想设备）+ 移出；宕机目标可点击跳转设备详情。
- **导出体系**：TopBar 导出改为下拉——JSON 结构化快照 / HTML 巡检报告（`engine/report-html.ts`，自包含单文件、内联 CSS、`escapeHtml` 五字符转义、空数据占位「暂无」不伪造）。
- **配置导入/导出**：`configExport`（schemaVersion:1：设置/别名/备注/标签/监控目标/打印机管理/首次发现）与 `configImport`（JSON.parse → schemaVersion 校验 → 逐键合并，非法键计入 skipped 绝不整包失败；运行时生效 setAutoScan/setPrinterSources/hydrateWatches/refreshPrinters）。设置页操作，导入后回读设置对齐 UI。
- **契约层**：`shared/channels.ts` +10 通道；`shared/types.ts` 新增 TracertHop/PortScanResult/BandwidthPoint/WatchTarget/WatchSample/WatchStatus，Device 加 `note/tags`，AppSettings 加 `notifyWebhookUrl`，Snapshot 加 `watches`；preload 全量暴露。
- **验证**：新增 `tests/task025-lan-ops.test.ts` 26 用例（WOL 字节级/WatchManager 窗口与变迁/端口扫描真监听/HTML 转义/Webhook 真 server/tracert 解析/ingestExternal 语义/JsonStore 往返）；全量 636 用例通过；node+web 双 typecheck 通过；`src/main/engine` electron 引用恒 0。

### 10.5 task-026 实时动态监控（自动刷新/自动扫描 → 实时化）

- **心跳真实时化（`scheduler.ts` heartbeat 重写）**：每 5s 一次"准实时"观测轮——① `arp -a` 建立在位视图；② 三集合去重合并单次 pingSweep：缺席确认（streak 降序 ≤32）∪ 在线全量（轮转 ≤112）∪ 未知 IP 滚动发现（`unknownCursor` 在 254 地址上轮转 ≤64/轮，新设备 ≈4 轮 ≈20s 内必被探到）；③ 未知 IP ping 中即时 `ensureRecord` 建册（进入快照与 DEVICE_NEW 告警）。最坏 208 目标 @64 并发 ≈2.4s < 5s 周期（`HEARTBEAT_PROBE` 常量约束）。
- **早推帧**：`mergeArp` 返回新建记录数，>0 时调用方**立即 emitSnapshot**——新设备从"ARP 冒头/被 ping 中"到 UI 可见 <100ms，不必等扫描/下一周期结束（心跳、扫描 phaseInitialArp 两处均生效）。
- **离线判定加速**：`ALARM_THRESHOLDS.offlineArpMisses` 3→4，语义升级为"连续 4 个**缺席观测轮**"——心跳（5s）与扫描轮**统一推进**同一账本，≈20s 判离（原最快 3×15s=45s，实际依赖扫描轮更慢）。配套防误判三件套：心跳开头 ICMP 存活全量归零（防陈旧 pingAlive 粘滞）；缺席设备的陈旧 `portResponded` 同步失效（TCP 回包前提是 ARP 在位，否则打印机被旧端口证据钉死在线）；ARP 读失败的一轮不算观测、不推进缺席（沿用上一轮视图，与扫描 phaseInitialArp 同语义）。10 分钟告警抑制窗口兜底防抖。
- **autoScan 语义变更（UI 命名）**：「自动扫描」→「实时监控」：开 = 心跳 + 深度扫描全量运行；关 = 心跳早退 + 扫描停 → 设备状态冻结（TopBar/StatusBar/设置页/托盘菜单全链路文案更新，TopBar 新增脉冲 live-dot 与"实时监控中/已暂停"状态）。带宽/打印机/质量/持续 Ping 不受影响（R-04）。
- **数据诚实边界不变**：状态判定仍以 ARP 在位为主信号，ICMP 超时绝不判离线；缺席计数只由真实观测推进；暂停即冻结、如实呈现"暂停"而非装作在线。
- **验证**：全量 643 用例通过（R-06 离线判定改 4 轮口径 + 新增实时化用例：未知滚动发现/新设备早推帧/扫描早推帧/暂停冻结语义）；顺带修复测试基建两处真实网络泄漏——`netbios`（nbtstat spawn）与 IPP 耗材查询（`http.request`）此前未被 mock，其 `setTimeout` 超时守卫在 fake timers 下永不触发，设备一旦持有 9100/631 端口即真实连网挂死（scheduler-resilience 定向耗时 223s → 1.7s）；node+web 双 typecheck 通过；`src/main/engine` electron 引用恒 0。

### 10.6 告警功能移除（2026-10-26）

- **移除范围**：告警引擎（`engine/alarms.ts`，7 规则/去重/恢复/抑制）与全部下游——告警视图（AlarmsView）与侧边栏入口、总览活跃告警 KPI 与 timeline、桌面通知、托盘角标、Webhook 推送（`engine/notify/webhook.ts`）、告警持久化（JsonStore `alarms`/`knownDeviceKeys` 字段）、`ackAlarm/alarmsClear/webhookTest/alarm` 四条 IPC 通道、设置项 `notifyDesktop`/`notifyWebhookUrl`、HTML 报告告警节。
- **保留并独立**：① 持续 Ping 监控（`watch.ts` 变迁改为 `onTransition → emitSnapshotNow` 即时重推快照，宕机在监控页以状态标示）；② 设备离线判定（缺席阈值迁至 `HEARTBEAT_PROBE.offlineArpMisses=4`，`resolveLinkState` 语义不变）；③ IP 冲突检测（`arp.ts` `collectArpConflicts` 纯函数 + `ipConflict` 徽标，独立于告警引擎）；④ warnings 降级信息；⑤ `firstSeen` 持久化；⑥ 打印机 `state='error'` 如实展示。
- **迁移**：Sqlite `user_version` 追加 v3——DROP `alarms`/`known_device_keys` 及两个索引；v3 会删除旧告警及已知设备键数据；重建空表不等于恢复历史记录，也不保证旧版本可直接回滚。旧版 `svesc-state.json` 中的遗留告警字段导入时整体忽略。
- **验证**：全量 557 用例通过；node+web 双 typecheck 通过；`src/main/engine` electron 引用恒 0；engine-check 全量断言 PASS；`src/` 仅 `db/migrations.ts` 保留 5 处告警字样（v1 建表供回滚 + v3 DROP 说明，有意保留）。

### 10.7 task-027 设备识别引擎增强（2026-10-26）

实测背景：engine-check 12 台设备 10 台 unknown——识别管线证据面不足。四个方向组合增强，全部为"设备自报或确定性推断"，不引入猜测性规则：

- **自报数据深挖**：SSDP 描述页新增 DigitalSecurityCamera → camera、Printer → printer（UPnP 标准设备类，聚合优先级 camera > printer > ap > router > iot），并提取 friendlyName 作 displayName 第三候补（`hostname ?? mDNS 名 ?? SSDP friendlyName`）；mDNS 服务表 17 → 21（`_miio` 小米生态 → iot、`_ipp-tls/_uscan/_uscans` 扫描 → printer）。
- **HTTP 管理页指纹（新模块 `discovery/http-fingerprint.ts`）**：对已探明 80/8080 开放的候选 ≤6 台/轮轮转 GET `/`，解析 title/Server 头。分类铁律：**关键词恰好命中 1 类才定 kind**（≥2 类同时命中即放弃），title 原文永远兜底 osHint；传输层可注入，失败静默。管线位置：自报层（2.8）与端口信号之间，title 原文兜底在 TTL 弱提示之前（7.5）。
- **OUI 类型知识库**：fingerprint 新增两个确定性类别表——TV_VENDORS（TCL/海信/创维/酷开/长虹/Roku → iot）、PC_VENDORS（Intel/戴尔/联想/微软/宏碁/微星/技嘉/华擎/超微/富士通 → workstation，需"无管理端口"反证守卫）；Realtek 这类跨设备类芯片厂商刻意不进表。
- **主机名词根扩充**：电视/机顶盒/游戏主机词根（androidtv/mitv/bravia/chromecast/xbox/shield/国产电视品牌…）判在手机词根之前（'androidtv' 含 'android'）；小米电视靠 `xiaomi-tv` 词根与手机 OUI 区分。
- **端口/覆盖扩充**：PROBE_PORTS 16 → 22 端口（+548 AFP/1883 MQTT/5900 VNC/8009 Chromecast/8554 RTSP 备/32400 Plex；其中 8009→iot、8554→camera、32400→server 定 kind，其余只做端口标注）；NBTSTAT_MAX_HOSTS 8 → 16 且并发 4 → 16（并发=上限，单波完成，最坏墙钟 2s 不劣化，hostnames 2.6s 旅标实测 2093ms PASS）。
- **scheduler 接线**：augmentDeviceIdentity 四路并行 → 五路（新增 HTTP 探针轮转游标 `httpCursor`）；buildDevices 指纹输入增加 `httpKind/httpOsHint`。
- **验证**：全量 599 用例通过（+42）；node+web 双 typecheck 通过；engine-check 全 PASS（扫描 4850ms / hostnames 2093ms）；db-check 通过。

### 10.8 task-028 五大生态识别扩充（2026-10-26）

在 task-027 组合基础上按生态线继续扩充识别表，原则不变：只收无歧义厂商/词根，双料厂商靠反证守卫与词根顺序纠偏：

- **手机生态**：PHONE_VENDORS 补 meizu/zte/nubia/hmd/nothing/fairphone/iqoo；主机名补 moto-/redmagic/nubia/iqoo。ZTE 双料风险（光猫）由"非网关 + 无管理端口"守卫承接（光猫几乎必开 80）。
- **无线AP生态**：新增 AP_VENDORS 专业 AP 厂商表（ruckus/engenius/openmesh/wavlink/comfast/cambium → ap）；主机名补 unifi/wavlink/comfast/ruckus/engenius/edimax/airport；mDNS 新增 `_airport/_ubnt` → ap（mdnsKind 联合类型加 'ap'，聚合 rank=3.5，编译器强制同步）；NETWORK_VENDORS 补 linksys/mercury/netcore/netis/edimax/belkin/cudy/gl.inet/jcg。Meraki 刻意不进表（MS 交换机/MX 路由器同名）；UniFi 交换机名（sw+数字）由更早的 switch 词根接住。
- **监控摄像头生态**：CAMERA_VENDORS 补 foscam/reolink/amcrest/vivotek/lorex/swann/hanwha/pelco/avigilon；主机名补对应品牌词 + `\bv380\b`；PROBE_PORTS 新增 34567（雄迈/大华系 DVR）、9527（雄迈系 Web）→ camera；HTTP 指纹补 dvr/foscam/reolink/amcrest/vivotek/hanwha/pelco。
- **电脑主板生态**：PC 整机系列词根入主机名通道（ideapad/thinkbook/legion/latitude/vostro/inspiron/alienware/elitebook/probook/pavilion/spectre/vivobook/zenbook/clevo + \bomen|tuf|yoga\b + \bnuc(?:[-_ ]?\d+)?\b）。顺带修复：server 词根 `dc\d|ad\d` 改 `\bdc[-_]?\d|\bad[-_]?\d`（'IDEAPAD5' 原会误中 `ad5` 判 server）。
- **路由器生态**：主机名补 miwifi/hiwifi/newifi/gl-inet/cudy/linksys/asuswrt/padavan + `\brt-(?:ax|ac|n|be)\d`（华硕 RT-AX88U 式命名）；HTTP 指纹补 asuswrt/padavan/gl-inet/cudy/linksys，IoT 补 tuya。
- **验证**：全量 615 用例通过（+16）；node+web 双 typecheck 通过；engine-check 全 PASS。

### 10.9 协议独立发现与身份关联（当前实现）

- `runFullScan` 初读 ARP 后立即启动 mDNS / SSDP / WS-Discovery，与 ping 扫描并行；没有 ARP 或 ICMP 候选也不跳过协议发现。
- `mergeDiscoveryHints` 只接收 `cfg.hosts` 内地址，复核扫描截止与 `acceptingIdentity`。合法协议回包可以建册、更新该次观测时间并提前推帧，但不设置 `pingAlive` / `portResponded`，也不注入质量采样。
- 协议发现地址参加后续候选探测；已读 ARP 地址可进行 WS-Discovery 定向补探，整轮预算仍为 10 秒。扫描结束后的协议结果不得写回已关闭的轮次。
- `printers/mdns.ts` 在完整 DNS 报文中解引用压缩 PTR / SRV，单次查询窗口内按实例关联 PTR、SRV、A、TXT。A 可早于 SRV，型号可后到；地址来自 SRV target 对应的 A 记录，不使用 UDP 来源地址冒充设备地址。
- TXT 型号读取优先级为 `model` > `md` > `ty`。设备类型由服务或明确型号提供；同类提示优先保留型号，Apple 共享服务只作为生态佐证。
- 服务与端口集合分别由 `MDNS_QUERY_SERVICES` / `PROBE_PORTS` 定义；新增的 135 / 139 端口作为 Windows 身份证据，不代表所有回应设备都可确定操作系统版本。

### 10.10 双通道租约与实时名称投影（当前实现）

**规范化入口：`router/leases.ts`**

- `normalizeLeaseMac` 接受完整连续、冒号、连字符、Cisco 点分格式，统一为小写连字符格式；拒绝不完整或分隔符混杂的输入。
- `normalizeLeaseHostname` 拒绝控制字符、空值、超过 253 字符及 `unknown` / `*` / `n/a` 等占位值，不生成名称。
- `normalizeDhcpLeases` 校验 IPv4、租期，复制输入，以 MAC + IP 去重；同来源重复项中两个不同非空名称冲突时置空，排序后最多保留 512 条。
- `expiresAt: null` 表示未知或无限，不等同于已过期。ubus 的 `expires=-1`、缺失或 null 保持此语义；零剩余时间视为已到期，其他非法租期不采纳。

**合并与回填**

- `RouterManager` 独立维护 `ubusLeases` / `webLeases`，只合并当前有效会话的数据。ubus 租约优先；同 MAC + IP 且 ubus 缺名时可用 web 补名，web 仅补入 ubus 未出现的 MAC。
- `Scheduler.setRouterHints` 每轮更新复制后的租期，但只在当下有效的名称投影变化时返回 true，避免排序变化、格式差异或仅续租制造额外推送。
- `leaseHostnameFor` 在每次快照组装时复查租期，并要求 MAC + 当前 IP 一致。`rec.hostname ?? leaseHostname` 供显示与指纹使用；最终用户别名仍覆盖显示名。
- 租约只作名称提示，不创建设备、不修改原始 hostname、lastSeen、ping/TCP 证据或在线判断。名称到期后在后续投影中消失，不靠历史租约给离线设备续命。

**刷新与失败语义**

- 默认 10 秒轮询，管理页探测限频 60 秒。UPnP、ubus 调用与管理页租约尽量并行；租约/会话先推帧，不等待 WAN 完成。提前帧保留上轮 UPnP 能力证据，最终帧重新过滤到期租约。
- 相同核心会话与 web 修订共享在飞 refresh；仅 web 修订改变时等待旧轮后补刷。新认证或网关改变可立即新开一轮，不被旧 WAN 等待阻塞；旧 Promise 的清理不得清除新一轮引用。
- `generation`、`webGeneration` 与 `loginAttempt` 分别约束核心会话、管理页会话和并发登录。每个异步边界复核有效性，防止退出、换网关或新登录后恢复旧数据。
- ubus 调用路径 `-32002` 才作废会话；网络错误、HTTP 错误或单对象 ACL 拒绝不当作登出。失效后清 ubus 租约和无线/系统数据，web 通道可独立保留。
- 管理页失败清掉本通道旧租约，并按 10 / 20 / 40 / 60 秒退避；成功或新 web 会话重置，不永久禁用。Cookie 活跃会话在轮询前复查；退出后不靠残留 Cookie 在后台自动复活。

**管理页实验通道**

- 总预算 6000ms，覆盖 Cookie 获取、候选页与 Host 重试；单个外部操作最多 1200ms，最多 6 个按品牌过滤且按路径去重的候选。
- 只借用同网关管理地址的 HTTP / HTTPS 协议与端口。仅识别为 TP-LINK 时允许 `tplogin.cn` Host 重试，Cookie 也必须重新按该 URL 获取，不复用网关 Cookie。
- Cookie provider 超时后停止该轮，迟到结果不启动传输；实际发送前再次检查取消条件。
- HTML 表头只作用于当前表；无列定义时保守取名。JS 仅解析纯字符串数组，禁止执行脚本、表达式或模板插值；登录页和无法识别的空表返回失败说明，不能视为成功的空租约集。

### 10.11 Cookie 与异步凭据边界（当前实现）

- `router-browser.ts` 将管理页放在 `persist:router-admin` 分区，与应用默认会话及打印机分区分离。`router-admin-gateway.json` 只记录网关地址；缺失、损坏或地址改变时先清旧 Cookie，首次升级可能要求重新登录。
- `getRouterAdminCookieHeader(url)` 委托 Electron 按 URL 的 domain / path / secure 规则筛选 Cookie。清理开始同步推进 `cookieRevision`；在飞读取完成后修订不一致则丢弃。
- 清理中或清理失败时，既禁止后台获取 Cookie，也通过分区 `webRequest.onBeforeRequest` 阻止原生 webview 请求，避免仅保护程序调用而漏掉 Chromium 自动携带 Cookie 的路径。
- 网关绑定只针对管理页 Cookie 的地址关联，不是硬件身份认证，也不代表 ubus 保存账号已按网关分库存储。只应在可信、已授权的管理网络使用保存登录功能。
- `router-store.ts` 使用异步 `safeStorage` 加密密码，存储结构仍为用户名与 base64 密文。`operationRevision` 在保存/清理时同步变更；每个 await 后与写盘前复核修订，IPC 另校验会话修订及“记住密码”开关。
- 密钥轮换沿用原 load 修订，不抢占新保存；退出或新保存后迟到的解密结果不能覆盖状态。底层异常返回通用错误，不把可能包含凭据的异常直接交给 UI。
- 已启用记住密码时，ubus 失效可按退避自动重登；提供者每次现读密文，连续三次失败停止自动重试，手动登录可重置。退出、停止轮询或会话变化时丢弃在飞的旧操作。

## 11. 开发、打包与验证范围

命令来源为 [package.json](package.json)，使用方法见 [README.md](README.md)：

| 目的 | 命令 | 边界 |
|---|---|---|
| 安装 | `npm ci` | 使用锁文件；需下载 Electron 二进制 |
| 启动 | `npm start` | 先构建再启动，不是热更新；当前无 dev 脚本 |
| 自动化测试 | `npm test` | Vitest 单元与本地集成测试；包含回环 TCP/HTTP 服务，不代表真机兼容认证 |
| 类型检查 | `npm run typecheck` 和 `npx tsc --noEmit -p tsconfig.web.json` | 分别检查主进程/Node 与渲染器 |
| 真实采集 | `npm run engine-check` / `npm run soak` / `npm run smoke` | 会执行真实采集或启动 Electron，须确认网络授权 |
| 打包 | `npm run dist -- --config.directories.output=<全新目录>` | 构建 NSIS + portable Windows x64，`--publish never` 不上传 |

`electron-builder.yml` 将 dist 与 package.json 放入 ASAR，额外复制运行时图标；NSIS 单独使用 `build/setup-icon.ico`，应用/便携版/卸载器仍使用应用图标。重打包使用全新输出目录，避免旧 ASAR 清理限制；当前未配置代码签名证书。

**租约增强验证基线（代码提交 `7e0cf25`）**：38 个测试文件、892 项测试通过；主进程、渲染器与修改测试的类型检查通过，production build 通过。安装版/便携版包内的 6 个 dist 文件及 3 个额外资源已与本地构建校验一致，包内版本为 0.4.0。

**状态历史 / 异常提醒 / 组件测试（2026-10-29）**：全量 43 个测试文件、1149 项测试通过；主进程与渲染器类型检查、production build 通过；Electron 冒烟检查启动正常（15 台设备、5 台打印机、0 问题）。组件测试运行于 jsdom，不代表安装包内 UI 或真实打印机行为已验证。

**未验证项**：该轮没有登录真实路由器，也没有安装发行包后测试 UI。不得将自动化测试或旧真机记录写成所有管理页固件均兼容。

**发布边界**：源码同步到 GitHub/Gitee 不会自动发布安装包。Release 应指向明确提交，先上传草稿并核验附件大小与 SHA256，再公开；同内部版本的增强构建应使用不冲突的标签，不能移动旧标签或覆盖旧附件。下载是否可用以公开 Release 状态为准。
