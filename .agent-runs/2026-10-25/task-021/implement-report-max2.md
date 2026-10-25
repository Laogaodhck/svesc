# task-021 渲染层实现报告（Max-2）

日期：2026-10-25。实现范围：`brief-max2.md` 的 F1–F4 四项，文件边界内的 8 个文件（实际触碰 7 个，`views.css` 新增一个块）。

## 自检结果（全部通过）

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json` | **0 error** |
| `npm run typecheck`（tsconfig.node.json） | 0 error |
| `npx vitest run` | **31 files / 503 tests 全绿** |
| `npm run build` | 退出码 0（`index-SJGsG4ZA.js` / `index-Bt8-LWIo.css`） |
| 全局 `grep -rn "移动端" src/renderer/` | **无残留**（tests/ 里仅剩测试标题注释，无断言引用 `KIND_LABEL`） |
| 无头渲染核对（CDP + Edge，7 个场景） | 0 exception / 0 React 警告 |
| 未跑 smoke | 是（按惯例留 Vic） |

## F1 告警清除

**`AlarmsView.tsx`**
- props 新增 `onClear(id)` / `onClearRange(ids)` / `clearing: string | null` / `clearingAll: boolean`。
- 行内"清除"按钮（:345-357 区段）：`state !== 'cleared'` 时渲染（pending 与 acked 都有，cleared 无意义不渲染）；busy 防重入 `disabled={ackingAll || clearingAll || acking === a.id || clearing === a.id}`；进行中显示"处理中"。
- 工具栏"清除当前范围（N）"（:257-274 区段）：`N = 当前筛选范围内 pending+acked 条数`（`clearableIds`，cleared 不重复清除）；与"全部确认（N）"并排、同构；进行中显示"批量清除中…"。
- `TRACE_LABEL`（:43）加 `'cleared-by-user': '手动清除'`；时间线倒序展示自动纳入；操作人显示条件从 `t.type === 'acked'` 扩为 `acked || cleared-by-user`（:131），清除了 trace 账目里"有 by 却不显示"的不一致。
- view-desc 补一句语义：「也可手动"清除"（记录操作人；10 分钟内同因不再重复提示）」。

**`App.tsx`**
- `onClear`（单条）与 `onClearRange`（串行逐条，与 onAckAll 同构）直调 `window.lanApi.alarmsClear([id])`——`useLiveFeed.ts` 不在本次文件边界内，故未改 hook；成功后依赖主进程快照推送自动刷新，无轮询。
- 失败可见：新增 `clearError` state + 顶部独立 `banner`（与 feed.error 同样式、可关闭），文案「清除失败：<原因>」/「批量清除中断：<原因>」；批量失败**不中断**后续条目。
- `clearing` / `clearingAll` busy 态传给 AlarmsView，与 acking 互斥禁用。

**无头实测**：pending 行 = 确认+清除，acked 行 = 仅清除；点清除后 `__alarmsCleared=1`、列表行数 4→3、工具栏计数 4→3；「已清除」视图无清除按钮；a7 详情时间线显示 `2026-10-25 23:05:26 手动清除 （Administrator）`。

## F2 开机自启（SettingsView.tsx）

- 新组件 `LaunchAtLoginSwitch`（:51-116 区段，放在 SettingsView 前）：复用现成 `Switch` 与 `setMsg` 模式，插在"通用"卡「关闭时最小化到托盘」之后。
- `on` 初值取 `settings.launchAtLogin`，`disabled={!settings.launchAtLoginAvailable || busy || pending}`。
- **不本地乐观置位**：切换 → `setLaunchAtLogin(next)` → `ok:false` 时 msg 条显示返回的中文 error；成功后 `settingsGet()` 回读，用回读值刷新开关与成功文案（「已开启/已关闭开机自启」）。OS 是唯一事实源，不写 store。
- hint 双态：可用 → 「开机后自动在后台启动并常驻托盘」；`launchAtLoginAvailable === false` → 「开发模式下不可用，请使用安装版」且开关禁用。

**无头实测**：切换后 `aria-pressed` 由 false→true、msg=「已开启开机自启」、`window.__launchAtLogin=true`；`?noLal` 场景 disabled=true 且 hint 为"开发模式下不可用，请使用安装版"。

## F3 手机标识（format.ts:139）

- `KIND_LABEL.mobile: '移动端'` → `'手机'`。列表类型列、类型筛选下拉、详情两处都走 KIND_LABEL，自动同步。
- 全局检查：`src/renderer/` 无"移动端"残留；`tests/` 仅 3 处测试标题注释（`fingerprint.test.ts` 的 describe/it 文案），无对 `KIND_LABEL` 的断言，503 测试全绿。
- 未做图标化（裁定范围外）。

**无头实测**：类型下拉选项含「手机」，无「移动端」。

## F4 无流量归集一等公民化

**DevicesView.tsx**
- 流量状态筛选（toolbar，类型下拉之后）：`全部流量 N / 可归集 N / 不可归集 N` 三段 segmented，按 `bandwidth.attributable` 判定，每档带计数与 hover 口径说明；`resetFilters` 一并重置；筛选/排序变化重置分页的 effect 依赖已补 `traffic`。
- 排序：`SortKey` 加 `'lanConnections'`（`SORT_LABEL: '活跃连接'`），按 `bandwidth.connections` 数值排序；下拉选中该键时**默认降序**（"谁连得多"），表头点击仍可切换方向。带宽 cell 的 hover 追加真实连接数：`（活跃连接 N）`——排序依据可被用户验证。
- 红线复查：不可归集分支仍显示「无流量归集」（`data-empty="true"`），无任何 `0 bps`/`0 Kbps` 路径；`fmtBitRate` 对负数/非有限值同样返回 `—`。

**OverviewView.tsx**
- KPI 区新增第 6 张卡「可归集设备」：`{x} / {y} 台在线`（x=attributable 台数，y=在线设备总数，均由 devices 本地派生）；副文案「仅统计与本机的 TCP 会话」；卡头「口径」chip + value hover 说明「不可归集 ≠ 离线，只是没有与本机的 TCP 会话」。

**DeviceDetailDrawer.tsx + views.css**
- 带宽口径说明从悬浮 title 升级为**常驻说明块** `.bw-note`（views.css:文件尾新增，含 `[data-tone='warn']` 琥珀描边变体）：
  - `attributable=true`：中性描边，「估算值：按网卡计数器与本机 TCP 连接占比分摊；流量统计仅覆盖与本机的会话，不是设备级流量镜像。」
  - `attributable=false`：琥珀描边，「该设备未与本机建立 TCP 会话，流量无法归集；流量统计仅覆盖与本机的会话，不代表设备没有流量。」（原 `p.note` 的"不显示 0 值"解释合并进 hover/既有分支，正文不再出现"0 值"字样以免误导）
- 无流量归集分支仍显示「无流量归集」+ `data-empty`，不回归。

**无头实测**：KPI `1 / 52 台在线`（mock 56 台中 1 台 attributable）；筛选三段计数 `56 / 1 / 55`，选「不可归集」后 55 行且每行都含「无流量归集」；「按活跃连接排序」默认降序，首行连接数 6→2→0→0 与 hover 数值一致；抽屉两种 `.bw-note` 文案/描边各就位。

## 与冻结形状的对照

| 冻结接口 | 现状 | 消费点 |
|---|---|---|
| `alarmsClear(ids: Alarm['id'][]): Promise<void>` | 已落地（types.ts:337 / preload.ts:41） | App.onClear / onClearRange，单条传 `[id]` |
| `setLaunchAtLogin(on): Promise<{ok, error}>` | 已落地（types.ts:362 / preload.ts:70） | LaunchAtLoginSwitch.onToggle |
| settingsGet 增 `launchAtLogin` / `launchAtLoginAvailable` | 已落地（types.ts:164/166） | LaunchAtLoginSwitch 初值与回读 |
| `AlarmTraceEntry.type` 增 `'cleared-by-user'` | 已落地（types.ts:246，含 by 语义注释 :247） | TRACE_LABEL + 操作人显示 |

四项全部按形状消费，未自行修改任何 types/channels/preload/global.d.ts。

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/renderer/views/AlarmsView.tsx` | F1：props、行内清除、范围批量按钮、TRACE_LABEL、操作人显示、view-desc |
| `src/renderer/App.tsx` | F1：onClear/onClearRange/clearing/clearingAll/clearError + 清除错误 banner + AlarmsView 传参 |
| `src/renderer/views/SettingsView.tsx` | F2：LaunchAtLoginSwitch 组件 + 通用卡挂载 |
| `src/renderer/lib/format.ts` | F3：KIND_LABEL.mobile = '手机' |
| `src/renderer/views/DevicesView.tsx` | F4：TrafficFilter 筛选、lanConnections 排序、带宽 cell hover 补连接数 |
| `src/renderer/views/OverviewView.tsx` | F4：可归集 x/y KPI 卡 + trafficStats |
| `src/renderer/views/DeviceDetailDrawer.tsx` | F4：两分支常驻说明块 |
| `src/renderer/styles/views.css` | F4：`.bw-note` 样式（含 warn 变体） |

## 遗留风险与说明

1. **清除错误条与确认错误条分属两套**：确认失败走 `feed.error`（hook 内），清除失败走 App 本地 `clearError`（hook 不在本次边界内）。视觉一致（同 `.banner`），文案都有中文原因；若后续统一，建议把 alarmsClear 收进 useLiveFeed 并合并错误通道。
2. **批量清除的中间态可见性**：串行逐条期间每完成一条，快照推送会让列表实时缩短——用户能看到进度，但没有"N/M"式进度文案（与"全部确认"行为保持一致，未超范围）。
3. **「按活跃连接排序」的可见性**：表格没有独立的连接数列（避免超范围），排序依据放在带宽 cell 的 hover 里（`（活跃连接 N）`）。若 Vic 验收认为不够直观，最小增补是在不可归集 cell 内加一行灰色小字，需要队长点头。
4. **开机自启的回读刷新**：切换成功后调用一次 `settingsGet()`（额外一次 IPC，非轮询）。若主进程未来把回读结果直接放进 `setLaunchAtLogin` 返回值，可省掉这一次调用。
5. `mobile` 相关引擎侧识别增强（RE_MOBILE_HOST / osHint「手机（主机名特征）」）归 Max-1，渲染层只消费 KIND_LABEL，无耦合。
