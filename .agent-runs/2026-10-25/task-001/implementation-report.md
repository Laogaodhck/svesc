# 实现报告 — Max-1（task-001 / P2a）

| 字段 | 值 |
|---|---|
| 角色 | 实现工程师 Max-1 |
| 范围 | 构建骨架 + 全部探测引擎 + IPC/预加载 + engine-check + 冒烟脚本 + ARCHITECTURE.md |
| 主机 | `LaoGaoDH` · Windows 10 Pro 19045 · 中文 locale · 192.168.2.0/24 |
| 运行时 | Node 22.22.2 · Electron 45.0.4 · TypeScript 5.9 · Vite 7.3.7 · Vitest 3.2.7 · esbuild 0.25 |
| 结论 | **PASS**（8 条验收自查全绿，真机扫到 20 设备 / 8 打印队列 / 1 条真实 critical 告警） |

---

## 1. 交付清单

### 1.1 构建骨架

| 文件 | 说明 |
|---|---|
| `package.json` | scripts: `typecheck` / `build`（vite + 2×esbuild）/ `build:main` / `build:preload` / `test` / `start` / `smoke` / `engine-check`；`main: dist/main/index.cjs`；**零原生依赖**（无 better-sqlite3 / node-snmp / node-ping） |
| `.npmrc` | npmmirror registry + `electron_mirror` |
| `tsconfig.base.json` / `tsconfig.node.json` / `tsconfig.web.json` / `tsconfig.json` | base 共享严格配置；node 侧含 `src/shared + src/main + scripts`；web 侧 `jsx: react-jsx` + DOM（供 Max-2） |
| `vite.config.ts` | `root: src/renderer`、`base: './'`、`outDir: ../../dist/renderer`、react 插件、`@shared`/`@` 别名 |
| `vitest.config.ts` | node 环境、`passWithNoTests: true`、`@shared`/`@engine` 别名、`testTimeout 20s` |
| `.gitignore` | node_modules / dist / 临时 bundle |

### 1.2 共享契约（`src/shared/**`）

| 文件 | 内容 |
|---|---|
| `types.ts` | plan.md 第 5 节逐字段照抄，含 §5.1 补充的 `BandwidthStat.attributable`；另外导出 `LanApi`（预加载桥形状） |
| `channels.ts` | 9 个通道常量（6 invoke + 3 push） |
| `constants.ts` | 端口表 / 超时 / 并发 / 分频 / 质量阈值 / 告警阈值 / 告警基线窗口 |
| `global.d.ts` | `window.lanApi` / `window.__ready` / `window.__setView` 类型（Max-2 可直接用） |

### 1.3 主进程

| 文件 | 内容 |
|---|---|
| `src/main/index.ts` | 1360×880 / min 1120×720 / `#0b0f14` / `Menu.setApplicationMenu(null)` / `contextIsolation:true` / `nodeIntegration:false`；`SMOKE=1` 时走 smoke 分支；**关闭硬件加速**（见 §6.3） |
| `src/main/ipc.ts` | 6 个 invoke 路由 + 3 个推送出口 |
| `src/main/preload.ts` | `contextBridge.exposeInMainWorld('lanApi', …)`，**不透传 ipcRenderer** |
| `src/main/smoke.ts` | 仅在 SMOKE=1 时动态 import，逐视图截图 + 落盘 snapshot；生产路径零引用 |

### 1.4 探测引擎（`src/main/engine/**`，23 个文件 / 约 5.1k 行）

```
exec.ts                    统一子进程出口（编码双通道 + 并发闸门 + PowerShell 单飞）
discovery/subnet.ts        网段推导（os.networkInterfaces + route print 读默认路由）
discovery/arp.ts           arp -a(GBK) 主路径 + Get-NetNeighbor 回退
discovery/ping.ts          ping -n 1 / ping -n 4 解析（双 locale）
discovery/ports.ts         TCP 探活 + 打印机端点探活
discovery/oui.ts           100 条 OUI 前缀表（≥60 要求）
discovery/fingerprint.ts   端口优先的 kind/osHint
discovery/index.ts         门面 + 反向 DNS 缓存（800ms/并发 8/10min）
network/quality.ts         质量评分（公式冻结）
network/monitor.ts         滑窗 20 + RTT 历史 60
network/bandwidth.ts       netstat -e 差分 + netstat -ano 归集 + attributable
printers/snmp-ber.ts       手写 BER
printers/snmp-client.ts    UDP 161 GET / GETNEXT / walk
printers/printer-mib.ts    RFC 3805 OID 与解析
printers/spooler.ts        Get-Printer / Win32_Printer / Get-PrintJob
printers/printer-service.ts 三源合并 + TCP 探活覆盖 + ConsumableProvider 链（snmp→ipp→unknown）
printers/ipp.ts            IPP 2.0 Get-Printer-Attributes（opt-in，148 行，仅 node:http）
printers/mdns.ts           _ipp / _pdl-datastream（可选，静默失败）
alarms.ts                  7 条规则 + 去重 + 自动恢复 + 500 条上限
scheduler.ts               分频 + 4 相位扫描 + 快照组装 + resolveLinkState
store.ts                   JSON 持久化（目录注入、300ms debounce、损坏自愈）
simulator.ts               mulberry32 12 设备 + 4 打印机
index.ts                   引擎门面 createEngine()
check.ts                   engine-check 的纯 Node 入口
```

### 1.5 脚本与文档

| 文件 | 说明 |
|---|---|
| `scripts/engine-check.mjs` | esbuild 打包 `check.ts` → 纯 Node 驱动一轮完整扫描；打印耗时分解/计数/断言；写 `engine-snapshot.json`；`devices>0 && printers>0` 才 exit 0 |
| `scripts/smoke.mjs` | 启动 Electron + 5 张截图 + snapshot.json + 完整性校验（PNG magic + >10KB + stderr 无未捕获异常） |
| `scripts/start.mjs` | `npm start` 的启动器：清掉宿主注入的 `ELECTRON_RUN_AS_NODE` 再拉起 Electron |
| `ARCHITECTURE.md` | 分层图 / 模块职责 / 数据流 / 手写 BER 原因 / 带宽估算边界 / 诚实原则 / 分频与预算 / 降级 / 扩展点 |
| `.agent-runs/2026-10-25/task-001/artifacts/` | `engine-snapshot.json`、`snapshot.json`、5 张 PNG |

---

## 2. 验收自查（brief §7 · 逐条）

| # | 条目 | 结果 | 证据 |
|---|---|---|---|
| 1 | `npm install` 成功；`npm run build` 退出码 0；三件产物存在 | **PASS** | `dist/renderer/index.html`、`dist/main/index.cjs` (124.8KB)、`dist/main/preload.cjs` (1.4KB)；`vite build` 1.27s。**注意**：本机首次 `npm install` 时 Electron 的 postinstall **未自动下载二进制**（`node_modules/electron/dist` 缺失），已用 `ELECTRON_MIRROR=… node node_modules/electron/install.js` 补齐；npm 包本体与其余依赖均安装正常，`npm install` 本身 exit 0 |
| 2 | `src/main/engine/**` 内 `grep "from 'electron'"` = 0 | **PASS** | `grep -rn "from 'electron'\|require('electron')" src/main/engine/` → 0 |
| 3 | 无测试文件时 `npm test` 不报错 | **PASS** | `No test files found, exiting with code 0` |
| 4 | 拉起窗口并截图，PNG > 10KB | **PASS** | overview 116,082 B / devices 136,190 B / detail 145,938 B / printers 157,032 B / alarms 112,090 B；人工确认五张图内容不同且非空白 |
| 5 | `devices.length>0`、`printers.length>0`、每设备 7 键齐全 | **PASS** | engine-check: devices=20, printers=8；`ip/mac/hostname/osHint/quality/bandwidth/openPorts` 键全存在 |
| 6 | 单次全量子网扫描 ≤ 12s | **PASS** | 最终一轮 **8,509ms**（分解见 §3）；多轮区间 7.3–8.5s |
| 7 | 主进程无未捕获异常 | **PASS** | smoke `problems=0`；stderr 无 `UnhandledPromiseRejection` / `uncaughtException` |
| 8 | `ARCHITECTURE.md` 覆盖 brief §6 全部要点 | **PASS** | 9 节全覆盖，含带宽"为什么只能估算"与诚实原则表 |

补充自验命令（Max-1 阶段可独立复现）：

```bash
npx tsc --noEmit -p tsconfig.node.json      # 0 error
npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --external:electron --outfile=dist/main/index.cjs
node scripts/engine-check.mjs                # exit 0
```

---

## 3. 真机实测数据

### 3.1 engine-check（最终一轮，`artifacts/engine-snapshot.json`）

```
subnet        : 192.168.2.0/24      dataSource : live
arp(首次)              106 ms
ping(254@64)         5,852 ms
arp(复读)              161 ms
ports(候选 20 台)      716 ms
fingerprint/dns         24 ms
─────────────────────────────
扫描阶段合计         6,861 ms   （预算 10,000ms，未触发截断）
printers 采集        4,443 ms   （独立 15s 任务，不计入扫描预算；SNMP 命中即短路）
─────────────────────────────
devices 20   printers 8   alarms 1   online 20 / offline 0 / degraded 0
ping 存活 20 / ARP 条目 19 / 候选 20
```

### 3.2 关键正确性验收点

> **team-lead 的直接提问：`.213` 是否被 TCP 探活覆盖成 `offline` 并产生 `PRINTER_OFFLINE`？**
> **答：是。** `192.168.2.213`（MF750C Series）在 spooler 里是 `PrinterStatus=0 / Win32=Idle / WorkOffline=false`，
> 9100→631→515 三次 connect 全部超时，`state` 被覆盖为 `offline`，`reachable.get('prn-192.168.2.213')===false`，
> 并产出唯一一条 `critical / PRINTER_OFFLINE / targetId=prn-192.168.2.213`。连续 3 轮 engine-check 结果一致。

| 检查 | 实测结果 |
|---|---|
| `.213`（Canon MF750C）被判离线 | ✅ `state='offline'`，`stateDetail='spooler=Normal · win32=Idle · 网络探活失败 9100/631/515'` |
| 产生 `PRINTER_OFFLINE` | ✅ `critical / PRINTER_OFFLINE / MF750C Series / IP 192.168.2.213` |
| `.170`、`.235` 在线 | ✅ 均 `idle`，`openPorts=[80,443,515,631,9100]`，`kind='printer'` |
| 大多数设备 `grade='unknown'` | ✅ 单轮扫描 20/20 为 `unknown`：扫描阶段的存活 ping **不进质量窗口**，第 15s 的 `ping -n 4` 采样才开始填样本；soak 实测 25s 后 8 台仍有样本、35s 全部有分级 |
| 无 ICMP 噪音告警 | ✅ 全快照仅 1 条告警（就是 PRINTER_OFFLINE）；`DEVICE_NEW` 首轮只做种（第二轮起的新 MAC 才产生，见 §7.2） |
| 大多数设备 `attributable=false` | ✅ 20/20 无归集（本机与 LAN 的 ESTABLISHED TCP 仅 4 条） |
| 带宽不为 0 假象 | ✅ 全网 `rxBps=288,773 / txBps=11,285,049`（2s 差分），设备级 `share=0` 且 `attributable=false` |
| 页计数/耗材来自真实来源 | ✅ SHARP `pageCount=117,483`、`black=75%`；Xerox `pageCount=17,773`、13 条耗材 `maxCapacity=-2/-3 → levelPct=null` |

### 3.3 IPP 通路验证（opt-in，P2 增量）

按 team-lead 规格实现 `printers/ipp.ts`（148 行，仅 `node:http`，零依赖）。自测结果：

| 检查 | 结果 |
|---|---|
| 请求字节 | 286 B，version `02 00`（IPP 2.0）、operation `00 09`、request-id 透传、正文含 `ipp://<ip>:631/ipp/print` |
| 报文布局 | **发现并修正了一个真实 bug**：属性必须是 `tag|nameLen|name|valueLen|value`，最初写成 `tag|nameLen|valueLen|name|value`（会让请求非法）。修正后自造响应可正确回读 |
| 多值属性 | 合成响应 `marker-levels = [42, -3, -1]` → 解析出 3 个值（后续条 `nameLen=0` 继承上一个名字） |
| 负值红线 | `-3 / -1` → `levelPct:null`（不 clamp 成 0）；`42` → `42` |
| 耗材类型推断 | `Black Toner`→black、`Cyan Toner`→cyan、`Waste Toner Box`→waste |
| 真机 `.235` | `null`（`0x0400` 立即放弃，**100ms**，未重试未换路径） |
| 真机 `.170` | `null`（`/ipp/print` HTTP 404 → 试 `/ipp` → 无有效响应，3.2s 后放弃，不抛异常） |
| 接入效果 | provider 链 `snmp → ipp → unknown`，命中即短路；网络不可达的 `.213` 直接跳过耗材查询。打印机采集 6.9s → **4.9s**，结果零回归 |

### 3.4 冒烟证据（`artifacts/*.png` + `snapshot.json`）

- `overview.png`：在线 19 / 打印机 8 / 活跃告警 1（严重 1）/ 全网带宽（标注"估算"）；本轮 ARP 19 条（本网段 ARP 老化在 19-20 间波动）
- `devices.png`：设备表 19 行 + 详情抽屉（`.170` MAC/厂商/类型/RTT 曲线/"无流量归集"说明）；质量列显示"采样中"（`samples=4 < 8`，置信门生效，score 仍为 97-100）
- `detail.png`：设备详情抽屉（打印机 `__setView('devices', id)`）
- `printers.png`：8 个打印队列；Xerox 默认 + **型号 `Xerox AltaLink C8055`**（固件串已降到详情 `sysDescr:`）+ 页计数 17,773；MF750C 卡片红色"离线"；SHARP 型号 `SHARP MX-B4621R PCL6` + 117,483 页 + 耗材条
- `alarms.png`：1 条 critical 活动（MF750C）；无 `DEVICE_NEW`（首轮只做种，历史里的旧版垃圾记录已在 hydrate 迁移中清理）
- `snapshot.json`：24.9KB，含 19 设备 / 8 打印机的完整字段；`alarmCounts={critical:1,warning:0,info:0}`、`degraded=0`

---

## 4. 与 investigation-report 的**冲突与偏差**（诚实记录）

> brief §9 要求"发现规格与实测冲突时，记录冲突并选诚实的那个"。

| # | Vera 报告 | 本次实测 | 处理 |
|---|---|---|---|
| **C1** | §2.8：SNMP **全部超时**（4 主机 × public/private），耗材只能 `null` | **SNMP 现在可用**：SHARP MX-B4621R(.170) 返回 `sysDescr`/耗材/`prtMarkerLifeCount=117483`；Xerox AltaLink C8055(.235) 返回 13 条耗材 + `pageCount=17773`。`.213` 仍超时（其网络本身不可达）。**根因已定位：P1 探针 varbind 少一层 SEQUENCE，详见 §7** | 未改任何 SNMP 参数（v2c / community=public / 900ms / retries=0）。按"有数据就展示、无数据就 null"处理；耗材 provider 链仍是 `snmp → ipp → unknown`。**耗材告警只在 `levelPct!==null` 时产生**，因此 Xerox 的 13 条 null 不产生任何告警（正确）。结论：不把 SNMP 可用当作验收前提，但 UI 与文档已按"设备可能报告"实现 |
| **C2** | `pageCount`：无来源 → `null` | SNMP 通时**有**真实来源（`prtMarkerLifeCount`） | `pageCount` 优先 SNMP 值；SNMP 不通时仍 `null`。多 marker 时取**最大值**（求和会把彩色/黑白重复计入＝造数） |
| **C3** | ARP 表 53 条（192.168.2.x） | 实测 19–36 条波动（ARP 老化；两次扫描之间会掉条目） | 不改判定逻辑；这也说明"连续 3 轮 ARP 缺席"必须用轮次计数而非单轮快照 |
| **C4** | ping 254@64 ≈ 6.0s | 6.3–8.2s（波动取决于主机存活数与磁盘/CPU 负载） | 保留 64 并发与 `-w 800`；预算 10s 内，实测未触发截断 |
| **C5** | 建议单端口 connect 700ms；brief §3 写 350ms | 取 **700ms** | 350ms 在低端打印机/跨网段场景会漏判；只对候选主机探测，总耗时仍仅 719ms（20 台） |
| **C6** | TTL 实测只有 64/255，经典 TTL→OS 规则失效 | 一致（网关 64、SHARP 255） | 按 §9.7：TTL 仅作"无其它信号时"的弱提示，不改变 `kind` |
| **C7** | brief §3 fingerprint："TTL ≥200 → 网络设备/打印机固件" | 与 §9.7 冲突 | 以 §9.7 为准 |
| **C8** | §8：IPP 不可用（0x0400 / 0x0406，无 marker-*） | 一致：`.235` 100ms 得 0x0400；`.170` `/ipp/print`=404、`/ipp` 无有效响应 | 按 team-lead 决定保留为 opt-in provider；本机不走该通路，耗材仍来自 SNMP |

**唯一新增的工程妥协**：`printer-service` 对 SNMP 结果做 **正缓存 60s / 负缓存 300s**。原因：`.213` 每次采集都要付 900ms 超时；若不缓存，15s 周期 × 3 台会把采集拖到 10s+。缓存不改变"拿不到就是 null"的语义。

---

## 5. 交接内容

### 5.1 给 Tess：纯函数清单（可直接单测，无需 Electron / 无需真机）

> 全部位于 `src/main/engine/**`，`vitest.config.ts` 已配 `@engine` / `@shared` 别名，node 环境。

#### `network/quality.ts`

| 导出 | 预期行为 |
|---|---|
| `clamp(v, lo, hi)` | NaN → `lo`；越界截断 |
| `gradeOf(score)` | `>=85 excellent` / `>=70 good` / `>=50 fair` / else `poor` |
| `computeQuality({latencyMs, jitterMs, packetLossPct, samples})` | `samples<2` → `{score:0, grade:'unknown'}`；`samples 2..7` → **score 照算、grade 一律 `unknown`**（置信门 `QUALITY_MIN_SAMPLES=8`）；`samples>=8` → 按冻结公式 `latPen=clamp((lat-20)/1.5,0,60)`、`lossPen=clamp(loss*1.5,0,60)`、`jitterPen=clamp(jitter/3,0,20)`、`score=round(clamp(100-Σ,0,100))` 并出 grade；`latencyMs===null` 时按 100ms 计 → latPen=**53.33**（score 47 / poor，不是 60/40） |
| `unknownQuality()` | `{latencyMs:null, jitterMs:null, packetLossPct:0, score:0, grade:'unknown', samples:0}` |
| `isDegraded(q)` | `samples<1` → false；否则 `latencyMs>150` 或 `packetLossPct>=20` |

建议断言边界：`{lat:20,jitter:0,loss:0,samples:10}` → 100/excellent；`{lat:150,jitter:0,loss:0,samples:10}` → 13/poor；`{lat:null,jitter:null,loss:0,samples:5}` → 40/fair（100−60）；`samples:1` → unknown。

#### `scheduler.ts`

| 导出 | 预期行为 |
|---|---|
| `resolveLinkState({isSelf,isGateway,arpPresent,pingAlive,portResponded,arpMissStreak,quality})` | 返回 `'online'\|'offline'\|'degraded'`。**6 级优先级**：self/gateway → online；arpPresent‖portResponded‖pingAlive → online；`arpMissStreak>=3` → offline；否则 online。质量达标退化时覆盖为 `degraded`（self 也会 degraded）。**ECMP 用例**：`arpPresent:true, pingAlive:false` → `online`（这是本任务最关键的反例断言） |
| `ipToNumber(ip)` | `192.168.2.24 > 192.168.2.9`；非法 → 0 |

#### `alarms.ts`

| 导出 | 预期行为 |
|---|---|
| `dedupeKey(code, targetId)` | 返回 `` `${code}:${targetId}` `` |
| `new AlarmEngine(limit=500, baselineUntil=0)` | `.evaluate({devices, printers, printerReachable, now})` → `{alarms, created, resolved}`；同 `(code,targetId)` 只产生一次；条件消失 → `resolvedAt` 置值并计入 `resolved`；`counts()` 只统计活跃 |
| 规则断言点 | ① `state==='offline'` → `DEVICE_OFFLINE` critical；② `quality.grade==='poor'` 连续 2 轮 → `NET_QUALITY` warning（第 1 轮不报警）；③ `consumables[].levelPct===null` **不产生**耗材告警；`<=5` → `SUPPLY_CRITICAL`，`<=10` → `SUPPLY_LOW`，同打印机不重复；④ `printerReachable.get(id)===false && ip!==null` → `PRINTER_OFFLINE`；⑤ 新 MAC 且 `now > baselineUntil` → `DEVICE_NEW`（只活跃一轮，下轮自动恢复） |
| `hydrate({alarms, knownDeviceKeys})` | 历史里 `resolvedAt===null` 的 `DEVICE_NEW` 视为已恢复；`knownDeviceKeys` 非空则视为已做种（重启不刷 `DEVICE_NEW`） |

#### `discovery/arp.ts`

| 导出 | 预期行为 |
|---|---|
| `parseArp(text, prefix?)` | **接受原始文本**（便于测双 locale）。中文样例：`接口: 192.168.2.179 --- 0x5` + `  192.168.2.1  e4-67-1e-12-68-a9  动态` → 1 条；英文 `Interface: …` / `dynamic` 同样命中；过滤 `224.* / 239.* / *.255 / *.0 / ff-ff-ff-ff-ff-ff / 00-00-00-00-00-00`；`prefix='192.168.2.'` 时丢弃 `172.25.x`；mac 归一化为小写连字符；空/乱码文本 → `entries:[]` 且 `parseWarning:true` |
| `parseNeighborRows(rows, prefix?)` | `State==='Unreachable'/'Permanent'` 跳过；全零 MAC 跳过；`:` 分隔 MAC 归一化 |
| `isSkippableArpIp(ip)` | 见上表过滤规则 |
| `findIpByMac(map, mac)` | 大小写/分隔符不敏感；未命中 → null |

#### `discovery/ping.ts`

| 导出 | 预期行为 |
|---|---|
| `parsePingOutput(ip, text, exitCode)` | 中文 `来自 X 的回复: 字节=32 时间=3ms TTL=64` → `{alive:true, rttMs:3, ttl:64}`；`时间<1ms` → `rttMs:0`；`请求超时。` → `{alive:false, timedOut:true, parseWarning:false}`；英文 `Reply from …` 同样命中；垃圾文本 + `exitCode=0` → `alive:true, parseWarning:true` |
| `parsePingStats(text)` | 从 `-n 4` 输出取 `lossPct`、`avgRttMs`、逐包 `rtts[]` |
| `RE_PING_REPLY / RE_PING_TIMEOUT / RE_PING_LOSS / RE_PING_AVG` | 正则本体（与 Vera §3.3 一致），可用于自定义断言 |

#### `printers/snmp-ber.ts`（重点）

| 导出 | 预期行为 |
|---|---|
| `encodeLength(0/127/128/300)` | `00` / `7f` / `81 80` / `82 01 2c` |
| `decodeLength(buf, off)` | 回读上面的字节；`0x80`（不定长）抛 `RangeError` |
| `encodeInteger(0 / 127 / 128 / 256 / -1)` | `02 01 00` / `02 01 7f` / `02 02 00 80` / `02 02 01 00` / `02 01 ff` |
| `encodeOid('1.3.6.1.2.1.1.1.0')` | `06 08 2b 06 01 02 01 01 01 00`（1.3 → 0x2b） |
| `decodeOid(encodeOid(x))` | 幂等回环；含 `>127` 的弧（如 `1.3.6.1.4.1.11.2.3.9.1`）也需回环 |
| `encodeOctetString('public')` / `encodeNull()` | `04 06 70 75 62 6c 69 63` / `05 00` |
| `decodeTlv / walkTlv / walkChildren` | 遍历同级 TLV；长度越界抛 `RangeError` |
| `buildGetRequest(['1.3.6.1.2.1.1.1.0'], {community:'public', requestId:42})` | 顶层 `0x30`，内含 `0x02 01 01`（version=1）、`0x04 06 public`、`0xa0` PDU |
| `buildGetNextRequest(...)` | PDU tag `0xa1` |
| `parseResponse(bytes)` | 用构造的 GetResponse 字节断言 `requestId/errorStatus/varbinds`；`Counter32(0x41)` → number；`Gauge32` → number；`NULL` → `value:null` |
| `oidStartsWith / compareOid` | `1.3.6.1.2.1.43.11` 是 `1.3.6.1.2.1.43` 的子树；`compareOid('1.3.5','1.3.6.1')<0` |

#### `printers/printer-mib.ts`

| 导出 | 预期行为 |
|---|---|
| `toLevelPct(current, max)` | `(50,100)`→50；`(0,100)`→0；`(null,100)`→null；`(50,-2)`→null；`(50,-3)`→null；`(50,0)`→null；`(-1,-2)`→null；结果 clamp 0-100 并保留 1 位小数 |
| `inferSupplyKind(desc, typeCode?)` | `'Black Toner'→black`、`'Cyan Toner'→cyan`、`'Magenta'→magenta`、`'Yellow'→yellow`、`'Drum Cartridge'→drum`、`'Waste Toner Box'→waste`、type=4(wasteToner)→waste、type=9(opc)→drum、其它→other |
| `groupSupplyRows / parseSupplies` | 按 `<column>.<hr>.<supply>` 聚合 4 列（5/6/8/9）→ `Consumable[]`，`source:'snmp'`；空 `description` 且有 type 时 label 用默认中文名 |
| `parseMarkerLifeCount(vbs)` | 多 marker 取 **max**；无值 → null |
| `parseSysDescr(v)` | 取首行、trim、>120 字符截断加 `…`；非字符串 → null |
| `mapHrDeviceStatus(3/4/6)` | `idle / warning / error`；其它 `unknown` |

#### `printers/spooler.ts`（纯映射，全部可测）

| 导出 | 预期行为 |
|---|---|
| `parsePortName(portName, printerName?)` | `'192.168.2.170'`→`{ip:'192.168.2.170',connection:'network'}`；`'IP_192.168.2.213'`→去前缀取 ip；`'WSD-9bc8…'` + 名称含 `(9C:93:4E:9C:6A:76)`→`{ip:null, macInName:'9C:93:4E:9C:6A:76', connection:'network'}`；`'PORTPROMPT:'/'SHRFAX:'/'…\x.pdf'`→virtual；`'USB001'/'LPT1:'/'COM1:'`→usb；`'\\\\server\\printer'`→network |
| `modelFromDriver` | 含 `Microsoft` → null；`'SHARP MX-B4621R PCL6'` → 原样 |
| `mapPrinterState({gpStatus,cimStatus,workOffline,detectedErrorState,jobCount})` | `workOffline:true`→offline；`gp===6`/`cim===7`/`detected===9`→offline；`gp∈{2,4,5}`/`detected∈{7,8,10}`→error；`detected∈{3,4,5,6,11}`/`gp===1`/`cim===6`→warning；`cim===4`/`gp===9`/`jobCount>0`→printing；`gp===0&&cim===3`→idle；全空→unknown。**关键用例**：`{gpStatus:0,cimStatus:3,workOffline:false}` → `idle`（这就是 `.213` 的"假在线"输入，必须由 printer-service 的 TCP 探活覆盖为 offline） |
| `buildStateDetail(...)` | `'spooler=Normal · win32=Idle'`；`workOffline` 追加 `WorkOffline=true`；`detected>2` 追加英文原因 |
| `parsePsDate` | `'/Date(1700000000000)/'`→1700000000000；ISO 串→时间戳；空→0 |
| `toPrintJobs(rows)` | `SubmittedTime` 解析；缺字段给安全默认（`pages:0`、`status:'unknown'`） |

#### `printers/printer-service.ts`（异步，注入点已留好）

| 导出 | 预期行为 |
|---|---|
| `collectPrinters({spooler, arp, devices, probe?, consumableProviders?, snmpEnabled?})` | `probe` 可注入（返回 `{reachable,port,triedPorts}`）→ **无需真机即可测 `.213` 场景**：注入 `probe: async()=>({reachable:false,…})` + spooler 行 `{Name:'MF750C', PortName:'IP_192.168.2.213', PrinterStatus:0}` + cim `{WorkOffline:false,PrinterStatus:3}` → 断言 `state==='offline'` 且 `reachable.get('prn-192.168.2.213')===false` |
| `resolveConsumables(providers, ctx)` | 按顺序取第一个非空 `consumables`；`model/pageCount` 逐项取第一个非 null |
| `applyMdnsHints(printers, mdns)` | 只补 `ip===null` 的项，不改其它字段 |
| `hasFault(p)` / `isVirtual(p)` | `error/offline/warning` 为故障；`connection==='virtual'` 为虚拟 |

#### `printers/ipp.ts`（opt-in，协议纯函数）

| 导出 | 预期行为 |
|---|---|
| `IPP_PATHS` | 恒为 `['/ipp/print', '/ipp']`（顺序固定，不穷举） |
| `buildGetPrinterAttributesRequest(ip, path, requestId=1)` | 8 字节头：`02 00`（IPP 2.0）/ `00 09`（Get-Printer-Attributes）/ requestId 非 0；正文以 group tag `01` 开头、`03` 结尾；含 `attributes-charset`(0x47 utf-8)、`attributes-natural-language`(0x48 en)、`printer-uri`(0x45 `ipp://<ip>:631<path>`)；`requested-attributes`(0x44) 首条带名、其余 nameLen=0。**属性布局必须是 `tag\|nameLen\|name\|valueLen\|value`** |
| `parseIppResponse(buf)` | 返回 `{statusCode, attrs: Map<name,{name,tag,values[]}>}`；delimiter `0x01-0x05` 跳过（无长度域）；多值属性 `nameLen=0` 继承上一个名字；`0x21/0x23` 读 4 字节有符号、`0x22` 读 1 字节、其它按 UTF-8 文本；`buf<8` 或长度越界抛 `RangeError` |
| `toConsumables(result)` | `marker-levels` 逐值映射；**负值 → `levelPct:null`**（不 clamp）；`0..100` 取整；`marker-names`/`marker-colors` → label 与 kind（复用 `inferSupplyKind`）；`source:'ipp'`、`maxCapacity:100` |
| `ippGetAttributes(ip, {timeoutMs=2500, requestId})` | 只试 2 个路径；HTTP 404/连接失败才换下一个；**任何非 `0x0000` 立即返回 null**（不重试）；异常一律 null。单测可用 `parseIppResponse` + 构造字节，无需真机 |

> 契约变更（team-lead 批准）：`Consumable.source` 现为 `'snmp' | 'spooler' | 'ipp' | 'unknown'`。

#### 其他

| 文件 · 导出 | 预期行为 |
|---|---|
| `discovery/subnet.ts` · `isValidIpv4` | `'1.2.3.4'` true；`'1.2.3.256'`/`'1.2.3'`/`' 1.2.3.4'` false |
| `discovery/subnet.ts` · `isExcludedIface(name,addr,internal)` | `vEthernet (WSL)`/`Loopback`/`internal:true`/`169.254.x` 均 true |
| `discovery/subnet.ts` · `listCandidates / to24Prefix / buildHosts / pickSubnet` | `/24` → 254 个主机地址（`.1`–`.254`）；`pickSubnet` 命中 `preferredAddress` 优先，否则按私有地址优先级排序 |
| `discovery/oui.ts` · `lookupVendor` | `'9C:93:4E:9C:6A:76'`→`'Xerox'`；`'00-E0-4C-…'`→`'Realtek'`；未知前缀→`null`；非法 MAC→`null`；`ouiTableSize()>=60` |
| `discovery/fingerprint.ts` · `inferFingerprint` | `openPorts:[9100]`→`printer`；`[445]`→`Windows (SMB)`+workstation；`[22]`→Linux/Unix (SSH)；`[62078]`→iOS/mobile；`TTL:255` 且无端口/主机名/厂商 → `kind:'unknown'`（TTL 不给 kind）；`isGateway:true` + `[80]`→router |
| `discovery/ports.ts` · `looksLikePrinter` | `[80,443,515,631,9100]`→true；`[80,443]`→false |
| `network/bandwidth.ts` · `parseNetstatE` | 中文 `字节  2636111916  1811382196` → rx/tx；英文 `Bytes …` 同样命中；无匹配→null |
| `network/bandwidth.ts` · `parseNetstatConnections` | `TCP 192.168.2.179:52344 192.168.2.170:445 ESTABLISHED 1234` → 一行；表头/`UDP … *:*` 行不匹配 |
| `network/bandwidth.ts` · `bpsFromDelta` | `(100,200)@2s` → `rxBps:400`；`Δt<=0`→0；计数器回绕（变小）→0（`max(0,Δ)`） |
| `network/bandwidth.ts` · `aggregateLanConnections` | 只算 `TCP + ESTABLISHED + 远端在 prefix 内 + 非自身/回环` |
| `network/bandwidth.ts` · `BandwidthMeter.statFor` | `lanConnections===0` → `{rxBps:0,txBps:0,share:0,attributable:false,estimated:true}`；归集存在时 `share=conn/total`（4 位小数） |
| `exec.ts` · `decodeGbk / decodeUtf8 / decodeAs` | GBK 字节解出中文；UTF-8 字节用 gbk 解会成乱码（用于反向验证"解码器必须与 spawn 约定绑定"） |
| `exec.ts` · `parsePsJson` | 空串→`{items:[],error:null}`；单对象→`[obj]`；数组→原样；坏 JSON→`{items:[],error:'…'}` |
| `store.ts` · `new JsonStore(dir)` | 目录不存在自动建；损坏 JSON→默认状态；`save()` 300ms 后落盘；`flush()` 立即落盘 |
| `simulator.ts` · `mulberry32(seed)` | 同种子 → 同序列（可复现截图） |
| `mdns.ts` · `encodeDnsName / buildMdnsQuery / parseMdnsRecords` | 名称编码为长度前缀 + `0x00`；query 报文 QDCOUNT=1、QTYPE=PTR；解析自造报文可取回记录 |

### 5.2 给 Vic：复现命令与环境限制

```bash
cd C:/github/svesc

# 0) 依赖（首次约 3-8 分钟；Electron 二进制约 120MB）
npm install
#    若 node_modules/electron/dist 不存在（postinstall 被跳过/失败）：
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js

# 1) 类型检查 + 构建（产物：dist/renderer/index.html + dist/main/{index,preload}.cjs）
npx tsc --noEmit -p tsconfig.node.json
npm run build

# 2) 单测（Tess 补齐后应全绿；当前无测试文件也 exit 0）
npm test

# 3) 纯 Node 探测能力验证（不启动 Electron，最重要的能力证据）
npm run engine-check
#    → stdout 打印耗时分解与断言；写 .agent-runs/2026-10-25/task-001/artifacts/engine-snapshot.json
#    → exit 0 当且仅当 devices>0 && printers>0

# 4) 冒烟截图（真实窗口 + 5 张 PNG + snapshot.json）
npm run smoke
#    → overview.png / devices.png / detail.png / printers.png / alarms.png + snapshot.json
#    → 需要图形会话（本地或 RDP 均可）

# 5) 手动启动
npm start
```

**环境坑（本机实测，必须知道）**

1. **`ELECTRON_RUN_AS_NODE=1`**：WorkBuddy 宿主会注入该变量，导致 `electron.exe` 退化为纯 Node，`require('electron')` 拿不到 API（报 `Cannot read properties of undefined (reading 'whenReady')`）。
   - `npm start` 走 `scripts/start.mjs`，已在子进程 env 中 `delete` 掉它；
   - `scripts/smoke.mjs` 同样已 `delete`；
   - **只有**手工直接敲 `electron .` 才需要自己 `unset ELECTRON_RUN_AS_NODE`。
2. **GPU 进程崩溃**：本机在 RDP/虚拟显示会话下 GPU 进程反复崩溃（`gpu_data_manager_impl_private.cc: GPU process isn't usable. Goodbye.` → 进程 FATAL 退出）。已在 `src/main/index.ts` 启动即 `disableHardwareAcceleration()` + `--disable-gpu / --disable-gpu-sandbox / --no-sandbox`。若在别的机器上删掉这些开关，必须确认 GPU 正常。
3. **编码**：不要给 `arp`/`ping` 设 `chcp 65001` 或经 PowerShell 调用——中文会变英文、中文字面量正则全失效。所有 spawn 站点都在 `engine/exec.ts` 统一绑定解码器。
4. **`ping -a` 禁用**：单次 4.6s，不可达主机 8s+。主机名走 `dns.reverse`（800ms/并发 8/缓存 10min）。
5. **冒烟需要真实数据落地**：`smoke.ts` 会等"真实设备 > 0 且真实打印机 > 0"（上限 35s）。若在无局域网机器上跑，会退化为 `dataSource=demo`（`sim-` 前缀数据），`smoke.mjs` 仍应通过但快照会标注 demo。

6. **模块格式（`"type":"module"` 下的约定）**：主进程产物固定 `.cjs`（`dist/main/index.cjs`、`dist/main/preload.cjs`，Electron 主进程必须 CJS）；`scripts/**` 全部 `.mjs`（纯 ESM，不用 `require`）；引擎 TS 由 esbuild 打包成 CJS 内联进主进程 bundle。`scripts/` 下**没有** `.js` 文件，避免重演 `probe/*.js` 被当成 ESM 后 `require` 报错的坑。

**判读要点**

- `engine-check` 的 `PRINTER_OFFLINE 产生` 一行：本机应显示 `PASS (MF750C Series)`。若显示 `FAIL(无离线打印机)`，说明 `.213` 这次网络可达了（真实拓扑变化），不是代码回归。
- 扫描耗时看 `≡ 扫描阶段合计`（本机 7.3-10.0s）；`printers 采集` 是独立 15s 任务，不计入 12s 指标。
- `alarms` 数量在**第二次及以后**启动时会包含历史 `DEVICE_NEW`（已标 `已恢复`），活跃告警数看 `system.alarmCounts`，本机应恒为 `{critical:1, warning:0, info:0}`。

---

## 6. 已知限制与未做项

### 6.1 明确未实现（按 brief 要求不自行猜测）

1. **IPP（631）耗材通路（已实现，opt-in）**：`printers/ipp.ts` 单文件 148 行、仅 `node:http`、零依赖，按 team-lead 规格实现（路径 `['/ipp/print','/ipp']`、IPP 2.0、operation 0x0009、2500ms、statusCode≠0 立即放弃、负值 `levelPct:null`）。本机两台设备都拒绝 `Get-Printer-Attributes`（`.235` 0x0400 / `.170` 404+0x0406），因此本机耗材仍全部来自 SNMP；模块价值在支持 IPP 的现场机型。负缓存 300s + 离线设备不查询，保证零噪音、零拖慢。
2. **mDNS 默认关闭**（`LAN_MDNS=1` 可开）：本机无 mDNS 打印机响应，且它属于"可选增强"；实现已就绪且任何异常都静默返回 `[]`。
3. **多网段**：只扫默认路由所在 /24（非 /24 网段取所属 /24 块）。
4. **真实 ICMP raw socket**：仍需管理员权限 + 原生依赖，违背零原生依赖，不做。

### 6.2 精度/行为边界

- **带宽**：连接数分摊是估算（见 ARCHITECTURE §5）；`share≈0` 时 `attributable:false`，UI 不应显示 0。
- **离线判定延迟**：需 ARP 连续 3 轮缺席（心跳 5s × 3 = 最快 ~15s）。单轮 `engine-check` 无法制造"离线"，该路径由 `resolveLinkState` 单测覆盖。
- **质量分级**：质量窗口只由 15s 的 `ping -n 4` 批量采样填充（每轮 ≤12 台 / 并发 8），扫描与心跳的存活 ping 不写入窗口；`samples<2` → `score 0 / unknown`，`samples 2..7` → score 照算但 grade 一律 `unknown`（置信门），`samples>=8` 才出 grade；判 degraded 与 `NET_QUALITY` 共用同一常量 `QUALITY_MIN_SAMPLES`。启动后约 10-25s 各台先显示"采样中"，30s 后陆续出 `优/良`。
- **虚拟打印机**：8 条队列里 4 条是 `Adobe PDF / Fax / Microsoft Print to PDF / XPS`，均已标 `connection:'virtual'`，UI 默认隐藏（由 Max-2 控制）。
- **`Canon G3030 series`**：端口是 `WSD-<uuid>` 且名称里没有 MAC，也不在任何 ARP 表中 → `ip:null`（诚实）。它同时出现在 spooler 里且网络可达性未知，因此不产生 `PRINTER_OFFLINE`（`ip===null` 时按规则不告警）。
- **SNMP 结果缓存**：正 60s / 负 300s，`.213` 若随后恢复，最多 5 分钟后才出现耗材数据（状态离线判定不受影响，TCP 探活每 15s 都做）。

### 6.3 主动做出的工程决策（需 Ray 复核）

| 决策 | 理由 |
|---|---|
| 启动即关闭硬件加速 + `--no-sandbox` | 本机不加则 Electron 直接 FATAL 退出（GPU 进程崩溃循环）。数据密集型 2D UI 无 GPU 需求 |
| `backgroundThrottling: false` | 隐藏/最小化时 Chromium 会节流渲染，导致 2s 推送停更、冒烟截到旧帧 |
| `AlarmEngine` 首轮扫描只做种，不产生 `DEVICE_NEW` | 否则每次重启刷十几条 info 噪音；语义是"运行期间接入的新设备" |
| `DEVICE_NEW` 保持 active 至 ack 或 10 分钟 TTL | 事件型告警若"下一轮自动恢复"，用户永远看不到（修复前 19 条同毫秒 resolved、`info=0`）；TTL 常量 `NEW_DEVICE_TTL_MS=600_000` |
| 扫描/心跳的单次 ping 不进质量窗口 | 单次 ping 只有"回复/超时"两种结果，混入窗口会把 3/4 回复算成 25% 丢包（`.23`/`.176` 假 degraded 的根因）；质量只认 `ping -n 4` 批次 |
| 判 degraded 需 `samples >= QUALITY_MIN_SAMPLES(8)`（2 个 `ping -n 4` 批次） | 单批次 4 包的最小丢包粒度就是 25%，1 包被限速即越过 20% 阈值，实测 `.196` 35s 变红、95s 变绿；8 样本才能区分持续丢包与单包抖动。150ms/20% 阈值**未改** |
| `samples<8` 时 `grade` 一律 `unknown`（score 保留） | 否则会出现"UI 显示 poor/40 但不告警"的不一致（Tess C-4 提出，team-lead 裁定 B 方案）。`computeQuality` 的 grade 门、`isDegraded`、`NET_QUALITY` 共用 `QUALITY_MIN_SAMPLES`，不写第二个 8 |
| `NET_QUALITY` 同样要求 `samples>=8` | 与 `isDegraded` 同一口径；否则单批次高延迟会让 `.75/.148` 在 60s 处闪出一条 NET_QUALITY（修复前 soak 实测），属同类假抖动 |
| 端口探活 700ms（非 brief 的 350ms） | 350ms 会漏判低端打印机；见 §4 C5 |
| `pageCount` 多 marker 取 max | 求和会把彩色/黑白重复计入＝造数 |
| `npm start` 改为 `node scripts/start.mjs` | 宿主注入的 `ELECTRON_RUN_AS_NODE=1` 会让 `electron .` 静默退化成 Node；启动器统一清掉，Vic 不用记这句咒语 |

---

## 7. 与 P1 调查报告的冲突及澄清（SNMP）

> 对应 team-lead 补充 3：Vera 报 8 次 GET 全 timeout，`ARCHITECTURE.md` / `plan.md` D-007 记为"SNMP 无法真机验证"；
> 本实现却拿到 SHARP 耗材与页计数。下面按「差异 / 原因 / 证据 / 结论」四段给出可复现的澄清。

### 7.1 差异

| 项 | P1 调查报告（Vera） | 本实现（Max-1 实测） |
|---|---|---|
| SNMP GET 结果 | 4 主机 × community{public,private} 共 8 次，**全部 timeout** | `.170` 55B / 7ms、`.235` 276B / 3ms，**各重复 3 次全成功** |
| 耗材 | 只能 `null` | SHARP `black=75%`；Xerox 13 条（`maxCapacity=-2/-3` → `levelPct:null`） |
| 页计数 | 无来源 → `null` | `prtMarkerLifeCount`：SHARP 117,483；Xerox 17,773 |
| `.213` | timeout | timeout（**一致**：该打印机 IP 层不可达，TCP 9100/631/515 也全失败） |
| 归档结论 | "SNMP 无法真机验证"（`plan.md` D-007） | v2c 单 GET 与 GETNEXT walk **均可真机验证** |

### 7.2 原因（根因：请求报文少一层 SEQUENCE）

不是超时长短、重试次数、community 或 OID 起点的问题——**是 Vera 探针构造的 BER 报文本身非法**。

SNMPv2c GetRequest 的正确结构：

```
SEQUENCE {
  INTEGER   version = 1
  OCTET STRING community = "public"
  [0] GetRequest-PDU {
    INTEGER request-id, INTEGER error-status=0, INTEGER error-index=0
    SEQUENCE OF SEQUENCE { OID, NULL }      ← VarBindList 里每个 varbind 必须再套一层 SEQUENCE
  }
}
```

Vera 的 `buildGet` 把 varbind 写成了 `SEQ(OID, NULL)`（只一层），即 `VarBindList = SEQUENCE{ OID, NULL }`，
少了一层嵌套。设备侧 BER 解码失败后**静默丢弃**（SNMP 代理普遍如此，不回 `genErr`），
于是探针只能等到自己的 UDP 超时——8 次全 timeout 的表象由此而来。

### 7.3 证据（可复现）

把两份实现打成纯 Node 模块后逐字节对比（同一 OID `1.3.6.1.2.1.1.1.0`、community=public、request-id=42）：

```
vera hex: 302402010104067075626c6963a01702012a020100020100300c06082b060102010101000500
mine hex: 302602010104067075626c6963a01902012a020100020100300e300c06082b060102010101000500
IDENTICAL: false   len 38 vs 40
```

差异点：`a0 17`（Vera，PDU 长 23）vs `a0 19`（本实现，PDU 长 25）；
Vera 的 varbind 是 `30 0c 06 08 … 05 00`（一层 `30`），本实现是 `30 0e 30 0c 06 08 … 05 00`（两层 `30`）。

同一时刻对两台真机各发包（UDP 161，900ms 超时，不重试）：

```
192.168.2.235  vera-packet -> {"ok":false,"err":"timeout","ms":2012}
               mine-packet -> {"ok":true,"len":276,"ms":3}
               mine repeat -> true, true, true
192.168.2.170  vera-packet -> {"ok":false,"err":"timeout","ms":2015}
               mine-packet -> {"ok":true,"len":55,"ms":7}
               mine repeat -> true, true, true
```

补充事实（排除环境变量）：同一台机器、同一网段、同一 community、同一 OID；本实现只改了 varbind 嵌套一层，
结果从 100% timeout 变为 100% 成功（3/3）。这说明设备侧 SNMP 一直是可用的，问题在报文。

### 7.4 结论

1. **P1 的"SNMP 全 timeout"是其探针报文缺陷造成的假阴性**，不能作为"SNMP 不可用"的证据；`plan.md` D-007 的结论应被本节的实测覆盖（`plan.md` 由 team-lead 维护，我不改动）。
2. 本实现的 `snmp-ber.ts` 支持：单 GET、GETNEXT walk（子树下行）、RFC 3805 耗材表、`prtMarkerLifeCount` 页计数；`prtAlert*` 告警表**未使用**（故障判定走 `hrDeviceStatus` + TCP 探活 + spooler state，避免不可控的大表 walk）。
3. 复现本实现的能力请用 `npm run engine-check`（或 `node scripts/engine-check.mjs`），**不要**直接运行 `probe/probe.js`——后者是上述缺陷报文的来源。
4. 若现场某台设备仍 timeout，才是真正的"设备未开 SNMP / 161 被封 / community 非 public"，此时按诚实原则返回 `consumables: []`、`pageCount: null`，不得编造。

> 附：`ARCHITECTURE.md` §4 已同步为"实测支持到哪一层"的能力表，并写入本节的根因说明。

---

## 8. P1 修复记录（DEVICE_NEW 语义 / 启动期假 degraded）

### 8.1 修复前后对比（同一台真机、同一网段）

| 指标 | 修复前 | 修复后（证据） |
|---|---|---|
| `DEVICE_NEW` 条数（启动） | **19 条**（首轮扫描后被当成"运行期新接入"） | **0 条**（首轮只做种；`soak` 95s 全程 active/resolved = 0/0） |
| `DEVICE_NEW` 状态 | 全部 `resolvedAt !== null`，且 **unique resolvedAt = 1**（同一毫秒批量恢复） | 新 MAC 产生 1 条 → 90s 后仍 `active`（`resolvedAt===null`），`counts().info=1` |
| 用户可见性 | 界面只能看到"新设备接入：…（已恢复）" | active 保留至 ack 或 TTL 10 分钟；ack 立即收尾，TTL 精确在 `raisedAt+600000ms` 恢复 |
| 同毫秒批量恢复 | 19 条 | 0（lifecycle `maxSameMs=0`；真实 soak `sameMs=0` 全程） |
| degraded 台数 | **2 台**：`.23` fair/loss 25%/samples=3、`.176` poor/loss 33.3%/samples=2 | **0 台**：95s 内每 5s 采样 20 次，`degraded` 恒为 0；20 台最终 samples 8-12、`excellent/good` |
| 样本不足导致的 degraded | 有（samples<4 且丢包 25-33%） | 0（`samples<8` 不判 degraded，且 grade 一律 unknown） |
| 质量样本来源 | 扫描 ping + 心跳单 ping 混入窗口 | **只有** 15s 的 `ping -n 4` 批次（≤12 台/轮、并发 8） |

证据文件：`artifacts/soak-report.json`（20 个采样点 + lifecycle 断言全部 PASS）、`artifacts/engine-snapshot.json`、`artifacts/snapshot.json`、`artifacts/*.png`。

### 8.2 根因与改动

| # | 根因 | 改动 |
|---|---|---|
| 1 | 启动初期 2s 带宽 tick 先调用 `evaluate(devices=[])`，把 `seeded` 置 true；扫描完成后 19 台全被当成"新设备" | `alarms.evaluate` 只在 **`devices.length>0`** 时置 `seeded`（"首轮"＝首次拿到非空设备列表） |
| 2 | `ephemeral` 集合让 `DEVICE_NEW` 下一轮必然 `resolvedAt=now` | 删除 `ephemeral`；改为 `NEW_DEVICE_TTL_MS=600_000`：`ack` 或 TTL 到期才 resolved |
| 3 | 扫描阶段 `pingSweep` 的存活结果写入 `QualityTracker`，单 ping 的"超时"被当成丢包样本 | 删除扫描/心跳中的 `tracker.record`；新增 `scheduler.sampleQuality()`（15s，`ping -n 4`，≤12 台，并发 8） |
| 4 | 4 包批次的最小丢包粒度 = 25%，1 包被限速即越过 20% 阈值 → `.196` 35s 红、95s 绿 | `samples < QUALITY_MIN_SAMPLES(8)` 时 grade 一律 unknown（score 保留）；`isDegraded` 与 `NET_QUALITY` 同门槛。**150ms/20% 阈值未改** |
| 5 | 旧版本的 `hydrate` 把未恢复的 `DEVICE_NEW` 直接置 `resolvedAt=raisedAt`，持久化后留下 19 条"同毫秒已恢复"垃圾 | `hydrate` 迁移：丢弃 `resolvedAt<=raisedAt` 的 `DEVICE_NEW`；未 ack 且未超 TTL 的记录继续 active |
| 6 | `ConsumableProvider` 接口只声明 `name/load`，`collectPrinters` 却用 `as SnmpConsumableProvider` 强转后直呼 `statusOf`，注入替身必 TypeError 并打断 15s 刷新周期（Tess 单测暴露） | 接口新增可选 `statusOf?(ip)`；调用点去掉强转，改为 `typeof === 'function'` 能力检测；`providers` 显式标注 `ConsumableProvider[]`。行为零变化 |

### 8.3 验收对照

| 验收项 | 要求 | 实测 |
|---|---|---|
| 首轮 seed 不产生 `DEVICE_NEW` | 0 条 | ✅ `seededCreated=0`；真实 95s soak 也是 0/0 |
| 第二轮起新 MAC 产生 | 1 条 | ✅ `created=1` |
| 产生后保持 active | 第 3 轮、90s 后仍 active | ✅ `activeAfterNextRounds=1`、`activeAfter90s=1` |
| `alarmCounts.info` 一致 | =1 | ✅ `info=1`（活跃且未 ack 未超 TTL） |
| ack 提前收尾 | ack 后 resolved | ✅ `ackedResolved=true` |
| TTL 10 分钟 | `raisedAt+600000ms` | ✅ `resolved@+600000ms` |
| 无同毫秒批量 resolved | 0 | ✅ `maxSameMs=0`（lifecycle 与真实 soak） |
| ≥60s 无样本不足 degraded | 0 | ✅ 95s 内 degraded 恒 0；`samples<8` 的 degraded = 0 |
| 真丢包稳定持续而非闪变 | — | ✅ `.176` 最终 8.3% 丢包 → `excellent`，`.196` 0% → `excellent`，无红绿跳变 |

复现：`npm run soak -- --duration 95`（或 `node scripts/soak-check.mjs`）、`node scripts/engine-check.mjs`、`npm run smoke`、`npx vitest run`（192/192）。

### 8.4 P2：`Printer.model` 被填入完整 sysDescr（实拍发现）

| 项 | 修复前 | 修复后（`artifacts/snapshot.json`） |
|---|---|---|
| Xerox 卡片型号 | `Xerox AltaLink C8055; SS 103.002.042.33200, NC …, DF 007…`（占两行并被截断） | `Xerox AltaLink C8055` |
| SHARP 卡片型号 | `SHARP MX-B4621R PCL6`（驱动名，本来正确） | 不变 |
| Microsoft 队列 | `null` | 不变（`Microsoft IPP Class Driver` / Print to PDF / XPS 均 `null`） |
| sysDescr 原文 | 被当作型号，固件串丢失在截断里 | 进入 `stateDetail`：`sysDescr: <前 80 字符>`，`SS/NC/UI/ME/CC/DF` 可查 |

实现：
- 新增纯函数 `sanitizeModel(raw)`（`printers/printer-mib.ts`，导出供 Tess 断言）：`null/空白 → null`；只取首行与首个 `;`/`；` 之前；合并空白、去首尾括号/引号；>40 字符用 `…`（保留 39 + 省略号）。
- 型号优先级不变：spooler `DriverName`（非 `Microsoft *`）→ SNMP `sanitizeModel(sysDescr)` → IPP `printer-make-and-model`（同样清洗）。
- `ConsumableProviderResult` 新增可选 `sysDescr`（SNMP 原文），`printer-service` 把它拼进 `stateDetail`（前 80 字符），不新增共享契约字段、不影响 UI 现有渲染。

### 8.5 grade 置信门（B 方案，team-lead 裁定）+ 注释纠错

| 项 | 修复前 | 修复后 |
|---|---|---|
| `samples` 2-7 的 grade | 按 score 判（可能 `poor/40`）但 `isDegraded`/`NET_QUALITY` 要 8 → "显示差但不告警" | **一律 `unknown`**；`score` 保留原值（测量证据） |
| `samples` 0/1 | `score 0 / unknown` | 不变 |
| `samples>=8` | 85/70/50 原边界 | 不变 |
| 常量来源 | `QUALITY.degradedMinSamples`（仅 degraded 用） | 顶层 **`QUALITY_MIN_SAMPLES = 8`**；`computeQuality` grade 门、`isDegraded`、`NET_QUALITY` 三处同源；`QUALITY.degradedMinSamples` 保留为同值别名（`@deprecated`，供渲染层过渡） |
| `latencyMs=null` 注释 | 写的是 "按 100 处理 → 60"（错） | `(100-20)/1.5 = 53.33` → **score 47 / poor**（47<50；提醒里写的 "fair" 是笔误，`gradeOf(49)==='poor'` 是既有断言） |

实测（纯函数直接驱动）：

```
samples= 0  grade=unknown  score=  0  degraded=false
samples= 1  grade=unknown  score=  0  degraded=false
samples= 4  grade=unknown  score= 63  degraded=false
samples= 7  grade=unknown  score= 63  degraded=false
samples= 8  grade=fair     score= 63  degraded=true
latency=null, samples=8 → grade=poor score=47
```

真机冒烟（16s 抓图，12 台刚完成 1 个批次）：`grade=unknown / samples=4 / score=97-100` → UI 显示"采样中"，不再出现"质量差但不告警"。
不变量：`grade ∈ {excellent,good}` ⇒ `samples>=8`；`grade==='unknown'` 永不进入 `NET_QUALITY`。
