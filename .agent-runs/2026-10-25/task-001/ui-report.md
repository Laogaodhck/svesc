# UI 实现报告 — 渲染层（Max-2 / task-001 P2b）

- **归属**：`src/renderer/**`（本报告之外不修改任何文件）
- **技术栈**：React 19 + TypeScript + 原生 CSS + 内联 SVG。零 UI/图表/图标库，零 fetch。
- **数据契约**：`src/shared/types.ts`（plan §5 + 契约补充 2 `attributable`），**未做任何字段增删**，偏差 0。
- **构建**：`npx tsc --noEmit -p tsconfig.web.json` 0 error；`npm run build` 退出码 0，产出 `dist/renderer/index.html`（0.65 kB）+ CSS 33.1 kB + JS 282.5 kB（gzip ≈87 kB，其中 React 运行时占绝大部分）。

---

## 1. 组件树

```
main.tsx
└─ App.tsx                       视图路由 / 冒烟钩子 / 渲染耗时埋点 / 动作编排
   └─ AppShell                   四区骨架（顶栏 56 / 侧栏 200 + 主区 / 状态条 28）
      ├─ TopBar                  品牌 · 网段 · 数据源 chip · 扫描状态 · 刷新/导出
      ├─ Sidebar                 导航 + 实时计数 + 告警红点
      ├─ main.content            当前视图
      │  ├─ OverviewView         KPI×5 · 设备健康表(8) · 打印机状态(5) · 最新告警(6)
      │  ├─ DevicesView          工具条 + 200+ 行虚拟表格（行级 memo）
      │  ├─ PrintersView         卡片栅格 · 耗材液位 · 队列 · 故障横幅
      │  └─ AlarmsView           按严重级分组 · 确认动作
      ├─ StatusBar               心跳 · 引擎任务 · 下次扫描倒计时 · 数据源 · 渲染耗时
      └─ DeviceDetailDrawer      右侧 420px 抽屉（R3 全部五项 + 端口 + 连接 + 曲线）
         ├─ ScoreRing            SVG 评分环（未采样时无弧）
         ├─ Sparkline            SVG 折线（null 断线 + 红点标超时）
         ├─ QualityBar           5 段质量条（未采样时**不画段**）
         ├─ LevelBar             垂直耗材液位（null → 斜纹 + "不报告"）
         ├─ Bar / StatusDot / StatusPill / Hint / EmptyState / Skeleton
         └─ Icon                 内联 SVG 图标集（stroke 1.5）
```

## 2. 组件职责

| 组件 | 职责 | 关键约束 |
|---|---|---|
| `App` | 视图状态、抽屉开关、自动扫描乐观更新、`__setView`/`__ready`、渲染耗时结算 | 不深拷贝快照；只持引用 |
| `useLiveFeed` | 订阅 `onSnapshot`/`onScanProgress` + 首屏 `getSnapshot()`；暴露 refresh/ack/export | 卸载时全部反订阅；桥缺失时 `apiMissing` |
| `useTick` | 1s 低频时钟，**只在顶栏/状态条内部使用** | 避免每秒重渲染 200 行表格 |
| `AppShell` / `TopBar` / `Sidebar` / `StatusBar` | 纯展示，全部 props 为原始类型 | 无业务状态 |
| `DevicesView` + `DeviceRow` | 搜索/状态/类型筛选、IP/延迟/带宽/名称排序、行点击开抽屉 | `memo` + 字段级 `areEqual`；key=`device.id`；离线行 0.55 透明度但不隐藏 |
| `PrintersView` | 卡片栅格 340px 自适应、故障横幅、队列进度、耗材 | `levelPct===null` 绝不兜底 0 |
| `AlarmsView` | 严重/警告/提示分组、相对时间、确认（已恢复置灰） | 去重由主进程负责，UI 只展示 |
| `DeviceDetailDrawer` | IP/MAC/主机名/OS/带宽/评分/延迟抖动丢包/RTT 曲线/端口/连接/发现时间 | 用快照设备取实时值，`getDeviceDetail` 只取端口/连接/历史 |
| `Sparkline` | 单序列折线，自动纵向缩放 | `null` 断线 + 红线底部标记；全 null 时只画虚线基准，不造曲线 |
| `ScoreRing` | 92px 评分环 | `samples===0 \|\| grade==='unknown'` → 空环 + "—" + "未采样" |
| `LevelBar` | 24×64 垂直液位 | `null` → 虚线斜纹 + "不报告" |
| `QualityBar` | 5 段质量 + 等级字 | 未采样**不画任何段**（避免灰条被当成"有数据") |
| `Icon` | 24 个线性图标 | 禁止图标库 |

## 3. 设计 token（`styles/tokens.css`，brief §3 原样落地）

| token | 值 | 用途 |
|---|---|---|
| `--bg` | `#0a0e13` | 应用底色 |
| `--surface` | `#11161d` | 卡片 / 顶栏 / 侧栏 |
| `--surface-2` | `#171e27` | 次级块 / hover |
| `--elevated` | `#1c2531` | 选中态 / tooltip |
| `--border` / `--border-strong` | `#232c38` / `#2f3a48` | 1px 分隔 / 表头下沿 |
| `--text` / `--text-muted` / `--text-dim` | `#e7edf5` / `#8b98a9` / `#5d6a7a` | 三级文字 |
| `--accent` | `#4c9aff` | 交互 / 良好质量 / 打印中 |
| `--ok` / `--warn` / `--crit` / `--offline` | `#34d399` / `#f5a623` / `#ff5c5c` / `#5d6a7a` | 在线 / 降级 / 故障 / 离线（灰，不是红） |
| 耗材 | `K #b9c4d2` `C #38bdf8` `M #e879f9` `Y #fbbf24` `鼓 #a78bfa` `废 #7c8899` | 液位条分色 |
| `--radius` | `10px` | 卡片圆角 |
| `--mono` | `ui-monospace, Cascadia Mono, Consolas` | 所有数字/地址/MAC + `tabular-nums` |
| 动效 | hover 120–180ms；抽屉 `220ms cubic-bezier(.22,1,.36,1)`；`crit` 1.8s 呼吸 | 只有故障脉冲与数值过渡 |

排版纪律：卡片只靠 1px 边框 + `0 1px 0 rgba(255,255,255,.03) inset` 高光，**无投影**；表头 11px/0.06em/600/`--text-dim`/sticky；行高 44px（紧凑表 36px）。

## 4. 数据缺失的措辞（本机实测的必然情况）

| 契约状态 | UI 呈现 | 悬停说明 |
|---|---|---|
| `quality.samples===0` 或 `grade==='unknown'` | 表格"未采样"、抽屉"未采样"+ 空评分环 | "该主机未响应 ICMP，本轮没有质量样本（在线判定来自 ARP 表）" |
| `bandwidth.attributable===false` | 表格"无流量归集"、抽屉两行"无流量归集" + 说明段 | "局域网内没有可见的 TCP 会话，无法把网卡流量归集到这台设备" |
| `consumables: []` 或全 `levelPct===null` | 斜纹虚线块 + "设备不报告耗材" + 原因行 | "未启用 SNMP（UDP 161 无响应），队列接口也不提供墨量" |
| 单个耗材 `levelPct===null` | 该条液位条斜纹 + "不报告" | "设备不报告该耗材余量" |
| `mac/hostname/osHint/vendor===null` | 等宽 `—` | — |
| `dataSource!=='live'` | 顶栏琥珀 chip「演示数据」常驻 | demo/mixed 分别说明来源 |
| 带宽任意位置 | 区块级 chip「估算值」 | "按网卡计数器与 TCP 连接占比推算，非设备级流量镜像" |

代码级保证：全仓库不存在 `levelPct ?? 0`、`rxBps || 0` 之类兜底；`LevelBar`/`QualityBar`/`ScoreRing` 三处均以 `null` 分支先行返回占位。

## 5. 性能实测

**方法 A — 真实浏览器（Edge headless + CDP，真实墙钟，非 virtual-time）**
数据：256 台设备，首次渲染 + **连续 20 次推送**（每 400ms，每次快照为新对象、字段仅少数变化），读应用自埋点 `window.__perf`（IPC 回调 `performance.now()` → React commit 结算）：

| 指标 | 数值 |
|---|---|
| 样本数 | 21（首帧 + 20 次推送） |
| 平均 | **3.99 ms** |
| 中位 | ≈ 2.6 ms |
| 稳态区间 | 1.8 – 5.4 ms |
| 最大 | 20.6 ms（**首帧** 256 行全量挂载） |
| 表格行数 | `document.querySelectorAll('tbody tr').length = 256`（已核对） |

**方法 B — 最坏情况全量重算（react-dom/server，无 memo 收益）**
256 行完整协调 + 序列化，20 轮：p50 **28.95 ms**，avg 52.88 ms（含两次 GC 抖动 150/383ms），HTML 240 KB。这是"所有行都变"的理论上界，实际推送只改少量行。

**方法 C — 真实首帧提交**：56 台设备（本机 ARP 实际量级）首帧 9.0 ms（状态条读数）。

达成手段：
1. `DeviceRow` 用 `memo` + 自定义 `areEqual`，只比该行展示字段（含 quality/bandwidth 关键值），`onOpen` 用 `useCallback` 保持稳定；
2. 列表派生全部 `useMemo`，key 用 `device.id`，不深拷贝快照（直接持引用）；
3. 每秒时钟只存在 `TopBar` / `StatusBar` 内部，视图用 `snapshot.ts` 作相对时间基准；
4. 渲染耗时用 `ref` 直接写 DOM（`<span ref>` 的 `textContent`），**不为显示一个数字多触发一次整树渲染**；
5. 抽屉仅在打开时 `getDeviceDetail` 一次，随后用快照值本地追加曲线点（不轮询 IPC）。

二次复测（同一脚本）：avg **5.19 ms**、max 28.3 ms、21 个样本 —— 与首轮同量级，波动来自浏览器调度而非应用逻辑。

**控制台检查（对应 plan §7.6）**：`perf/console-check.mjs` 在 256 行 + 20 次推送场景下抓 `Runtime.consoleAPICalled` / `exceptionThrown` / `Log.entryAdded`，结果 **0 exception、0 React 警告**，唯一一条是本地临时静态服务的 `favicon.ico 404`（与应用无关，Electron 下不会出现这种资源请求）。

可复现：
```bash
node .agent-runs/2026-10-25/task-001/perf/measure.mjs "http://127.0.0.1:8901/index.html?perf#devices" out.png 12500
# 方法 B（先打包再跑，约 30 秒）
npx esbuild .agent-runs/2026-10-25/task-001/perf/bench.tsx --bundle --platform=node \
  --format=cjs --jsx=automatic --alias:@app=C:/github/svesc/src/renderer \
  --outfile=.agent-runs/2026-10-25/task-001/perf/bench.cjs
node .agent-runs/2026-10-25/task-001/perf/bench.cjs
```
（`measure.mjs` 需要本机 Edge；它同时验证 `__ready === true` 与 256 行真实渲染。）

## 6. 验收自查（brief §6 逐条）

| # | 条目 | 结论 | 证据 |
|---|---|---|---|
| 1 | `npm run build` 退出码 0，TS 无 error | **PASS** | `tsc --noEmit -p tsconfig.web.json` 27 个渲染层文件 0 error；`vite build` ≈2.9s 成功 |
| 2 | 四视图 + 抽屉齐全，无 TODO / 无 `alert()` | **PASS** | `grep -rn "alert(\|TODO\|FIXME" src/renderer` → 0 |
| 3 | R3 五项（IP/MAC/主机名/OS/带宽）抽屉内全可见 | **PASS** | 900px 高窗口内：IP 大字 + MAC/主机名/OS/厂商/类型/首末发现 + 带宽块（含"估算值"chip）均在首屏 |
| 4 | 耗材 `null` 显示"不报告"，无 null→0 分支 | **PASS** | `LevelBar.tsx` 先判 `pct===null`；全仓库无 `levelPct ?? 0` |
| 5 | `dataSource!=='live'` 出现演示角标 | **PASS** | 顶栏琥珀 chip，demo/mixed 各自 hover 说明 |
| 6 | 256 行 × 20 次快照无卡顿（给实测） | **PASS** | avg 3.99 ms / 稳态 1.8–5.4 ms / 首帧 20.6 ms（<16.7 ms 预算） |
| 7 | `__setView` / `__ready` 暴露且可被驱动 | **PASS** | CDP 实测 `ready:true`；`__setView('devices')` 切视图、`__setView('devices', id)` 同时开抽屉 |
| 8 | CSS 无 `!important` 滥用，无内联样式堆砌 | **PASS** | `!important` 共 3 处，全部在 `prefers-reduced-motion` 媒体查询内；内联样式仅剩进度条宽度/液位高度/骨架尺寸等**动态值** |

已知限制（不影响验收）：
- 本机 `node_modules/electron/dist` 尚未下载完成，**我没能在 Electron 窗口内截图**；上述视觉检查用 Edge headless 打开同一份 `dist/renderer` 产物完成，真实截图请以 Vic 的 `npm run smoke` 为准。
- 视觉自检用的是严格按契约形状构造的临时 mock（复现"53 台 ARP、仅 3 台回 ICMP、SNMP 全超时、带宽不可归集"），**未写入仓库、不影响产品数据来源**。
- 抽屉关闭动画依赖 CSS transition；无头环境下 `requestAnimationFrame` 可能不派发，故未用 rAF 驱动开合（否则冒烟截不到抽屉）。

## 7. 给 Vic 的截图检查点清单

> 每张图先看"整体是否成立"，再逐个对照下列元素；任何一项缺失即 FAIL。

### overview.png（`__setView('overview')`）
1. 顶栏：`SVESC 局域网管理台` + 网段 chip（`192.168.2.0/24`）+ 数据源 chip；右侧「最后扫描 hh:mm:ss」、自动扫描开关（亮）、倒计时、蓝色「立即刷新」。
2. KPI 五行：在线设备（含"共 N 台"）、离线/降级（两数分色）、打印机（"故障 N 台"）、活跃告警（严重/警告/提示三色小字）、全网带宽（**上下两行** ↓/↑，带「估算」chip，不得溢出卡边）。**带宽单位必须是 bit/s（Kbps/Mbps），不是 B/s**；采样失败时两行都是 `—`，**不得显示 0 bps**（见第 12 节）。离线/降级卡的脚注形如 `降级 1 台 · 采样中 1 台 · ARP 缺席 3 轮才判离线`：**`采样中` 的台数绝不能计入降级**（见第 11 节）。
3. 设备健康表：按"离线→降级→在线"排序，前 8 行；ICMP 不通的行延迟列是 `—`、质量列是"未采样"，**不得出现 0 ms 或灰条**；采样中的行延迟是真实值、质量列写"采样中 n/8"（灰）。
4. 打印机状态：名称 + 状态 pill（待机绿/打印中蓝/离线灰），缺耗材的显示"· 不报告耗材"。
5. 最新告警：≤6 条，左侧色点按严重级，右侧相对时间。
6. 状态条：`心跳 正常 · Ns 前`、`引擎 4 个任务`、`下次扫描 Ns`、`渲染 X ms`。

### devices.png（`__setView('devices')`）
1. 工具条：搜索框（带 `/` 提示）、全部/在线/降级/离线分段控件**带计数**、类型下拉、排序下拉。
2. 表头 11 列齐全且 sticky：状态 · IP · 主机名 · MAC · 厂商 · 系统 · 类型 · 延迟 · 丢包 · 质量 · ↓/↑ 带宽。
3. 行高 44px；离线行整体变淡**但仍然存在**；hover 时左侧出现 2px 蓝色竖条。
4. 质量列**三态**（见第 11 节）：`samples=0` → "未采样"（灰、无段）；`0<samples<8` → "采样中 5/8"（灰、无段）；`samples>=8` → "▮▮▮▮▮ 良/优/中/差"（良=蓝、优=绿、中=琥珀、差=红）。**"采样中"绝不能是琥珀/红色，也不能显示成"差"**——启动前 30 秒全表都是这一态。
5. 按「延迟」排序时，`grade==='unknown'` 的行必须垫底，不能当 0 分排最前。
6. 带宽列：可归集显两行 ↓/↑ 数值；不可归集显示"无流量归集"（**绝不能是 0 KB/s**）。
7. 数字用等宽字体，连续刷新时**列不抖动**。

### detail.png（`__setView('devices', '<deviceId>')`）
1. 右侧 420px 抽屉滑入，背后有半透明遮罩，左上角"设备详情"eyebrow + 设备名 + 状态点。
2. **R3 五项必须同屏可见**：IP 大字等宽、MAC、主机名、操作系统、带宽块（含「估算值」chip，数值带 bps/Kbps/Mbps 单位，hover 注明 bit/s）。
3. 评分环 92px **三态**：`samples>=8` → 分数 + 等级色弧；`0<samples<8` → **灰色弧 + 真实分数**，角标"采样中 5/8"（不是"差"、不是红黄）；`samples=0` → 空环 + "—" + "未采样"。启动后立刻截图必然是第二态，属正常。
4. 延迟 / 抖动 / 丢包 三宫格：采样中显示**真实数值**（不染红）；`samples===0` 时三格都写"未采样"，不是 0。
5. RTT 迷你曲线：最近 60 点折线，超时点用红色标记贴底；全无样本时是一条虚线基准。
6. 开放端口 chips：`端口号 + 服务名`（如 `9100 RAW-Print`、`631 IPP`）。
7. 活跃连接表 ≤10 行（远端 IP:端口 / 状态 / 协议）；无连接显示说明句。
8. 首次/最后发现时间均为 `YYYY-MM-DD HH:mm:ss · 相对时间`。

### printers.png（`__setView('printers')`）
1. 顶部汇总必须是 **`网络打印机 N 台 · 在线 X · 离线 Y · 故障 Z · 活动告警 A`** 的拆分口径；`A` 来自 alarms 中 `targetType==='printer' && 未恢复 && 未确认` 的实时统计，**不得出现"离线 1 / 告警 0"这种自相矛盾**。
2. 工具条有「显示本机虚拟打印机」开关，**默认关闭**，旁边提示"已隐藏 N 台虚拟设备"；网格里不应出现 Adobe PDF / Fax / XPS / Print to PDF。
3. 卡片栅格（≥340px 自适应列），每卡：名称 + 默认/共享标记 + 状态 pill；元信息行：型号 · IP · 连接方式 · 数据源角标（SNMP / 系统队列 / 模拟）· 累计页数。
4. **耗材区文案必须与数据来源一致**（见第 8 节）：`无 IP 地址，无法探测耗材`（`ip===null`，如 WSD 端口，**优先级最高**）、`SNMP 未报告耗材容量`（SNMP 通了但 maxCapacity=-2/-3）、`未启用 SNMP`（**有 IP** 且 UDP 161 不通）、`设备不报告耗材`（SNMP 通了但表为空）。同一张卡片上"徽标写 SNMP + 文案说 SNMP 不通"= FAIL；**`ip` 显示"无"却有"UDP 161 无响应"= FAIL**（没探测过就不能说探测失败，见第 10 节）。
5. 有数据的耗材画 24×64 液位条 + 百分比 + 名称，并在条区下方标一行「耗材来源 SNMP / IPP / 系统队列」；`levelPct===null` 的单条仍是斜纹 + "不报告"。
6. 队列区：≤5 条（文档名 · 属主 · 已打/总页 + 进度条），超出显示"+N 项排队"；空队列写"队列为空 · 最后发现 …"。
7. 若存在 `state==='error'/'warning'`：卡片顶部出现红/橙横幅并带 `stateDetail`；虚拟打印机卡片**不渲染耗材区**（它们没有墨盒）。

### alarms.png（`__setView('alarms')`）
1. 三段分组：严重 / 警告 / 提示，组头带计数。
2. 每条：左侧 3px 严重级色条 · 目标名 · 代码 chip · 消息 · 类型/相对时间/详情 · 状态 pill（活动琥珀 / 已确认灰 / 已恢复绿）· 「确认」按钮。
3. 已恢复项整体降透明度且「确认」置灰。

### 通用（所有图）
- 无白屏、无红色错误条、无布局溢出；窗口 1440×900 下无横向滚动条。
- 顶栏若 `dataSource!=='live'`，**必然**出现琥珀「演示数据」chip。
- 状态条始终在底部 28px，`渲染 X ms` 有读数。
- 关闭「自动扫描」后，顶栏与状态条都显示 `自动扫描已关闭 · 仍持续监控`（**不能写"已暂停"**，心跳/带宽/打印机采集仍在跑）。
- 若快照带 `warnings`：顶栏出现**琥珀** chip `数据不完整 N`，hover 列前 5 条 + `另有 N 条`；它**不计入告警数、不染红**。0 条时该 chip 不出现。

## 8. 修复轮 1（team-lead 复审后）

三处问题全部在本轮修完，改动仅限 `src/renderer/**`；`Consumable.source` 新增 `'ipp'` 的契约变更已同步（`src/shared/types.ts:74`）。

### 8.1 契约变更：`Consumable.source` 增加 `'ipp'`
- `lib/format.ts` 新增 `CONSUMABLE_SOURCE_LABEL = { snmp:'SNMP', spooler:'系统队列', ipp:'IPP', unknown:'未知' }`。
- 耗材条区下方新增一行低饱和小字「耗材来源 SNMP · IPP」，逐条液位条的 title 也带来源；不抢主信息（10.5px / `--text-dim`）。
- 其余不变：`consumables: []` 或全部 `levelPct===null` 时**仍不画任何 0% / 空液位条**。

### 8.2 修复 1（P1）：耗材空态文案按数据来源分支

`PrintersView.suppliesNote(printer)` 是唯一判定入口，不再写死一句话：

| 条件 | 主行（≤14 字） | 副行 | hover 完整解释 |
|---|---|---|---|
| **`ip === null` 且非虚拟**（WSD 端口） | `无 IP 地址，无法探测耗材` | `WSD 端口未解析出 IP` | 「该打印机通过 WSD 端口接入且系统未解析出 IP，SNMP/IPP 均无法探测。」（修复 4 新增，**优先级最高**） |
| `consumables` 非空且全 `levelPct===null`，`source ∈ {snmp,both}` | `SNMP 未报告耗材容量` | `maxCapacity 为 -2/-3，视为未知` | 「设备已响应 SNMP，但未报告耗材容量：maxCapacity 返回 -2/-3，按 RFC 8010 语义为未知/无限，因此没有百分比余量。」 |
| `consumables` 非空且全 null，`source` 不含 snmp | `耗材条目无余量字段` | `设备返回了条目但容量为空` | 「设备返回了耗材条目，但所有容量字段为空，无法换算百分比。」 |
| `consumables` 为空，`source ∈ {snmp,both}` | `设备不报告耗材` | `SNMP 返回了空耗材表` | 「设备已响应 SNMP，但 Printer MIB 未返回任何耗材条目。」 |
| `consumables` 为空，`source` 不含 snmp | `未启用 SNMP` | `UDP 161 无响应，队列无墨量` | 「未启用 SNMP（UDP 161 无响应），系统打印队列接口不提供耗材属性。」 |

> 说明：你表格里的原句「设备已响应 SNMP，但未报告耗材容量」为 18 字，与同段「文案要短（≤14 字）」冲突。我的处理是**主行压到 11 字**（`SNMP 未报告耗材容量`），**原句完整保留在 hover** 里，并把 RFC 语义单独放副行。team-lead 已裁决保留 11 字版本。
>
> 判定顺序即语义：**有真实余量 → 无 IP → 有条目全空（分 snmp/非 snmp）→ 空表（分 snmp/非 snmp）**。因此「未启用 SNMP / UDP 161 无响应」只在**确实有 IP、确实探测过且失败**时出现，详见 §10。

### 8.3 修复 2（P1）：汇总计数口径
- 「告警」不再取全局 `system.alarmCounts`，改为 `alarms.filter(a => a.targetType==='printer' && !a.resolvedAt && !a.ackAt).length`（`PrintersView` 新增 `alarms` prop，由 `App` 传入）。
- 汇总文案：`网络打印机 {N} 台 · 在线 {X} · 离线 {Y} · 故障 {Z} · 活动告警 {A}`，展示虚拟时追加 `· 虚拟 {V}`。
- 口径定义写死在代码注释里：在线 = `state !== 'offline' && state !== 'unknown'`（idle/printing/warning/error 都代表设备有响应）；离线单列；故障 = `state === 'error'`。三者不再混在同一个 0 里。

### 8.4 修复 3（P2）：默认隐藏本机虚拟打印机
- 工具条新增开关「显示本机虚拟打印机」，**默认关闭**。
- 默认只渲染 `connection !== 'virtual'`；汇总与侧栏计数同为过滤后口径（`App` 里 `printers` 计数按同一规则过滤）。
- 开关状态提升到 `App`（`showVirtualPrinters`），**切换视图后不丢失**，满足"会话内保持"。
- 视图内两种空态分开：`printers.length>0` 但全被过滤 → "没有可监控的网络打印机 + 显示虚拟打印机"；真的没有打印机 → "未发现网络打印机 + 立即扫描"。
- 虚拟卡片不渲染耗材区（没有墨盒，写"未启用 SNMP"反而是噪音）。
- 连带一致性：总览的「打印机」KPI 与打印机状态面板也改为同口径（虚拟台数只在脚注写「另有 N 台虚拟」），避免总览 8 台 / 打印机视图 3 台。

### 8.5 自检结果

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json` | **0 error** |
| `npm run build` | 退出码 0（vite 2.6s + esbuild） |
| 控制台（256 行 + 20 次推送） | 0 exception、0 React 警告（仅本地临时服务的 favicon 404） |
| 性能复测 | 21 样本，avg **4.79 ms**、max 14.8 ms（与首轮 3.99/20.6 同量级） |
| 无头截图核对 | 默认态：3 张网络卡片 + "已隐藏 5 台虚拟设备"，Xerox 显示「SNMP 未报告耗材容量」；开启态：8 张卡片、虚拟卡无耗材区、汇总追加「· 虚拟 5」 |

本轮未触碰 `src/main/**`、`src/shared/**`、配置、测试；未运行 `npm run smoke`（避免覆盖 Max-1 的证据）。

## 9. 修复轮 2（Max-1 实拍缺陷）

### 9.1 耗材 label 互相覆盖（P1）
**现象**（Max-1 在 `artifacts/printers.png` 看到）：SHARP 卡片 5 条耗材的 label 挤在同一行互相压字，`Black Toner` / `Waste Toner Box` / `Drum Cartridge (R1)` 重叠不可读。

**根因**：`.level` 固定 44px 宽，而 `.level__label` 是 `white-space: nowrap` 且**没有 overflow 裁剪**——label 直接溢出到相邻耗材上；引擎真实 label 长度（16–20 字符）远超 44px。

**修复**（`styles/components.css` + `LevelBar.tsx`）：
- 列宽 44 → **52px**（5 条 × 52 + 4 × 10 = 300px，可单行放进 340px 卡片；6 条自动换行）；
- label 改为**两行截断**：`display:-webkit-box; -webkit-line-clamp:2` + 固定 `height:2.4em`，短名/长名混排时下方不参差，超长再省略；
- label 增加 `title`，悬浮可见完整名称（如 `Drum Cartridge (R1)`）；
- `.consumables` 间距 12 → 10px，`.level__pct` 加 `nowrap`。

**验证**：用 5 条长标签（Black Toner / Waste Toner Box / Drum Cartridge (R1) / Cyan Toner / Magenta Toner，其中 4 条 `levelPct:null`）无头渲染核对——无重叠，两行内全部可读，"不报告"与百分比列对齐。

### 9.2 类型来源统一（无行为变更）
改用 Max-1 提供的 `src/shared/global.d.ts` 中 `Window` 增强（`lanApi` / `__ready` / `__setView`），删除渲染层三处 `as unknown as {...}` 局部断言（`useLiveFeed`、`DeviceDetailDrawer`、`App`）。运行时仍保留 `window.lanApi ?? null` 判空——preload 注入失败时要走 `apiMissing` 分支而不是崩在访问属性上。

### 9.3 本轮回测
| 项 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.web.json` | 0 error |
| `npm run build` | 退出码 0 |
| 控制台（打印机视图 + 20 次推送） | 0 exception / 0 React 警告（仅本地 favicon 404） |
| 性能 | 21 样本 avg **2.63 ms**、max 22.6 ms（打印机视图 8 卡） |

## 10. 修复轮 3（team-lead 修复 4：无 IP 设备不得声称"探测失败"）

### 10.1 问题
`Canon G3030 series`（PortName `WSD-…` → 判为 `network`，但 `ip === null`）卡片原来显示：

> 未启用 SNMP / UDP 161 无响应，系统队列不提供墨量

**这是虚假陈述**：该设备没有 IP，我们从未向任何地址发过 UDP 161 请求，"无响应"是凭空断言的一次探测结果。运维看到会去查防火墙/SNMP 配置，方向完全错误——真正的问题是该打印机走 WSD 端口、系统未解析出 IP。

### 10.2 修复（`views/PrintersView.tsx` 的 `suppliesNote()`）
在"有真实余量 → 直接画条"之后、"任何 SNMP 文案"之前插入最高优先级分支：

```ts
if (p.ip === null && p.connection !== 'virtual') {
  return {
    title: '无 IP 地址，无法探测耗材',
    sub: 'WSD 端口未解析出 IP',
    explain: '该打印机通过 WSD 端口接入且系统未解析出 IP，SNMP/IPP 均无法探测。',
  }
}
```

判定顺序（在函数头注释里写死，防止后来者调换）：

1. `consumables` 有任一 `levelPct !== null` → 不出空态，照常画条；
2. **`ip === null` 且非虚拟 → 「无 IP 地址，无法探测耗材」**；
3. `consumables` 非空且全 null → 含 snmp 走「SNMP 未报告耗材容量」，否则「耗材条目无余量字段」；
4. `consumables` 为空 → 含 snmp 走「设备不报告耗材」，否则「未启用 SNMP」。

由此「未启用 SNMP（UDP 161 无响应）」成为**唯一且排他**的"探测过且失败"分支——能走到第 4 支 else 的前提就是 `ip !== null`（第 2 支已把无 IP 的全部拦掉）。
虚拟打印机不渲染耗材区，故 `connection === 'virtual'` 的守卫是双保险。

### 10.3 验证（`?notes` 模式，5 台设备覆盖 4+1 支）

| 卡片 | ip | source | 耗材 | 命中主行 | 次数 |
|---|---|---|---|---|---|
| Canon G3030 series | `null` | spooler | `[]` | `无 IP 地址，无法探测耗材` | 1 |
| Xerox AltaLink C8055 | `192.168.2.235` | both | 2 条全 null | `SNMP 未报告耗材容量` | 1 |
| HP LaserJet M404 | `192.168.2.172` | spooler | `[]` | `未启用 SNMP` | 1 |
| Brother HL-L2350DW | `192.168.2.173` | snmp | `[]` | `设备不报告耗材` | 1 |
| Brother DCP-T520W（附加） | `192.168.2.174` | spooler | 1 条 null | `耗材条目无余量字段` | 1 |

- 四支各命中一次、无串支、无重复；5 张卡片的 `title` 悬浮文案均非空且与主行不矛盾。
- 真实形状数据回归：`Canon MF750C`（有 IP `192.168.2.213`）仍显示「未启用 SNMP」——有 IP 才允许说探测失败；`SHARP` 有 75% 液位不出空态。
- 控制台 0 exception / 0 React 警告。
- `tsc --noEmit -p tsconfig.web.json` 0 error；`npm run build` 退出码 0。

### 10.4 本轮回测

| 项 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.web.json` | 0 error |
| `npm run build` | 退出码 0（`dist/renderer/assets/index-BevN25Sy.js`） |
| 控制台（`?notes` 5 卡 + 真实形状 3 卡） | 0 exception / 0 React 警告 |
| 分支覆盖 | 4/4 各一次，另附第 5 支（非 SNMP 条目无余量） |

未运行 `npm run smoke`（Max-1 正在重跑，避免覆盖 `artifacts/`）。本轮仅改 `PrintersView.tsx` 一个函数 + 本报告，未触碰其他文件。

## 11. 修复轮 4（team-lead 修复 5：区分「未采样」与「采样中 n/8」）

### 11.1 背景与问题
team-lead 裁定质量置信门：`samples < 8` 时 `grade` 一律 `unknown`，`score` 仍算出数值（作为测量证据）。于是 `grade === 'unknown'` 有了两种成因，而 UI 原来一律写「未采样」：

- `samples === 0`：真的没采到（禁 ping / 未响应 ICMP）；
- `0 < samples < 8`：**正在采样**，已经拿到真实 RTT 却还没有评级结论。

启动后前 30 秒所有设备都在第二态。原来两种都显示「未采样」尚不算错，但评分环在 `unknown` 时**不画弧、不给分数**，把"已测到 14ms"也藏了；如果给 `unknown` 套红黄，则会出现"满屏质量差"的假事故。两者都不可接受。

### 11.2 单一判定入口
`lib/semantics.ts` 新增（三处调用方共用，杜绝各写各的）：

```ts
import { QUALITY_MIN_SAMPLES } from '../../shared/constants'   // 顶层导出，值 8

export type QualityPhase = 'unavailable' | 'sampling' | 'graded'

export function qualityPhase(samples: number, grade: string): QualityPhase {
  if (samples <= 0) return 'unavailable'                       // 从未拿到 ICMP 样本（可能禁 ping）
  if (samples < QUALITY_MIN_SAMPLES) return 'sampling'         // 0 < n < 8：采样中 n/8
  if (grade === 'unknown') return 'unavailable'                // 契约外兜底：n>=8 但样本全超时
  return 'graded'                                              // n >= 8：按 grade 上色
}
```

分母只有顶层常量一个来源（Max-1 已导出，`QUALITY.degradedMinSamples` 降级为同值 `@deprecated` 别名）；`isQualitySampled` 改为 `qualityPhase(...) === 'graded'`，不再是第二套判断。第 3 支的 `grade === 'unknown'` 守卫是契约外兜底（样本全部超时），保证既不会假装已评级、也不会画成 0 分。

### 11.3 三态的视觉与文案

| phase | 表格「质量」列 | 评分环 | 延迟/抖动/丢包 | 着色 |
|---|---|---|---|---|
| `unavailable`（`samples===0`） | `未采样` | 空环 + 中心 `—` + 角标「未采样」 | 「未采样」 | `--text-dim`，无弧 |
| `sampling`（`0<n<8`） | `采样中 5/8` | **中性灰弧 + 真实分数 76** + 角标「采样中 5/8」 | **照常显示真实值** | `--text-dim`（`arcStroke=var(--text-dim)`），不写"差" |
| `graded`（`n>=8` 且已有 grade） | `优/良/中/差` + 5 段条 | 原配色弧 + 分数 + 等级 | 原逻辑 | 沿用 ok/accent/warn/crit |

附加的诚实细节：
- `samples >= 8` 但 `grade` 仍是 `unknown`（例如样本全部超时、无有效 RTT）→ 环角标写「**无有效样本**」、表格 title 写「已发起 N 次 ICMP 采样但均未取得有效 RTT」，不再谎称"未采样"。
- 抽屉里 `延迟/抖动/丢包` 的红字阈值（>150ms / >=20%）只在 `graded` 生效；采样中即使 200ms 也不染红。RTT 迷你曲线同理（只有已评级且 poor 才画红）。
- 抽屉底部说明按 phase 分支：未采样讲「可能禁 ping」，采样中讲「已收到 5 个样本，累计 8 个后给评级，上方数值是已测得的真实值」。

### 11.4 统计与排序口径（要求 3、4）
- 总览「离线 / 降级」KPI 的降级数**改为本地派生**，不再直接用 `system.degraded`：
  `affected = (state==='degraded') + (grade==='poor' && samples>=8)`，`grade==='unknown'` 一律不计入；
  同时脚注补 `· 采样中 N 台`，让"为什么降级是 0"有解释。
  > 注意：这里是我**主动偏离**引擎汇总字段的一处，理由是你给的硬要求"unknown 一律不计入"。若引擎将来把 `unknown` 计入 `system.degraded`，UI 会与 `system.degraded` 不一致——以 UI 为准。
- 设备表「按延迟排序」：`grade==='unknown'` 一律垫底（同为 unknown 时样本多的在前），已验证排序结果为 `良(8ms) → 差(212ms) → 采样中(5 样本) → 未采样(0 样本)`，不会把 unknown 当 0 分顶到最前。
- 顶栏没有质量类统计，无需改动（`grep degraded` 在 `components/shell/**` 无命中）。

### 11.5 自检（`?quality` 模式：4 台设备覆盖三态 + poor）

表格实测：

| IP | 阶段 | 质量列 | 计算色值 | 段 |
|---|---|---|---|---|
| .10 | `samples=0` | 未采样 | `rgb(93,106,122)` = `--text-dim` | 无 |
| .11 | `samples=5` | 采样中 5/8 | `rgb(93,106,122)` = `--text-dim` | 无 |
| .12 | `samples=12 poor` | 差 | `rgb(139,152,169)` | `rgb(255,92,92)` = `--crit` |
| .13 | `samples=20 good` | 良 | `rgb(139,152,169)` | `rgb(76,154,255)` = `--accent` |

- 采样中行延迟 `14 ms`、丢包 `0%` **照常显示**（真实测量），未采样行两列均为 `—`。
- 抽屉：采样中 → `arcStroke=var(--text-dim)`、`valueFill=var(--text-dim)`、值 `76`、角标 `采样中 5/8`、三宫格 `14 ms / 2.1 ms / 0%` 均无 `data-tone`；未采样 → 无 `ring__arc`、值 `—`；已评级 poor → `arcStroke=var(--crit)`、值 `41`、角标 `差`、延迟 `212 ms@crit`。
- 文字未溢出：环 92px，`采样中 5/8` 盒宽 38px（角标字号降到 7.5px），与数值盒 y 不重叠。
- 总览 KPI 脚注：`降级 1 台 · 采样中 1 台 · ARP 缺席 3 轮才判离线`（1 = state degraded，采样中的 1 台与未采样的 1 台均未计入）。
- 排序：`192.168.2.13 | 良` → `192.168.2.12 | 差` → `192.168.2.11 | 采样中 5/8` → `192.168.2.10 | 未采样`。
- 控制台：0 exception / 0 React 警告（含 4 次视图切换 + 3 次抽屉切换）。

### 11.6 本轮回测

| 项 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.web.json` | 0 error |
| `npm run build` | 退出码 0（`dist/renderer/assets/index-CO9kn9WM.js`） |
| 耗材四分支回归（`?notes`） | 无 IP / SNMP 未报告 / 未启用 SNMP / 设备不报告耗材 + 第 5 支，各一次；0 串支 |
| 默认形状回归 | Canon MF750C（有 IP）仍「未启用 SNMP」，SHARP 75% 液位不出空态 |
| 性能（256 行 × 20 次推送，Edge+CDP 真实墙钟） | 21 样本 avg **6.9 ms**、稳态 3.4–8.2 ms、首帧 38.5 ms（含挂载），与首轮 3.99/20.6 同量级 |
| 截图 | `perf/q-devices.png`、`perf/q-drawer-sampling.png`、`perf/q-drawer-rated.png`、`perf/q-overview.png` |

本轮改动文件：`lib/semantics.ts`、`components/atoms/QualityBar.tsx`、`components/atoms/ScoreRing.tsx`、`views/DevicesView.tsx`、`views/OverviewView.tsx`、`views/DeviceDetailDrawer.tsx`、`styles/components.css`。未触碰 `src/main/**`、`src/shared/**`、配置、测试；未运行 `npm run smoke`。

### 11.7 三态判定复测（含 team-lead 指出的"写反"核对）

用 esbuild 直接打包 `qualityPhase` 做纯函数验证（`QUALITY_MIN_SAMPLES = 8`）：

| samples | grade | 返回 | 说明 |
|---|---|---|---|
| 0 | unknown | `unavailable` | 从未拿到样本（禁 ping） |
| 1 | unknown | `sampling` | 采样中 1/8 |
| 5 | unknown | `sampling` | 采样中 5/8 |
| 7 | unknown | `sampling` | 采样中 7/8 |
| 8 | good | `graded` | 按 grade 上色 |
| 12 | poor | `graded` | 按 grade 上色 |
| 12 | unknown | `unavailable` | 契约外兜底（样本全超时，不假装已评级） |
| 5 | good | `sampling` | 引擎契约外；不信任过早的 grade |

> 关于"`samples===0` 被当成采样中"：原实现的第 1 支就是 `if (samples <= 0) return 'unavailable'`，`0` 从未落进 `sampling`；本轮仍按你给的三支结构重写为 `0 → unavailable / <8 → sampling / >=8 → graded`，并采纳 `graded` 这个命名（原为 `measured`，语义相同）。
>
> 关于"缺 import 导致 smoke 炸"：那是我编辑中途的瞬时状态（先删了 `isQualitySampled` 的 import，随后才把使用处改掉）。当前树里 `DeviceDetailDrawer.tsx` / `OverviewView.tsx` 已**不再引用** `isQualitySampled` / `gradeTone`，`npx tsc --noEmit -p tsconfig.web.json` 实测 0 error、`npm run build` 退出码 0、无头渲染 4 次视图切换 + 3 次抽屉切换控制台 0 exception。冒烟截图请照常重跑，无需等我。

### 11.8 常量收口与口径注释（team-lead 复审后）

- `semantics.ts` 已直接 `import { QUALITY_MIN_SAMPLES } from '../../shared/constants'`，`TODO(constant)` 与本地定义都已删除；
  `grep -rn "TODO(constant)\|degradedMinSamples" src/renderer/` → **空**；`grep -rn "degradedMinSamples" src/ | grep -v shared/constants.ts` → 空。
  全项目字面量 `8` 只存在于 `src/shared/constants.ts:67`，UI 三个使用点（QualityBar / ScoreRing / ScoreRing 的 5/8、抽屉说明、总览派生）全部引用常量。
- `OverviewView` 的派生处补了你要的两条注释：一条说明「与 `system.degraded` 应相等，若不等以本处为准（unknown 不计入视觉告警）」，一条说明「`sampling` 必须单独计数并显示，否则用户看到降级 0 会误以为全健康」。
- 「· 采样中 N 台」脚注**保留**，实测输出：`降级 1 台 · 采样中 1 台 · ARP 缺席 3 轮才判离线`。
- 关于 `grade==='unknown' && samples>=8`：**保持 `unavailable`**，不改 `sampling`。原因：`sampling` 会让 UI 打印「采样中 12/8」，自相矛盾；而现有 `unavailable` 分支的文案已针对该情况特化——表格 hover「已发起 12 次 ICMP 采样，但均未取得有效 RTT，无法评级」、环角标「无有效样本」、中心显示「—」。既不谎称未采样，也不假装已评级。

回测：`tsc --noEmit -p tsconfig.web.json` 0 error；`npm run build` 退出码 0（产物哈希不变 `index-CO9kn9WM.js`，本轮只加注释）；无头复测总览脚注与三态，0 exception / 0 React 警告。

## 12. 修复轮 5（Ray R-01~R-04：带宽量纲、null 带宽、数据不完整角标、自动扫描文案）

### 12.1 R-01 带宽量纲 8 倍错误（P1）
**问题**：引擎的 `rxBps/txBps` 是 **bit/s**（`Δbytes × 8 / Δt`），UI 全部按 **B/s** 除以 1024 格式化。`11,285,049 bit/s`（11.3 Mbit/s ≈ 1.4 MB/s）被显示成 `10.76 M/s`——少一个 b、差 8 倍。运维据此判断链路是否打满，属于最不可接受的一类错误。

**修复**（`lib/format.ts` 整组替换，旧函数全删，避免再被误用）：
```ts
fmtBitRate(bps: number | null): string            // '11.3 Mbps' / '0 bps' / '—'
fmtBitRateParts(bps): { value, unit }             // KPI 分段排版
fmtBitRateCompact(bps): string                    // '11.3M'，单位由表头声明
```
SI 进位（1000），`>=10` 保留 1 位小数、`<10` 保留 2 位。

**改动点（3 处展示 + 2 处表头）**：

| 位置 | 改动 |
|---|---|
| 总览「全网带宽」KPI | `fmtBitRateParts`，脚注补「· bit/s ·」，hover 补「单位 bit/s」 |
| 总览「设备健康」表头 | `↓/↑ B/s` → `↓/↑ bit/s` |
| 设备表列 + 表头 | `fmtBitRate`；`↓/↑ 带宽` → `↓/↑ bit/s` |
| 详情抽屉带宽区 | `fmtBitRate`；「估算值」Hint 补「速率单位 bit/s」 |

实测（esbuild 打包纯函数）：`0 → 0 bps`、`999 → 999 bps`、`193405 → 193.4 Kbps`、`11285049 → 11.3 Mbps`、`2.5e9 → 2.50 Gbps`、`null → —`。全仓库 `grep fmtBps|fmtBytes` → 空。

### 12.2 R-02 带宽 null（本轮未采样）
`SystemStat.rxBps/txBps` 已为 `number | null`。KPI 用 `=== null` 判断（不是 `!rx`，避免把 0 当缺失）：
- 值显示 `—`（`data-empty` → `--text-dim`），单位段为空，**不写 0 bps**；
- hover：`本轮未能采样网络吞吐（网卡计数器读取失败或尚未建立基线）`；
- 脚注：`本轮未采到吞吐 · 2s 采样`。

实测 `?nullbw`：`kpi.text = "↓ — ↑ —"`、`title` 命中上述句子、两行 `data-empty="true"`。

### 12.3 R-03 数据不完整角标（`Snapshot.warnings`）
`TopBar` 新增 props `warnings: WarningEntry[]`（`App` 传 `snapshot?.warnings ?? []`，引擎未落地时不会崩）。顶栏数据源 chip 右侧出现**琥珀** `chip--warn`：

- 文案 `数据不完整 N`，`WARN_SOURCE_LABEL` 把 `discovery/printers/bandwidth/system` 译成 设备发现 / 打印机采集 / 带宽采集 / 系统信息；
- `title` 逐行列出前 5 条（来源 · message · 相对时间），超过 5 条追加 `…另有 N 条`；
- **不进入告警中心计数、不染红**——它是"某些数据源没采到"，不是故障。

实测三态：0 条 → 不渲染 chip；1 条 → `数据不完整 1`（title 2 行）；3 条 → 3 行详情；7 条 → 5 行 + `…另有 2 条`（title 共 7 行）。

### 12.4 R-04 关闭自动扫描的文案
- 顶栏倒计时位：`已暂停` → `自动扫描已关闭 · 仍持续监控`，hover 补「心跳 / 带宽 / 打印机采集仍在运行」；
- 状态条：`自动扫描已关闭` → `自动扫描已关闭 · 仍持续监控`；
- 该串是中文长句，等宽字体 + 52px 最小宽会撑开字距，故加 `.topbar__countdown[data-off='true']` 切回 sans、`min-width: 0`、`nowrap`。

实测 `?norun`：顶栏与状态条均为新文案，1440 宽无换行、无溢出。

### 12.5 回测
| 项 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.web.json` | 0 error |
| `npm run build` | 退出码 0（`index-D0pFMjxq.js` / `index-Cs2m8fbe.css`） |
| 控制台（5 个页面场景：默认 / nullbw / warn1 / warn3 / warn7 / norun） | 0 exception / 0 React 警告 |
| 截图 | `perf/r01-overview.png`、`perf/r01-drawer.png`、`perf/r02-null-bw.png`、`perf/r03-warn1|warn3|warn7.png`、`perf/r04-norun.png` |

未运行 `npm run smoke`；未触碰 `src/main/**`、`src/shared/**`。
