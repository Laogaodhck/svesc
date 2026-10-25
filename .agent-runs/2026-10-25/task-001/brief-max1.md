# Brief — 实现工程师 Max-1（task-001 / P2a）

| 字段 | 值 |
|---|---|
| `role_name` | lan-engine-implementer |
| `mission` | 交付可构建、可启动的 Electron 应用骨架与全部探测引擎（discovery / printers / network / 调度 / 告警 / 持久化 / 模拟源 / IPC / 预加载 / 冒烟脚本）。 |
| `when_to_use` | 这是全项目唯一的原生能力层与骨架，UI 与测试都依赖它先落地契约文件。 |
| `input_files` | `.agent-runs/2026-10-25/task-001/plan.md`（**第 5 节契约为准**）、`.agent-runs/2026-10-25/task-001/investigation-report.md`（Vera 实测结论，解析规则直接照用） |
| `allowed_edit_scope` | `package.json`、`.npmrc`、`tsconfig*.json`、`vite.config.ts`、`vitest.config.ts`、`.gitignore`、`ARCHITECTURE.md`、`src/shared/**`、`src/main/**`、`scripts/**` |
| `forbidden_actions` | 不得创建/修改 `src/renderer/**`（Max-2 的领地）；不得修改 `tests/**`（Tess 的领地）；不得修改 `.agent-runs/**/plan.md`；不得引入任何需要 node-gyp 编译的依赖；不得使用网络请求访问外网取数据；不得在引擎层 `import electron`（引擎必须能在纯 node 下被 vitest 直接测） |
| `tools_policy` | 可编辑上述文件；可 `npm install`；可运行 build/test/命令；可启动 Electron |
| `output_path` | `.agent-runs/2026-10-25/task-001/implementation-report.md` |
| `success_criteria` | 见文末"验收自查"8 条，逐条 PASS/FAIL |
| `stop_condition` | 依赖安装连续失败 2 次且镜像无效 → BLOCKED；发现必须改 `src/renderer/**` 才能完成 → BLOCKED 说明 |
| `handoff_format` | STATUS 块 ≤20 行 |
| `max_iterations` | 2 |

---

## 1. 技术栈（已定，不得更换）

Node 22 / Electron 45 / React 19 / TypeScript 5 / Vite 7 / Vitest 3 / esbuild。
**零原生依赖**：不要 better-sqlite3、不要 node-snmp、不要 node-ping、不要 serialport。

`package.json` scripts：
```
build : vite build && esbuild src/main/index.ts --bundle --platform=node --format=cjs --external:electron --outfile=dist/main/index.cjs && esbuild src/main/preload.ts --bundle --platform=node --format=cjs --external:electron --outfile=dist/main/preload.cjs
test  : vitest run
start : npm run build && electron .
smoke : npm run build && node scripts/smoke.mjs
```
- `main` 字段指向 `dist/main/index.cjs`。
- Vite：`root: 'src/renderer'`、`base: './'`、`build.outDir: '../../dist/renderer'`、`emptyOutDir: true`、react 插件。
- 渲染层用 `win.loadFile('dist/renderer/index.html')` 加载（不能依赖 dev server）。
- 写 `.npmrc`：`electron_mirror=https://npmmirror.com/mirrors/electron/`（已实测 GitHub 与 npmmirror 均 200，双保险）。
- 装依赖耗时可能 3-8 分钟，用后台任务跑，**不要中途判定失败**；electron postinstall 失败时改用镜像重装一次。

## 2. 目录（严格按此，不得自创）

```
src/shared/types.ts       # 严格照抄 plan.md 第 5 节，字段名/联合类型一个字都不许改
src/shared/channels.ts    # 通道常量
src/shared/constants.ts   # 端口表、阈值、OUI 表容量等
src/main/index.ts         # 生命周期、窗口、SMOKE 模式
src/main/ipc.ts           # invoke/event 路由
src/main/preload.ts       # contextBridge → window.lanApi
src/main/engine/discovery/subnet.ts | ping.ts | arp.ts | ports.ts | oui.ts | fingerprint.ts | index.ts
src/main/engine/network/quality.ts | bandwidth.ts | monitor.ts
src/main/engine/printers/snmp-ber.ts | snmp-client.ts | printer-mib.ts | spooler.ts | printer-service.ts | mdns.ts
src/main/engine/alarms.ts | scheduler.ts | simulator.ts | store.ts
scripts/smoke.mjs
ARCHITECTURE.md
```

## 3. 引擎硬性技术要求

**分层铁律**：`src/main/engine/**` 下任何文件**禁止 `import electron`**。引擎只吃注入的配置与回调，由 `index.ts` 组装。这是为了让 Tess 能用 vitest 直接测引擎。

### discovery
- `subnet.ts`：从 `os.networkInterfaces()` 取 IPv4 非 internal；排除名称含 `vEthernet`/`Loopback`/`WSL`、IP 为 `169.254.*` 的接口；有默认路由的优先。**按 /24 计算**并发上限（254 地址），输出 `{ iface, cidr, hosts[] }`。
- `ping.ts`：`spawn('ping', ['-n','1','-w',String(timeout), ip])`，`windowsHide:true`。**必须按 Vera 报告的方式解码中文输出**（Buffer → utf8 失败回退 `new TextDecoder('gbk')`）。解析 `TTL=(\d+)` 判活，`时间[=<](\d+)ms` 取 RTT（`<1ms` 记 1）。绝不因解析失败抛异常，返回 `{alive:false}` 并计数 `parseWarning`。
- `arp.ts`：优先 `Get-NetNeighbor`（JSON），失败回退 `arp -a` 文本解析；双 locale 正则（`动态|dynamic`、MAC 支持 `-` 与 `:`）。返回 `Map<ip,{mac,iface}>`。
- `ports.ts`：`net.connect` + 350ms 超时 + 并发池（默认 24），端口集 `[22,80,443,445,515,631,9100,3389,554,62078]`。
- `oui.ts`：内置 ≥60 条常见 OUI 前缀表（HP/Canon/Epson/Brother/Xerox/Ricoh/Kyocera/Lexmark/Samsung/Apple/Intel/Dell/Lenovo/TP-Link/Xiaomi/Huawei/Realtek/ASUS/Netgear/Microsoft…），`normalizeMac()` 兼容三种分隔符，`lookupVendor()` 前缀匹配不中返回 `null`（**不许猜**）。
- `fingerprint.ts`：TTL ≥200 → 网络设备/打印机固件；128 附近 → Windows；64 → Linux/Unix；64 且有 62078 → iOS；有 9100/631/515 → printer；有 445 → workstation。返回 `{osHint, kind}`，两者都可为 `null`/`'unknown'`。

### network
- `quality.ts`：**纯函数，公式冻结**（Tess 会按此写断言）：
  ```
  latencyMs, jitterMs, packetLossPct(0-100), samples
  if samples < 2 → score 0, grade 'unknown'
  latPen    = clamp((latencyMs - 20) / 1.5, 0, 60)      // latencyMs 为 null 时按 100 处理 → latPen = (100-20)/1.5 = 53.33 → score 47 / grade 'poor'
  lossPen   = clamp(packetLossPct * 1.5, 0, 60)
  jitterPen = clamp(jitterMs / 3, 0, 20)
  score     = round(clamp(100 - latPen - lossPen - jitterPen, 0, 100))
  grade     : >=85 excellent | >=70 good | >=50 fair | else poor
  ```
- `monitor.ts`：每设备滑动窗口（最近 20 次探测）算 loss/jitter；`rttHistory` 保留最近 60 点。
- `bandwidth.ts`：2s 采样网卡计数器 delta 得全网 rx/tx bps（`Get-NetAdapterStatistics` JSON，回退 `netstat -e`）；再取 `Get-NetTCPConnection` 按远端 IP 聚合连接数，`device.bandwidth.rxBps = 全网rx * (设备连接数/总连接数)`，`estimated:true`，`share` 为占比。总连接为 0 时全 0。**必须在 UI 与文档里标注为估算**。

### printers
- `snmp-ber.ts`：手写 BER —— `encodeLength/decodeLength/encodeInteger/encodeOctetString/encodeOid/decodeTlv/walkTlv`。支持 SNMPv2c GET 与 GETNEXT，`community` 默认 `public`。
- `printer-mib.ts`：OID 常量表 + 解析（sysDescr/sysName、hrDeviceStatus(1.3.6.1.2.1.25.3.2.1.5)、prtMarkerLifeCount(1.3.6.1.2.1.43.10.2.1.4)、supplies 表 43.11.1.1.6/8/9 walk、prtAlertDescription 43.18.1.1.8、面板文本 43.16.5.1.2）。耗材颜色由 description 文本推断（black/cyan/magenta/yellow/drum/waste），`maxCapacity` 为 -2/-3 等负数时按 RFC 语义视为"未知/无限"，`levelPct` 置 `null`。
- `spooler.ts`：一次性 PowerShell 取 `Get-Printer` + `Get-PrintJob`（`ConvertTo-Json -Compress`，强制 UTF8 输出编码）；失败自动回退 `Get-CimInstance Win32_Printer` / `Win32_PrintJob`；再失败返回空数组 + `error` 字段。
- `printer-service.ts`：合并三源（spooler 本机队列 + SNMP 网络设备 + mDNS 发现），按 IP 或名称关联；`source` 标注 `snmp|spooler|both|simulated`；`state` 映射：Normal→idle、Printing→printing、Error/Offline→error/offline、Warning→warning。
- `mdns.ts`：可选增强，dgram 组播 `_ipp._tcp.local` / `_pdl-datastream._tcp.local`，1.5s 超时，失败静默返回空数组（禁止抛错拖垮主流程）。

### 编排
- `scheduler.ts`：分频任务表 `{ devices: 5000, bandwidth: 2000, printers: 15000, fullScan: 60000 }`；每个任务有 in-flight 守卫（上一轮没结束不叠加）；扫描分 4 相位（sweep / arp / ports / fingerprint）并上报 `ScanProgress`。
- `alarms.ts`：规则与阈值——设备连续 2 次探测无响应 → `critical` DEVICE_OFFLINE；恢复 → 自动 resolved；延迟 >150ms 或丢包 ≥20% → `warning` NET_QUALITY；耗材 ≤10% → warning SUPPLY_LOW，≤5% → critical SUPPLY_CRITICAL；打印机 error → critical PRINTER_ERROR；新设备出现 → info DEVICE_NEW。**按 `(code,targetId)` 去重**，同因不重复刷屏；历史上限 500 条。
- `store.ts`：`app.getPath('userData')/svesc-state.json`，保存别名、告警历史、设置；写入做 300ms debounce；损坏文件自动重建不崩。
- `simulator.ts`：mulberry32 种子随机，生成 12 台设备（网关/服务器/工作站/手机/IoT）+ 4 台打印机（HP/Canon/Epson/Brother 命名，含 K/C/M/Y 耗材缓慢下降、随机故障、队列任务），当真实设备 <3 台或 `LAN_DEMO=1` 时启用，`dataSource` 标 `demo`/`mixed`。
- `ipc.ts`：实现 plan.md 第 5 节全部通道；每次心跳推 `lan:snapshot`；`lan:refresh` 立即触发一轮并 1s 内返回 `{started:true}`；`lan:exportReport` 导出当前快照为 JSON 到用户下载目录并返回路径。

## 4. 主进程窗口

- 窗口 1360×880，`minWidth:1120`、`minHeight:720`，`backgroundColor:'#0b0f14'`，`titleBarStyle` 默认，隐藏菜单栏（`Menu.setApplicationMenu(null)`）。
- `webPreferences: { preload, contextIsolation:true, nodeIntegration:false, sandbox:false }`。
- `SMOKE=1` 时：等 `window.__ready` 为 true（`executeJavaScript` 轮询，最多 20s）→ 依次 `__setView('overview'|'devices'|'printers'|'alarms')` + 每视图 `capturePage()` 存 PNG → 打印快照断言 JSON → `app.quit()`。**这些截图逻辑放 `scripts/smoke.mjs` 里通过环境变量注入**，主进程只暴露必要钩子，不要把 smoke 逻辑写死在生产路径中（可用 `if (process.env.SMOKE)` 分支，但保持整洁）。

## 5. 冒烟脚本 `scripts/smoke.mjs`

- 用 `child_process.spawn` 启动 `node_modules/electron/dist/electron.exe` + 项目根，注入 `SMOKE=1`、`SMOKE_OUT=.agent-runs/2026-10-25/task-001/artifacts`。
- 输出：`overview.png`、`devices.png`、`printers.png`、`detail.png`、`alarms.png` + `snapshot.json`。
- 60s 超时退出码非 0；成功退出码 0 并打印每张图字节数与完整性判断。

## 6. ARCHITECTURE.md（用户明确要求的交付物）

必须写清楚：分层架构图（ASCII）、模块职责表、数据流（扫描→归一→告警→推送）、SNMP 手写 BER 的原因与结构、带宽估算方法与精度边界（**诚实说明是估算**）、数据来源诚实原则（拿不到就 null，不造数）、分频策略与延迟预算、降级路径（无 SNMP/无打印机/无 spooler 权限/无局域网）、扩展点（真实 ICMP raw socket、Prometheus 导出、多网段）。中文撰写，给技术负责人看。

## 7. 验收自查（逐条 PASS/FAIL 写入报告）

1. `npm install` 成功，`npm run build` 退出码 0，`dist/renderer/index.html`、`dist/main/index.cjs`、`dist/main/preload.cjs` 三件产物存在
2. `src/main/engine/**` 内 `grep -r "from 'electron'"` 结果为 0
3. `npm test` 在无测试文件时不报错（Tess 之后会加）
4. `npm start`（或 SMOKE 模式）能真实拉起窗口并成功截图，PNG > 10KB
5. 快照 JSON：`devices.length>0` 且 `printers.length>0`，每台设备 7 个必备键齐全（值可为 null）
6. 单次全量子网扫描耗时 ≤12s（报告里给实测毫秒数）
7. 主进程无未捕获异常（stderr 无 UnhandledPromiseRejection）
8. `ARCHITECTURE.md` 覆盖第 6 节全部要点

## 8. 交接给下游的必写内容（报告第 5 节）

- 给 Tess：纯函数清单（文件+导出名+预期行为），特别是 `quality.ts` 的公式签名、`snmp-ber.ts` 的编解码入口、`alarms.ts` 的去重键、`arp.ts` 的解析函数（需可注入原始文本，才能测双 locale）。
- 给 Vic：确切的启动命令、smoke 命令、artifacts 路径、已知环境限制。

---

# §9 实测修正（P1 结论 · **优先于上文任何冲突条款**）

以下每条都来自 `investigation-report.md` 的真机实测。**上文与我冲突的地方，一律以本节为准。**

## 9.1 状态判定必须是 ARP 主信号（推翻原 §3 的"连续 2 次无响应→offline"）

实测：ARP 表 53 条活跃条目，抽样 8 个仅 3 个回 ICMP（本网段大量主机禁 ICMP）。因此"ping 不通 ≠ 离线"。
**严格按 `plan.md` §5.1 的 6 级优先级实现**，其中：
- ARP 在位 → `online`（主信号）
- ARP 在位但 3 轮 ICMP 全超时 → 仍 `online`，但 `quality.grade='unknown'`、`samples=0`（UI 显示"质量未采样"）
- **只有 ARP 连续 3 轮缺席且 ping 无响应**才判 `offline`
- **禁止**为"ICMP 不可达"产生告警，否则本网段会刷 50+ 条噪音

## 9.2 编码双通道（P0，写错就全盘皆废）

原 §3 里"PowerShell 抓 arp 再解码"的做法**作废**。实测：一旦给 PowerShell 设 `[Console]::OutputEncoding=UTF8` 或 `chcp 65001`，`arp.exe`/`ping.exe` 会**回退成英文资源**，中文字面量正则全部失效；而不设则会输出 GBK 字节，用 UTF8 解就是乱码。

必须按用途分两路，各自绑定解码器：

```ts
// 路径 1：原生 exe + GB18030（arp / ping / netstat）
const decodeGbk = (b: Buffer) => new TextDecoder('gb18030', { fatal: false }).decode(b);

// 路径 2：PowerShell + UTF8 + ConvertTo-Json（打印机结构化数据）
const PS_CMD = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; <code> | ConvertTo-Json -Depth 4 -Compress';
const decodeUtf8 = (b: Buffer) => b.toString('utf8');
```

- 统一封装 `runNative(cmd: string, args: string[], enc: 'gbk'|'utf8', timeoutMs: number)`，**调用点不得自行 `.toString()`**（Vera 自己踩过：UTF8 输出被 GB18030 解 → `浠ュお缃�`=以太网）
- **禁止** `chcp 65001`；**禁止**用 PowerShell 调 arp/ping
- 硬超时强杀：`ping 1200` / `arp 2000` / `netstat 3000` / PowerShell `8000` ms；`close` 后清 timer
- 子进程全局并发上限 64（实测 64@64 = 1523ms 无瓶颈）；**PowerShell 全局单飞**（冷启动 700-900ms，并发无收益）

## 9.3 `ping -a` 从扫描路径彻底移除

实测 `ping -a` 单次 4660ms，不可达主机挂 8s+。主机名改走 `dns.reverse(ip)`：`Promise.race` 800ms 超时、并发 ≤8、结果缓存 ≥10 分钟、失败即 `null`（**不要重试**）。

## 9.4 扫描编排顺序（实测耗时账）

```
1. arp -a（83-90ms）→ 建立"在位集合"（按段头 IP 过滤到目标网段，剔除 224./239./*.255/ff-ff-ff-ff-ff-ff）
2. 254 地址 ping -n 1 -w 800 并发 64（≈6.0s）
3. 再次 arp -a → 新出现的 ARP 条目也算在线（能捞到禁 ping 但发过 ARP 的主机）
4. 端口探测只对候选设备（ARP 在位者，本机 53 台 → 40 次 connect 实测 2.8s）：9100/631/515→printer，445/3389→workstation，80/443→router/web
   ❌ 禁止 254 × 10 端口全打
5. 总预算 10s，超预算就用已得结果出快照（保证 UI 1s 内有反馈）
```

## 9.5 带宽取数改 netstat（推翻原 §3 的 Get-NetAdapterStatistics 主路径）

- **`Get-NetTCPConnection` 弃用**（890ms），改 `netstat -ano`（83ms），正则 `^\s*(TCP|UDP)\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)$`
- 聚合吞吐：`netstat -e`（103ms）取 `字节 rx tx` 两列差分 ×8 / 间隔秒数 = bps，@2s
- 每设备归集：按远端 IP 聚合连接数占比分摊，`estimated:true`
- **新增 `attributable` 字段**（见 plan.md §5.1 契约补充）：本机实测与 LAN 的 TCP 连接仅 4 条 → 绝大多数设备 `share≈0`，此时 `attributable:false`，**UI 显示"无流量归集"而不是 0.0 Kbps**（编造 0 会被当成真实测量）
- `Get-NetAdapterStatistics` 可选，@15s，仅用于"系统"面板排除 `vEthernet*` 的单卡吞吐；**不得与 netstat 混算**（实测汇总 tx 比单卡大 4 倍）

## 9.6 打印机：三源合并 + 探活覆盖（这是本模块的核心正确性）

- 主源 `Get-Printer | ConvertTo-Json`（765ms 全量），**内存过滤**；`Get-PrintJob` 单独一次（702ms）
- `Get-CimInstance Win32_Printer`（859ms）**只补 `Default` / `WorkOffline` / `DetectedErrorState`** —— `Get-Printer` 没有 Default 字段
- `Get-PrinterProperty` **不作为耗材来源**（实测 SHARP 返回空、Xerox 只有 FormTrayTable）
- **`state` 必须叠加网络探活**：对 `ip!==null` 的打印机做 TCP 9100 探活（失败退 631、515），不可达 → 覆盖为 `offline` 并产出 `PRINTER_OFFLINE` critical 告警。`192.168.2.213`(Canon MF750C) 在 spooler 里是 `Normal/Idle/WorkOffline=false` 但网络不可达 —— **这就是必须被覆盖成 offline 的假在线样本，也是本任务唯一的真实告警验收点**
- `ip` 解析：`PortName` 匹配 `^\d+\.\d+\.\d+\.\d+$` 直取；`^IP_(<ip>)$` 去前缀；`WSD-<uuid>` 无 IP → `ip:null`，再从 `Name` 里的 `(9C:93:4E:9C:6A:76)` 反查 ARP 得 IP（Xerox 已验证可行）
- 状态映射（实测值）：`Get-Printer.PrinterStatus` 0=Normal/1=Paused/2=Error/4=PaperJam/5=PaperOut/6=Offline；`Win32_Printer.PrinterStatus` 3=Idle/4=Printing/7=Offline；`WorkOffline===true` → offline
- `pageCount: null`（无来源）；耗材**无数据时返回 `[]` 且 `source:'unknown'`，绝不填 0**
- `Get-PrintJob` 空队列时 PowerShell 输出**空字符串**，`JSON.parse('')` 会炸 → 空串直接 `[]`；单条结果 JSON 是对象不是数组 → `Array.isArray(j)?j:[j]`
- `model`：`DriverName` 含 `Microsoft` 的通用驱动 → 视为 `null`（不是真实型号）
- 采集全部打印机（含 PDF/Fax 等 `virtual`），但 `connection` 必须正确标注，UI 默认隐藏 virtual

## 9.7 `osHint` 不再靠 TTL

实测只有 64/255 两个值（网关 64、SHARP 打印机 255），经典 TTL→OS 规则在本机失效（会把路由器判成 Linux）。
改为：端口优先（445→`Windows (SMB)`、22→`Linux/Unix (SSH)`、62078→`iOS`、548→`macOS`、9100/631→打印机固件）+ 主机名特征 + OUI；**TTL 只作弱提示，且不得单独用于判定 workstation/server**；拿不准就 `null`。

## 9.8 真实环境预期（不要把这些"修掉"，它们是正确行为）

| 现象 | 正确认知 |
|---|---|
| 发现 3 台网络打印机，`.170`/`.235` 在线，`.213` 离线 | 这是真实拓扑，`.213` 必须出 `PRINTER_OFFLINE` |
| 全部打印机 `consumables: []`、`levelPct` 拿不到 | SNMP 实测全 timeout，诚实的正确结果。**不要用随机数填充** |
| 大多数设备 `quality.grade='unknown'` | 禁 ICMP 主机的真实体现，`samples=0` |
| 大多数设备 `bandwidth.attributable=false` | LAN 内 TCP 连接仅 4 条的真实体现 |
| 默认打印机 = Xerox AltaLink C8055 | `Win32_Printer.Default` 实值 |

**IPP 通路暂不实现**：Vera 正在验证 631 上的 IPP `Get-Printer-Attributes` 能否拿到真实 `marker-levels`。请把耗材来源抽象成可插拔接口（`ConsumableProvider`：`snmp` | `ipp` | `spooler` | `unknown`），预留 `printers/ipp.ts` 的接入位并在 `printer-service.ts` 里按 `snmp → (预留 ipp) → unknown` 顺序调用。我拿到结论后会派第二轮增量任务，你不要自己猜 IPP 报文格式。

---

# §10 并行边界与验证方式（重要，避免你卡住）

`src/renderer/**` 由 Max-2 在**同一时间**开发，你开工时这些文件**尚不存在**。因此：

1. **不要创建任何 `src/renderer/**` 文件**（哪怕是占位 index.html）——会和 Max-2 冲突。
2. 因此 `npm run build` 里的 `vite build` 在你的阶段**一定会失败**（缺 renderer 入口），**这是预期行为，不算你的失败**。你的自验命令是这三条：
   ```bash
   npx tsc --noEmit -p tsconfig.node.json                                    # 主进程+共享+脚本类型检查
   npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --external:electron --outfile=dist/main/index.cjs
   node scripts/engine-check.mjs                                             # 纯 node 跑引擎，不需要 Electron
   ```
3. **必须新增 `scripts/engine-check.mjs`**（不在我原来的文件清单里，现在加进来）：
   - 纯 Node（`node` 直跑，不 import electron）驱动引擎跑**一轮完整扫描**：subnet → arp → ping sweep → ports → printer 采集 → 组装 Snapshot
   - 打印到 stdout：耗时分解（各阶段 ms）、`devices.length`、`printers.length`、`alarms.length`、`dataSource`
   - 把完整 Snapshot 写入 `--out` 指定路径（默认 `.agent-runs/2026-10-25/task-001/artifacts/engine-snapshot.json`）
   - 退出码：`devices.length>0 && printers.length>0` → 0，否则 1
   - 这个脚本是 Vic 在没有 GUI 情况下验证探测能力的唯一入口，也是你证明"引擎真的能扫到东西"的证据
4. `vitest.config.ts` 必须设 `passWithNoTests: true`（Tess 稍后才加测试，你此刻 `npm test` 不能因此报错）。
5. 渲染层需要的 tsconfig 请一并提供 `tsconfig.web.json`（`jsx: react-jsx`、`lib: DOM`、include `src/renderer`、`src/shared`），否则 Max-2 无法类型检查。

## 依赖安装提示

`npm install` 可能耗时 3-8 分钟（Electron 二进制约 120MB）。**用后台任务跑**，期间继续写代码，不要阻塞等待，也不要因一次超时误判失败。`.npmrc` 写 `electron_mirror=https://npmmirror.com/mirrors/electron/`（已实测该镜像 200）。


