# Brief — 实现工程师 Max-2（task-001 / P2b）

| 字段 | 值 |
|---|---|
| `role_name` | lan-console-ui-implementer |
| `mission` | 只做渲染层：用 React 19 + 原生 CSS 实现深色 NOC 控制台界面，把 Snapshot 变成可读、可交互、高频刷新不卡的监控台。 |
| `when_to_use` | 引擎与 IPC 契约已由 Max-1 冻结，UI 是独立文件领地，可与测试并行。 |
| `input_files` | `.agent-runs/2026-10-25/task-001/plan.md`（**第 5 节契约 + 冒烟钩子**）、`.agent-runs/2026-10-25/task-001/implementation-report.md`（Max-1 的真实导出名/路径） |
| `allowed_edit_scope` | `src/renderer/**` |
| `forbidden_actions` | 不得修改 `src/main/**`、`src/shared/**`、`package.json`、vite/tsconfig 配置（发现契约缺字段 → BLOCKED 上报，不许自行加字段或改类型）；不得引入任何 UI 库/图表库/图标库/Tailwind（**只用原生 CSS + 内联 SVG**）；不得发起 fetch/网络请求；不得伪造数据 |
| `tools_policy` | 可编辑 `src/renderer/**`；可跑 build 验证类型；可启动 Electron 看效果 |
| `output_path` | `.agent-runs/2026-10-25/task-001/ui-report.md` |
| `success_criteria` | 见第 6 节，逐条 PASS/FAIL |
| `stop_condition` | `src/shared/types.ts` 缺失或与 plan.md 不符 → BLOCKED；需要改引擎 → BLOCKED |
| `handoff_format` | STATUS 块 ≤20 行 |
| `max_iterations` | 2 |

---

## 1. 数据来源（唯一）

`window.lanApi`（preload 暴露）：`getSnapshot()`、`refresh(mode)`、`setAutoScan(enabled, intervalSec)`、`getDeviceDetail(id)`、`ackAlarm(id)`、`exportReport()`、`onSnapshot(cb)`、`onScanProgress(cb)`、`onAlarm(cb)`。
类型全部来自 `src/shared/types.ts`。**推送是主要数据源**（主进程 5s 心跳推 `snapshot`），首屏用 `getSnapshot()` 取一次。

## 2. 布局（桌面应用形态，不是网页）

```
┌───────────────────────────────────────────────────────────────┐
│ 顶栏 56px  SVESC 局域网管理台 │ 网段 chip │ 数据源 chip │ 右侧：    │
│            最后扫描 12:03:44 · 自动扫描[开] 30s · [立即刷新] [导出]│
├──────────┬────────────────────────────────────────────────────┤
│ 侧栏 200 │  主内容区（可滚动，padding 20px，栅格 12 列）          │
│ 总览  12 │                                                    │
│ 设备  24 │                                                    │
│ 打印机 4 │                                                    │
│ 告警  3 │                                                    │
├──────────┴────────────────────────────────────────────────────┤
│ 状态条 28px  心跳 ● 正常 · 引擎 4 个任务 · 下次扫描 12s          │
└───────────────────────────────────────────────────────────────┘
```

四个视图（`overview` / `devices` / `printers` / `alarms`）+ 右侧详情抽屉。

### 总览
- KPI 卡 5 个一行：在线设备（含总设备数）、离线/降级、打印机（故障台数）、活跃告警（按严重级分色小字）、全网带宽（↓/↑）。
- 中部左右分栏：左侧"设备健康表"（前 8 行，紧凑版），右侧"打印机状态"紧凑卡列表。
- 底部：最新告警时间线（最近 6 条）。

### 设备
- 工具条：搜索框（IP/MAC/主机名/厂商）、状态筛选（全部/在线/降级/离线）、类型筛选、排序（IP/延迟/带宽/名称）。
- 表列：`●` 状态 · IP · 主机名 · MAC · 厂商 · 系统 · 类型 · 延迟 · 丢包 · 质量 · ↓/↑ 带宽。
- 行：44px，hover 左侧出现 2px accent 竖条，整行可点 → 打开详情抽屉。
- 离线行整体降透明度 0.55，但**不能被隐藏**（用户要知道谁掉了）。

### 打印机
- 卡片栅格（minmax 340px，自适应列数）。每卡：
  - 头部：名称 + 状态 pill（idle 待机/printing 打印中/warning 警告/error 故障/offline 离线/unknown 未知）+ 默认/共享标记
  - 型号 · IP · 连接方式 · 数据源角标（SNMP / 系统队列 / 模拟）
  - 耗材区：**垂直液位条**（24×64，按耗材色 K 黑/C 青/M 洋红/Y 黄/鼓/废粉），下方百分比；`levelPct===null` 显示"不报告"斜纹底，**绝不显示 0%**
  - 队列区：最多 5 条任务（文档名 · 属主 · 进度条 pagesPrinted/pages），超出显示"+N 项排队"
  - 故障横幅：`state==='error'||'warning'` 时顶部出现红/橙条 + `stateDetail`

### 告警
- 按严重级分组（严重/警告/提示），每条：严重级色条 · 目标名 · 消息 · 代码 · 时间（相对"3 分钟前"）· 状态（活动/已确认/已恢复）· `[确认]` 按钮（已恢复项置灰）。

### 详情抽屉（右侧 420px 滑入）
必须完整覆盖需求 R3：
- 身份区：IP（大字+等宽）、MAC、主机名、操作系统、厂商、类型、网关/本机标记、首次/最后发现时间
- 网络质量：评分环形（SVG 圆环，颜色随 grade）、延迟/抖动/丢包三项、RTT 迷你曲线（最近 60 点折线，断点/超时用红点标出）
- 带宽：↓/↑ 当前值 + 迷你曲线 + **"估算值"标注**（hover 说明：按网卡计数与 TCP 连接占比推算）+ 活跃连接数列
- 开放端口：chip 列表（端口号 + 服务名，HTTP/HTTPS/SMB/IPP/RAW-Print/SNMP/RDP/SSH…）
- 连接表：远端 IP:端口 · 状态 · 协议（最多 10 行）
- 空/加载态：骨架屏，不得跳动

## 3. 视觉规范（照做，不要自由发挥）

```css
--bg:#0a0e13; --surface:#11161d; --surface-2:#171e27; --elevated:#1c2531;
--border:#232c38; --border-strong:#2f3a48;
--text:#e7edf5; --text-muted:#8b98a9; --text-dim:#5d6a7a;
--accent:#4c9aff; --ok:#34d399; --warn:#f5a623; --crit:#ff5c5c; --offline:#5d6a7a;
--radius:10px; --mono:ui-monospace,'Cascadia Mono','Consolas',monospace;
```
- 字体：`'Segoe UI','Microsoft YaHei UI',system-ui`；所有数字/地址/MAC 用 `--mono` + `tabular-nums`。
- 状态点：8px 圆 + `box-shadow:0 0 0 3px rgba(...,.18)`；`crit` 状态 1.8s 呼吸动画。
- 圆角 10px，卡片背景 `--surface` + 1px `--border`，**禁止大阴影**（最多 `0 1px 0 rgba(255,255,255,.03) inset`）。
- 表头：11px / `letter-spacing:.06em` / 大写字重 600 / `--text-dim` / sticky。
- 过渡：hover 与数值变化 120-180ms；抽屉 `transform 220ms cubic-bezier(.22,1,.36,1)`；仅故障与刷新时用轻微脉冲，**不要满屏动画**。
- 滚动条细样式（6px，`--border-strong`）。
- 键盘：`Esc` 关抽屉、`Tab` 焦点环 `--accent` 2px、`/` 聚焦搜索框。
- 空态：居中图标（内联 SVG 线性图标，stroke 1.5）+ 一句解释 + 主操作按钮。
- 数据源为 `demo`/`mixed` 时，顶栏常驻琥珀色 chip「演示数据」并在 hover 说明原因。

## 4. 性能要求（硬指标）

- 快照 5s 推一次、带宽 2s 推一次。设备可能 200+ 行，**禁止每 tick 全量重排**：
  - 行组件 `React.memo` + 自定义 `areEqual` 只比较该行展示的字段（含 bandwidth/quality 关键值），rttHistory 数组按引用比较
  - 列表用 `useMemo` 派生，key 用 `device.id`
  - 详情抽屉只在打开时 `getDeviceDetail`，且仅对当前设备更新
  - 不要用 `useState` 存整个快照的深拷贝，直接持有引用
- 首屏 skeleton ≤ 300ms 出现；首个快照到达后一次性渲染。
- 浏览器控制台零 error / 零 React key 警告。

## 5. 冒烟钩子（冻结契约，必做）

在 `window` 上无条件暴露：
```ts
window.__setView = (v: 'overview'|'devices'|'printers'|'alarms', deviceId?: string) => void;
window.__ready = true;  // 首个快照渲染完成后置 true
```
`__setView('devices', id)` 需同时打开该设备详情抽屉（供 `detail.png` 截图）。

## 6. 验收自查（逐条 PASS/FAIL 写入 ui-report.md）

1. `npm run build` 退出码 0，TypeScript 无 error（允许既有 warning）
2. 四视图 + 详情抽屉全部实现，无 TODO 占位、无 `alert()`
3. 需求 R3 五项（IP/MAC/主机名/OS/带宽）在详情抽屉中全部可见
4. 打印机耗材 `null` → 显示"不报告"，代码中不存在把 null 兜底成 0 的分支
5. 演示数据角标在 `dataSource!=='live'` 时出现
6. 256 行设备表在连续 20 次快照更新下无明显卡顿（给出实测：`performance.now()` 包裹一次快照渲染耗时 ms）
7. `window.__setView` / `window.__ready` 已暴露且被 smoke 成功调用（与 Max-1 联调一次即可）
8. CSS 无 `!important` 滥用（≤3 处），无内联样式堆砌（动态宽度除外）

## 7. 报告要求

`ui-report.md` 写：组件树、每组件职责、设计 token 表、性能实测数据、与引擎契约的任何偏差（应为 0）、给 Vic 的截图检查点清单（每张图应该长什么样、要看哪几个元素）。
