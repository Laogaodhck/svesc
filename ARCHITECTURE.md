# SVESC 局域网监控台 · 架构设计

> 面向技术负责人。本文只描述**已经落地并实测跑通**的设计，不含未来畅想（未来项集中在第 9 节）。
> 所有耗时数字均来自本机（Windows 10 Pro 19045 / 中文 locale / 192.168.2.0/24）实测。

---

## 1. 分层架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 渲染层 Renderer（React 19 + Vite 7）                      src/renderer/**  │
│  Overview / Devices / Printers / Watches / DeviceDetail 抽屉               │
│  ▲ 只读 Snapshot，不发任何探测请求；订阅推送，2s/5s 增量重绘                 │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ contextBridge（src/main/preload.ts）
                                    │ window.lanApi：6 个 invoke + 3 个订阅
┌───────────────────────────────────┴──────────────────────────────────────┐
│ 编排层 Main（唯一允许 import electron 的层）                                │
│  index.ts   生命周期 / 窗口 / 菜单隐藏 / SMOKE 分支                          │
│  ipc.ts     6 个 invoke 路由 + 3 个推送出口                                 │
│  smoke.ts   仅 SMOKE=1 时加载的截图例程（生产路径不引用）                     │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ 纯函数 / 服务调用（无 electron）
┌───────────────────────────────────┴──────────────────────────────────────┐
│ 探测引擎 Engine（src/main/engine/**，可被 Vitest 在纯 Node 下直接导入）       │
│  discovery : subnet → arp → ping sweep → ports → oui → fingerprint        │
│  network   : quality（冻结公式） / monitor（滑窗） / bandwidth（估算）        │
│  printers  : snmp-ber → snmp-client → printer-mib / spooler → 三源合并       │
│  orchestration : scheduler（分频+相位） / watch（持续监控） / store / simulator│
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ child_process / net.Socket / dgram
┌───────────────────────────────────┴──────────────────────────────────────┐
│ 系统层 Windows                                                            │
│  ping.exe · arp.exe · netstat.exe · route.exe（GBK 解码）                  │
│  powershell.exe + Get-Printer / Win32_Printer / Get-PrintJob（UTF-8 JSON） │
│  UDP 161 (SNMPv2c) · TCP connect（9100/631/515/445/…）· UDP 5353 (mDNS)    │
└──────────────────────────────────────────────────────────────────────────┘
```

**分层铁律**：`src/main/engine/**` 内 `grep "from 'electron'"` 恒为 0。
需要 Electron 能力的两处（userData 目录、下载目录）由 `index.ts` 注入字符串路径，引擎不认识 Electron。
收益：Tess 的单元测试不需要启动 Electron；`scripts/engine-check.mjs` 能在纯 Node 下一轮跑完真实扫描。

---

## 2. 模块职责

| 文件 | 职责 | 关键约束 |
|---|---|---|
| `engine/exec.ts` | **唯一子进程出口**。`runNative(cmd,args,enc,timeoutMs)`、`runPowerShell(code)`、`parsePsJson` | 编码按调用点声明；禁止调用点自行 `toString()`；全局并发 64；PowerShell 单飞；硬超时强杀后清 timer |
| `discovery/subnet.ts` | 从 `os.networkInterfaces()` 推导 /24 网段 + 默认路由（`route print -4`） | 排除 `vEthernet/WSL/Loopback/169.254.*`；网关读不到就是 `null`，不猜 |
| `discovery/arp.ts` | `arp -a`（GBK）主路径 + `Get-NetNeighbor` 回退 | 双 locale 正则；过滤组播/广播/全零 MAC；解析空 → `[]` + `parseWarning`，不抛错 |
| `discovery/ping.ts` | `ping -n 1 -w 800` 存活与 RTT；`ping -n 4` 质量采样 | 解析失败不抛错；`<1ms` 记 0；**禁止 `ping -a`** |
| `discovery/ports.ts` | `net.connect` 探活（700ms/端口），只对候选主机 | 禁止 254×10 全打 |
| `discovery/oui.ts` | OUI 前缀表（手写主表 + `oui-extended.ts` IEEE 官方数据生成表），未命中返回 `null` | 不按概率猜厂商；`isRandomizedMac` 识别本地管理位 MAC（随机化 Wi-Fi MAC 查不到厂商属预期） |
| `discovery/oui-extended.ts` | `scripts/build-oui.mjs` 从 IEEE oui.txt 过滤白名单厂商生成（802 条/41 厂商，task-023） | 生成结果入库，原始 10MB 数据不入库；主表优先于扩充表 |
| `discovery/wsdiscovery.ts` | ONVIF WS-Discovery（UDP 3702）摄像头自报发现：Probe → ProbeMatches Types → ipc/nvr（task-023） | 只认 Types 明确写摄像头类别的响应（Windows WSD/打印不猜）；异常静默 `[]` |
| `discovery/ssdp-devices.ts` | SSDP `ssdp:all` M-SEARCH + 描述页 deviceType → router/ap/camera/printer/iot 自报发现（task-023/027）；friendlyName → displayName 候补（task-027） | MediaServer 等拿不准的不定 kind 只给 osHint；异常静默 `[]` |
| `discovery/http-fingerprint.ts` | HTTP 管理页指纹（task-027）：对已探明 80/8080 开放的候选（≤6 台/轮轮转）GET `/`，title/Server 头厂商型号关键词分类 → printer/router/camera/server/iot | **恰好命中 1 类才定 kind**（≥2 类或 0 类不猜）；title 原文兜底 osHint；传输层注入；失败静默跳过 |
| `discovery/fingerprint.ts` | 端口优先的 `kind`/`osHint` 推断：打印机端口 → Windows 管理端口 → 网关（硬事实）→ 自报层（WS-D/SSDP/mDNS/HTTP 管理页）→ 端口（含 8009 Chromecast/8554 RTSP/32400 Plex）→ 主机名（平板/电视/机顶盒/手机/PC 词根）→ OUI（手机/打印机/摄像头/NAS/IoT/电视/网络设备/PC 类别表）→ TTL 弱提示 | TTL 只作弱提示，绝不单独判 workstation/server；手机厂商 OUI 需"非网关+无管理端口"，PC 厂商 OUI 需"无管理端口"；电视厂商/PC 厂商 OUI 与 HTTP 自报的 osHint 均明示推断来源 |
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
| `printers/mdns.ts` | `_ipp/_pdl-datastream` 组播发现（可选） | 任何异常静默返回 `[]` |
| `scheduler.ts` | 分频调度、4 相位扫描、质量采样、快照组装、状态判定 | `resolveLinkState` 是纯函数；**质量窗口只由 15s `ping -n 4` 填充**，扫描/心跳的存活 ping 不写入；带宽历史环（60 点，失败轮入 null 点）与 WatchManager 挂载于此（task-025） |
| `soak.ts` | 长跑取证（真实 95s 采样，质量/降级率稳定性统计） | 纯 Node，`npm run soak` 驱动 |
| `store.ts` | JSON 持久化（别名/设置/备注/标签/监控目标/首次接入） | 目录注入；300ms debounce；损坏文件自动重建；`normalizeTags` 归一化（≤8 个/单个 ≤24 字符） |
| `db/` | SqliteStore（better-sqlite3）与 JsonStore 同构；migrations 版本管理 | v2：`device_notes/device_tags/watch_targets`（task-025）；v3：DROP `alarms`/`known_device_keys`（告警功能移除） |
| `watch.ts` | 持续 Ping 监控（task-025）：`WatchManager` 每 5s ICMP 探测目标，环形窗口 60 点 | 目标存 store（Json+Sqlite 同构）；`tickInFlight` 闸门防重入；宕机/恢复变迁经 `onTransition` 交 scheduler 即时重推快照；无样本诚实 `unknown` |
| `wol.ts` | WOL 网络唤醒（task-025）：Magic Packet（6×0xFF+16×MAC，102 字节）UDP 广播 9/7 端口 | 只承诺"包已发出"；本机/网关/跨网段/未知 MAC/演示设备诚实拒绝 |
| `diag/portscan.ts` | 自定义 TCP 端口扫描（task-025）：worker pool 并发 64，单次 ≤1024 端口 | `validateDiagTarget` 白名单校验；结果 `{ports,openPorts,durationMs}` |
| `report-html.ts` | HTML 巡检报告（task-025）：自包含单文件（内联 CSS），设备/打印机/降级三节 | `escapeHtml` 转义五字符；空数据占位「暂无」，不伪造内容 |
| `simulator.ts` | mulberry32 种子生成的 12 设备 + 4 打印机 | 与真实数据凭 `sim-` 前缀区分 |

---

## 3. 数据流

```
分频触发（2s 带宽 / 5s 心跳 / 15s 质量采样 / 15s 打印机 / 60s 全量）
        │
        ├─ 全量扫描 4 相位 ─────────────────────────────────────────────┐
        │   ① arp -a（~120ms）→ 在位集合                                │
        │   ② 254 × ping -n 1 -w 800 @并发 64（~6-8s）                   │
        │   ③ 再读 arp -a（~150ms）→ 新条目也算在线                       │
        │   ④ 端口探测（仅候选主机，~1.5s）→ 9100/631/515→printer 等       │
        │   ⑤ 反向 DNS（800ms 超时/并发 8，只等 1.5s，其余后台补齐）        │
        └───────────────────────────────────────────────────────────────┘
        │
归一化：DeviceRecord（mac/ttl/ports/hostname/miss 计数）
        │  ├─ quality = QualityTracker.quality(ip)      ← 冻结公式
        │  ├─ bandwidth = BandwidthMeter.statFor(ip)    ← 估算 + attributable
        │  └─ state = resolveLinkState(6 级优先级)      ← ARP 主信号
        ▼
快照 Snapshot（+ 演示数据合并 + 别名覆盖）
        │  onSnapshot → ipc.pushSnapshot → webContents.send('lan:snapshot')
        ▼
渲染层重绘（无轮询、无请求风暴；扫描进度单独走 lan:scanProgress）
```

**状态判定（plan.md §5.1，自上而下命中即定论）**

| 序 | 条件 | 结果 |
|---|---|---|
| 1 | `isSelf` / `isGateway` | online |
| 2 | 本轮 ARP 存在有效 MAC | online（**主信号**） |
| 3 | 任一被探测端口有响应 | online |
| 4 | ARP 在位但 ICMP 全超时 | online + `quality.grade='unknown'`（质量未采样） |
| 5 | ARP **连续 4 个观测轮**缺席且 ICMP 无响应（task-026：心跳 5s 与扫描轮**统一推进**缺席计数，≈20s 判离） | offline（**唯一**判离线路径） |
| 6 | 有 ≥8 个质量样本（2 个 `ping -n 4` 批次）且（丢包 ≥20% 或延迟 >150ms） | degraded（覆盖 1-4） |

本机实测：ARP 表 20-50 条，其中仅少数回 ICMP。若按"ping 不通即离线"，一次扫描会产出 20-30 条假离线。这就是第 5 条存在的原因。

task-026 实时化补充：心跳每 5s 对**本轮真实观测**记账——ICMP 存活先全量归零、只有本轮回包才置 true（防陈旧证据粘滞）；缺席设备的陈旧端口响应证据同步失效（TCP 回包前提是 ARP 在位）；ARP 读失败的一轮不算观测、不推进缺席（缺席必须基于真实账本）。

---

## 4. 为什么手写 SNMP BER

**动机**
1. `net-snmp` 等库需要 node-gyp 编译原生模块，在中文本地化 Windows + 企业网络环境下安装失败率高（本任务明确要求零原生依赖）。
2. SNMPv2c GET/GETNEXT 只需要 BER 的一个极小子集：`INTEGER / OCTET STRING / NULL / OID / SEQUENCE / 上下文标签 PDU`。完整实现约 300 行，可控。
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
| 全量扫描 | 60s | **~8-10s**（预算 10s 内每个阶段都受 deadline 约束） | 超预算即跳过后续阶段，用已得结果出快照 |

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
- **10s 预算对每个阶段都生效**（`SCAN_BUDGET_MS`）：`ping` 到点即把剩余主机判死；`ports` 用 `AbortController` 在剩余预算为 0 时中止；`hostnames` 只等"剩余预算"（下限 300ms）；**已过预算则整个 `arp2` 阶段跳过**（`arp1` 的在位集合已够出快照）——否则一次 `arp -a` 撞上 2s 超时线后回退的 `Get-NetNeighbor` 能把该阶段拖到 ~10s。
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
| 状态文件损坏 | JSON 解析异常 | 自动重建默认状态，不阻塞启动 |
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

## 9.5 打印管理页（新增需求）

**导航**：独立"打印管理"视图（`PrinterManageView`），三项能力：手动添加打印机、别名、忽略。配置持久化于 `JsonStore.printers`（与别名同一份 `svesc-state.json`）。

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

## 9.7 全面审计修复（2026-10-25，两路并行调查 → 10 项落地）

- **世代号（L4）**：`RouterManager.generation` 在 logout 时自增；`doRefresh` 入口捕获、写回前比对，不一致整体丢弃——堵住"logout 后在飞一轮把旧会话数据写回 status"的竞态。
- **告警收尾**：`AlarmEngine.evaluate` 对"从监控集消失的打印机"（忽略/删除/拔除）统一 resolve 活跃告警；`printersCollected` 入参区分"启动早期空列表 tick"（绝不收尾）与"真实采集结果"。
- **store 可感知性**：落盘失败 → `onWriteError` 回调 → 快照 `warnings[source=store]` + 5s 重试定时器直到恢复（恢复也通报）；损坏文件 `console.error` + alarms 逐条形状校验。
- **设备别名补通**：引擎与持久化早已支持但无通道无 UI——新增 `lan:setDeviceAlias` 通道 + 详情抽屉别名编辑行；设备（displayName）与打印机（alias 字段）共用 `store.aliases`。
- **告警交互收口**：`onAlarm` 推送被订阅（增量合并进快照）；system 告警跳总览；printer 告警滚动 + 高亮定位目标卡；ack 失败经 banner 提示。
- **诚实化清理**：状态栏硬编码"引擎 4 个任务"删除；侧边栏打印机计数恒非虚拟口径；死代码（isVirtual/currentPrinters/alarmEvaluation/counts.router）移除。
- **健壮性**：heartbeat 补 catch → warnings（此前 spawn 失败会让快照静默停更）；手动刷新在扫描进行中如实返 `started:false`；`exportReport` 附 routerStatus + printerManage。
- **M3**：`runFullScan` 抽为 5 个 phase 方法（ScanCtx 共享上下文），预算语义逐行保留，engine-check 回归 PASS。

## 10. 路由器管理模块（新增需求）**目标**：登录路由器账号密码，自动获取路由信息并进行管理——但严格遵守"能力探测 + 诚实降级"。

### 10.1 三条通道（每条独立探测，能力互不假设）

| 通道 | 协议 | 拿到什么 | 不支持时 |
|------|------|----------|----------|
| UPnP IGD | SSDP M-SEARCH → 描述 XML → SOAP（WANIPConnection） | WAN IP、累计流量计数器、**连接状态/连接时长（GetStatusInfo，task-024）**、Reboot | 标注"该路由器不提供 UPnP IGD"；不支持 GetStatusInfo 的固件两字段为 null |
| OpenWrt ubus | HTTP POST /ubus（JSON-RPC，session.login） | system board、DHCP 租约、无线客户端、**无线频段状态（iwinfo，task-024）**、reboot | 登录表单 + "登录后可查看"（404 时文案指引改用内置浏览器）；未装 rpcd-mod-iwinfo → `wirelessStatus:null` |
| HTTP 管理页 | GET :80/:8080/:443，跟随 30x（≤2 跳），品牌指纹 | 品牌/型号提示（OpenWrt/TP-Link/小米/华硕/华为/NETGEAR）+ 落点 URL（`identity.adminUrl`）；**401 Basic 质询 → `auth:'basic'`（reachable 但 brand=null，task-024）** | "品牌未识别"，绝不猜 |
| 内置浏览器登录（推荐） | 主进程 BrowserWindow（`router-browser.ts`）加载 `adminUrl`，用户在真实管理页登录 | 管理页会话（`session.kind='web'`，Cookie 关键词检测：sysauth/session/token/stok/auth…） | 无 Cookie → 不标记会话，绝不猜 |
| Basic-Auth 通用登录（task-024） | ubus 登录失败且管理页给出 `WWW-Authenticate: Basic` 质询 → 账密经 `Authorization` 头 GET 验证（HTTP 200 即通过） | 会话 `kind='basic'`（登录态展示；**不提供任何 ubus 数据**） | 无质询不降级、不发凭据 GET，沿用 ubus 错误文案 |

### 10.2 关键实现决策

- **零依赖**：node:http / node:dgram 直用，不引 xml2js/soap 库；描述 XML 与 SOAP 用正则解析（`upnp.ts` 纯函数，30 条单测覆盖）。
- **transport 注入**：`UbusClient` 的网络出口是构造参数，测试直接喂真实抓包形状的响应，不 mock 网络。
- **ubus 登录 sid**：`session.login` 必须用 32 位零 null-session（`UBUS_NULL_SESSION`）——uhttpd 的 `uh_ubus_allowed` 只接受这种 sid 调登录，发字面量 `'session'` 会被当成不存在的会话，一律 -32002（真机必然登录失败，且文案与"密码错误"无法区分）。错误码文案按路径分流：`-32002` 在登录路径是"用户名或密码错误"，在调用路径是"会话已过期或无权限，请重新登录"。
- **会话失效当场作废**：调用路径上的 -32002 是唯一"证据确凿的会话死亡"信号（同一个 sid 重试永远不会成功），且与网络超时/HTTP 错误走完全不同的分支——所以 `UbusClient.call()` 见到它即清掉缓存会话，下次调用直接 `auth-required` 短路，不再拿死 sid 发请求；网络/HTTP/权限拒绝（`result:[6]`）**不**作废会话（`sessionInvalid` 为 falsy），瞬时故障不会把用户登掉。
- **凭据安全**：明文只存在内存；落盘必须经 Electron `safeStorage.encryptStringAsync` / 读取用 `decryptStringAsync`（Windows DPAPI，与旧同步 API 同一套平台密钥库，密文跨版本兼容）。密钥环不可用 → **拒绝落盘**并如实告知，绝不降级明文（`src/main/router-store.ts`）。同步 API（`isEncryptionAvailable`/`encryptString`/`decryptString`）自 Electron 45 弃用、46 移除，故主进程只走异步路径；`decryptStringAsync` 返回 `{shouldReEncrypt, result}`，平台密钥轮换时用新密文重存。
- **WAN 速率**：UPnP 计数器 ≥2 个样本才出 bps；计数器回绕（路由器重启）→ 丢弃样本返回 null。
- **独立 IPC**：路由器状态走 `router:*` 通道 + `router:status` 推送，不污染 Snapshot 冻结契约。
- **会话正交性（404 修复的架构结论）**：ubus 会话（kind='ubus'）与管理页会话（kind='web'，Cookie 检测）是两个独立事实，合成规则"ubus 优先、web 独立存续"——ubus 登录失败不得清 web 会话，反之亦然；web 会话**不**点亮 `caps.openwrt`（Cookie 证明不了 ubus 可用，点亮就是撒谎）。DHCP/无线数据卡只在 kind='ubus' 下展示。非 OpenWrt 固件登录 ubus 拿到 HTTP 404 时，登录语境文案明确指引"改用内置浏览器登录"。
- **实测结果（本机网关 192.168.2.1）**：管理页可达（302 落点 `/view/admin_login/tologin.html` 已被 `adminUrl` 捕获）、无 UPnP IGD、非 OpenWrt（generic）——界面如实展示"该路由器不支持"，内置浏览器登录直达登录页。

### 10.3 task-024 增补（打印与路由器页面功能增强）

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
- **迁移**：Sqlite `user_version` 追加 v3——DROP `alarms`/`known_device_keys` 及两个索引；旧版本回滚时按 v1 `CREATE TABLE IF NOT EXISTS` 重建空表，无数据损失。旧版 `svesc-state.json` 中的遗留告警字段导入时整体忽略。
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
