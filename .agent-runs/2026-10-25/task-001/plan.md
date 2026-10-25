# 局域网管理桌面应用 — 执行计划

- **任务编号**：task-001（2026-10-25）
- **仓库状态**：全新空目录，非 git 仓库（greenfield，无回归风险，无需 worktree 隔离）
- **队长**：Horizon（代码小队）
- **目标**：交付一个可运行、可验证的 Windows 桌面应用 + 架构设计文档

---

## 1. 需求拆解（对应用户 6 条核心诉求）

| # | 需求 | 实现载体 | 验收方式 |
|---|---|---|---|
| R1 | 打印机在线状态/队列/墨盒/故障告警 | `engine/printers/*` + `views/PrintersView` | 快照中 `printers[]` 字段完整、耗材来源标注 |
| R2 | 终端在线/离线 + 网络质量 | `engine/network/*` + `views/DevicesView` | 有 rtt/抖动/丢包/质量分级 |
| R3 | 设备详情：IP/MAC/主机名/OS/带宽 | `engine/discovery/*` + `views/DeviceDetail` | 详情接口返回 5 项齐全 |
| R4 | 自动扫描 + 手动刷新 + 低延迟更新 | `engine/scheduler.ts` + 推送式 IPC | 默认 5s 心跳，刷新 < 1s 响应 |
| R5 | 异常可视化提醒 | `engine/alarms.ts` + `AlarmCenter` | 告警去重、可确认、可自动恢复 |
| R6 | 界面简洁直观、交互流畅 | 深色监控台 UI，无第三方图表库 | 截图证据 + 60fps 级增量渲染 |

---

## 2. 技术选型

**选定：Electron 45 + React 19 + TypeScript 5 + Vite 7 + Vitest 3**

理由：
1. 局域网探测依赖大量 OS 原生能力（ICMP、ARP 表、TCP 连接表、Windows 打印后台处理程序），Node 侧可直接调用；Electron 主进程即 Node 运行时，无需第二语言。
2. 打印机耗材必须走 SNMP（RFC 3805 Printer MIB），纯 Node 可手写 BER 编解码，零原生模块依赖，安装零编译风险。
3. 渲染层用 React 便于实现高频增量刷新（5s 心跳 + 2s 带宽）而不重排整表。
4. 验证可闭合：Electron 自带 `webContents.capturePage()`，可自行截图，无需额外浏览器内核下载。

否决方案：
- **Tauri/Rust**：需 Rust 工具链，本机未验证，构建失败风险高；且 SNMP/ARP 生态并无优势。
- **PyQt/PySide**：UI 表现力与高频刷新体验不如 Web 栈，且要求把探测逻辑重写为 Python。
- **纯 Web + 本地服务**：不满足"桌面应用"形态要求（无托盘、无原生窗口、需手动开浏览器）。
- **引入 net-snmp / node-ping 等三方库**：增加安装面与原生编译风险，且本任务的核心探测逻辑需可单测，手写更可控。

---

## 3. 架构设计（四层）

```
┌──────────────────────────────────────────────────────────────┐
│ 渲染层 Renderer (React 19)                                    │
│  TopBar(扫描控制/计数) │ DevicesView │ PrintersView │ AlarmCenter│
│  DeviceDetail 抽屉(IP/MAC/主机名/OS/带宽/端口/连接/历史曲线)      │
│  ▲ 只消费 Snapshot，不发起网络探测；useLiveFeed 订阅推送         │
└───────────────────────────┬──────────────────────────────────┘
                            │ contextBridge (预加载桥，类型化)
┌───────────────────────────┴──────────────────────────────────┐
│ 编排层 Main Orchestrator                                      │
│  ipc.ts（invoke/event 路由）· scheduler.ts（分频轮询调度）      │
│  alarms.ts（告警引擎）· store.ts（JSON 持久化）· simulator.ts   │
└───────────────────────────┬──────────────────────────────────┘
                            │ 纯函数/服务调用
┌───────────────────────────┴──────────────────────────────────┐
│ 探测层 Engine（全部可单测，无 Electron 依赖）                   │
│  discovery: subnet → ping sweep → ARP 表 → 端口探测 → 指纹推断  │
│  printers : SNMP v2c(手写BER) → Printer MIB / spooler(PowerShell)│
│  network  : ICMP 采样 → rtt/jitter/loss → 质量评分 → 带宽估算    │
└───────────────────────────┬──────────────────────────────────┘
                            │ child_process / net.Socket / dgram
┌───────────────────────────┴──────────────────────────────────┐
│ 系统层 Windows：ping.exe · arp -a · PowerShell Get-Printer     │
│ netstat/Get-NetTCPConnection · Get-NetAdapterStatistics · UDP 161│
└──────────────────────────────────────────────────────────────┘
```

**关键设计决策**

- **推送优先**：主进程每心跳主动 `webContents.send('lan:snapshot')`，渲染层不做轮询，保证低延迟且无请求风暴。
- **分频采集**：带宽 2s / 设备心跳 5s / 打印机 15s / 全量子网扫描 60s（可切手动），避免 254 台主机同时 ping 打满。
- **数据来源诚实原则**：耗材拿不到就返回 `null` + `source:'unknown'`，UI 显示"设备不报告"，**绝不编造 0%**。带宽为"网卡计数器 × TCP 连接占比"推算，`estimated:true` 明示。
- **降级开关**：真实扫描 0 结果时自动切模拟数据源并在 UI 顶部常驻"演示数据"角标，保证应用在任何网络环境都可演示与验证。
- **零原生依赖**：不用 better-sqlite3 / node-snmp，避免 node-gyp 编译失败；持久化用 JSON 文件。

---

## 4. 目录结构与文件归属（所有权矩阵）

| 目录/文件 | 归属 | 说明 |
|---|---|---|
| `package.json` `tsconfig*.json` `vite.config.ts` `vitest.config.ts` `.gitignore` | Max-1 | 构建骨架 |
| `ARCHITECTURE.md` | Max-1 | 架构文档（用户明确要求的交付物之一） |
| `src/shared/**` | Max-1 | **契约冻结区**，Max-2 只读不得改 |
| `src/main/**` | Max-1 | 主进程 + 引擎 |
| `scripts/smoke.ts` | Max-1 | 自截图冒烟脚本 |
| `src/renderer/**` | Max-2 | 全部 UI，与 Max-1 文件零交集 |
| `tests/**` | Tess | 只写测试 |
| `.agent-runs/**` | 全员 | 报告与证据 |

> 并行安全性：Max-2 仅依赖 `src/shared/types.ts` 的接口形状（本文件第 5 节已逐字段冻结），不依赖 Max-1 的实现细节。

---

## 5. 共享数据契约（冻结 · 任何人不得单方修改）

```ts
// src/shared/types.ts —— 形状冻结，字段名即为渲染层依据
export type DeviceKind = 'workstation'|'printer'|'router'|'server'|'mobile'|'iot'|'unknown';
export type LinkState  = 'online'|'offline'|'degraded'|'scanning';
export type AlarmSeverity = 'critical'|'warning'|'info';
export type DataSource = 'live'|'mixed'|'demo';

export interface NetQuality {
  latencyMs: number|null; jitterMs: number|null; packetLossPct: number;
  score: number; grade: 'excellent'|'good'|'fair'|'poor'|'unknown'; samples: number;
}
export interface BandwidthStat {
  rxBps: number; txBps: number; share: number; connections: number; estimated: boolean;
}
export interface Device {
  id: string; ip: string; mac: string|null; hostname: string|null; vendor: string|null;
  osHint: string|null; kind: DeviceKind; state: LinkState;
  firstSeen: number; lastSeen: number; openPorts: number[];
  quality: NetQuality; bandwidth: BandwidthStat; rttHistory: number[];
  isGateway: boolean; isSelf: boolean; displayName: string|null;
}

export type ConsumableKind = 'black'|'cyan'|'magenta'|'yellow'|'drum'|'waste'|'other';
export interface Consumable {
  kind: ConsumableKind; label: string;
  levelPct: number|null; maxCapacity: number|null; current: number|null;
  source: 'snmp'|'spooler'|'ipp'|'unknown';
}
export type PrinterState = 'idle'|'printing'|'warning'|'error'|'offline'|'unknown';
export interface PrintJob {
  id: string; documentName: string; owner: string; status: string;
  pages: number; pagesPrinted: number; submittedAt: number;
}
export interface Printer {
  id: string; name: string; model: string|null; ip: string|null; mac: string|null;
  connection: 'network'|'usb'|'virtual'|'unknown';
  state: PrinterState; stateDetail: string|null;
  isDefault: boolean; shared: boolean; pageCount: number|null;
  consumables: Consumable[]; jobs: PrintJob[];
  source: 'snmp'|'spooler'|'both'|'simulated'; lastSeen: number;
}

export interface Alarm {
  id: string; severity: AlarmSeverity; code: string;
  targetType: 'device'|'printer'|'system'; targetId: string; targetName: string;
  message: string; detail: string|null;
  raisedAt: number; ackAt: number|null; resolvedAt: number|null;
}

export interface ScanProgress { active: boolean; pct: number; phase: string;
  scanned: number; total: number; startedAt: number|null; }
export interface SystemStat {
  totalDevices: number; online: number; offline: number; degraded: number;
  printers: number; printersWithFault: number;
  rxBps: number; txBps: number;
  alarmCounts: { critical: number; warning: number; info: number };
  scan: ScanProgress; lastScanAt: number|null; nextScanInMs: number|null;
  autoScan: boolean; autoScanIntervalSec: number;
}
export interface Snapshot {
  ts: number; subnet: string|null; dataSource: DataSource;
  devices: Device[]; printers: Printer[]; alarms: Alarm[]; system: SystemStat;
}
export interface DeviceDetail {
  device: Device;
  ports: { port: number; service: string; open: boolean }[];
  connections: { remoteIp: string; remotePort: number; state: string; proto: string }[];
  history: { ts: number; rtt: number|null; rxBps: number; txBps: number }[];
}
```

IPC 通道（`src/shared/channels.ts`）：
`lan:getSnapshot` `lan:refresh` `lan:setAutoScan` `lan:getDeviceDetail` `lan:ackAlarm` `lan:exportReport` （均为 invoke）；`lan:snapshot` `lan:scanProgress` `lan:alarm` （为 main→renderer 推送）。

预加载桥：`window.lanApi = { getSnapshot, refresh, setAutoScan, getDeviceDetail, ackAlarm, exportReport, onSnapshot, onScanProgress, onAlarm }`。

**契约补充 2（P1 实测后修订，作者：队长）**：`BandwidthStat` 增加 `attributable` 字段，其余字段不变：

```ts
export interface BandwidthStat {
  rxBps: number; txBps: number; share: number; connections: number;
  /** 是否存在可归集的局域网流量。false 时 rxBps/txBps 无意义，UI 必须显示"无流量归集"而不是 0 */
  attributable: boolean;
  estimated: boolean;
}
```

## 5.1 状态判定语义（P1 实测后冻结，覆盖一切早期假设）

本网段实测：ARP 表 53 条活跃条目，抽样 8 个仅 3 个回 ICMP。**大量主机关闭了 ICMP**，"ping 不通"绝不等于"离线"。判定优先级（自上而下命中即定论）：

| 序 | 条件 | state | 说明 |
|---|---|---|---|
| 1 | `isSelf` 或 `isGateway` | `online` | 本机与网关永远在线 |
| 2 | 本轮 `arp -a` 中存在该 IP 的有效 MAC | `online` | ARP 在位 = 二层可达，这是**主信号** |
| 3 | 任一被探测端口 TCP 有响应 | `online` | 对 ICMP 的有效补充 |
| 4 | ARP 在位但 3 轮 ICMP 全超时 | `online` + `quality.grade='unknown'` + `samples=0` | 禁 ICMP 主机，UI 显示"质量未采样" |
| 5 | ARP **连续 3 轮**缺席且 ping 无响应 | `offline` | **唯一**判离线的路径（ARP 老化有延迟，不可提前判） |
| 6 | 已采到质量样本且（`packetLossPct>=20` 或 `latencyMs>150`） | `degraded` | 覆盖第 1-4 条的 online |

**告警规则同步修订**（`alarms.ts` 以此为准）：
- `DEVICE_OFFLINE` critical：state 变为 `offline`（第 5 条命中）
- `DEVICE_NEW` info：新 MAC 首次出现
- `NET_QUALITY` warning：`grade==='poor'` 连续 2 轮
- `SUPPLY_LOW` warning / `SUPPLY_CRITICAL` critical：**仅当 `levelPct!==null`**；`null` 不产生任何耗材告警（不报告 ≠ 耗尽）
- `PRINTER_ERROR` critical：state 为 `error`
- `PRINTER_OFFLINE` critical：网络打印机（`ip!==null`）TCP 9100/631 不可达而 spooler 仍报 Normal（正是 `.213` 的假在线场景）
- **禁止**为"ICMP 不可达"产生告警（本网段会产生 50+ 条噪音）

## 5.2 编码双通道（P1 实测后冻结 · P0 级约束）
| 用途 | 通道 | 解码 |
|---|---|---|
| 抓中文文本（arp / ping / netstat） | 直接 spawn 原生 exe，**禁止经 PowerShell** | `TextDecoder('gb18030')` |
| 抓结构化数据（打印机等） | `powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ... \| ConvertTo-Json -Compress"` | `buf.toString('utf8')` |

- **禁止** `chcp 65001`；**禁止**用 PowerShell 抓 arp/ping（代码页 65001 会让 MUI 程序回退英文资源，中文字面量正则全部失效）
- 每个 spawn 站点显式声明解码方式，统一封装 `runNative(cmd, args, enc:'gbk'|'utf8', timeoutMs)`，**不允许调用点自行 `toString()`**
- 硬超时强杀：ping 1200ms / arp 2000ms / netstat 3000ms / PowerShell 8000ms；`close` 后必须清 timer
- 子进程全局并发上限 64；**PowerShell 全局单飞队列**（冷启动 700-900ms，并发无收益）

## 5.3 安全约束（P0，供 Ray 复核）

- **禁止**把 IP / 主机名 / 打印机名拼进任何 shell 字符串；一律 `spawn(cmd, argsArray)`
- IP 使用前过 `^(?:\d{1,3}\.){3}\d{1,3}$` 且按 0-255 复核
- 打印机名含 `()` `:`（实测 `Xerox AltaLink C8055 (9C:93:4E:9C:6A:76)`），**禁止** `Get-PrintJob -Name '<name>'` 形式；必须一次性 `Get-Printer | ConvertTo-Json` 全量取回后在内存过滤

**契约补充（冒烟钩子，跨成员冻结）**：渲染层必须在 `window` 上无条件暴露两个测试钩子，供 Max-1 的 `scripts/smoke.mjs` 驱动截图：
- `window.__setView(view: 'overview'|'devices'|'printers'|'alarms', deviceId?: string): void` — 切换视图 / 打开详情抽屉
- `window.__ready: boolean` — 首个快照渲染完成时置 `true`

这两个钩子是验证闭环的必要条件，Max-2 不得省略，Max-1 的冒烟脚本依赖它们。

---

## 6. 执行序列

| 阶段 | 成员 | 产出 | 依赖 |
|---|---|---|---|
| P0 | Horizon | plan.md（本文件）、团队 | — |
| P1 | 调查员 Vera | `investigation-report.md`：本机探测能力实测（中文 Windows 输出解析、spooler 权限、SNMP 可达性、真实打印机有无、ping 并发上限） | P0 |
| P2a | 实现工程师 Max-1 | 构建骨架 + 引擎 + IPC + 预加载 + 冒烟脚本 + ARCHITECTURE.md | P1 |
| P2b | 实现工程师 Max-2 ∥ 测试工程师 Tess | `src/renderer/**` UI ∥ `tests/**` 单测 | P2a 完成契约文件 |
| P3 | 验证员 Vic | 构建/测试/真机启动/截图证据 → PASS/FAIL | P2a+P2b |
| P4 | 审查员 Ray | `review-report.md` | P3 |
| P5 | Horizon | `final-summary.md` | P4 |

---

## 7. 验收标准（Vic 逐条判定）

1. `npm install` 成功，`npm run build` 退出码 0，产出 `dist/renderer/index.html` 与 `dist/main/index.cjs`。
2. `npm test` 全绿，且测试用例数 ≥ 25，覆盖：SNMP BER 编解码、OUI 归一化、质量评分边界、告警去重与恢复、带宽差分、ARP 解析（中英文双 locale）、子网推导。
3. `npm run smoke` 能真实拉起 Electron 窗口并落盘 ≥3 张 PNG（总览/打印机/详情抽屉），PNG 非全黑非空白（像素方差校验）。
4. 快照断言：`devices.length > 0`、`printers.length > 0`、每台设备 `ip` 非空、字段 `mac/hostname/osHint/quality/bandwidth` 均存在（可为 null 但键必须存在）。
5. 主进程主线程不阻塞：单次全量子网扫描 ≤ 12s（254 地址）。
6. 界面无控制台未捕获异常，React 无 key 警告。

---

## 8. 风险登记册与降级策略

| 风险 | 影响 | 降级策略 |
|---|---|---|
| 中文 Windows 命令行输出（`arp -a` 显示"动态"、ping 显示"字节="） | 解析空结果 | P1 必须实测并给出双 locale 正则；解析失败不得抛异常，返回空数组并记 `parseWarning` |
| 无 SNMP 设备/161 被防火墙拦截 | 耗材全空 | `levelPct:null` + UI 显示"设备不报告"；模拟数据源补齐演示 |
| PowerShell 执行策略限制 | spooler 队列取不到 | 改用 `Get-CimInstance Win32_PrintJob`；再失败降级为 SNMP 队列 OID |
| 无真实局域网打印机 | 打印机面板空 | 自动模拟数据源 + "演示数据"角标 |
| Electron 下载失败 | 无法启动 | 已实测 GitHub 与 npmmirror 双通道 200；设 `ELECTRON_MIRROR` 兜底 |
| 无图形会话，`capturePage` 黑屏 | 截图证据缺失 | Vic 回 BLOCKED，改以 JSON 快照 + DOM 快照作证据，并向用户说明 |

---

## 9. 成本控制

- 每次成员调用只回 ≤20 行状态块，详细内容落盘，防止主会话上下文爆炸。
- 修复循环上限 2 轮，超限出 `blocked-report.md`。
- 不引入任何需要编译的原生依赖；不下载浏览器内核；不搭 CI。

---

## 10. 决策记录（Decision Log）

| # | 决策 | 依据 | 影响 |
|---|---|---|---|
| D-001 | Electron 45 + React 19 + TS + Vite，零原生依赖 | 探测依赖 OS 原生能力，Node 直连；避免 node-gyp 编译风险 | 安装面最小，可复现 |
| D-002 | 在线判定以 **ARP 在位为主信号**，ICMP 仅作质量采样 | P1 实测：53 条 ARP 活跃但抽样 8 个仅 3 个回 ICMP | 避免 50+ 台设备被误报离线；`offline` 仅由"ARP 连续 3 轮缺席"触发 |
| D-003 | 编码双通道：原生 exe+GB18030 / PowerShell+UTF8+JSON | P1 实测：设 UTF8 会让 MUI 程序回退英文资源，中文与 UTF-8 不可兼得 | 解码器与 spawn 站点绑定，禁止全局统一 |
| D-004 | 弃用 `Get-NetTCPConnection`，改 `netstat -ano` | 实测 890ms vs 83ms（慢 10 倍） | 带宽归集每轮省 ~800ms |
| D-005 | 单机带宽标注为**估算**，新增 `attributable` 字段 | 实测本机与 LAN 的 TCP 连接仅 4 条，无法真实归集 | UI 显示"无流量归集"而非 0，杜绝伪精确 |
| D-006 | 打印机 `state` 叠加 TCP 9100/631 探活覆盖 | 实测 `.213` 在 spooler 报 Normal/Idle 但网络不可达 | 消除"假在线"；产生本任务唯一真实告警 `PRINTER_OFFLINE` |
| D-007 | SNMP 手写 BER，保留但**无法真机验证** | 实测 4 主机 × 2 community 全 timeout | 仅靠单测（构造报文）保证正确性；文档标注未验证 |
| D-008 | IPP 保留为 **opt-in provider（≤100 行）**，不因它拖慢主线 | 实测两台打印机 631 均回 `0x0400/0x0406/0x0503` 且无 printer 属性组，但其他网络可能存在 IPP 机型 | `Consumable.source` 增加 `'ipp'`；`marker-levels` 负值一律 null，不 clamp |
| D-009 | 耗材拿不到即 `consumables: []` + `source:'unknown'`，UI 显示"设备不报告" | 数据诚实红线：不报告 ≠ 耗尽 | 真机环境下这是**默认主设计**，不是异常态 |
| D-010 | 降级：ARP 解析 0 条 → `dataSource='demo'`，UI 常驻"演示数据"角标 | 保证任意网络环境可演示与验证 | 模拟数据必须显式标注，禁止静默混入 |
