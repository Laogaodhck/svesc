# 代码审查报告 — SVESC 局域网监控台（task-001 / P4）

| 字段 | 值 |
|---|---|
| 审查员 | Ray（code-reviewer） |
| 审查对象 | `C:/github/svesc` 全部 `src/**`（engine 23 + main 4 + renderer 27 文件）、`scripts/**`、`tests/**` |
| 基准 | `plan.md` §5/§5.1/§5.2/§5.3、`ARCHITECTURE.md`、`brief-ray.md` |
| 约束遵守 | 只读；仅写入本文件；未执行 `npm install`；未改动任何源码/测试/配置 |
| 结论 | **修复后交付**（0 × P0，6 × P1，17 × P2；必须修 R-01～R-06） |

---

## 1. 审查范围与方法

### 1.1 逐行读过的文件（按风险优先级）

| 区域 | 文件 |
|---|---|
| 子进程 / 编码 | `engine/exec.ts`（全 216 行逐行） |
| BER / SNMP | `printers/snmp-ber.ts`、`snmp-client.ts`、`printer-mib.ts` |
| PowerShell 站点 | `printers/spooler.ts`（全部 4 个 spawn 站点）、`printer-service.ts`、`ipp.ts`、`mdns.ts` |
| 编排 | `engine/scheduler.ts`（全 788 行逐行）、`alarms.ts`、`store.ts`、`index.ts`、`check.ts`、`soak.ts` |
| 探测 | `discovery/{subnet,arp,ping,ports,index}.ts`、`network/{quality,monitor,bandwidth}.ts` |
| IPC / 安全边界 | `main/{index,ipc,preload,smoke}.ts`、`shared/{types,constants,channels,global.d}.ts` |
| UI | `renderer/App.tsx`、`views/*`（4 视图 + 抽屉）、`hooks/*`、`lib/*`（format/semantics/perf）、`components/atoms/{LevelBar,Bar,Sparkline,ScoreRing}.tsx`、`shell/{TopBar,StatusBar}` |

### 1.2 用于验证怀疑的命令（全部只读）

```
grep -rn "exec(\|execSync\|shell: *true\|shell:" src/ scripts/        # 13 命中，全部是 RegExp.exec
grep -rn "spawn(" src/ scripts/                                      # 3 命中：exec.ts:104 + 2 个脚本
grep -rn "from 'electron'\|require('electron')" src/main/engine/     # 0 命中
grep -rln "electron" src/main/engine/                                # 5 文件，全部是注释里的"不含 electron"
grep -rn "?? 0\b|?? '0'| || 0\b" src/                                # 18 命中，逐条分类（见 §4.4）
grep -rn "signal" src/main/                                          # AbortSignal 仅在 ports.ts 声明，生产路径未传
grep -rn "parseWarning" src/ tests/ scripts/                         # 生产侧 0 消费点（仅测试断言）
grep -rn ": any\b|as any|<any>" src/                                 # 0 命中
grep -rn " as [A-Z][A-Za-z]*\b" src/main src/shared                  # 13 命中（全部 Tlv 索引 / JSON.parse）
grep -rn "settings.autoScan" src/main/                               # 1 命中（只写不读）
grep -rn "SCHEDULE\." src/main/                                      # 4 命中，周期全部硬编码常量
npx tsc --noEmit -p tsconfig.node.json                               # 0 error
npx tsc --noEmit -p tsconfig.web.json                                # 0 error
npx vitest run                                                       # 12 files / 274 tests 全绿（3.44s）
```

### 1.3 方法说明

- 每个结论都先 `grep` 出**全部**命中点再逐条读代码，不做抽样外推。
- 对 P0 三个面（命令拼接 / BER / IPC）采取"正面证伪"：先假定有问题，找不到可触发路径才写"未发现"，并记录用哪条命令排除。
- 作者自述（`implementation-report.md` / `ui-report.md` / `ARCHITECTURE.md`）只当线索，不当依据；第 5 节列出与自述冲突处。

---

## 2. 问题清单

> 位置格式 `文件:行`。严重级：P0 安全/数据破坏；P1 正确性/诚实性/静默失败；P2 可维护性/健壮性/次要正确性。

| 编号 | 位置 | 级 | 问题 | 触发条件 | 最小修复建议 |
|---|---|---|---|---|---|
| R-01 | `engine/network/bandwidth.ts:78` ↔ `renderer/lib/format.ts:13-24`、`views/OverviewView.tsx:236`、`views/DeviceDetailDrawer.tsx:319` | P1 | **带宽单位错配 8 倍**：引擎算的是 bit/s（`Δbytes×8/Δt`），字段名 `rxBps` 也是 bit/s，但 UI 全部按 **B/s** 格式化（除以 1024、单位写 `B/s`/`KB/s`/`MB/s`） | 任何一次带宽采样都会触发；如报告自述 `txBps=11,285,049`（≈11.3 Mbit/s）在 UI 上显示为 `10.76 M/s`（≈86 Mbit/s 的观感） | 在 `format.ts` 增 `fmtBitRate(bps)`（bps/Kbps/Mbps），三处带宽展示改用它；`OverviewView.tsx:236` 表头 `B/s` 改为 `bit/s` |
| R-02 | `engine/scheduler.ts:684-685`、`engine/network/bandwidth.ts:157-170`、`views/OverviewView.tsx:82` | P1 | **系统级带宽把"没采到"兜成 0**：`rxBps: bandwidth?.rxBps ?? 0`；`BandwidthSample.error` 与 `sample===null` 两条失败路径都被压成 `0`，UI 显示 `0 B/s`（会被读成"真实测得的零流量"），违反 plan §5.1 / D-005 | 启动后首 2s（`last===null`）、`netstat -e` 解析失败、netstat 被安全软件拦截 | 契约层（需队长批准）：`SystemStat` 增 `bandwidthAt:number\|null` 或 `attributable:boolean`；在此之前至少让 UI 在 `!snapshot.system.lastScanAt || rx===0 && 无法区分` 时显示 `—` |
| R-03 | `engine/scheduler.ts:387`、`:429`、`:344-345`、`:347-349`、`:712-719`；`discovery/arp.ts:87-88` | P1 | **解析告警与采集错误全部丢弃 = 静默失败**：`readArp(...).entries` 只取 entries，`parseWarning` 从不消费；`collectPrinters().errors` 被丢弃；`refreshPrinters` / `emitSnapshot` 用 `catch {}` 吞异常 | (a) `arp -a` 编码/locale 变化导致 0 条 → 界面显示"尚未发现设备"，用户以为网段没设备；(b) spooler 权限/执行策略失败 → 打印机页显示"该网络内没有响应 9100/631 的打印设备"（`PrintersView.tsx:345-354`），与事实相反；(c) `buildSnapshot` 抛错 → 界面冻结在上一帧且无任何提示 | 快照增 `warnings: string[]`（引擎侧收集 `arp.parseWarning` / `spooler.errors` / `collectPrinters.errors` / 各 catch 的 err.message），顶部 banner 渲染；至少 `console.error` 并保留错误计数 |
| R-04 | `engine/scheduler.ts:184-193`、`:208-220`；`renderer/components/shell/TopBar.tsx:89-99` | P1 | **关闭"自动扫描"会停掉全部采集**：`setAutoScan(false)` → `clearTimers()` → `installTimers()` 因 `!autoScan` 直接 return，于是 2s 带宽、5s 心跳、15s 质量、15s 打印机、60s 扫描**五个定时器全部消失** | 用户点顶栏"自动扫描"开关关闭 → 带宽数字冻结、打印机状态不再刷新、告警不再产生且不恢复，UI 仍显示 `已暂停`（用户理解为"只是不扫网段了"） | 拆成两个开关/两层：`autoScan` 只控制 `SCHEDULE.fullScan` 定时器；bandwidth/heartbeat/printers 保持运行（心跳仍需驱动在线判定）。或至少把开关文案改成"暂停全部采集"并在 UI 明示"数据已停止更新" |
| R-05 | `engine/exec.ts:124-131`、`:133-150`、`:174-187`；影响面 `spooler.ts:232/247/253/259/266` | P1 | **硬超时不是硬保证**：超时只做 `child.kill()`，Promise 仅由 `close`/`error` 结算；`kill` 后没有兜底 settle。`runPowerShell` 的 `powershellGate`(limit=1) 只在 `runNative` settle 后 `release()` | 任一 PowerShell 子进程被 kill 后仍未触发 `close`（Windows 上子进程再派生进程并继承 stdout 管道时 `close` 不派发，Node 已知行为）→ 该 Promise 永不 settle → **单飞闸门永久占用** → 之后所有 `readSpooler()` 永久挂起 → 打印机面板永久停更且 `printersInFlight` 永为 true；若 `childGlobal` 泄漏 64 次则整机探测停摆 | `timer` 内 `kill()` 后再挂 500ms 兜底 `finish(null)`；Windows 用 `taskkill /PID <pid> /T /F` 杀进程树；`runPowerShell` 增整体超时兜底 |
| R-06 | `engine/scheduler.ts:413-421`、`:249`、`:525-537`、`:543-547`、`:129` | P1 | **离线判定时序与语义偏离文档 + 状态字段不清零**：(a) `runFullScan` 只对存活主机 `pingAlive=true`，从不把超时主机置 `false`；(b) `applyArpPresence` 在 **5s 心跳**里也会推进 `arpMissStreak`，所以"ARP 连续 3 轮缺席"实际是 **15 秒**，而文档语义是 3 个扫描轮（60s×3）；(c) `updatePortResponders()` 用上一轮的 `openPorts` 把 `portResponded` 置回 true，且 `applyArpPresence` 因此在心跳里不断 `lastSeen = now` | (a) 关闭自动扫描（见 R-04）或无心跳时，`pingAlive` 永远为真 → **永不判离线**；(b) 对"禁 ICMP + 无被探端口"的静默主机：ARP 条目老化（Windows 约 30-120s）→ 15s 后判 offline 并产生 `DEVICE_OFFLINE` critical → 下一轮全量扫描 ping 触发 ARP 复活 → 再老化 → **每 60-90s 一条 critical 抖动告警**，正是 D-002 想消灭的噪音；(c) "最后发现 X 秒前" 被陈旧标记刷新，属于展示层不实 | (a) 全量扫描对每个 host 显式写 `rec.pingAlive = result.alive`；(b) `arpMissStreak` 只允许在**扫描轮**推进（心跳路径只更新 `lastSeen`，不推进离线计数）；(c) `updatePortResponders()` 只在"本轮真实探测过"的记录上置 true（记录本轮 `probedAt`） |
| R-07 | `engine/printers/printer-service.ts:429`（配合 `:343`、`:379`） | P2 | `applyMdnsHints` 在**探活与 `reachable` 落表之后**才改写 `printer.ip`：该 IP 从未被 `probePrinterEndpoint` 验证，`reachable` 里也没有这个 id，`state` 仍是 spooler 的判定 | 启用 mDNS（`useMdns=true`）且 spooler 打印机无 IP、名称与 mDNS 实例模糊匹配（`includes` 双向包含）→ 出现"有 IP 但从未探活"的打印机，且永远不会产生 `PRINTER_OFFLINE` | 把 mDNS 补齐移到循环之前（先定 `ip` 再探活），或补齐后重跑一次 `probeOf(ip)` 并写入 `reachable` |
| R-08 | `engine/printers/printer-service.ts:406` | P2 | 纯网络打印机（spooler 里没有）`state = probeInfo.reachable ? 'idle' : 'offline'`：仅凭 TCP 端口可达就断言 `idle`（待机），我们没有设备状态证据 | 任何 9100/631/515 可达的打印机 → 卡片显示"待机"，与真实"卡纸/缺纸"无关，属于无证据下结论 | `reachable ? 'unknown' : 'offline'`；或在有 SNMP `hrDeviceStatus` 时用它覆盖（当前 `hrStatus` 只进了 `panelText` 文本） |
| R-09 | `engine/printers/printer-service.ts:388`、`:216`（`sources` 未用） | P2 | `source: consumables.length>0 ? 'both' : 'spooler'`：耗材若来自 **IPP**（未连 SNMP）也会被标成 `both`=「SNMP + 队列」，UI 徽标（`PRINTER_SOURCE_LABEL`）就此撒谎；`resolveConsumables` 明明算了 `sources` 却在 `collectPrinters` 里被丢弃 | 只有 IPP 提供耗材的机型（D-008 的目标场景） | `source` 由 `sources` 推导：含 `snmp`→`both`；仅 `ipp`→ 扩枚举或回退 `spooler` 并在 UI 用耗材来源徽标表达，不要写成 `both` |
| R-10 | `engine/printers/spooler.ts:196`（`parsePsDate` 返回 0）、`:211-213`（`pages ?? 0`） | P2 | `SubmittedTime` 缺失/不可解析时返回 `0` → UI `relTime(0)` 显示"1970-01-01"式绝对时间；`pages: row.TotalPages ?? 0` 把"未知页数"记为 0（契约 `pages:number` 逼的，但叠加 `job.pages>0` 判断会走到"页数未知"分支，逻辑自洽，仅契约本身不诚实） | `Get-PrintJob` 未返回 `SubmittedTime`（Win32_PrintJob 回退路径常见） | `parsePsDate` 返回 `number \| null`，`submittedAt` 侧用 `null` 表示未知（需队长批准契约调整）；临时方案：UI 对 `submittedAt<=0` 显示"—" |
| R-11 | `engine/printers/spooler.ts:299` | P2 | `fallbackUsed = cim.error !== null`：字段语义是"主源失败改用 Win32_Printer 回退"，却用 `cim` 读取错误赋值（`cim` 是补充源，与回退无关），该字段当前无消费点 | spooler 主源失败但 `cim` 成功 → `fallbackUsed=false`（反了） | 由 `readPrinters()` 返回真实回退标记并透传；或删除该字段 |
| R-12 | `engine/printers/printer-service.ts:305-391`（循环内 `await`）、`:353-366`、`ipp.ts:117-129`、`snmp-client.ts:49` | P2 | 打印机耗材采集**逐台串行**，单台最坏 ≈ 0.9s(SNMP 超时) + 2.5s×2(IPP 两条路径) + ≤2.1s(端口探活) ≈ 6-8s，串行累积可超 15s 打印周期（`printersInFlight` 会直接丢弃下一轮） | 打印机 9100 可达、161 被防火墙拦截、631 接受 TCP 但不响应 IPP（半开端口） | 逐台 `Promise.all`（并发 3-4）或把 provider 探测改为整体并发；给 `collectPrinters` 加总预算（如 8s）后截断 |
| R-13 | `engine/printers/snmp-client.ts:188`、`:143`、`snmp-ber.ts:303-343` | P2 | (a) `ok = collected.length>0 && lastError===null`：walk 因 `maxSteps` 截断时仍返回 `ok:true`，调用方无法区分"表读完"和"读到一半"（`stoppedBy` 有值但无人看）；(b) `opts.maxColumns` 声明后从未使用；(c) `parseResponse` 不校验 `pduTag===0xA2`（GET_RESPONSE）、不校验 version，任意 PDU 类型都能被当响应解析 | 设备耗材表 >80 条（`maxSteps:80`）时静默少报耗材；伪造/错包只要 requestId 命中也会被接受 | `ok` 改为 `stoppedBy==='subtree-end'` 或把 `stoppedBy` 上抛到 `ConsumableProviderResult.error`；删除 `maxColumns`；`parseResponse` 增加 `pduTag`/`version` 断言 |
| R-14 | `engine/discovery/ping.ts:99`、`:167`；`discovery/ports.ts:39`；`printers/ipp.ts:91` | P2 | plan §5.3 要求"IP 使用前过 `isValidIpv4` + 0-255 复核"，实际**只有** `snmp-client.ts:108/148` 做了；`ping`/`probePort`/`ipp` 把入参直接当 argv 与 `http.request host` | 当前所有入参来自 `buildHosts()`（生成式）与 `arp` 正则，**无 shell，故不构成 P0**；但下游任何新调用方（如将来接用户输入/持久化 IP）都会把 `-t`、`-n 100` 之类选项注入 ping.exe | 在 `pingHost`/`pingQuality`/`probePort`/`ippGetAttributes` 入口加 `isValidIpv4()` 守卫并返回失败结果 |
| R-15 | `renderer/App.tsx:39`；`hooks/useLiveFeed.ts:57-61`；全仓无 `pct` 渲染 | P2 | `scanning = system?.scan?.active ?? feed.progress?.active ?? false`：`??` 只在 `null/undefined` 时回退，而 `system.scan.active` 恒为 boolean（上一轮快照的 `false`），因此 **`lan:scanProgress` 推送（含 `pct/phase/scanned`）在渲染层完全无效**；且全仓没有任何进度条 UI | 自动扫描（定时器触发）期间 `runFullScan` 只 `emitProgress()` 不 `emitSnapshot()`，快照里的 `scan.active` 仍是上一轮 `false` → 顶栏不显示"扫描中"、也没有任何进度 | 改成 `const scanning = feed.progress?.active ?? system?.scan?.active ?? false`；若要兑现 ARCHITECTURE §7 的"进度条"，需补一个 `pct` 进度条组件 |
| R-16 | `renderer/views/DeviceDetailDrawer.tsx:111-126` | P2 | 历史曲线在快照更新时本地"追加一点"：`rtt: device.quality.latencyMs`（**窗口平均值**）被当成一次新的 RTT 采样画进曲线 | 抽屉停留超过一个心跳（5s）→ 每次快照都新增一个点，曲线出现"平滑复制点"，且与真实逐次采样混在同一序列 | 只在 `detail.history` 上做展示，不本地追加；或追加时 `rtt: null`（断线）以表达"这轮没有新样本" |
| R-17 | `engine/scheduler.ts:184-193`、`:213-220`；`engine/index.ts:47-48`、`:104-108` | P2 | (a) `setAutoScan(enabled, intervalSec)` 声称改周期，但真实定时器固定用 `SCHEDULE.fullScan`(60000)，`intervalSec` 只影响倒计时显示 → 倒计时每轮末尾会长时间停在 `0s`；(b) `store.settings.autoScan` 每次保存，但启动时只读 `autoScanIntervalSec`，用户"关闭自动扫描"的偏好在重启后失效 | 任何调用 `setAutoScan(true, 30)` 的路径；或用户关闭自动扫描后重启应用 | 定时器用 `cfg.autoScanIntervalSec*1000` 或从 `setAutoScan` 重建；启动时 `this.autoScan = store.settings.autoScan ?? …` |
| R-18 | `engine/check.ts`（76 行）、`engine/soak.ts`（241 行）；`engine/simulator.ts:13-14`+`:96-113` | P2 | 分层洁净：`check.ts`/`soak.ts` 是"验证取证工具"却放在 `engine/` 内（`soak.ts` 还反向依赖 `./index` 的 `createEngine`，并在生产源码里保留 `fakeDevice` 测试替身）；`simulator.ts` 注释宣称"同一种子 → 同一世界，便于截图复现"，实际 `tick()` 每次都消耗 `this.rand()`，每次快照的模拟延迟/抖动都不同 | 任何 `npm run soak` / `engine-check` 的维护者会误以为它们属于运行时引擎；截图逐帧不同使"确定性复现"不成立 | 把 `check.ts`/`soak.ts` 移到 `scripts/` 或 `tools/`；`Simulator` 用 `子种子 = seed ^ idx` 每帧独立 PRNG，或把注释改成"同一次 tick 内确定" |
| R-19 | `shared/constants.ts:10-23` vs `renderer/lib/format.ts:198-219`；`constants.ts:33/42/46/119/125`；`renderer/lib/semantics.ts:15-19`；`constants.ts:77-78` | P2 | 单一来源被破坏 + 死代码：`PORT_SERVICE` 有两份（值不一致：`shared` 缺 23/53/135/902/1433/3306/5432/5900/8080/8443，`format` 多出 `9100:'RAW-Print'` vs `'JetDirect'`）；`PRINTER_PROBE_ORDER`、`TIMEOUTS.portsSweep`、`CONCURRENCY.portSweep`、`OUI_TABLE_MIN_ENTRIES` 全仓 0 引用；`semantics.ts` 留着"Max-1 将在 constants 顶层导出 QUALITY_MIN_SAMPLES"的过期 TODO（该常量早已存在于 `constants.ts:67`）；被标 `@deprecated` 的 `QUALITY.degradedMinSamples` 仍有 6 处使用 | 改端口服务名时两份会漂移；新同学按 TODO 去改已经改好的地方 | 渲染层从 `shared/constants.ts` 导入 `PORT_SERVICE`（或做一次合并）；删除 0 引用常量与过期 TODO；把 `degradedMinSamples` 的消费点改为 `QUALITY_MIN_SAMPLES` |
| R-20 | `renderer/components/shell/TopBar.tsx:7`、`StatusBar.tsx:14`；`App.tsx:198/201`；`engine/store.ts:64` | P2 | 类型诚实：(a) shell 组件把 `dataSource` 放宽成 `string`，于是 `App` 传入了契约外的 `'unknown'`——冻结契约 `DataSource` 的三值约束在渲染层被绕过；(b) `store.ts:64 (obj.alarms as Alarm[])` 对磁盘数据零校验（与此前修过的"provider 强转 TypeError"同类）；(c) `App.tsx:201` 默认 `autoScanIntervalSec ?? 30` 与真实默认 60 不一致 | (a) 将来主进程新增数据源值时 UI 静默走 `isDemo` 分支；(b) 手工编辑或语义损坏的 `state.json`（可解析但字段错）会把坏告警灌进 `AlarmEngine`（缺 `targetId` → `dedupeKey` 变 `CODE:undefined` 互相覆盖） | (a) 用 `DataSource \| 'unknown'` 或让 App 用 `'unknown'` 前先判定；(b) 逐字段校验/丢弃非法告警；(c) 默认值统一取常量 |
| R-21 | `main/index.ts:24`（`no-sandbox`）、`:49`（`sandbox:false`） | P2 | 安全加固被过度关闭：`app.commandLine.appendSwitch('no-sandbox')` 关闭 Chromium 渲染进程 OS 沙箱，`sandbox:false` 让 preload 保有完整 Node 能力。ARCHITECTURE §8 只论证了 `disable-gpu` 的必要性，未提 `no-sandbox` | 当前只加载本地 `dist/renderer/index.html`、无远程内容，实际暴露面小；但一旦将来引入外链/预览图/iframes，XSS 直接等于任意代码执行 | 去掉 `no-sandbox`（先验证 GPU 崩溃是否仅由 `disable-gpu` 解决）；`sandbox` 保持 false 时在 ARCHITECTURE 里显式登记为"已知例外" |
| R-22 | `engine/scheduler.ts:549-569`（records 只增不删）；`discovery/index.ts:26-30`（DNS 缓存无上限）；`scheduler.ts:466-472` | P2 | 长跑资源：`records` 与 `QualityTracker.windows`、`ReverseDnsCache.cache` 都没有驱逐策略；`lookupMany` 用 `Promise.race` 1.5s 截断，但后台查询仍在跑，下一轮会对同一批 IP 再发一次（缓存只在完成后写入） | 长期运行 + 网段内 DHCP 频繁换机 → 设备列表与内存单调增长（UI 表格也会越滚越长）；无 DNS 服务器时每轮重复付出 800ms×N | 给 `records` 加 TTL 驱逐（如离线超 24h 清除），DNS 缓存加 LRU 上限 + "查询中"占位 |
| R-23 | `renderer/hooks/useLiveFeed.ts:50-61` | P2 | 契约声明 3 个订阅（`onSnapshot/onScanProgress/onAlarm`），实际只订阅 2 个，`lan:alarm` 推送无人接收 | 主进程 `pushAlarm` 每次都发，渲染层丢弃；新告警只能等下一次快照（≤2s） | 要么订阅并做角标/toast，要么从契约与 `preload` 移除 `onAlarm` |

---

## 3. P0/P1 逐条论证

### 3.1 关于 P0（结论：三条面均未发现 P0 缺陷，论证见 §4.1-§4.3）

审查员重点找了四类 P0，均**未能构造出可触发路径**：
命令注入（无 shell、无字符串拼接、PowerShell 无插值）、BER 内存放大与死循环（长度域先验边界）、IPC 提权（preload 不透传、contextIsolation 开启）、以及"把 null 兜成 0 造成运维误判"（`levelPct/pageCount/score` 无一处兜底）。

真正接近 P0 的是 **R-01（带宽 8 倍单位错配）** 与 **R-02（系统带宽 0 兜底）**：两者都不破坏数据、不越权，但会让运维把 8 Mbit/s 读成 86 Mbit/s、把"没采到"读成"零流量"。按本项目"数据诚实第一原则"，我给 P1。

### 3.2 R-01 带宽单位错配（P1）

证据链：

1. `bandwidth.ts:72-82` 的 `bpsFromDelta`：`rxBps = Δbytes × 8 / seconds` → **bit/s**。单测（`tests/bandwidth.test.ts`）也按 bit 断言：`(100,200)@2s → rxBps:400`。
2. `ARCHITECTURE.md` §5 写的公式同样是 `bps = Δbytes × 8 / Δt`。
3. `format.ts:13-24` `fmtBps(bps)`：按 1024 递进，单位表是 `['B','KB','MB','GB','TB']` + `/s` → **字节/s**。
4. `OverviewView.tsx:82` 直接 `fmtBpsParts(system.rxBps)`；`:236` 表头写 `↓/↑ B/s`；`DeviceDetailDrawer.tsx:319/325` 用 `fmtBps`。

后果量化：`implementation-report.md:142` 自述实测 `txBps=11,285,049`。真实含义 = 11.3 Mbit/s（约 1.4 MB/s）。UI 计算 `11285049/1024/1024 = 10.76` → 显示 **`10.76 M/s`**。运维看到"10.76 M/s"会理解成 10.76 MB/s ≈ 86 Mbit/s，**高估 8 倍**；同时"全网带宽"KPI 与"设备带宽列"用的是同一套错单位，无法互相校验。

为什么算 P1 而不是 P2：带宽是 R2/R3 的验收字段，显示值直接进入运维判断（"是不是有人在拉大文件"），且这不是格式偏好而是量纲错误。

最小修复：`format.ts` 加 `fmtBitRate(bps)`（`bps/Kbps/Mbps/Gbps`，1024 制或 1000 制需在文档里写清并用同一套），替换三处展示与两处表头；引擎侧不动（`rxBps` 的 bit 语义与文档一致）。

### 3.3 R-02 系统带宽把"没有"兜成 0（P1）

`bandwidth.ts:157-170` 有两条失败路径：

- `counters === null`（`netstat -e` 解析失败/被拦截）→ 构造 `sample` 时 `rxBps:0, txBps:0`，只把原因写进 `sample.error`（**没有任何消费点**）。
- 首次采样（`this.prev === null`）→ `rxBps:0, txBps:0`，这是合理的"基线"，但同样无法与"真实零流量"区分。

`scheduler.ts:684-685` 再补一刀：`rxBps: bandwidth?.rxBps ?? 0`，把 `last===null`（还没采过）也变成 0。

结果：`OverviewView` 的"全网带宽"KPI 在启动后、netstat 失败后、以及真零流量时**显示完全相同的 `0 B/s`**。设备级反而做对了（`statFor` → `attributable:false` → UI 显示"无流量归集"）——同一个诚实原则在系统级被漏掉了。

最小修复（契约需队长批准）：`SystemStat` 增加 `bandwidthAt: number | null`；UI 在 `lastScanAt===null || bandwidthAt===null` 时显示 `—` 并 `title` 说明原因。在不改契约的前提下，至少应把 `sample.error` 上抛到快照的 `warnings[]`（与 R-03 合并实现）。

### 3.4 R-03 静默失败（P1）—— 这是本报告最建议优先修的一条

三条独立证据，都指向"引擎知道出了问题、但用户永远看不到"：

**证据 A：`parseWarning` 生产侧零消费。**
`arp.ts:87-88` 精心区分了"表里没有条目"和"有表格行但一条没解析出来（编码/locale 不匹配）"，`ping.ts:19/74` 也有。但 `grep -rn "parseWarning" src/ tests/ scripts/` 的结果显示：除两个生成文件与 `tests/ping.test.ts` 的断言外，**没有任何生产代码读取它**。`scheduler.ts:387` 只写了 `(await readArp(this.cfg.prefix)).entries`，`.parseWarning` 在表达式里直接蒸发。

触发场景：公司域策略把系统 locale 改成非中英（或 `arp.exe` 被 EDR 替换），`arp -a` 输出格式变了 → `parseArp` 返回 0 条 → `entries.size===0` → `composeDevicesAndPrinters` 判定"真实设备 0 台" → `dataSource='demo'` → **界面挂出 12 台模拟设备 + "演示数据"角标**，而真相是"ARP 解析失败"。plan §8 风险表写的降级策略是"返回空数组并记 `parseWarning`"，但"记"了没人"报"。

**证据 B：spooler 错误被丢弃。**
`printer-service.ts:287-289` 把 `spooler.errors.{printers,cim,jobs}` 收集进 `CollectPrintersResult.errors`；`scheduler.ts:337-345` 只取 `result.printers` 与 `result.reachable`，`errors` 没有任何引用（`grep -rn "result.errors" src/` → 0）。于是"Get-Printer 因执行策略失败"（`spooler.ts:246-250` 回退、`:232-243` 两路都失败）最终表现为 `printers: []` → `PrintersView.tsx:345-354` 显示"**该网络内没有响应 9100/631 的打印设备**"。这是把"我们没权限读队列"说成"网里没有打印机"——比不显示更糟。

**证据 C：`catch {}` 吞掉组装异常。**
`scheduler.ts:347-349`（`refreshPrinters`）、`:712-719`（`emitSnapshot`）用空 catch。`emitSnapshot` 是唯一的出快照通道：一旦 `buildSnapshot` 内部抛错（例如告警引擎遇到异常数据），**UI 会永久停在上一帧**，而主进程日志里什么都没有（因为 `catch` 连 `console.error` 都没有）。plan §5.2/R6 要求"无未捕获异常"，但"捕获后静默"同样违反可观测性。

最小修复（一次改完）：在 `Snapshot` 增 `warnings: string[]`（或单独 IPC `lan:warning`），引擎在各 catch 与 `parseWarning` 处 push 一条人类可读文案；渲染层 `App.tsx` 已有 `feed.error` banner，复用即可。这一条同时修掉 R-02 的"错误不可见"。

### 3.5 R-04 关闭"自动扫描"停掉全部采集（P1）

代码路径：
`TopBar.tsx:87-95` 开关 → `App.toggleAutoScan` → `feed.setAutoScan(false)` → `ipc.ts:28-32` → `engine.setAutoScan` → `scheduler.setAutoScan`：

```ts
setAutoScan(enabled, intervalSec) {
  this.autoScan = enabled;
  ...
  if (this.running) { this.clearTimers(); this.installTimers(); }   // scheduler.ts:187-190
}
private installTimers() {
  if (!this.autoScan) return;                                        // scheduler.ts:214 ← 全部 5 个定时器在此被拦掉
  this.timers.push(setInterval(... SCHEDULE.bandwidth 2s));
  this.timers.push(setInterval(... SCHEDULE.devices   5s));
  this.timers.push(setInterval(... QUALITY_SAMPLE.intervalMs));
  this.timers.push(setInterval(... SCHEDULE.printers 15s));
  this.timers.push(setInterval(... SCHEDULE.fullScan 60s));
}
```

`autoScan` 在产品语义里是"自动扫描网段"，UI 文案也是"自动扫描 / 已暂停"。但实现把它做成了"全部采集总闸"：

- 带宽：2s 差分停止 → 数字冻结在最后一帧（用户读不到新值，且不会变灰）。
- 心跳：5s ARP 重读 + 轮转 ping 停止 → **在线/离线判定彻底不再更新**（配合 R-06(a) 的 `pingAlive` 不清零，设备状态被永久钉死）。
- 质量采样：停止 → 曲线不增长。
- 打印机：15s 停止 → 卡纸/缺纸状态永不更新，**而打印机恰恰是最需要实时告警的对象**。
- 告警：`evaluate` 只在 `emitSnapshot` 时跑；没有 tick 就没有新告警，也没有自动恢复。

用户意图是"别自动扫网段"，得到的是"整个监控台停摆"。另外 `TopBar.tsx:99` 只显示 `已暂停`，没有"数据已停止更新"的提示，用户会把陈旧数据当实时数据读。

最小修复：把 `autoScan` 只作用于 `SCHEDULE.fullScan` 那个定时器（其余四个无条件安装）；或新增 `paused` 概念并让 UI 明确表达"非扫描类任务仍在运行"。至少要在 `StatusBar` 显示"数据停止更新于 HH:mm:ss"。

### 3.6 R-05 硬超时不构成保证（P1）

`exec.ts` 的超时实现：

```ts
const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);   // :124-131
const finish = (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve(...) };  // :133
child.on('error', …finish(null));
child.on('close', (code) => finish(code));                                       // :158 ← 唯一的正常结算点
```

问题在于 **`finish` 只能被 `error`/`close` 触发**，`kill()` 之后没有任何兜底 settle。Windows 上 `child.kill()` 走 `TerminateProcess`，通常能触发 `close`；但 Node 在 Windows 的已知行为是：**若被 kill 的进程已派生子进程且子进程继承了 stdout/stderr 管道，`close` 不会派发**（只有 `exit`）。`powershell.exe -Command` 完全可能启动子进程（`Get-CimInstance` 之类在本机不会，但 `-Command` 里任何原生命令都会）。

叠加放大器在 `runPowerShell`：

```ts
await powershellGate.acquire();          // limit = 1
try { return await runNative(...) } finally { powershellGate.release() }   // :174-187
```

一次不 settle → `release()` 永不执行 → **PowerShell 单飞闸门被永久占用** → 之后所有 `readPrinters/readCimPrinters/readPrintJobs` 全部挂起 → `refreshPrinters` 卡在 `await readSpooler()` → `printersInFlight` 永为 true → 打印机面板永久停更（且因为 R-03 的静默 catch，用户看不到任何错误）。

同一机制在 `childGate`(64) 上会退化为"整机探测停摆"：泄漏 64 次后所有 ping 都排队永不返回。

最小修复（两行级）：

```ts
const timer = setTimeout(() => {
  timedOut = true;
  try { child.kill('SIGKILL') } catch {}
  // Windows 上确保进程树被终结
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  setTimeout(() => finish(null), 500);          // 兜底 settle，保证闸门一定释放
}, timeoutMs);
```

### 3.7 R-06 离线判定：时序偏离 + 状态不清零（P1）

这条集合了三个互相放大的缺陷，最终后果是**要么永不判离线，要么每隔一分钟抖一条 critical 告警**。

**(a) `pingAlive` 从不清零。**
`scheduler.ts:413-421`：

```ts
for (const [ip, result] of sweep.results) {
  if (!result.alive) continue;        // ← 只处理存活的；超时主机什么都不写
  const rec = this.ensureRecord(ip, startedAt);
  rec.pingAlive = true;
  ...
}
```

对比 `heartbeat()`（`:249`）写的是 `rec.pingAlive = result.alive`（会置 false），但心跳只覆盖 `pickHeartbeatTargets(32)` 的轮转子集。所以：全量扫描**永不**把一台设备从"存活"降级；只有轮到心跳时才会降级。若心跳不跑（见 R-04：用户关掉自动扫描），`pingAlive` 永远是首轮的值 → `resolveLinkState`（`:126`）里 `input.pingAlive` 恒真 → `return 'online'` → **离线判定功能整体失效**。

**(b) `arpMissStreak` 在 5s 心跳上推进，"3 轮"实际是 15 秒。**
`heartbeat()`（`:237-261`）末尾调用 `applyArpPresence()`（无参数版，用 `this.arp`）；`applyArpPresence`（`:525-537`）对每条记录做 `rec.arpMissStreak += 1`。心跳周期 `SCHEDULE.devices = 5000`。而 plan §5.1 第 5 条与 ARCHITECTURE §3 的表述是"ARP 连续 3 轮缺席"，语境是**扫描轮**（60s）。实现把计数单位从"轮"变成"心跳"，判离线窗口从 ~3 分钟缩到 **15 秒**——而 Windows ARP 缓存对静默主机的条目寿命只有 30-120s。

具体触发链（禁 ICMP + 无被探端口的静默主机，例如一台只跑 SMB 心跳之外的 NAS/工控机）：
1. 主机 30-120s 无流量 → 本机 ARP 条目被老化；
2. 心跳读 `arp -a` 不见该 IP → `arpPresent=false`；同时它被 `pickHeartbeatTargets`（`:264` 过滤 `arpPresent || pingAlive`）保留一轮，ping 超时 → `pingAlive=false`；
3. 之后它既不在 ARP、也不在 ping 目标里 → 15s 后 `arpMissStreak>=3` → `offline`；
4. `alarms.ts:193-202` 产生 `DEVICE_OFFLINE` **critical**；
5. 60s 后全量扫描 ping 全部 254 地址 → 触发 ARP 解析 → 该主机 ARP 重新出现 → `online` → 告警 resolved；
6. 再老化 → 回到第 1 步。

净效果：每 60-90 秒一条 critical 抖动告警。这正是 D-002 与 plan §5.1 明确要消灭的"50+ 条噪音"。

**(c) `lastSeen` 被陈旧 `portResponded` 刷新。**
`:543-547` `updatePortResponders()` 把任何 `openPorts.length>0` 的记录置 `portResponded=true`；它在 `applyArpPresence` **之后**执行，于是下一轮（含心跳）`applyArpPresence` 的 `if (present || rec.pingAlive || rec.portResponded)` 命中 → `missStreak=0` **且 `lastSeen = now`**。一台真正离线、但 `openPorts` 还留着上一轮结果的设备，在"最后发现"栏里会持续显示"几秒前"。这是面向运维的假信息。

最小修复：
1. `runFullScan` 对每个被 ping 的 host 写 `rec.pingAlive = result.alive`（不再 `continue`）；
2. `applyArpPresence` 增加参数 `advanceMiss: boolean`，只有扫描轮传 `true`；心跳只更新 `lastSeen`/`arpPresent`；
3. `updatePortResponders` 只在"本轮确实探测过"的记录上生效（记录 `probedAtRound`）；
4. `lastSeen` 只在有真实响应（ARP/ping/port 三者任一在**本轮**命中）时更新。

---

## 4. 已核查且未发现问题的项（附核查证据）

### 4.1 命令注入（P0 面）—— 未发现

```
grep -rn "spawn(" src/ scripts/
→ src/main/engine/exec.ts:104                     （唯一生产子进程出口）
   scripts/smoke.mjs:64 / scripts/start.mjs:34    （开发脚本，参数数组）
grep -rn "exec(\|execSync\|shell:" src/ scripts/
→ 13 命中，全部为 RegExp#exec，无 child_process.exec / execSync，无 shell:true
```

逐站点审计（全部 `spawn(cmd, Array<string>)`，`windowsHide:true`，无 `shell` 选项）：

| 站点 | 命令行 | 可控值来源 | 结论 |
|---|---|---|---|
| `exec.ts:104` | `<cmd> <args…>`，`argv` 数组 | 下面 5 个站点 | 无 shell 解析，**不存在命令注入面** |
| `subnet.ts:146` | `route print -4 0.0.0.0` | 常量 | 安全 |
| `arp.ts:120` | `arp -a` | 常量 | 安全 |
| `ping.ts:99/167` | `ping -n 1/4 -w 800 <ip>` | `buildHosts()` 生成 + `arp` 正则 | 参数注入见 R-14（非 P0） |
| `bandwidth.ts:85/93` | `netstat -e` / `-ano` | 常量 | 安全 |
| `spooler.ts:232/247/253/259/266` | `powershell -NoProfile -NonInteractive -Command <常量脚本>` | **纯常量字符串，无一处插值** | 安全 |

**PowerShell 与打印机名（plan §5.3 的红线）**：`spooler.ts:219-229` 定义了 4 个常量脚本，全部是 `Get-Printer | ConvertTo-Json` / `Get-CimInstance Win32_Printer` / `Get-PrintJob`（全量取回 + 内存关联），`printer-service.ts:291-300` 明确用 `PrinterName` 做 Map 关联。**全仓没有一处 `Get-PrintJob -PrinterName '<name>'` 形式的拼接**，含 `()` `:` 的中文打印机名（`Xerox AltaLink C8055 (9C:93:4E:9C:6A:76)`）不会被解释为 PowerShell 语法。这一条是我最担心的地方，实测确认做到了。

`psJsonCommand`（`exec.ts:190-192`）与 `runPowerShell`（`:175`）都只拼接**常量** code，且两层前缀重复出现（`[Console]::OutputEncoding` 两遍）属冗余但无害。

### 4.2 手写 BER 解码的健壮性（P0 面）—— 未发现可利用缺陷

| 攻击面 | 结论 | 证据 |
|---|---|---|
| 长度字段伪造（`0x84 FF FF FF FF`）导致内存放大 | **不可能**：`decodeLength` 只算数值不分配；`decodeTlv:184-185` 先算 `end = valueOffset+length`，`end > buf.length` 立即抛 `RangeError`；`value` 用 `subarray`（视图，不复制） | `snmp-ber.ts:59-70`、`:178-195` |
| 不定长编码 / 长度域过长 | 拒绝：`count===0`（0x80）抛"不支持不定长"；`count>4` 抛错；`offset+1+count>buf.length` 抛截断 | `:64-66` |
| GETNEXT 不收敛 → 无限循环 | 三重终止：`maxSteps`（默认 40，耗材 80）；`compareOid(vb.oid, cursor) <= 0` → `no-progress` 停机；离开 base 子树 → `subtree-end`；且 UDP 单跳有 900ms 超时 | `snmp-client.ts:157-186` |
| `walkTlv` 死循环 | `cursor += tlv.totalLength`，`totalLength = 1+lenBytes+length ≥ 2`，**单调前进**，不可能原地打转 | `snmp-ber.ts:198-207` |
| 递归深度 | 全模块**无递归**（`walkTlv`/`walkChildren` 都是迭代；OID 名称无压缩指针解析） | 通读 `snmp-ber.ts` 364 行 |
| 截断报文 | 抛错而非产出脏数据；`snmp-client.ts:89-91` 把 `decode:` 错误作为 `ok:false` 返回，不上抛 | `:303-344` + `:80-92` |
| 变长整数 | `decodeInteger` 用 `result = result*256 + byte`（负号初值 -1）正确处理补码；`Counter64` 超 2^53 会丢精度但不会错值到负 | `:163-175` |

### 4.3 IPC 边界（P0 面）—— 未发现

| 检查项 | 结论 | 证据 |
|---|---|---|
| preload 是否泄露 `ipcRenderer` 本体 | 否。只 `exposeInMainWorld('lanApi', api)`，api 是 9 个显式方法的字面量，`ipcRenderer` 是模块内私有 | `preload.ts:7-35` |
| 是否允许任意频道调用 | 否。所有频道名来自 `CH` 常量（`shared/channels.ts`），无 `invoke(channel, …)` 形式的透传 | `preload.ts:20-32` |
| `contextIsolation` / `nodeIntegration` | `true` / `false` | `main/index.ts:47-48` |
| 渲染层传参校验 | `deviceId`/`alarmId` 走 `String()` 后仅在内存 Map/数组里查找，不落地、不进命令行 → **无注入面**；`setAutoScan` 的 `enabled` 用 `Boolean()` 收敛，`intervalSec` 有 `>0` 守卫 | `ipc.ts:26-39`、`scheduler.ts:184-193` |
| 订阅回调清理 | `subscribe()` 返回 `removeListener` 闭包，`useLiveFeed` 卸载时逐个调用并 `try/catch` | `preload.ts:11-17`、`useLiveFeed.ts:76-85` |

唯一相关问题是 R-21 的 `no-sandbox`/`sandbox:false`（加固层，非边界缺失）。

### 4.4 "null 兜成 0"（数据诚实红线）—— 已逐条分类，`levelPct` 侧干净

```
grep -rn "?? 0\b|?? '0'| || 0\b" src/
```
18 条命中，逐条判定：

| 命中 | 判定 |
|---|---|
| `alarms.ts:236`、`bandwidth.ts:111`、`printers/snmp-ber.ts:156`、`printer-mib.ts:69`、`spooler.ts:171`、`spooler.ts:318` | 计数器/索引/枚举的初值，**不是被测指标**，合理 |
| `check.ts:54-58`、`soak.ts:111` | 开发探针内部，合理 |
| `printers/spooler.ts:211-212`（`pages/pagesPrinted`） | 契约 `PrintJob.pages: number` 逼出的 0，见 R-10（P2） |
| `scheduler.ts:684-685`（`system.rxBps/txBps`） | **R-02（P1）** |
| `LevelBar.tsx:24`（`Math.round(shown ?? 0)`） | **安全**：`shown` 为 null 时走 `empty` 分支，`??0` 在死分支；组件对 null 渲染"不报告"（`:34-36`） |
| `DeviceDetailDrawer.tsx:107/243` | `hasSamples` 守卫后的展示判断，不改数据 |

**`levelPct`、`pageCount`、`score`、`latencyMs`、`jitterMs` 五类关键指标在全仓 `?? 0` 命中数为 0**：
`toLevelPct`（`printer-mib.ts:85-92`）对 `current<0`/`maxCapacity<=0` 一律 `null`；`parseMarkerLifeCount`（`:160-168`）无数据返回 `null`；`ipp.ts:143` 对负值 `null`；`unknownQuality`（`quality.ts:39-48`）score=0 但 grade='unknown' 且 `samples=0`，UI 三处（`QualityBar`/`ScoreRing`/`DevicesView`）都按 `samples` 分支显示"未采样/采样中"，不把 0 分当结论。**这一块是全项目做得最扎实的部分**，与 D-009/ARCHITECTURE §6 完全一致。

### 4.5 socket / 子进程释放 —— 未发现泄漏

```
grep -rn "destroy()\|\.close()" src/main/engine/
→ ports.ts:23,32（finish 内 removeAllListeners + destroy，settled 双保险）
   ipp.ts:106（超时 req.destroy + finish 双保险）
   mdns.ts:136（close 幂等，close() 内 clearTimeout）
   snmp-client.ts:70（finish 内 clearTimeout + close，try/catch 幂等）
```
每条连接都有一条明确的释放路径，且都有 `settled/done/closed` 幂等守卫。`probePort` 的 `AbortSignal` 监听器确实只在 `finish` 外清理（若传入共享 signal 会累积 listener），但 `grep -rn "signal" src/main/` 显示**生产路径从未传 signal**（只有类型声明与内部逻辑），因此当前不构成泄漏——已记为 R-14 的相邻风险，不单列。

### 4.6 编码双通道 —— 未发现违规

| 检查 | 结论 |
|---|---|
| 是否有调用点自行 `.toString()` 解码 | 0 处。`decodeGbk`/`decodeUtf8` 只在 `exec.ts:144-145` 收口；`decodeAs` 是唯一入口 |
| 每个 spawn 站点是否显式声明编码 | 是。`runGbkNative`（ping/arp/netstat/route）与 `runPowerShell`（utf8）两个封装，grep 无第三种 |
| 是否误用 PowerShell 抓 `arp`/`ping` | 否。`arp` 主路径是 `arp -a` + GBK（`arp.ts:120`）；PowerShell 只用于结构化 JSON（`Get-NetNeighbor` 回退、`Get-Printer`） |
| `chcp 65001` | 全仓 0 命中 |
| 多字节字符跨 chunk 切断 | 已正确规避：先 `Buffer.concat` 全部 chunk 再一次性解码（`exec.ts:137-145`），不会把 GBK 双字节切坏 |

### 4.7 引擎层洁净度（`import electron` = 0）—— 已确认

```
grep -rn "from 'electron'\|require('electron')" src/main/engine/     → 0
grep -rln "electron" src/main/engine/                               → 5 文件，全部是注释里的"不含 electron"
```
`store.ts` 接受注入目录（`constructor(dir, filename, debounceMs)`），`createEngine` 由 `index.ts` 传入 `app.getPath('userData')`，依赖方向正确。唯一越界是 R-18（`check.ts`/`soak.ts` 放在 engine 目录里，属"目录职责"而非"依赖越界"，且已确认**不在生产 bundle 路径**：`package.json` 的 `build:main` 入口只有 `src/main/index.ts`，`soak.ts` 只被 `scripts/soak-check.mjs` 用 esbuild 单独打包）。

### 4.8 React `memo` 比较器字段覆盖 —— 已确认无遗漏

`DevicesView.tsx:38-64` 的 `sameRow` 与被渲染字段逐项核对：

| 行内渲染 | 比较器是否覆盖 |
|---|---|
| `state`/`ip`/`isGateway`/`isSelf`/`displayName`/`hostname`/`mac`/`vendor`/`osHint`/`kind` | ✅ 全部显式比较（`:44-54`） |
| `quality.latencyMs`/`packetLossPct`/`score`/`grade`/`samples` | ✅（`:55-59`） |
| `QualityBar` 依赖的 `grade`+`samples` | ✅ |
| `bandwidth.rxBps`/`txBps`/`attributable` | ✅（`:60-62`）；`estimated` 仅进 `title`，不影响可见值 |
| 未比较项 `openPorts`/`firstSeen`/`lastSeen`/`jitterMs`/`rttHistory` | 均**不在行内渲染**，漏比较不会造成"数据变了但界面不动" |
| `selected`/`onOpen` | ✅ 显式比较，`onOpen` 由 `useCallback([onOpenDetail])` 稳定 |

结论：这是正确写法（"比较器只覆盖展示字段 + 引用快路径"），不是常见的"漏字段"缺陷。

### 4.9 定时器 / 事件监听清理 —— 未发现泄漏

- `DeviceDetailDrawer.tsx:89-103`：Esc 监听 `window.addEventListener` → cleanup `removeEventListener` + `clearTimeout`，`deps=[deviceId,onClose]` 正确。**没有** brief 担心的"Esc 监听忘了移除"。
- `DevicesView.tsx:166-178`：`/` 聚焦监听同样成对出现。
- `useTick.ts:8-13`：`setInterval` + `clearInterval`，`deps=[intervalMs]` 正确。
- `useLiveFeed.ts:76-85`：IPC 订阅逐个 `off()`。
- `scheduler.ts:208-211`：`clearTimers` 遍历 `clearInterval` 并清空数组。
- `App.tsx:69-76`：`__ready` 的 `setTimeout` 有 cleanup。

### 4.10 类型诚实（无 `any`，13 处 `as` 全部合理）

```
grep -rn ": any\b|as any|<any>" src/   → 0
grep -rn " as [A-Z][A-Za-z]*\b" src/main src/shared | grep -v "as const"  → 13
```
13 处分布：`snmp-ber.ts` 的 11 处 `items[i] as Tlv`（`walkChildren` 返回数组，索引类型 `Tlv|undefined`，已被前置 `length` 检查保护）、`exec.ts:205-206` 的 JSON 反序列化、`store.ts:60/64`（见 R-20b）。
用 `unknown` + 显式收窄的地方做得好：`spooler.ts:271-286`（Win32 回退逐字段 `typeof` 校验）、`printers/mdns.ts:151-162`。此前"provider 强转导致 TypeError"的修复方式（把 `statusOf` 提到接口上 + `typeof statusOf === 'function'` 能力检测，`printer-service.ts:44-47`、`:360-362`）是正确的，未退化为 `as` 强转。

### 4.11 构建与测试现状（我的验证基线）

```
npx tsc --noEmit -p tsconfig.node.json   → 0 error
npx tsc --noEmit -p tsconfig.web.json    → 0 error
npx vitest run                            → 12 files / 274 tests 全绿，3.44s
```
注：`npm run typecheck` 只跑 `tsconfig.node.json`，**不覆盖渲染层**（`tsconfig.web.json` 存在但无脚本引用）——建议加 `"typecheck:web"`，属 P2 工程项，不单列编号。

---

## 5. 与 `ARCHITECTURE.md` 自述的偏差

> 项目第一原则是"文档只描述已经落地并实测跑通的设计"，因此以下偏差按严重度排序，**优先于同级别代码问题**。

| # | ARCHITECTURE 自述 | 代码实际 | 影响 |
|---|---|---|---|
| D-1 | §2 `bandwidth.ts`："带宽为网卡计数器 × TCP 连接占比推算"；§5 公式 `bps = Δbytes × 8 / Δt`（bit/s） | 引擎确实算 bit/s（`bandwidth.ts:78`），但**全部 UI 按 B/s 展示**（`format.ts:13-24`、`OverviewView.tsx:236`） | 8 倍高估，见 R-01。文档与引擎一致，是 UI 违背文档 |
| D-2 | §7："手动刷新：先 `emitSnapshot()` 再启动扫描 → UI 在 **1 个 IPC 往返内看到进度条**与既有数据" | **UI 里根本没有进度条**；`lan:scanProgress` 推的 `pct/phase` 无任何渲染点，且 `App.tsx:39` 的 `??` 顺位使 `feed.progress` 永不生效 | 自述了一项不存在的交付物，见 R-15 |
| D-3 | §8 降级表："`arp -a` 解析失败（编码/locale 变化） → 0 条目 + `parseWarning`" | `parseWarning` 生成后无消费点，界面上等价于"网段没有设备"（并切 demo） | 降级策略只做了一半，见 R-03 |
| D-4 | §3/plan §5.1："ARP **连续 3 轮**缺席且 ICMP 无响应 → offline（唯一判离线路径）"，语境为扫描轮 | 计数在 **5s 心跳**上推进（`scheduler.ts:256` → `:534`），实际 15s 即可判离线；同时全量扫描不重置 `pingAlive` | 语义偏离 + 抖动告警，见 R-06 |
| D-5 | §2 `exec.ts`："硬超时强杀后清 timer"；":PowerShell 单飞" | 清 timer 正确，但 `kill()` 后无兜底 settle，`close` 不派发时单飞闸门永久占用 | 见 R-05 |
| D-6 | §1 分层图把 `check.ts`/`soak.ts` 与引擎模块并列（`soak.ts | 长跑取证`） | 二者是验证工具却位于 `engine/`，`soak.ts` 还在生产源码里保留 `fakeDevice` 测试替身 | 分层语义模糊，见 R-18 |
| D-7 | §8："`disableHardwareAcceleration()` + `disable-gpu`（本机实测必须）" | 代码另有 `no-sandbox`、`disable-gpu-sandbox`、`disable-gpu-compositing`，文档只论证了 GPU 那条 | 安全加固被关闭但未登记，见 R-21 |
| D-8 | `simulator.ts:13-14`："确定性 PRNG（同一种子 → 同一世界，便于截图与测试复现）" | `tick()` 每帧消耗 `rand()`，每次快照的模拟延迟都不同 | 宣称的可复现性不成立（不影响验收，因截图仍在同一会话内） |

未发现偏差的自述（逐条核对通过）：`engine/**` 无 `electron`（§1 铁律）、编码双通道（§2/D-003）、`PowerShell 单飞`（§2）、`spooler 空队列→[]`（§2）、`IPP statusCode≠0 立即放弃`（§9）、`levelPct` 负值不 clamp（§6）、`disable-gpu` 必要性（§8）、`.213` 探活覆盖（D-006）。

---

## 6. 结论

### 6.1 判定：`修复后交付`

- **P0：0 条**。命令注入、BER 健壮性、IPC 边界三条 P0 面均经正面证伪，未发现可触发缺陷——尤其"打印机名拼进 PowerShell"这条红线守住了。
- **P1：6 条**（R-01 ～ R-06）。其中 R-01/R-02 是量纲与诚实性问题，R-03/R-05 是"故障不可见 + 可能永久停摆"，R-04/R-06 是监控主功能（自动采集与离线判定）的行为偏差。
- **P2：17 条**（R-07 ～ R-23）。多数是局部可维护性，但有 4 条（R-07/R-08/R-10/R-16）会让 UI 说出没有证据的话，建议随 P1 一并修。

不判 `不可交付` 的理由：没有安全问题、没有数据破坏、没有事务性风险，274 个单测全绿、双 tsconfig 类型检查干净，主要缺陷集中在"显示口径"和"异常可见性"，全部可在不动架构的前提下修复。不判 `可交付` 的理由：R-01 的 8 倍带宽、R-03 的静默失败、R-04 的"关自动扫描=全停"都会直接误导运维判断——这与项目"数据诚实第一原则"正面冲突。

### 6.2 必须修（P1，交付前置条件）

| 编号 | 一句话 | 预估改动面 |
|---|---|---|
| **R-01** | 带宽按 bit/s 展示（或统一改为 B/s 并同步文档），消除 8 倍量纲错误 | `format.ts` + 3 处调用 + 2 处表头 |
| **R-02** | 系统带宽不再把"没采到/失败"显示为 `0 B/s` | `scheduler.ts` + 契约字段（需队长批准）+ `OverviewView` |
| **R-03** | 把 `parseWarning` / `spooler.errors` / `collectPrinters.errors` / 各 `catch` 上抛到快照 `warnings[]` 并渲染 | `scheduler.ts` + `types.ts` + `App.tsx` |
| **R-04** | `autoScan` 只管全量扫描，不得停掉带宽/心跳/质量/打印机采集 | `scheduler.ts:213-220` + UI 文案 |
| **R-05** | `kill()` 后加兜底 settle（+ Windows `taskkill /T /F`），保证闸门必释放 | `exec.ts:124-131` |
| **R-06** | 全量扫描清零 `pingAlive`；`arpMissStreak` 只在扫描轮推进；`lastSeen` 只在真实响应时更新 | `scheduler.ts:413-421 / 525-547` |

### 6.3 建议同批修（P2 中影响"界面是否说真话"的四条）

R-07（mDNS 补 IP 未探活）、R-08（网络打印机假 `idle`）、R-09（IPP 耗材标成 `both`）、R-16（抽屉曲线伪造采样点）。

### 6.4 亮点（3 条，简短）

1. **`levelPct` 的 null 语义贯穿到底**：`toLevelPct` → `Consumable.levelPct` → `LevelBar` 的"不报告"斜纹 → 告警侧 `filter(c => c.levelPct !== null)`，四层一致，没有一处把"不报告"变成 0%。这是本项目最难做对的诚实性链路，做对了。
2. **`exec.ts` 的编码双通道收口**：唯一 spawn 出口 + 两个命名封装 + 全 Buffer 拼接后解码，把"调用点自决编码"这类最容易腐化的地方锁死了（`grep` 无第三种解码路径）。
3. **`sameRow` 比较器与 `walkTlv` 的边界检查**：前者逐字段对齐渲染内容（不是抄 `props` 全量），后者"先算 end 再 subarray"从结构上排除了长度字段攻击——两处都体现了作者知道自己在防什么。
