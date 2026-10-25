# 打印管理与路由器页面功能增强（task-024）

## Context

用户要求对打印管理和路由器两个页面进行功能增强与完善。现状：

- **打印管理**：`PrintersView` 已展示打印机卡片/耗材条/队列前 5 条，`PrinterManageView` 支持手动添加/忽略/别名；但**无任务操作**（取消/暂停/恢复）、**无打印机操作**（测试页/设默认）、队列无法看全、打印机 Web 管理页不能内置打开。
- **路由器**：`RouterView` 已展示网关/WAN/能力矩阵，OpenWrt ubus 登录后可看 DHCP 租约与无线客户端；但租约/客户端**与设备列表无联动**、WAN 流量**无趋势图**、**WiFi 状态（SSID/信道）未采集**、UPnP 能力未升级为通用数据通道（限制了非 OpenWrt 品牌可用性）。

用户已确认增强集：打印（任务操作 + 打印机操作 + 队列完整展示 + 打印机管理页内置浏览器打开）+ 路由器（设备联动 + WAN 趋势图 + OpenWrt WiFi 状态 + 适配更多路由器）。

## 已确认的复用点（探索结论）

1. `src/main/router-browser.ts` 的 `openRouterAdminWindow`：独立 BrowserWindow + `persist:router-admin` 分区 + 模块级单例 → 抽共享窗口参数，新增 `openPrinterAdminWindow(ip)`（独立单例 + `persist:printer-admin` 分区，无 Cookie 监视）
2. `App.tsx`：`detailId` state（L30）+ `openDetail`（L121），Drawer 挂 AppShell（L371）；`RouterView` 当前零 props（L302）→ 加 `devices` + `onOpenDetail` 两个 props 即可联动
3. `src/renderer/components/atoms/Sparkline.tsx` 已存在：`values: Array<number|null>`，null 断线不补 0 → WAN 趋势直接复用
4. 确认弹窗：PrinterManageView 的内联确认模式（`confirmRemoveIp` state，L45）→ 任务操作确认复用此模式
5. `RouterStatus.wan`（types.ts L459-467）：`ip/totalBytesRx/totalBytesTx/rxBps/txBps` 全 `number|null`
6. UPnP（router/upnp.ts）已实现 GetExternalIPAddress + GetTotalBytes* + Reboot → 只需补 `GetStatusInfo`
7. openwrt.ts 模式：`UbusClient.call(object, method)` + 纯函数 parser（parseDhcpLeases L93-116）→ getWirelessStatus 按同样式
8. `Printer.isDefault` 已存在（types.ts L115），PrintersView 已有"默认"chip（L174）→ A2 无需新增字段
9. exec 出口：`runPowerShell(code)` + `psJsonCommand` + `parsePsJson`（exec.ts L214-252）；测试页走 `runNative('rundll32', ...)`（铁律：MUI 程序不经 PowerShell）
10. 测试模式：`tests/printer-service.test.ts` 注入式探针；`tests/router-upnp.test.ts` 纯函数直测；exec 替换用 `vi.mock('../src/main/engine/exec')`（参考 tests/exec-fallback.test.ts）

## 实现步骤

### 第 1 步：shared 契约（types.ts + channels.ts）
- channels.ts 新增：`printerJobAction: 'printer:job-action'`、`printerPrintTestPage: 'printer:print-test-page'`、`printerSetDefault: 'printer:set-default'`、`printerOpenAdmin: 'printer:open-admin'`
- types.ts：
  - `export type PrintJobAction = 'cancel' | 'pause' | 'resume'`
  - `export interface WirelessBandStatus { device: string; ssid: string | null; channel: number | null; clientCount: number | null }`
  - `RouterStatus.wan` 增加 `connectionStatus: string | null; uptimeSec: number | null`
  - `RouterStatus` 增加 `wirelessStatus: WirelessBandStatus[] | null`（null=未登录/不支持，区别于 `[]`）
  - `session.kind` 联合类型增加 `'basic'`
  - `LanApi` 增加六个方法

### 第 2 步：engine 打印操作（新文件 `src/main/engine/printers/print-ops.ts`）
- `escapePsSingleQuoted(name)`：`'`→`''`，拒绝换行/反引号（纯函数可测）
- `cancelPrintJob / pausePrintJob / resumePrintJob(printerName, jobId)` → `Remove/Suspend/Resume-PrintJob -PrinterName '<esc>' -Id <id>`（jobId 强制数字校验）
- `printTestPage(printerName)` → `runNative('rundll32', ['printui.dll,PrintUIEntry','/k','/n', name], 'gbk', timeout)`——args 数组分离，名称含 `"` 直接拒绝
- `setDefaultPrinter(printerName)` → CIM `Win32_Printer` `SetDefaultPrinter`（psJsonCommand 包装）
- 统一返回 `{ ok: boolean; error: string | null }`；非零 exit/timeout 如实带出
- `Engine`（engine/index.ts）包装：`printerJobAction` / `printerPrintTestPage` / `printerSetDefault`——操作留痕 + 成功后 `void scheduler.refreshPrinters()`（与 addManualPrinter L188-190 同模式）

### 第 3 步：engine 路由器增强
- upnp.ts：`upnpQuery` 增加 `GetStatusInfo` SOAP → `UpnpSnapshot` 加 `connectionStatus` / `uptimeSec`（解析失败 null）
- openwrt.ts：新增纯函数 `parseIwinfoDevices` / `parseIwinfoInfo`（ssid/channel/assoclist 长度；形状不符全 null）
- router/index.ts doRefresh：
  - ubus 分支 `Promise.all` 追加 `iwinfo devices`，对最多 4 个设备逐个 `iwinfo info`（防超时膨胀）合成 `wirelessStatus`；sessionInvalid 逻辑照旧
  - WAN 区块写入 connectionStatus / uptimeSec
- router/detect.ts：`PageProbeResult` 增加 `auth: 'basic' | null`（401 + `WWW-Authenticate` 含 Basic）
- Basic-Auth 登录：ubus 登录失败且 detect 到 Basic challenge → 带Basic Authorization 头 GET 验证，200 即 `session.kind='basic'`（不解析页面内容）；logout 同步清 basic 态

### 第 4 步：IPC 路由与 preload
- ipc.ts 打印区（L110-121 后）追加 4 通道（action 白名单校验、ip 格式校验）
- preload.ts 补 6 个 invoke 方法

## 新增 IPC 通道清单

| 通道 | 参数 | 返回 |
|---|---|---|
| `printer:job-action` | `(action, printerName, jobId)` | `{ ok, error }` |
| `printer:print-test-page` | `(printerName)` | `{ ok, error }` |
| `printer:set-default` | `(printerName)` | `{ ok, error }` |
| `printer:open-admin` | `(ip)` | `{ ok, error, url }` |

## UI 改动

- **PrintersView.tsx**：队列项加"取消/暂停/恢复"小按钮，行内翻转为"确认？"（内联确认，busy 禁用）；新增 `printerExpandId` state（卡片间互斥展开），展开时显示全量任务；操作走 `window.lanApi.printerJobAction`
- **PrinterManageView.tsx**：监控表加 3 列——耗材摘要（取 levelPct 最低项；全 null 显示"不报告"）、队列长度、默认 chip + "设为默认"/"测试页"按钮；行尾"管理页"按钮（有 ip 时调 `printerOpenAdmin`）
- **RouterView.tsx**：
  - props 加 `devices: Device[]`、`onOpenDetail(id)`（App.tsx L302 传入）；租约/无线行按 `ip`/`mac` 匹配设备，命中显示 kind 徽标、整行可点开抽屉
  - WAN 卡内加两条 Sparkline（useRef 累积 rxBps/txBps，上限 60 点，null 断线，注明"基于推送累积"）
  - WAN 区块展示 UPnP 通道数据：connectionStatus/uptimeSec + 累计流量
  - 无线状态卡：wirelessStatus 每行 device/ssid/channel/clientCount，null 显示"—"
  - 会话 pill 增加 'basic' 分支文案

## 测试计划

- 新增 `tests/print-ops.test.ts`：vi.mock exec 出口；断言单引号转义（O'Brien → O''Brien）、jobId 非法被拒、非零 exit → `{ok:false,error}`、测试页走 runNative args 分离
- 扩展 `tests/router-upnp.test.ts`：GetStatusInfo 解析（正常/缺字段/Fault → null）
- 扩展 `tests/router-openwrt.test.ts`：parseIwinfoDevices/parseIwinfoInfo 形状防御
- 扩展 `tests/router-manager.test.ts`：wirelessStatus 写入与 sessionInvalid 联动、Basic-Auth 登录成功/失败
- 契约冻结靠 typecheck（LanApi/preload/ipc 三处同步）

## 验证

1. `npm run typecheck` 零错误
2. `npm test` 全绿（无新进程/网络）
3. `grep "from 'electron'" src/main/engine` 恒为 0
4. 手动：`npm run dev` → 取消一条测试任务；打印测试页；设默认后徽标刷新；打印机管理页弹出独立窗口；路由器页观察 Sparkline（约 20s 出首个点）、OpenWrt 真机看无线状态行

## 风险与注意点

- PowerShell 注入面：PrinterName 单引号转义 + 拒绝控制字符；jobId 强制数字
- printui 引号：`/n` 与名称 args 数组分离；名称含 `"` 拒绝；rundll32 走 GBK 通道不经 PowerShell
- 权限：取消他人任务可能失败，error 原样透出，UI 不吞
- UPnP 超时预算：每轮多 1 个 SOAP RTT；iwinfo 最多 4 设备，受既有 ROUTER.*TimeoutMs 约束
- SetDefaultPrinter 后 isDefault 需刷新才更新——操作成功即触发 refreshPrinters
- WAN Sparkline 样本稀疏：10s 轮询 + 前 2 轮 null，断线是预期诚实表现

## 明确不做

- 小米/华硕复杂表单登录适配（写入 ARCHITECTURE.md 未来项）
- 解析打印机/路由器 Web 管理页内容（只开窗口与登录态）
- Basic-Auth 会话下的页面数据抓取
- 跨打印机批量任务操作、任务重定向/优先级
- 租约/无线表的过滤、排序、导出
