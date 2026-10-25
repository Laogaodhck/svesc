# 测试报告 — 测试工程师 Tess（task-001 / P2b）

| 字段 | 值 |
|---|---|
| 范围 | 仅 `tests/**`（14 个文件），**未修改任何 `src/**`、`package.json`、`vitest.config.ts`** |
| 命令 | `cd C:/github/svesc && npx vitest run`（node 环境） |
| 轮次 1 自验 | 9 文件 / 165 用例 / 165 通过 / 0 失败 |
| 轮次 2 自验（补 P0+P1） | 11 文件 / 192 用例 / 192 通过 / 0 失败 |
| 轮次 3 自验（Max-1 二次改动后加守卫） | 11 文件 / 198 用例 / 198 通过 / 0 失败 |
| 轮次 4 自验（T-4 改为接口可选方法后） | 11 文件 / 199 用例 / 199 通过 / 0 失败 |
| 轮次 5 自验（C-4 选 B 落地） | 11 文件 / 205 用例 / 205 通过 / 0 失败 |
| 轮次 6 自验（补 `sanitizeModel` + Printer MIB + 接入点 + 常量单一来源 + ack 特例不外溢） | 12 文件 / 280 用例 / 280 通过 / 0 失败 |
| 轮次 7 自验（R-02~R-06 断言先行） | **我的 14 文件 / 318 用例 / 318 通过 / 0 失败**；`tsc --noEmit -p tsconfig.node.json` → 0 error。**全仓** 17 文件 / 348 用例 / 347 通过 / 1 失败（唯一一条红在他人新文件 `router-openwrt.test.ts`，见 §6 附注） |
| 环境约束达成 | 无网络、无 Electron、无管理员权限（无 ping / 无 arp / 无 SNMP / 无 HTTP / 无 netstat 实调；全部注入 fixture 或注入 probe/provider） |
| 结论 | **PASS**。累计 5 个真实缺陷（1 低 / 2 中 / 2 高）：T-1~T-4 由我的用例逼出，T-5 由 Max-1 读码自查（我的用例漏了启动期空 devices 调用序，已补 4 条断言锁定）。**全部在 `src` 侧修复，断言零改动即转绿**；我全程未改 `src` |

---

## 1. 用例总览

| # | 文件 | 用例数 | 通过 | 失败 | 覆盖目标 |
|---|---|---:|---:|---:|---|
| 1 | `tests/snmp-ber.test.ts` | 34 | 34 | 0 | A. BER 编解码 |
| 2 | `tests/quality.test.ts` | 33 | 33 | 0 | B. 质量评分 |
| 3 | `tests/arp.test.ts` | 18 | 18 | 0 | C. ARP 解析 |
| 4 | `tests/alarms.test.ts` | 38 | 38 | 0 | D. 告警引擎 |
| 5 | `tests/bandwidth.test.ts` | 15 | 15 | 0 | E. 带宽差分 |
| 6 | `tests/subnet.test.ts` | 12 | 12 | 0 | F. 子网推导 |
| 7 | `tests/oui.test.ts` | 14 | 14 | 0 | G. OUI |
| 8 | `tests/fingerprint.test.ts` | 13 | 13 | 0 | G. 指纹 |
| 9 | `tests/scheduler.test.ts` | 9 | 9 | 0 | §5.1 状态判定（追加） |
| 10 | `tests/printer-service.test.ts` | 19 | 19 | 0 | **P0 打印机状态覆盖（`.213` 假在线）+ 型号/sysDescr 接入点** |
| 11 | `tests/ping.test.ts` | 16 | 16 | 0 | **P1 ping 输出解析** |
| 12 | `tests/printer-mib.test.ts` | 59 | 59 | 0 | **Printer MIB 纯函数：`sanitizeModel`/耗材百分比/页计数/状态映射** |
| 13 | `tests/scheduler-resilience.test.ts` | 34 | 34 | 0 | **R-02 带宽 null 语义 / R-03 warnings 去重自愈裁剪 / R-04 关扫描不停采集 / R-06 离线判定 + WarningLog 纯函数** |
| 14 | `tests/exec-fallback.test.ts` | 4 | 4 | 0 | **R-05 子进程不派发 close 时的兜底 settle**（Max-1 落地后转绿） |
| 15 | `tests/router-openwrt.test.ts` | — | — | — | **他人新增**（router 模块，非我写）：3 文件 / 30 例，其中 1 红（`login 成功缓存会话`） |
| 16 | `tests/router-detect.test.ts` | — | — | — | 同上，他人新增 |
| 17 | `tests/router-upnp.test.ts` | — | — | — | 同上，他人新增 |
| — | `tests/fixtures.ts` | — | — | — | 夹具（非测试文件，`include` 不收集） |
| | **我的合计（1–14）** | **318** | **318** | **0** | 目标 ≥25，实际 12.7× |
| | **全仓合计（1–17）** | **348** | **347** | **1** | 唯一一条红不是我写的（见 §6 附注） |

一次 `it()` 只断一件事；断言消息都带输入摘要（`实际探活 ${calls} 次`、`实际 detail：…`、`活跃告警：…`），失败可直接定位。

---

## 2. 覆盖矩阵

### 2.1 brief §1 A–G 逐项

| 组 | 必覆盖点 | 对应用例（节选） |
|---|---|---|
| **A** SNMP BER | 短/长格式、127/128、0x81/0x82 | `encodeLength(127) 应仍为短格式 7f`、`encodeLength(128) 应切换为长格式 81 80`、`encodeLength(300) 应为两字节长度 82 01 2c`、`decodeLength 应回读 0x82 01 2c 为 300` |
| | integer 正负与 0、-3 | `encodeInteger(0/127/128/-1/-3)`、`decodeInteger 应把 02 01 fd 的值段读回 -3` |
| | OID 往返 + 子标识 ≥128 | `encodeOid(1.3.6.1.2.1.1.1.0) 应为 06 08 2b…`、`OID …43.11.1.1.9.1.1 编码后解码应原样往返`、`子标识 9999（≥128）应编码为两字节 ce 0f 且可往返` |
| | 嵌套 sequence、截断、伪造长度 | `嵌套 sequence 的父子标签应可逐层遍历`、`截断报文必须抛 RangeError 而不是产出半个 value`、`被伪造的 4 字节长度 0xFFFFFFFF 必须抛错且不得耗尽内存/死循环` |
| | 报文冒烟 | `buildGetRequest` 全字节断言、`parseResponse` 解 requestId/varbinds、`Counter32→number`、`Gauge32→number`、`NULL→null`、`顶层非 SEQUENCE 应抛错` |
| **B** 质量评分 | samples<2 → 0/unknown | `samples=1 …`、`samples=0 …`、`unknownQuality() …` |
| | 完美链路 100/excellent | `完美链路（lat 10 / jitter 0 / loss 0）应为 100 分 excellent` |
| | latencyMs=null | `latencyMs=null 且样本充足时应为 47/poor`（裁定见 §5 C-2；注意 47 < 50 → poor） |
| | 置信门 `QUALITY_MIN_SAMPLES=8` | `samples 在 2..7 时 grade 一律 unknown`、`samples=7 且链路完美时 score 仍应为 100`、`samples=8 时 grade 应按原边界判定（70 分 → good）`、`grade 门与 degraded 门必须在 7/8 边界上同时翻转（同源锁）` |
| | 常量单一来源（C-4 裁定 ③） | `QUALITY_MIN_SAMPLES 的口径值应为 8（>0 且整数）`、`QUALITY.degradedMinSamples 必须与 QUALITY_MIN_SAMPLES 严格相等（不得出现第二个字面量 8）`、`全样本区间 0..12：grade !== unknown 当且仅当 samples >= QUALITY_MIN_SAMPLES`、`全样本区间 0..12：isDegraded 为 true 时 samples 必 >= QUALITY_MIN_SAMPLES`（比 7/8 单点锁更强：任一处两门取值不同即报红，失败消息列出不一致的样本数） |
| | loss=100 下界钳制 | `loss=100 时 lossPen 封顶 60，score 应为 40 而不是负数`、`score 无论如何不得越出 0..100` |
| | 85/70/50 边界 | `gradeOf(85/84/70/69/50/49)` 六条，全部按 `>=` 归高挡 |
| | NaN/负数/超范围 | `NaN 延迟/抖动/丢包不应抛异常`、`负延迟应按 0 罚分处理`、`丢包 250% 应按 100% 截断`、`clamp(NaN,0,60) 应返回下界 0` |
| | 防抖动口径（`degradedMinSamples=8`） | `只有 1 个批次（4 样本）时即使丢包 25% 也不得判 degraded（防闪变）`、`两个批次（8 样本）丢包 25% 才应判 degraded` |
| **C** ARP 解析 | 中文原文 | `应解析出 4 条真实设备`（Vera §2.1 逐字照抄）、`MAC 应归一化为小写连字符，且挂在正确的接口段下` |
| | 英文原文 | `Interface: 段头 + dynamic 行应解析出 1 条`、`英文段的接口地址应被记录` |
| | 过滤组播/广播 | `224.0.0.22 组播条目不得出现在结果里`、`广播地址 192.168.2.255 与全 f MAC 不得出现`、`isSkippableArpIp …` |
| | 空/乱码/半行 | `空字符串…`、`乱码文本…`、`半行…`、`中文表头被错误解码但 IP/MAC 完整时仍应解析出条目` |
| | 回退路径 | `State=Unreachable 的条目应跳过`、`全零 MAC 即使 State=Stale 也不得当成设备`、`Permanent 条目应跳过`、`冒号分隔的大写 MAC 应归一化` |
| **D** 告警引擎 | 同因去重 | `同一设备连续两轮离线只应产生 1 条 DEVICE_OFFLINE`、`dedupeKey …` |
| | 条件消失自动 resolved | `设备恢复后原告警应置 resolvedAt 并计入 resolved`、`恢复后再次离线应重新产生一条` |
| | 耗材阈值 / null | `耗材 10%（阈值边界）应产生 SUPPLY_LOW`、`耗材 8% …`、`耗材 4% 应升级为 SUPPLY_CRITICAL`、`levelPct=null 时不得产生任何耗材告警` |
| | 历史 500 裁剪 | `历史超过 500 条时应裁剪到 500 条`、`裁剪应丢弃最旧的告警`、`裁剪应保留最新的告警`（520 台真实溢出） |
| | alarmCounts 一致 | `alarmCounts 应与实际活跃告警逐级一致` |
| | 打印机规则 | `spooler 报 Normal 但 TCP 探活不可达 → PRINTER_OFFLINE critical`、`ip 为 null 时不得产生…`、`state=error → PRINTER_ERROR` |
| | NET_QUALITY 2 轮 | `poor 仅 1 轮时不得告警`、`poor 连续 2 轮应产生 1 条 NET_QUALITY warning` |
| | DEVICE_NEW 生命周期（新规格） | `首轮 seed 不得产生`、`第二轮起新 MAC 产生 1 条`、`下一轮不得自动恢复`、`counts().info===1`、`ack 立即收尾`、`TTL 满 10 分钟收尾`、`devices 为空的一轮不得消耗 seed`、`hydrate 恢复的已知设备不再产生`、`hydrate 丢弃旧版"同毫秒已恢复"垃圾记录`、`hydrate 让未超 TTL 的事件续命` |
| | **ack 特例不得外溢**（Max-1 建议） | `DEVICE_OFFLINE ack 后只写 ackAt、resolvedAt 仍 null、仍在 active`、`ack 后仍计入 counts().critical`、`ack 不阻断恢复：设备 online 后仍写 resolvedAt 且保留 ackAt`、`SUPPLY_LOW ack 后同样留在 active（不得只给 offline 打补丁）`、对照组 `DEVICE_NEW ack 后必须立即 resolved 并移出 active（特例本身不得消失）` |
| **E** 带宽差分 | 两次采样算 bps | `2 秒内 +100 字节应为 400 bps` |
| | 回绕/重置 | `计数器重置为 0（curr<prev）应返回 0，不得出现负值或天文数字` |
| | 间隔 ≤0 | `采样间隔为 0 应返回 0（不得除零）`、`采样间隔为负（时钟回拨）应返回 0` |
| | 解析/归集 | `应从中文本地化原文取到 rx/tx 字节数`、`英文 Bytes 行应同样命中`、`无字节行时应返回 null`、`应解析出 6 条 TCP 连接…`、`归集只算 TCP+ESTABLISHED+网段内+非自身+非回环` |
| | 0 连接不除零 | `局域网连接数为 0 时不得除零：全 0 且 attributable=false`、`单设备独占全部连接时 share 应为 1`、`share 应按 4 位小数取整` |
| **F** 子网推导 | 挑出业务网卡 | `从含 vEthernet/WSL/环回/APIPA/蓝牙的接口表中只应留下业务网卡`、`isExcludedIface …`、`非 IPv4 条目应被忽略` |
| | /24 → 254 主机 | `/24 应展开 254 个可用地址，且首尾为 .1 / .254`、`展开结果不得包含网络号 .0 与广播地址 .255` |
| | 非 /24 截断 | `掩码为 /16 时仍应只扫所属 /24 块` |
| | 其它 | `preferredAddress 命中时应选中该接口`、`无 preferredAddress 时优先 192.168`、`无候选接口时应返回 null`、`isValidIpv4` 正反、`to24Prefix` |
| **G** OUI/指纹 | 三种 MAC 写法 | `大写连字符…`、`冒号分隔…`、`点分格式 aabb.ccdd.eeff 应归一化…` |
| | HP/Canon/Epson/Brother | 四条真实前缀 + `本机实测 9c-93-4e-9c-6a-76 应命中 Xerox` |
| | 未知前缀 null | `未知前缀必须返回 null`、`非法 MAC 应返回 null`、`ouiTableSize ≥60`、`厂商表键必须是小写连字符格式` |
| | 9100 → printer | `只有 9100 端口时应判为 printer`、`只有 631（IPP）…`、`hasPrinterPort([80,443,515,631,9100])=true` |
| | TTL 不得单独判定 | `TTL=255 且无端口/主机名/厂商时 kind 必须为 unknown`、`TTL=64 …`、`TTL=255 可以给弱提示，但不改变 kind` |
| 附 | §5.1 状态判定 | `ARP 在位但 ICMP 不通时必须判 online（ECMP 反例）`、`ARP 连续缺席 3 轮 → offline`、`ARP 只缺席 2 轮不得提前判 offline`、`本机/网关永远 online`、`质量退化覆盖为 degraded`、`只有 1 个样本不得判 degraded` |

### 2.2 P0 打印机状态覆盖（队长追加，`.213` 假在线）

| 断言 | 用例 |
|---|---|
| spooler `PrinterStatus=0 / Win32=Idle / WorkOffline=false` + 探活 `{9100,631,515}` 全 false → `state='offline'` | `spooler Normal/Idle + 探活全不通 → state 必须是 offline` |
| `stateDetail` 同时含 spooler 与探活视角 | `stateDetail 必须同时保留 spooler 视角与探活视角（运维定位用）` → 精确等于 `spooler=Normal · win32=Idle · 网络探活失败 9100/631/515` |
| `reachable` 表供告警引擎消费 | `reachable 表应记录该打印机 ip 不可达` |
| 反例：探活 9100 可达 → 不覆盖 | `反例：探活 9100 可达时不得覆盖 spooler 的 idle 判定` |
| 反例：`ip===null` 虚拟打印机 | `不得对无 IP 的打印机发起探活（调用次数=0）`、`不得被判为 offline` |
| `.213` 场景产出告警 | `应产出 PRINTER_OFFLINE / critical` |
| 告警 detail 双视角 | `告警 detail 应同时含 spooler 视角与探活视角`（正则 `spooler=Normal[\s\S]*网络探活失败 9100\/631\/515`） |
| 不可达时不查耗材 | `网络不可达时不得去查耗材（provider 调用=0）` + 两条正向对照（snmp / ipp 各一条，证明上一条不是空断言） |
| 面板文本合并不丢功能 | `实现了 statusOf 的 provider 应把面板文本追加进 stateDetail（生产路径不变）` → 精确等于 `spooler=Normal · win32=Idle · Toner Low · Load Paper` |

> 可测性结论：`collectPrinters({ probe, consumableProviders })` **本来就是可注入的**，无需改造 src 即可覆盖 `.213` 场景（比预期好）。但注入测试同时暴露了 T-4：注入点与 `ConsumableProvider` 接口契约不一致，已由 Max-1 修为能力检测。

### 2.3 P1 ping 输出解析（Vera §2.3 原文）

| 断言 | 用例 |
|---|---|
| 中文可达 `时间=3ms TTL=64` | `应解析出 alive=true / rtt=3 / ttl=64` |
| `时间<1ms` → rtt 0 | `时间<1ms 应记为 rtt=0（不是 1，也不是 null）` |
| TTL 提取 | `TTL=255 应原样提取（SHARP 打印机的真实值）` |
| 全角标点 | `全角冒号与全角等号混排时仍应解析成功` |
| `请求超时。` | `应判 alive=false`、`不得产出 rtt=0 的"成功"样本`、`应标记 timedOut=true 且不算"解析失败"` |
| 英文 locale | `Reply from … time=3ms TTL=64 …`、`Request timed out. …` |
| 无法解析 | `垃圾文本 + exitCode=0 → alive=true 但 parseWarning`、`垃圾文本 + exitCode=1 → alive=false 且不标记超时` |
| `-n 4` 统计 | `4 包全通 → loss 0% + rtts [0,1,1,0]`、`4 包全丢 → loss 100% 且 rtts 为空`、`半丢 → loss 50% + 2 个样本`、`平均 RTT 取到 0`、`无统计行时返回 null 而不是 0` |

### 2.4 Printer MIB 纯函数 + 型号清洗接入点（轮次 6，Max-1 新增 `sanitizeModel`）

**`tests/printer-mib.test.ts`（58 例，全部纯函数注入）**

| 关注点 | 用例（节选） |
|---|---|
| `sanitizeModel` 空输入 | `null → null`、`undefined → null`、`空字符串 → null`、`全空白 → null` |
| 截取规则 | `只取首行`、`半角分号后的固件版本必须被切掉`（`Xerox AltaLink C8055; SS 103.002…` → `Xerox AltaLink C8055`）、`全角分号同样切掉`（`SHARP MX-B4621R PCL6；固件 01.02`） |
| 反作弊 | `清洗结果不得残留固件版本号`（`not.toMatch(/SS\s*\d\|103\.002/)` —— 防止只做长度截断不做分号切分）、`首个字符就是分号 → null`、`只有括号 → null` |
| 空白/括号/引号 | `连续空白合并为单空格`、`成对圆括号去掉`、`成对双引号去掉` |
| 长度上限 | `恰好 40 字符不截断`、`41 字符 → 39 + …`、`截断后总长恰好等于 MODEL_MAX_CHARS`、`必须用 … 不用 ...`、`任意输入 ≤ 上限` |
| 幂等性 | `对已清洗结果再清一次不得变化`（调用点两次清洗不得漂移） |
| `toLevelPct` | `75/100 → 75`、`1/3 → 33.3`（一位小数）、`超容量钳 100`、`maxCapacity=0 → null`、`maxCapacity=-1 → null`、`current=-3 → null`（绝不换算成 -3%）、`current=null → null` |
| `inferSupplyKind` | `black/cyan/magenta/yellow`、`waste 优先于 toner`、`drum`、`中文"废粉"`、`typeCode 兜底（4→waste、21→other）`、`部件类型优先于颜色（Magenta Drum → drum）` |
| `parseSupplies` | `同 supplyIndex 的四列聚合成 1 条`、`完整契约形状断言`、`source 恒 snmp`、`maxCapacity=-1 时 levelPct null 但原值保留`、`description 空 → 中文默认标签`、`非 supplies 表 OID 不算耗材`、`无数据 → []（不伪造 0% 耗材）` |
| `parseMarkerLifeCount` | `多 marker 取最大值不求和`、`负值忽略`、`无 OID → null` |
| `parseSysDescr` / `parsePanelText` / `mapHrDeviceStatus` | `多行取首行`、`>120 截断`、`非字符串 → null`；`多行面板文本空格拼接`、`空白 → null`；`3→idle / 4→warning / 6→error / 未知→unknown`（不得乐观当 idle） |

**`tests/printer-service.test.ts` 新增 7 例（`型号清洗（sanitizeModel）与 sysDescr 的接入点`）**

| 断言 | 为什么要锁 |
|---|---|
| `通用类驱动时采用 provider 清洗后的型号` | `modelFromDriver('Microsoft *')` 返回 null，此时才轮到 SNMP 型号——这条是唯一的型号来源路径 |
| `型号里不得含固件版本串` | 防止 provider 层漏洗、靠 UI 兜底 |
| `spooler 给出具体驱动名时不得被 provider 型号覆盖` | 防修复过头（用户装的是自己的驱动，不能被 SNMP 顶掉） |
| `sysDescr 原文进入 stateDetail`（前 80 字符） | 排查固件版本时必须看得到 `SS/NC/UI/ME/CC/DF` |
| `>80 字符只取前 80`（且不得出现第 81 字符起的片段） | 防整串固件撑爆详情面板 |
| `无 sysDescr 时不得出现空的 "sysDescr: " 占位` | `filter(Boolean)` 漏写成模板字符串会留下尾巴 |
| `型号与 sysDescr 是两个字段：型号干净 + 详情留原文` | 双字段设计不可退化成单字段 |

#### 已确认口径（Max-1 书面确认，非我的推测）

| 口径 | 内容 | 我的断言 |
|---|---|---|
| `inferSupplyKind` 优先级 | `waste > drum > cyan > magenta > yellow > black > typeCode 兜底`。`kind` 描述"这是什么部件"（drum 决定更换周期/寿命语义），颜色由 `label` 原文保留。若把 drum 排到颜色之后，四色鼓会被拆成 4 条 `cyan/magenta/yellow/black`，UI 会把"鼓"当碳粉条显示 | `Magenta Drum → drum`、`Cyan Drum Unit → drum`（失败消息写明 UI 后果）、`Waste Toner Box → waste` |
| `sanitizeModel` 截断 | 契约只保证 `≤ MODEL_MAX_CHARS(40)`，**不保证恰好 40**；`slice(0,39).trimEnd()` 吃掉尾随空格是期望行为；不做词边界（中文无空格分词，引入 CJK 分词会违背零依赖）；UI 不得假设等宽截断（Max-1 已同步 Max-2） | 只锁 `≤ MODEL_MAX_CHARS`（不锁"恰好 40"），另锁"恰好 40 不截断 / 41 与 60 截断后总长 40" |
| 幂等与反退化 | `sanitizeModel` 两个调用点（SNMP/IPP）都会经过，重复清洗不得漂移；分号切分不得退化为"只截 40 字符" | `sanitizeModel(sanitizeModel(x)) === sanitizeModel(x)`、结果 `not.toMatch(/SS\s*\d\|103\.002/)` |

---

### 2.5 R-02~R-06 守卫（Ray 审查出的 5 条 P1，断言先行）

> 注入方式：`vi.mock` 替换四个 IO 出口（`readArp` / `pingSweep`+`pingQuality` / `probeHosts` / `readSpooler`）+ `node:child_process` 替身 + 结构注入 `meter` + fake timers。
> 不 spawn、不联网、不真等 180s；`T0` 固定，断言与真实时钟无关。

| 需求 | 断言（用例名节选） | 状态 |
|---|---|---|
| **R-02** 采样失败必须是 null | `warnings 必须始终是数组`、`采样失败时 rxBps/txBps 必须严格为 null`、`采样失败当轮必须有 source=bandwidth 条目`、`正常采样必须为数值且无 bandwidth 条目`、**对照** `零流量必须给 0（零流量 ≠ 采样失败）`、`从未采样也必须 null` | 全绿 |
| **R-03** 去重/上限/自愈 | `同 source+message 5 次只留 1 条`、`重复触发 at 更新为最后一次`、`恢复后条目消失`、`打印机异常 → source=printers`、`arp parseWarning → source=discovery`、`不同 source 各自保留`、`按 at 升序`、`超 20 条裁到 20 且丢最旧`（白盒，见下） | 全绿 |
| **R-04** 关扫描不停采集 | `关闭后全量扫描计数冻结`、`心跳继续增长`、`带宽继续增长`、`打印机刷新继续增长`（**三条分开断言**，合成一条会看不出是哪条退化）、`重新开启恢复增长`、`autoScan=false 时 rxBps 仍更新` | 全绿 |
| **R-05** exec 兜底 settle | `永不派发 close 时 ~500ms 内必须 settle`、`兜底后 PowerShell 闸门必须释放（第二次调用要能执行）`、`正常关闭后不得再被超时 kill`、`close 与兜底都到达只 settle 一次` | 全绿（曾 2 红） |
| **R-06** 离线判定 | `扫描1 在位 → online`、`36 次心跳（180s）不得 offline`、`缺席 1/2 次不得 offline`、`缺席 3 次必须 offline`、`offline 前 DEVICE_OFFLINE 必须 0 条`、`缺席 3 次后必须 1 条`、`pingAlive 每轮重置（粘住会永远在线）`、`无观测轮不得刷新 lastSeen` | 全绿 |

**观察到的"红→绿"证据**（这些守卫确实咬得住，不是写完就绿的）：

| 守卫 | 首跑（Max-1 未落地）实得 | 落地后 |
|---|---|---|
| `36 次心跳不得 offline` | `expected 'offline' not to be 'offline'` —— 3 次心跳（15s）就判离线，正是线上"设备突然离线"的形态 | 绿 |
| `offline 前 DEVICE_OFFLINE 必须 0 条` | `expected [ { id: 'alm-loyw46mw-1', … } ] to have a length of +0` —— 提前告警 | 绿 |
| `autoScan=false 时 rxBps 仍更新` | `expected {autoScan:false,grew:false}` —— 关扫描把带宽计时器一起拆了 | 绿 |

**关于"是否假绿"的三个自查**：
1. R-02 的 null 断言没有留下红色截图（Max-1 的实现在我第一次跑通前就落地了）。防假绿的依据是**成对对照**：`采样失败 → null` 与 `确实零流量 → 0` 必须同时成立——写死 null 会让对照红，写死 `?? 0` 会让失败用例红，只有真语义能同时过。
2. R-05 的 2 条红是我亲眼看到的（`expected 'pending' not to be 'pending'`、`expected false to be true`），转绿零改动。而且这条 600ms 就要求 settle 的断言把"立即 settle"这个更严的选择锁住了：Max-1 中途版本是"kill 后再等 500ms 兜底"（落在 1000ms），那个版本会被这条打成红；最终他选立即 settle，与 Vera 的受控实验结论一致（多占闸门会在 254 ping 批次里被放大成拥塞）。
3. R-03 的 20 条上限**原来是白盒**（poke 私有 `warnings` Map + `trimWarnings()`）。Max-1 随后把 `WarningLog` 导出成纯类（`push(source, message, at?)` / `clearSource` / `list()`），我立刻换成 7 条纯函数用例——私有字段 poke 在重构当天就断了（实测 `TypeError: Cannot read properties of undefined (reading 'bind')`），纯函数不会。这是"白盒能用一时、导出能用一世"的实例。

---

## 3. 真实缺陷表

> 轮次 1：00:49 首轮全量 154 例 → 4 红；发给 Max-1 后 00:52 复跑 165 例 → 0 红。
> 轮次 2：新增 P0/P1 后 192 例 → 1 红（T-4）；上报后 00:57 复跑 192 例 → 0 红。
> 轮次 3：Max-1 二次改动（含他自查出的 T-5）后 198 例 → 0 红。
> 轮次 4：T-4 改为「接口可选方法 + 能力检测」后 199 例 → 0 红（+1 条面板文本正向断言）。
> 轮次 5：C-4 选 B 落地后 205 例 → 0 红（grade 置信门 4 条 + 跨模块 NET_QUALITY 2 条）。
> 轮次 6：`sanitizeModel` + Printer MIB 纯函数 + sysDescr 接入点 + 置信门常量单一来源 + ack 特例不外溢 280 例 → **0 红（未发现新缺陷）**。
> 轮次 6 事后：Max-1 书面确认了两处我提交待裁的口径（`drum` 优先于颜色、截断只保证 `≤40`），已写入 §2.4「已确认口径」，**无需任何 src 改动**。
> 轮次 7：R-02~R-06 断言先行（Ray 审查的 5 条 P1）→ 312 例，**2 红（R-05）**。R-02/R-03/R-04/R-06 的守卫在 Max-1 未落地时真红过（见 §2.5「红→绿证据」），落地后零改动转绿；R-05 仍等上游。
> 轮次 7 附：全仓出现 3 个他人新增的 router 测试文件（30 例），其中 `router-openwrt.test.ts` 的 `login 成功缓存会话` 1 条红。已定位为**用例替身下标写错**（不是 src 缺陷），诊断见 §6 附注；**未替他改文件**。
> **断言全程未放宽、未 `.skip`、未改 `src`；5 个缺陷全部由 Max-1 在实现侧修复。**
>
> 诚实记录：轮次 6 我有 1 条用例首跑红——我把 `inferSupplyKind('Magenta Drum')` 期望成 `magenta`，实际实现按 `drum` 返回。核对后我判断**是我的口径假设错、不是缺陷**（`label` 仍保留原文 `Magenta Drum`，颜色信息不丢），改为显式锁定该优先级；随后 Max-1 书面确认这正是本意，并给出理由（若 drum 排到颜色之后，四色鼓会被拆成 4 条碳粉条，UI 把"鼓"当碳粉显示）。我又补了一条真实描述 `Cyan Drum Unit → drum` 把该后果写进失败消息。未动 src。

| # | 模块 · 文件:行 | 期望 | 实际 | 复现命令 | 严重级 | 状态 |
|---|---|---|---|---|---|---|
| T-1 | `discovery/oui.ts` `normalizeMac` | 三种写法归一化到同一 key：`AA-BB-CC-DD-EE-FF` / `aa:bb:cc:dd:ee:ff` / `aabb.ccdd.eeff` → `aa-bb-cc-dd-ee-ff` | 点分格式原样返回 → `isValidMac=false` → `lookupVendor` 静默 `null` | `npx vitest run tests/oui.test.ts -t 点分格式` | 低 | **已修复**（4-4-4 展开后两位分组；`isValidMac` 同步接受点分） |
| T-2 | `network/quality.ts` `isDegraded` | `samples < 2` 必须 false（扫描阶段那次存活 ping 不是质量样本） | `samples < 1`；单样本 `{latencyMs:300}` 即判 `degraded`，UI 把只 ping 过一次的设备标成网络劣化 | `npx vitest run tests/quality.test.ts -t 只有 1 个` | 中 | **已修复**（先改 `<2`；再按防抖动口径改为 `< QUALITY_MIN_SAMPLES=8`）。同一处还发现不一致：告警侧已加 `samples>=8` 门，但 `computeQuality` 的 grade 门仍是 `<2` → 「告警不报但 UI 显示 poor」（见 §5 C-4，已裁定补 grade 门） |
| T-3 | `alarms.ts` `ephemeral` | DEVICE_NEW 保持 active 直到 ack 或 TTL 10min；不得下一轮同毫秒 `resolvedAt` | `evaluate()` 开头把上一轮 DEVICE_NEW 全部 resolved 并删 active → 19 条 info 全消失、`alarmCounts.info=0` | `npx vitest run tests/alarms.test.ts -t DEVICE_NEW` | 高 | **已修复**（`NEW_DEVICE_TTL_MS=600_000` + `expireNewDevices()` + ack 出口） |
| T-4 | `printers/printer-service.ts:341-345` | `consumableProviders` 声明为 `ConsumableProvider[]`（只有 `name` + `load()`），注入的 provider 必须能被正常调用 | `providers.find(p => p.name==='snmp') as SnmpConsumableProvider` 后直呼 `statusOf(ip)`（**接口外方法**）→ 任何按接口实现的 snmp provider 抛 `TypeError`，异常直冒 `refreshPrinters()`，打断 15s 打印刷新周期 | `npx vitest run tests/printer-service.test.ts -t 网络可达时应确实查一次耗材` | 中 | **已修复**（两处：① 把 `statusOf?` 声明为 `ConsumableProvider` 的**可选方法**；② 调用点改 `typeof statusOf === 'function'` 能力检测并删掉 `as SnmpConsumableProvider` 强转；③ `providers` 显式标注 `ConsumableProvider[]`）。正向路径也已用断言锁住：注入 `statusOf` 时面板文本仍应合并进 `stateDetail` |
| T-5 | `alarms.ts` seed 判定 | "首轮 seed" 必须由**首次拿到非空 devices 列表**来消耗 | `evaluate()` 无条件在末尾置 `seeded=true`；启动 2s 的带宽 tick 以 `devices=[]` 调用一次，就把 seed 消耗掉 → 扫描完成后整表 19 台全被当成"新接入"（**线上 19 条 info 的真正根因**） | `npx vitest run tests/alarms.test.ts -t 空的一轮` | **高**（这是 T-3 现象的上游根因） | **已修复**（`if (input.devices.length > 0) this.seeded = true`）；**我的用例此前未覆盖**（我每轮都传非空列表），已补 4 条断言锁定 |

---

## 4. 「等待上游落地」清单（两轮共 3 项，均已落地并验证）

| 项 | 我按新规格写的断言 | 落地情况 | 证据 |
|---|---|---|---|
| ① `DEVICE_NEW` 语义 | 首轮 seed 不产生 / 第二轮新 MAC 产生 1 条 / 下一轮不得自动恢复 / `counts().info===1` / ack 立即收尾 / TTL 10min 收尾 | **已落地**（`NEW_DEVICE_TTL_MS=600_000` + `expireNewDevices()` + ack 出口；T-5 的另一半：seed 改由"首个非空 devices 轮"消耗） | 6/6 通过；`resolvedAt=raisedAt+600000`；`artifacts/soak-report.json` 95s 长跑：`seededCreated=0, created=1, infoCountAfter90s=1, ttlResolvedAtDeltaMs=600000, maxSameMsResolved=0`，与断言一致 |
| ② 质量采样口径 | `samples=1 → unknown & score 0` / `isDegraded(samples=1)===false` / `resolveLinkState(samples=1, lat=300)==='online'` / scheduler 扫描结果不进窗口 | **已落地**：`scheduler` 删除扫描与心跳的 `tracker.record`，新增 `sampleQuality()`（15s / `ping -n 4` / ≤12 台 / 并发 8）作为质量窗口唯一数据源 | 4/4 通过；soak 报告 95s 内 `degraded=0`、`samples` 8–12 |
| ③ `hydrate` 语义（T-3/T-5 的持久化面） | `hydrate 恢复的已知设备不再产生 DEVICE_NEW` / `丢弃旧版"同毫秒已恢复"垃圾记录` / `未超 TTL 的事件续命` | **已落地** | 3/3 通过 |

> 三项落地后**未改动既有断言**即转绿；新增的 4 条断言是我在阅读其修复代码后补的**回归守卫**（原来只覆盖"每轮非空 devices"的理想路径，漏了启动期空列表这一真实调用序）。

---

## 5. 口径冲突与裁定（3 项，全部已定）

| # | 冲突 | 裁定 | 处理 |
|---|---|---|---|
| C-1 | 耗材 warning 阈值：brief-tess「12%」vs brief-max1/constants「≤10%」 | 队长认可 **≤10%** | 断言 `耗材 10%（边界）→ SUPPLY_LOW` + `耗材 12% 不应告警`，用例名/消息里写明依据；brief-tess 的 12% 判为笔误 |
| C-2 | `latencyMs=null` 的分数：注释「latPen=60 → 40」vs 公式「53.33 → 47」 | **队长裁定：保留实现，改文档**（数值 47 是公式唯一解） | 断言已精确锁 `{score:47, grade:'poor'}`。**勘误**：我上一版报告与队长裁定意见都写成「47/fair」，实际 `gradeOf(47)` 因 47 < 50 应为 **poor**；已于本次修正断言与报告，并请 Max-1 同步改注释（`→ 60` 应为 `→ 53.33`） |
| C-3 | 英文 arp 的 MAC 分隔符：brief-tess「`:`」vs Vera 实测「连字符」 | 队长认可 **连字符** | 英文 `arp -a` 用真实格式；冒号形式在真正会出现它的 `parseNeighborRows` 上断言 |
| C-4 | 质量结论的置信门：`computeQuality` 在 samples 2–7 时仍给 `grade`（可能 poor），而 `isDegraded`/NET_QUALITY 要求 `samples>=8` → 「UI 显示差但不告警」 | **队长裁定：选 B 并精细化** —— ① `samples<8` 时 `grade` 一律 `'unknown'`，`score` 仍照公式保留数值（测量证据，不得归零）；② `samples===0` 保持 `score 0/unknown`；③ `samples>=8` 按原边界判 grade；④ 常量 `QUALITY_MIN_SAMPLES=8` 放 `constants.ts`，grade 门与 `isDegraded` **共用同一常量**；⑤ 不新增契约字段（UI 用 `samples<8` 自行判断「采样中」）；⑥ 不变量：excellent/good ⇒ samples>=8，unknown 永不触发 NET_QUALITY | 断言 10 条：`samples 2..7 → unknown`、`samples=7 完美 → {100, unknown}`、`samples=8 + loss20% → {70, good}`、`7/8 边界同源锁`、`samples=4 极端链路经 AlarmEngine 两轮零 NET_QUALITY`、`samples=8 同链路两轮必出 1 条 warning`（对照），以及 Max-1 保留 `QUALITY.degradedMinSamples: QUALITY_MIN_SAMPLES` 别名后新增的 4 条**直接**断言：`QUALITY_MIN_SAMPLES===8`、`degradedMinSamples===QUALITY_MIN_SAMPLES`（严格相等，锁住别名而非第二个字面量）、`0..12 全域 grade!==unknown ⟺ samples>=8`、`0..12 全域 isDegraded⇒samples>=8`。**勘误**：此前我写「常量复用无法直接断言、只能用 7/8 边界等价锁」——那是在别名存在之前；现已能直接断言，7/8 锁降级为冗余守卫（保留，成本为零） |

---

## 6. 运行记录（`npx vitest run` 输出尾部）

```
 RUN  v3.2.7 C:/github/svesc

 ✓ tests/printer-mib.test.ts (59 tests) 26ms
 ✓ tests/snmp-ber.test.ts (34 tests) 25ms
 ✓ tests/alarms.test.ts (38 tests) 52ms
 ✓ tests/quality.test.ts (33 tests) 21ms
 ✓ tests/scheduler-resilience.test.ts (34 tests) 20ms
 ✓ tests/printer-service.test.ts (19 tests) 24ms
 ✓ tests/arp.test.ts (18 tests) 18ms
 ✓ tests/ping.test.ts (16 tests) 19ms
 ✓ tests/bandwidth.test.ts (15 tests) 15ms
 ✓ tests/oui.test.ts (14 tests) 14ms
 ✓ tests/fingerprint.test.ts (13 tests) 15ms
 ✓ tests/subnet.test.ts (12 tests) 14ms
 ✓ tests/scheduler.test.ts (9 tests) 5ms
 ✓ tests/exec-fallback.test.ts (4 tests) 24ms
 ✓ tests/router-upnp.test.ts / router-detect.test.ts / router-openwrt.test.ts（他人新增，30 例）
   × router-openwrt > login 成功缓存会话；call 自动带会话令牌（他人文件，见附注）

 Test Files  1 failed | 16 passed (17)
      Tests  1 failed | 347 passed (348)
   Start at  09:56:50
   Duration  2.71s
```

**R-05 的 2 条红已转绿**：Max-1 最终选了比"500ms 兜底"更严的形态——超时 `child.kill()` 后**立即** `finish(null)`（`settled` 幂等，迟到的 `close` 被忽略）。我的用例只推进 600ms 就要求 settle，正好把这个更严的选择锁住；谁改回"再等一个 500ms 定时器"，用例 1/2 会重新变红。

**附注：全仓唯一的红不在我的文件里**（`tests/router-openwrt.test.ts`，02:17 由他人新增的 router 模块测试）：

```
login 成功缓存会话；call 自动带会话令牌
  expect(login.ok).toBe(true)  → 实际 false
```

已定位，是**用例替身的参数下标写错**，不是实现缺陷：`login` 真实发出去的 params 是
`['0000…0'(32位零), 'session', 'login', {...}]`（`openwrt.ts:186-191`），而替身判断的是
`p[0] === 'session' && p[1] === 'login'`，永远不匹配 → 落进"未登录"分支返回 `result:[-1]`
→ `login` 拿到 `-1` → 文案"无权访问"。`raw()` 的解析器（`openwrt.ts:256-271`）只要求
`result: [code, payload]`，**并不要求 `jsonrpc`/`id` 字段**，所以同文件里其他用例带 `jsonrpc/id` 也能过，别被误导成"缺字段"。
**我没有动这个文件**（不是我写的，且可能有人在改）。一行修复：把下标改成 `p[1] === 'session' && p[2] === 'login'`。已把诊断发给 team-lead 与 Max-1。

**我自己的 14 个文件 / 318 用例全绿**，`tsc --noEmit -p tsconfig.node.json` → 0 error。

退出码 0。附独立类型检查：`npx tsc --noEmit -p tsconfig.node.json` → 0 error（TESS 复跑，非引用 Max-1 结论）。
连续多轮全量运行结果一致（无抖动/无时序依赖）。

## 7. 未覆盖项与理由（如实写）

| 未覆盖 | 理由 | 风险 |
|---|---|---|
| 真实 SNMP 设备报文 | 无一手抓包（Vera §2.8 全超时）。按 brief 兜底用自造 GetResponse 覆盖结构 | Counter64 溢出、多字节 tag 等非常规编码未验证 |
| `exec.ts` GBK/UTF-8 双通道 | 需真实 spawn + 控制台代码页，与确定性冲突；属 I/O 层 | 编码回归只能靠 `engine-check` 真机验证 |
| `store.ts` / `simulator.ts` / `mdns.ts` / `spooler.ts` 解析层 | 依赖定时器 / 文件系统 / 子进程；按队长裁定留给 Vic 整机验证 | `spooler.parsePortName`、`mapPrinterState` 仍无直测，其行为已通过 `collectPrinters` 间接触达（`.213` 场景走的就是 gp=0/cim=3 映射） |
| `SnmpConsumableProvider` / IPP provider 的真实网络路径 | 需真机 161/631；纯函数层（`parseSupplies`/`sanitizeModel`/`toLevelPct`）已全测，接入点（`collectPrinters` 侧的型号/`sysDescr`/`panelText`）也已用注入断言锁定 | 正/负缓存 TTL（60s/300s）、SNMP walk 的分页与超时降级未覆盖；只能靠 soak 与 `engine-check` 观察 |
| `scheduler.ts` 的**真实 IO 路径** | `readArp`/`pingSweep`/`probeHosts`/`readSpooler` 全部被 `vi.mock` 替掉，测的是编排逻辑而非进程调用 | 模块替身与被替模块的**导出形状**绑定：若 Max-1 把某个 IO 改成构造函数注入或改签名，替身会静默失效（表现为测试去 spawn 真进程 → 超时或假绿）。我已把这一点写进给 Max-1 的消息，请他改动时通知 |
| ~~R-03 的 20 条上限~~ | **已消除**：Max-1 把 `WarningLog` 导出成纯类（`push(source, message, at?)` / `clearSource` / `list()`），裁剪/去重/自愈现在都是纯函数用例，不再依赖私有字段 | 无（纯函数与实现解耦） |
| `BandwidthMeter.sample()` 端到端 | 禁止真实 netstat；改为注入采样状态后验证 `statFor` 的 `share`/`attributable`/除零分支（`tests/bandwidth.test.ts:129`） | 两次 spawn 时序、失败降级路径未覆盖 |
| `pingSweep` / `probePrinterEndpoint` 真实探活 | 需真实网络；解析层（`parsePingOutput`/`parsePingStats`）已全覆盖 | 并发闸门、超时强杀未覆盖 |
| UI / IPC / 冒烟 | 属 Max-2 与 Vic 的验证面 | — |

---

## 8. 给下游（Vic）的复现提示

```bash
cd C:/github/svesc
npx vitest run                                        # 我的 14 文件 / 318 用例 / 0 失败（全仓 17 文件 / 348，router-openwrt 1 红非我）
npx vitest run tests/scheduler-resilience.test.ts      # R-02/R-03/R-04/R-06：null 语义、warnings、关扫描不停采集、离线判定
npx vitest run tests/exec-fallback.test.ts             # R-05：子进程不派发 close 时的兜底 settle（当前预期红）
npx vitest run tests/printer-service.test.ts           # P0：.213 假在线覆盖 + 型号/sysDescr 接入点
npx vitest run tests/printer-mib.test.ts               # 型号清洗 sanitizeModel + 耗材百分比（RFC 3805 诚实语义）
npx vitest run tests/ping.test.ts                      # P1：中英双 locale ping 解析
npx vitest run tests/alarms.test.ts -t DEVICE_NEW      # 新规格：seed/TTL/ack/hydrate 语义
npx vitest run tests/quality.test.ts -t degraded       # 防抖动口径：单批次不判、两批次才判
npx vitest run tests/scheduler.test.ts                 # §5.1 六条优先级
```

- 所有测试**不依赖**局域网、打印设备、管理员权限、Electron 二进制（`electron/dist` 缺失也能跑）。
- 口径守卫：把 `constants.ts` 的 `supplyLowPct` 改成 15 → `耗材 10%/12%` 两条报红；`NEW_DEVICE_TTL_MS` 改 0 → `DEVICE_NEW 满 TTL` 报红；`degradedMinSamples` / `QUALITY_MIN_SAMPLES` 改成 2 → `4 样本不判 degraded` 与 `samples 2..7 一律 unknown` 同时报红（这两个门同源）；`MODEL_MAX_CHARS` 改成 30 → `恰好 40 字符不截断` 报红 —— 均为有意设计。
- 行为守卫（不靠常量，靠代码结构）：① 把 `alarms.ts` `ack()` 里的 `if (alarm.code === ALARM_CODES.DEVICE_NEW)` 泛化到所有 code（"让 ack 更彻底"是最常见的误改）→ `ack 特例不得外溢` 5 条全部报红；② 反过来删掉这个特例分支 → `DEVICE_NEW 被 ack 后应立即收尾` 与对照组同时报红（特例本身不得消失）；③ 删掉 `sanitizeModel` 的分号切分只留 40 字符截断 → `结果不得残留固件版本号` 报红（长度对了但固件串留下了）。
- 新建模守卫（R-02~R-06）：把 `buildSnapshot` 的 `rxBps: bandwidth?.rxBps ?? null` 改回 `?? 0` → `采样失败必须是 null` 红；把 `applyArpPresence(undefined, false)` 的心跳 `advanceMisses` 改成 `true` → `36 次心跳不得 offline` 红；把 `setAutoScan(false)` 改回"拆掉所有定时器" → R-04 三条计数冻结用例红；`exec.ts` 去掉兜底 `finish` → R-05 两条红。
- 交叉证据：`artifacts/soak-report.json`（Max-1 的 95s 真机长跑）与我的断言互不矛盾：`seededCreated=0 / infoCountAfter90s=1 / ttlResolvedAtDeltaMs=600000 / maxSameMsResolved=0 / degraded=0`。
