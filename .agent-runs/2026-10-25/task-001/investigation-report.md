# 局域网探测能力实测报告（P1 / 调查员 Vera）

- 任务：task-001 · 2026-10-25
- 主机：`LaoGaoDH` · Windows 10 专业版 10.0.19045 · 中文 locale（`zh-CN` / `zh-CN` / 控制台代码页 `gb2312`）
- PowerShell：5.1.19041.6456
- 探测用 Node：`22.22.2-6`（`C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`）
- 主网卡：`以太网` / Realtek PCIe GbE Family Controller / `00-E0-4C-36-D0-79` / **192.168.2.179/24** / 网关 `192.168.2.1`
- 其他虚拟网卡：`vEthernet (WSL)` 172.25.0.1/20、`vEthernet (Default Switch)` 172.26.176.1/20（**必须按 InterfaceAlias 过滤，否则带宽/邻居数据会被污染**）
- 探测脚本（可复跑）：`probe/probe.js`（enc/conc/ports/snmp）、`probe/probe2.js`（ttl/hostname/net/tcp/printerdetail）
- 全程只读：仅 ICMP、TCP connect、单次 SNMP GET，无任何写入操作。

---

## 1. 结论速览（给实现方的一句话）

| 主题 | 结论 |
|---|---|
| ARP | `arp -a` **直接 spawn + GBK 解码** 最可靠；`Get-NetNeighbor` 字段更结构化但耗时高且含 `Unreachable` 假条目 |
| 编码 | **不要**给 PowerShell 设 UTF8 去跑 `arp`/`ping`——会导致输出**变成英文**；正确做法是保留 GBK 并用 `TextDecoder('gb18030')` 解码 |
| ping | 中文关键字为 `字节=`/`时间<`/`TTL=`/`请求超时`/`丢失`；`-n 1 -w 800` 实测约 480~505ms 返回，**必须用 `-n 1`**，禁止 `-n 4` 做扫描 |
| 并发 | 16@16=831ms，16@8=1000ms，64@64=1523ms → **254 地址 @64 并发 ≈ 6s，满足 ≤12s** |
| ICMP 存活率 | 本网段极低：8 个抽样地址仅 3 个回 ICMP，但 ARP 表有 **53** 个 192.168.2.x 条目 → **在线判定必须以 ARP+TCP 为主，ICMP 只作质量采样** |
| 打印机 | **真实存在 3 台网络打印机**：SHARP MX-B4621R(.170)、Xerox AltaLink C8055(.235)、Canon MF750C(.213，当前离线) |
| Spooler | `Get-Printer`/`Get-PrintJob`/`Get-CimInstance Win32_Printer`/`Get-PrinterPort` **全部可用，无权限错误**；`Get-PrinterProperty` 对本机驱动基本无内容 |
| SNMP | **全部超时**（4 主机 × 2 community），无任何回包 → **SNMP 耗材链路在本机无法做真实集成测试** |
| IPP | **不可用**：.170/.235 的 631 都在线且回合法 IPP 报文，但全部拒绝 Get-Printer-Attributes（0x0406 / 0x0400），`marker-*` 一个都拿不到（详见 §8） |
| 带宽 | `netstat -e`（102-103ms，系统级汇总）远快于 `Get-NetAdapterStatistics`（~900ms，按网卡）；`Get-NetTCPConnection` 890ms，`netstat -ano` 83ms |
| TTL | 实测 64 / 255 两种；**255 出现在打印机** → 不能仅凭 TTL 判定 OS |

---

## 2. 逐项实测

### 2.1 `arp -a` 中文输出结构

命令：`arp -a`（经 Node `execFile('arp',['-a'],{encoding:'buffer'})` 取 Buffer 后用 `TextDecoder('gb18030')` 解码）

原始输出（GBK 正确解码后）：

```
接口: 192.168.2.179 --- 0x5
  Internet 地址         物理地址              类型
  192.168.2.1           e4-67-1e-12-68-a9     动态
  192.168.2.17          00-e0-4c-3b-41-31     动态
  192.168.2.24          48-5f-08-41-4f-d1     动态
  192.168.2.235         9c-93-4e-9c-6a-76     动态
  192.168.2.255         ff-ff-ff-ff-ff-ff     静态
  224.0.0.22            01-00-5e-00-00-16     静态
```

若无 GBK 解码（默认 `toString('utf8')`）则为：

```
�ӿ�: 192.168.2.179 --- 0x5
  Internet ��ַ         ������ַ              ����
  192.168.2.1           e4-67-1e-12-68-a9     ��̬
```

结构事实：
- 每个网卡一段，段头 `接口: <ip> --- 0x<hex>`；本机有 3 段（以太网、WSL、Default Switch）。
- 表头为 `Internet 地址 / 物理地址 / 类型`（列之间为多个空格，**不是制表符**）。
- MAC 分隔符为 **连字符 `-`**，6 组小写十六进制；**不是 `:`**。
- 类型中文为 `动态` / `静态`，英文 locale 下为 `dynamic` / `static`。
- 表内含 `224.0.0.x` 组播、`*.255` 广播、`239.255.255.250`（SSDP）等**非设备条目，必须过滤**。
- 192.168.2.x 有效条目 53 条（另有 172.25.x、组播等）。

### 2.2 `Get-NetNeighbor` 对比

命令：`Get-NetNeighbor -AddressFamily IPv4 | ? {$_.State -ne 'Permanent'} | Select IPAddress,LinkLayerAddress,State,InterfaceAlias`

原始输出：

```
IPAddress     LinkLayerAddress        State InterfaceAlias
---------     ----------------        ----- --------------
172.25.8.169  00-15-5D-42-A0-F1       Stale vEthernet (WSL)
192.168.2.240 00-E0-4C-3B-46-25       Stale 以太网
192.168.2.212 00-00-00-00-00-00 Unreachable 以太网
192.168.2.211 00-E0-4C-3C-D0-F3       Stale 以太网
```

- 总条目 **73**（含 Permanent/组播），字段 `IPAddress / LinkLayerAddress / State / InterfaceAlias` 均为独立属性，无需正则。
- **坑**：`Unreachable` 条目的 MAC 是 `00-00-00-00-00-00`（如 `.212`），若不按 State 过滤会产出 0 MAC 的假设备。
- **坑**：耗时约 890ms（PowerShell 启动 + CIM 查询），是 `arp -a`（83-90ms）的 10 倍以上。
- **判定：主用 `arp -a`（GBK 解码 + 结构化正则），`Get-NetNeighbor` 仅在需要 `State`/`InterfaceAlias` 时作为可选补充。**
- 交叉验证：两表在 192.168.2.0/24 上的 IP↔MAC 完全一致（`.235 = 9C-93-4E-9C-6A-76`、`.170` 见 ARP），仅 MAC 大小写与分隔符不同（ARP 小写 `-`，Neighbor 大写 `-`）。

### 2.3 ping 输出格式

**`ping -n 1 -w 800 192.168.2.1`（GBK 解码）**

```
正在 Ping 192.168.2.1 具有 32 字节的数据:
来自 192.168.2.1 的回复: 字节=32 时间=3ms TTL=64

192.168.2.1 的 Ping 统计信息:
    数据包: 已发送 = 1，已接收 = 1，丢失 = 0 (0% 丢失)，
往返行程的估计时间(以毫秒为单位):
    最短 = 3ms，最长 = 3ms，平均 = 3ms
```

**`ping -n 4 192.168.2.1`（PowerShell 中文原文，含 `<1ms` 变体）**

```
正在 Ping 192.168.2.1 具有 32 字节的数据:
来自 192.168.2.1 的回复: 字节=32 时间<1ms TTL=64
来自 192.168.2.1 的回复: 字节=32 时间=1ms TTL=64
...
192.168.2.1 的 Ping 统计信息:
    数据包: 已发送 = 4，已接收 = 4，丢失 = 0 (0% 丢失)，
往返行程的估计时间(以毫秒为单位):
    最短 = 0ms，最长 = 1ms，平均 = 0ms
```

**死地址 `ping -n 1 -w 800 192.168.2.249`**

```
正在 Ping 192.168.2.249 具有 32 字节的数据:
请求超时。

192.168.2.249 的 Ping 统计信息:
    数据包: 已发送 = 1，已接收 = 0，丢失 = 1 (100% 丢失)，
```

关键格式事实：
- 回复行：`来自 <host> 的回复: 字节=32 时间=<n>ms TTL=<n>`；**时间可能是 `=3ms` 也可能是 `<1ms`**，比较符有两种，且 `=` 前无空格（有版本会在 `字节` 与 `=` 间无空格）。
- 全角/半角标点混用：统计行用全角逗号 `，` 与半角括号 `(0% 丢失)`，行尾还有全角 `，`。
- 英文 locale 对应：`Reply from 192.168.2.1: bytes=32 time=3ms TTL=64`、`Request timed out.`、`Packets: Sent = 1, Received = 1, Lost = 0 (0% loss)`。
- 退出码：可达 0，超时 1（可作快速判据，少一次正则）。

**`ping -a` 主机名反解**（`ping -a -n 1 -w 600 <ip>`）：

```
正在 Ping XRX9C934E9C6A76.lan [192.168.2.235] 具有 32 字节的数据:   ← .235 成功反解
正在 Ping 192.168.2.170 具有 32 字节的数据:                        ← .170 反解失败，保留 IP
```

- 成功时首行格式为 `正在 Ping <hostname> [<ip>] 具有 32 字节的数据:`，可正则提取。
- **代价极高**：`.235` 与 `.170` 各耗时 **4660ms 左右**（DNS 查询超时）；`.52` 直接挂到脚本 8s 超时被杀。
- **判定：禁止在扫描路径使用 `ping -a`**。主机名另走异步 `dns.reverse()`（带 ~800ms 超时）或 `nslookup`，且必须缓存 + 限并发（≤8）。

### 2.4 并发 ping 实测

脚本：`probe/probe.js conc`（`spawn('ping',['-n','1','-w','800',ip])`，统计 `close` 事件耗时）

| 场景 | 结果 |
|---|---|
| 16 地址（192.168.2.1~16），并发 16 | **831 ms** |
| 16 地址，并发 8 | **1000 ms** |
| 4 个死地址，并发 4 | **505 ms**（单 IP 480/491/470/505ms） |
| **64 个死地址（.100~.163），并发 64** | **1523 ms** |

结论：
- 单个死地址实测 ~0.5s 返回（`-w 800` 未跑满，Windows 自行提前结束）。
- **254 地址 @ 并发 64 → 4 批 × ~1.5s ≈ 6.0s**，满足 plan 的 ≤12s 指标，**无需调小 `-w`**；若压到 `-w 500` 可再降到 ~5s，但 `-w` 过小会误判高延迟主机（跨网段 RTT>500ms 场景），**保持 `-w 800` 更稳**。
- 并发 64 无明显进程创建瓶颈（64 个 ping.exe 同时启动仍 1.5s 内完成）。
- **警告**：本网段 ICMP 存活率极低（见 2.5），254 全扫的 alive 数会远小于 ARP 条目数，不能把 `alive=0` 当离线。

### 2.5 编码实测（最重要的一节）

环境：`[Console]::OutputEncoding.WebName` = `gb2312`。Node 默认 `toString('utf8')`。

| 方案 | 命令 | 结果 |
|---|---|---|
| A 直接 spawn `arp.exe`，Buffer→GBK | `execFile('arp',['-a'],{encoding:'buffer'})` + `new TextDecoder('gb18030').decode(buf)` | ✅ **`接口: 192.168.2.179 --- 0x5` / `Internet 地址  物理地址  类型` / `动态`**（完全正确） |
| A' 同上但 utf8 解码 | `buf.toString('utf8')` | ❌ `�ӿ�: 192.168.2.179 --- 0x5` |
| B spawn powershell 默认 | `powershell -NoProfile -Command "arp -a"`，stdout→utf8 | ❌ 乱码 `��ַ / ������ַ / ��̬`（PowerShell 默认以 gb2312 输出到管道） |
| C powershell + `[Console]::OutputEncoding=UTF8` | 同上加前缀 | ⚠️ **无乱码，但输出变成英文** `Internet Address  Physical Address  Type` |
| D `cmd /c chcp 65001 & arp -a` | — | ⚠️ 同上，**killed 中文，输出英文** |
| E powershell + UTF8 + `ConvertTo-Json -Compress` | `Get-Printer | Select ... | ConvertTo-Json -Compress` | ✅ JSON 可 `JSON.parse`，中文字段正常（如 `Description:"本地端口"`），前提是**按 UTF-8 解码** |

机制解释（实测推出，非猜测）：`arp.exe` / `ping.exe` 等 MUI 程序按**控制台代码页**选择语言资源。代码页 65001（UTF8）时它们回退到英文资源；代码页 936 时输出中文 GBK 字节。因此"设 UTF8 + 得到中文"两者不可兼得。

**决定性坑（我踩到了）**：`probe2.js net` 中 PowerShell 已设 UTF8，我却仍用 `gb18030` 解码，得到 `"浠ュお缃�"`（= `以太网` 的 UTF-8 字节被当 GBK）、`"鏈湴绔彛"`（= `本地端口`）。**同一份字节，解码器选错即全废；解码器必须与 spawn 时的编码约定绑定，不能全局统一。**

最终推荐（按用途分两路，**都在同一进程内混用**）：

```ts
// 路径 1：抓中文（arp / ping / netstat / ipconfig）—— 直接 spawn 原生 exe，不经 PowerShell
function decodeGbk(buf: Buffer): string {
  return new TextDecoder('gb18030', { fatal: false }).decode(buf);
}
// spawn('arp', ['-a'], { windowsHide: true }) → 收 Buffer → decodeGbk

// 路径 2：抓结构化数据（Get-Printer 等）—— PowerShell + UTF8 + ConvertTo-Json
// powershell -NoProfile -NonInteractive -Command
//   "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Printer | Select ... | ConvertTo-Json -Depth 3 -Compress"
function decodeUtf8(buf: Buffer): string { return buf.toString('utf8'); }
```

- 路径 1 输出**中文**，用 GBK 解码；路径 2 输出**UTF-8 JSON**，用 UTF-8 解码。二者**不可互换**。
- 路径 2 加 `[Console]::OutputEncoding` 不影响 `Get-Printer` 的字段值（字段值来自 CIM，非 MUI 资源），只有 `Get-PrinterPort` 的 `Description` 这类本地化字符串受影响——设为 UTF8 后它正确输出 UTF-8 中文。
- **不要给 `arp`/`ping` 加 `chcp 65001`**：会同时丢掉中文表头，且让正则的中文字面量全部失效。

### 2.6 Spooler 能力（全部可用）

`Get-Printer`（8 台，`ConvertTo-Json` 后字段完整）：

| Name | DriverName | PortName | PrinterStatus | Shared | Type |
|---|---|---|---|---|---|
| Xerox AltaLink C8055 (9C:93:4E:9C:6A:76) | Microsoft IPP Class Driver | `WSD-9bc82b0c-...` | **0** | False | 0 |
| SHARP MX-B4621R PCL6 | SHARP MX-B4621R PCL6 | `192.168.2.170` | 0 | False | 0 |
| MF750C Series | Canon Generic Plus PCL6 | `IP_192.168.2.213` | 0 | False | 0 |
| Canon G3030 series | Microsoft IPP Class Driver | `WSD-1494d5f0-...` | 0 | False | 0 |
| Microsoft XPS Document Writer / Microsoft Print to PDF / Fax / Adobe PDF | — | `PORTPROMPT:` / `SHRFAX:` / `Documents\*.pdf` | 0 | False | 0 |

`Get-Printer -Name 'SHARP MX-B4621R PCL6' | Select *` 全部可用字段（原文截断）：

```json
{"PrinterStatus":0,"Name":"SHARP MX-B4621R PCL6","PortName":"192.168.2.170",
 "DriverName":"SHARP MX-B4621R PCL6","JobCount":0,"Shared":false,"ShareName":"",
 "Published":false,"Type":0,"Datatype":"RAW","PrintProcessor":"winprint",
 "Priority":1,"Location":"","Comment":"","KeepPrintedJobs":false,"SeparatorPageFile":"",
 "StartTime":0,"UntilTime":0,"PermissionSDDL":null}
```

`Get-CimInstance Win32_Printer`（网络打印机子集）：

```json
[{"Name":"SHARP MX-B4621R PCL6","PortName":"192.168.2.170","PrinterStatus":3,
  "DetectedErrorState":0,"ExtendedPrinterStatus":2,"WorkOffline":false,"Status":"Unknown"},
 {"Name":"MF750C Series","PortName":"IP_192.168.2.213","PrinterStatus":3,
  "DetectedErrorState":0,"ExtendedPrinterStatus":2,"WorkOffline":false,"Status":"Unknown"}]
```

`Get-PrinterPort`：返回 `COM1:`…`PORTPROMPT:`、`192.168.2.170`（`Description:"标准 TCP/IP 端口"`, `PortNumber:515`）、`IP_192.168.2.213`（`PortNumber:9100`）。

`Get-PrintJob` / `Get-CimInstance Win32_PrintJob`：**可用、code=0、无权限报错，但返回空**（当前无排队作业；`| ConvertTo-Json` 输出为空字符串，JSON.parse 需容错）。

`Get-PrinterProperty`：
- SHARP：返回**空**（无报错，无输出）。
- Xerox：仅 1 条 `FormTrayTable = "Config:Tray1,PrintSchema:ISOA4,..."`（纸盒/纸张配置），**不含耗材百分比、不含计数器**。

结论：
- Spooler 权限、执行策略均**无障碍**，无需考虑 `-ExecutionPolicy Bypass` 之外的降级（当前策略下 `-Command` 正常执行）。
- 可用信息：名称、驱动、端口（→ 可推出 IP）、默认打印机、共享、JobCount、WorkOffline、PrinterStatus、DetectedErrorState、ExtendedPrinterStatus。
- **不可用**：耗材百分比、页计数器。`Get-PrinterProperty` 不是耗材来源，**不要指望它**。

### 2.7 端口探测与真实打印机

脚本：`probe/probe.js ports`（10 端口 × 4 主机 = 40 次 connect，总耗时 **2832ms**）

| 主机 | 开放端口 |
|---|---|
| 192.168.2.170（SHARP MX-B4621R） | **80, 443, 515, 631, 9100** |
| 192.168.2.235（Xerox AltaLink C8055） | **80, 443, 515, 631, 9100** |
| 192.168.2.213（Canon MF750C） | 无（全部超时/拒绝） |
| 192.168.2.1（网关） | 80, 443（无 9100/631/515） |

- **真实网络打印机 = 3 台**（其中 2 台在线：`.170`、`.235`；`.213` 在 spooler 中存在但网络不可达 → 天然可作"打印机离线"告警的演示样本）。
- `9100 + 631` 同时开放 = 强打印机指纹；`515(LPD)` 同时开放进一步确认。**`9100` 单开也足以判 printer**。
- 网关 `80/443 → router`；只有 `9100/631/515` 才判 `printer`，避免把 Web 管理页面主机误判。
- 单端口 connect 超时 700ms；每主机 10 端口并发 → 40 次仅 2.8s。**254 主机 × 10 端口若并发 64 需 ≈ 11s，建议只对 ARP 存活主机做端口探测（本机仅 53 台 → ≈2.4s）**。

### 2.8 SNMP（全部失败）

脚本：`probe/probe.js snmp`（手写 BER，SNMPv2c GET `1.3.6.1.2.1.1.1.0`，超时 900ms）

```
SNMP 192.168.2.170 c=public  -> {"ok":false,"err":"timeout","ms":910}
SNMP 192.168.2.170 c=private -> {"ok":false,"err":"timeout","ms":905}
SNMP 192.168.2.213 c=public  -> {"ok":false,"err":"timeout","ms":915}
SNMP 192.168.2.213 c=private -> {"ok":false,"err":"timeout","ms":910}
SNMP 192.168.2.235 c=public  -> {"ok":false,"err":"timeout","ms":906}
SNMP 192.168.2.235 c=private -> {"ok":false,"err":"timeout","ms":905}
SNMP 192.168.2.1   c=public  -> {"ok":false,"err":"timeout","ms":903}
SNMP 192.168.2.1   c=private -> {"ok":false,"err":"timeout","ms":907}
```

- 报文构造正确（`SEQUENCE{INTEGER version=1, OCTET STRING "public", [0] GET{requestId,0,0,SEQUENCE{OID, NULL}}}`），两台打印机虽开 80/443/515/631/9100 但 **UDP 161 无响应**（很可能设备未启用 SNMP 或被网络策略过滤）。
- 本机 `Get-Service SNMP` 为空（未安装 SNMP 服务，仅作记录，不影响客户端发送）。
- **结论：本机**没有任何**可用的 SNMP 目标，`sysDescr` 无法取得。SNMP 解码器只能靠单元测试（构造应答字节）验证，不能靠真机集成。plan 第 8 节"耗材全空"风险**已确认发生**，`levelPct:null + source:'unknown'` 是唯一诚实选择。

### 2.9 带宽与连接数

`netstat -e`（中文，102-103ms 量级）：

```
接口统计

                           接收的            发送的

字节                    2636111916      1811382196
单播数据包            34576280        46071108
非单播数据包         9359160           66228
丢弃                          0               0
错误                            0               0
未知协议                 0
```

2 秒后再次取值：字节 2636111916 → 2636309904（rx +19788 B / 2s ≈ 9.7 KB/s）、1811382196 → 1815514476（tx +4.13 MB / 2s ≈ 2.07 MB/s）。

`Get-NetAdapterStatistics`（~900ms，按网卡）：

```json
[{"Name":"vEthernet (WSL)","ReceivedBytes":4032161,"SentBytes":4977715},
 {"Name":"vEthernet (Default Switch)","ReceivedBytes":0,"SentBytes":341889},
 {"Name":"以太网","ReceivedBytes":2802533457,"SentBytes":5817589837}]
```

2 秒后：`以太网` rx +20710 B、tx +1048698 B（≈10.3 KB/s / 524 KB/s）。

- 可用属性：`ReceivedBytes / SentBytes / ReceivedUnicastPackets / SentUnicastPackets / ReceivedUnicastBytes / SentUnicastBytes / ReceivedDiscardedPackets / ReceivedPacketErrors / OutboundDiscardedPackets / OutboundPacketErrors` 等（完整列表已实测枚举）。
- **粒度差异**：`netstat -e` 是**全系统汇总**（含 WSL/虚拟网卡）；`Get-NetAdapterStatistics` 是**按网卡**，可排除 `vEthernet*`，更适合"本网卡真实吞吐"。
- **速度差异**：`netstat -e` ~103ms vs `Get-NetAdapterStatistics` ~900ms（PowerShell 冷启动占大头）。
- 两者差值与网卡选择有关：netstat 的 tx 增量比以太网单卡 tx 增量大 4 倍（含虚拟网卡），**不要混算**。

`Get-NetTCPConnection -State Established`：**890ms**，57 条 established；`netstat -ano`：**83ms**，同样 57 条。
- 按远端 IP 聚合：`grouped 192.168.2.x = [[192.168.2.179,4]]` → 本机与局域网内其他主机**几乎没有 TCP 连接**（业务都在公网侧）。**这意味着"按远端 IP 分摊带宽"在本机会全部落到 `share≈0`，必须有 `estimated:true` 与回退文案。**
- 254 设备场景：`netstat -ano` 83ms 完全可行（比 PowerShell 快 10 倍）；建议 **`netstat -ano` 为主、解析文本**，`Get-NetTCPConnection` 弃用。

### 2.10 TTL 与 OS 推断

`probe/probe2.js ttl`：

```
TTL 192.168.2.1   alive=true  rtt=1 ttl=64
TTL 192.168.2.170 alive=true  rtt=1 ttl=255   ← SHARP 打印机
TTL 192.168.2.213 alive=false rtt=null ttl=null
TTL 192.168.2.235 alive=true  rtt=1 ttl=64    ← Xerox 打印机
TTL 192.168.2.17  alive=false
TTL 192.168.2.52  alive=false
TTL 192.168.2.101 alive=false
TTL 192.168.2.157 alive=false
```

- 实测仅 64 与 255 两个值，**没有 128**。
- 若按"TTL>128→Windows、64→Linux/Unix、255→网络设备"的经典规则：网关 `.1` TTL=64 会被判成 Linux（实际是路由器）；SHARP 打印机会被判成"网络设备"（勉强对）。
- **结论：经典 TTL→OS 规则在本机实测中不具备区分力**。建议 `osHint` 只在 TTL 落在明确区间时给弱提示，且**必须叠加端口/端口组合与 OUI**（如 `9100` → printer 优先于 TTL），并把置信度标为 `low`。**不要用 TTL 单独判 `workstation`/`server`。**

### 2.11 命令原生耗时基线（各 2 次取范围）

脚本：`probe/t.js`（`execFile(...,{encoding:'buffer'})`，`Date.now()` 包围）

```
{"cmd":"arp -a","ms":90,"bytes":3667}
{"cmd":"arp -a","ms":83,"bytes":3667}
{"cmd":"netstat -e","ms":103,"bytes":341}
{"cmd":"netstat -e","ms":102,"bytes":341}
{"cmd":"netstat -ano","ms":83,"bytes":16984}
{"cmd":"ping -n 1 -w 800 192.168.2.1","ms":80,"bytes":261}   ← 可达主机
```

据此：`arp -a` 83-90ms、`netstat -e` 102-103ms、`netstat -ano` 83ms、可达主机 ping 80ms、不可达主机 ping ~500ms。PowerShell 系命令 673-988ms（冷启动主导）。

---

## 3. 可复制的解析规则（可直接粘进 TS）

### 3.1 通用

```ts
export const decodeGbk = (b: Buffer) => new TextDecoder('gb18030').decode(b);
// 归一化：全角→半角仅处理已知符号，避免污染主机名
export const MAC_RE = /\b([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})\b/i;
export const normalizeMac = (s: string) => s.toLowerCase().replace(/:/g, '-');
```

### 3.2 `arp -a`

```ts
// 段头：接口: 192.168.2.179 --- 0x5   /   Interface: 192.168.2.179 --- 0x5
const RE_ARP_IFACE = /^\s*(?:接口|Interface)\s*:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*---\s*(0x[0-9a-f]+)\s*$/i;
// 行：IP  空格 MAC(-)  空格 类型(动态|静态|dynamic|static)
const RE_ARP_LINE = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+(\S+)\s*$/i;
const SKIP_IP = (ip: string) =>
  ip.startsWith('224.') || ip.startsWith('239.') || ip.endsWith('.255') || ip === '255.255.255.255';
```

字段映射：`ip ← group1`；`mac ← normalizeMac(group2)`；`动态/static 之外的 静态` 仅记录，本引擎**不区分动态/静态**（静态条目照样是真实设备）。

### 3.3 `ping`

```ts
// 回复行（中/英）：来自 X 的回复: 字节=32 时间=3ms TTL=64 | 时间<1ms
const RE_PING_REPLY = /(?:来自\s*(\S+)\s*的回复|Reply from\s*(\S+?))[:：]\s*(?:字节|bytes)\s*[=＝]\s*(\d+)\s*(?:时间|time)\s*[=＝<＜]\s*(\d+)\s*ms\s*TTL\s*[=＝]\s*(\d+)/i;
// 超时：请求超时。 | Request timed out.
const RE_PING_TIMEOUT = /请求超时|Request timed out/i;
// 统计（-n 4 时用）：丢失 = 0 (0% 丢失)
const RE_PING_LOSS = /(?:已发送|Sent)\s*[=＝]\s*(\d+)[，,]\s*(?:已接收|Received)\s*[=＝]\s*(\d+)[，,]\s*(?:丢失|Lost)\s*[=＝]\s*(\d+)\s*\((\d+)%/i;
// 平均 RTT
const RE_PING_AVG = /(?:平均|Average)\s*[=＝]\s*(\d+)\s*ms/i;
```

- `时间<1ms` → `rttMs = 0`（有意取 0，保留 `<1` 语义可用 `rttMs = 0.5`，**推荐 0** 以免抖动计算失真）。
- 判定优先级：`exitCode === 0 || RE_PING_REPLY` → alive；`RE_PING_TIMEOUT` → dead。
- 扫描**只用** `ping -n 1 -w 800 <ip>`；质量采样用 `ping -n 4 -w 800`（仅对 alive 主机、并发 ≤8、周期 15s）。

### 3.4 `netstat -e` / `netstat -ano`

```ts
const RE_NETSTAT_E_BYTES = /^\s*字节\s+(\d+)\s+(\d+)\s*$/m;        // rx, tx
const RE_NETSTAT_E_UCAST = /^\s*单播数据包\s+(\d+)\s+(\d+)\s*$/m;
// -ano 行：  TCP    192.168.2.179:52344    192.168.2.170:445    ESTABLISHED    1234
const RE_NETSTAT_CONN = /^\s*(TCP|UDP)\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)\s*$/i;
```

### 3.5 PowerShell JSON（二级来源）

```ts
// 统一命令模板
const PS = (code: string) =>
  ['-NoProfile', '-NonInteractive', '-Command',
   `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${code} | ConvertTo-Json -Depth 4 -Compress`];
// 解析容错：空输出（0 条）时 PowerShell 输出空字符串
function parsePsJson<T>(s: string): T[] {
  const t = s.trim();
  if (!t) return [];
  const j = JSON.parse(t);
  return Array.isArray(j) ? j : [j];
}
```

### 3.6 打印机字段映射（`Get-Printer` → 契约 `Printer`）

| 契约字段 | 来源 | 规则 |
|---|---|---|
| `name` | `Get-Printer.Name` | 原样 |
| `model` | `Get-Printer.DriverName` | 原样（`Microsoft IPP Class Driver` 这类通用驱动 → 视为 null 更好，需 `includes('Microsoft')` 判断） |
| `connection` | `PortName` | 匹配 `^\d+\.\d+\.\d+\.\d+$` 或 `^IP_` → `network`；`WSD-` → `network`；`PORTPROMPT:`/`SHRFAX:`/`Documents\` → `virtual`；`USB`/`LPT`/`COM` → `usb`；其他 `unknown` |
| `ip` | `PortName` | `192.168.2.170` 直取；`IP_192.168.2.213` → 去掉 `IP_` 前缀 |
| `isDefault` | `Win32_Printer.Default === true` | **`Get-Printer` 无 Default 字段，必须走 CIM** |
| `shared` | `Get-Printer.Shared` | 本机全 false |
| `state` | `PrinterStatus`(Get-Printer, 0=Normal) + `Win32_Printer.PrinterStatus`(3=Idle) + `WorkOffline` + `DetectedErrorState` | 见下 |
| `jobs` | `Get-PrintJob -PrinterName` | `JobStatus/Id/DocumentName/Owner/TotalPages/PagesPrinted/SubmittedTime` |
| `pageCount` | — | **无来源** → `null` |

状态映射（实测值）：

```ts
// Get-Printer.PrinterStatus: 0=Normal,1=Paused,2=Error,3=Pending,4=PaperJam,5=PaperOut,6=Offline,7=IOActive
// Win32_Printer.PrinterStatus: 1=Other,2=Unknown,3=Idle,4=Printing,5=Warmup,6=Stopped,7=Offline
function mapState(gp: number, offline: boolean, cim: number): PrinterState {
  if (offline) return 'offline';
  if (gp === 2 || gp === 4 || gp === 5) return 'error';
  if (gp === 1) return 'warning';
  if (cim === 4) return 'printing';
  return 'idle';
}
// 本机实测：gp=0 且 cim=3 且 offline=false → 'idle'（正确，但注意 .213 网络不可达 → 应叠加 TCP 9100 探活覆盖为 'offline'）
```

**重要**：`PrinterStatus=0/3` 只反映**本机 spooler 视角**，`.213` 在 spooler 中显示 `Normal/Idle/WorkOffline=false`，但实际网络不可达 → **必须用 `ip` 做一次 TCP 9100 探活来修正 `state`**，否则会出现"打印机在线"假象。

### 3.7 耗材 OID（仅列规则，**本机未验证**）

RFC 3805：`prtMarkerSuppliesLevel` = `1.3.6.1.2.1.43.11.1.1.9.<hrDeviceIndex>.<supplyIndex>`；`prtMarkerSuppliesMaxCapacity` = `...8.x.y`；`prtMarkerSuppliesDescription` = `...6.x.y`；`prtMarkerSuppliesType` = `...5.x.y`（3=toner,4=wasteToner,…）。**本机无 SNMP 应答，未验证。**

---

## 4. 编码与 locale 陷阱清单

| # | 陷阱 | 实测现象 | 规避 |
|---|---|---|---|
| 1 | Node 默认 utf8 解 GBK 输出 | `arp -a` → `�ӿ�` | 路径 1 用 `TextDecoder('gb18030')` |
| 2 | 给 PowerShell 设 `OutputEncoding=UTF8` 后跑 `arp`/`ping` | 中文**变英文** | 抓中文走原生 exe + GBK；**不要**用 PowerShell 抓 arp/ping |
| 3 | `chcp 65001` | 同上，丢中文 | 禁用 |
| 4 | 解码器混用 | 已设 UTF8 的 PowerShell 输出被 GBK 解 → `浠ュお缃�`（以太网）、`鏈湴绔彛`（本地端口） | 解码器按 spawn 约定绑定，**每个 spawn 站点显式标注 `encoding: 'gbk' \| 'utf8'`** |
| 5 | 中文关键字正则 | `字节=`/`时间<`/`丢失`/`请求超时`/`动态` 全角逗号 `，` | 正则同时容纳中英 + `=`/`<` + 全/半角标点（见 §3） |
| 6 | `ping -a` 反解 | 单次 4.6s，不可达主机挂 8s+ | 扫描路径禁用；主机名异步 `dns.reverse()` 800ms 超时 + 缓存 |
| 7 | spooler 名称含中文/括号/冒号（`Xerox AltaLink C8055 (9C:93:4E:9C:6A:76)`） | 直接拼进 PowerShell 单引号可能被引号截断 | 用 `-Name` 时做 `'` → `''` 转义，或**优先 `Get-Printer` 全量取回后内存过滤**（本机已验证全量 `Get-Printer` 仅 765ms） |
| 8 | `ConvertTo-Json` 空结果 | `Get-PrintJob` 无作业时输出**空字符串** | 空串直接返回 `[]`，不要 `JSON.parse('')` |
| 9 | PowerShell 单对象 vs 数组 | 1 条结果时 JSON 是对象不是数组 | `Array.isArray(j) ? j : [j]` |
| 10 | locale 影响 `Get-*` 文本字段 | `PrinterStatus` 在表格视图是 `Normal`，JSON 里是 `0` | **只用 JSON 数值，不解析表格文本** |
| 11 | `arp -a` 含组播/广播 | `224.0.0.22`、`192.168.2.255`、`ff-ff-ff-ff-ff-ff` | 过滤（§3.2） |
| 12 | `Get-NetNeighbor` 的 `Unreachable` | MAC `00-00-00-00-00-00` | 过滤 `State==='Unreachable'` 或 MAC 全零 |
| 13 | 多网卡 | WSL/Default Switch 的 172.x 条目混入 | 用 `arp -a` 段头 IP 过滤出目标网段；带宽排除 `vEthernet*` |

---

## 5. 真实环境事实

1. **真实网络打印机 3 台**：SHARP MX-B4621R（192.168.2.170，在线，TTL=255，开 80/443/515/631/9100）、Xerox AltaLink C8055（192.168.2.235，在线，主机名 `XRX9C934E9C6A76.lan`，TTL=64，开 80/443/515/631/9100）、Canon MF750C（192.168.2.213，spooler 中存在但**网络不可达**）。
2. **初始打印机默认 = Xerox AltaLink C8055**（`Win32_Printer.Default = True`）。
3. **Spooler 完全可读**，无权限/执行策略错误；`Get-Printer` 765ms、`Get-PrinterProperty` 673ms、`Get-PrintJob` 702ms、`Win32_Printer` 859ms。
4. **SNMP 完全不通**（4 主机 × public/private 全 timeout）→ 耗材只能 `null`。
5. **ICMP 存活率低**：抽 8 个 ARP 在位地址，仅 3 个回 ICMP（网关、2 台打印机）；ARP 表 53 个 192.168.2.x 条目。→ **在线判定主信号 = ARP 在位 + 端口/TCP，ICMP 仅作 RTT 采样。**
6. `Get-NetTCPConnection Established` 仅 57 条，其中与 192.168.2.x 的只有 4 条（全指向本机）→ **按远端 IP 分摊带宽基本无效**。
7. 本机未安装 SNMP 服务（`Get-Service SNMP` 空），不影响客户端探测。

---

## 6. 给 Max-1 的实现建议

### A. discovery（子网/发现）

1. **子网推导**不要用 `ipconfig` 文本，用 `os.networkInterfaces()` 取非内网 `IPv4` + `netmask`（本机 `192.168.2.179/255.255.255.0`），排除 `vEthernet*`（`internal`/名称含 `vEthernet`/`WSL`/`Loopback`）。若需 InterfaceAlias 中文名，再走 PowerShell `Get-NetIPAddress`（已验证可返回 `以太网`，注意按 UTF-8 解码）。
2. **扫描主循环**：先读 `arp -a`（GBK 解码，83-90ms）建立"在位集合"，再对 254 地址做 `ping -n 1 -w 800` 并发 64（实测 64@64=1523ms，254 全量 ≈6s）；**ping 结束后立刻重读 `arp -a`**，把"新出现的 ARP 条目"也算在线（能捞到禁 ping 但发过 ARP 的主机）。
3. **禁止 `ping -a`**；主机名走 `dns.reverse(ip)` 且 `Promise.race` 800ms 超时、并发 ≤8、结果缓存 ≥10min（本机实测反向解析可能 4.6s）。
4. **端口探测只对候选设备**：先按 `9100/631/515` 判 printer，`80/443 → router/web`，`445/3389 → workstation`；端口探测并发 64、单端口超时 700ms（实测 40 次 2.8s）。**不要 254×10 全打**。
5. 解析失败**必须**返回 `[]` + `parseWarning`，绝不抛异常（plan 第 8 节要求）；`arp` 段头按 IP 过滤到目标网段，避免 172.x 污染。

### B. printers

1. **数据源主用 `Get-Printer` JSON**（765ms，全量一次取回，内存分发），`Get-CimInstance Win32_Printer` 只补 `Default`/`WorkOffline`/`DetectedErrorState`（`Get-Printer` 没有 Default 字段，实测确认）。
2. **`Get-PrinterProperty` 不要用于耗材**：SHARP 返回空、Xerox 只有 `FormTrayTable`，实测无百分比/计数器。
3. **`state` 必须叠加网络探活**：对 `ip != null` 的打印机做 TCP 9100（失败退 631/515）探活，不可达则覆盖为 `offline`；否则 `.213` 会被误报为 `idle`。
4. `ip` 从 `PortName` 解析：`^\d+\.\d+\.\d+\.\d+$` 直取，`^IP_(<ip>)$` 去前缀；`WSD-<uuid>` 无 IP → `ip:null` + 用 `Name` 里的 `(XX:XX:..)` 反查 ARP 得 IP（Xerox 名称含 `9C:93:4E:9C:6A:76`，与 ARP `.235` 匹配，**已验证可行**）。
5. `pageCount: null`、`consumables: []`（或 `source:'unknown'` + `levelPct:null`），**绝不填 0**。`Get-PrintJob` 空输出要容错为 `[]`。

### C. network（质量与带宽）

1. **带宽**：2s 采样用 `netstat -e`（103ms，`字节 rx tx` 两列差分 × 8 / 2s = bps）；**若要排除虚拟网卡**，改用 `Get-NetAdapterStatistics`（900ms，按 Name 精确匹配 `以太网`）。二者择一，**不要混用**（实测汇总值比单卡 tx 大 4 倍）。
2. **连接数**：用 `netstat -ano`（83ms，57 条），按 `远程地址` 的 IP 段聚合；**弃用 `Get-NetTCPConnection`**（890ms，慢 10 倍）。本机与 LAN 的 TCP 连接仅 4 条 → `share` 基本为 0，必须 `estimated:true`。
3. **质量采样**：对 alive 设备按 15s 周期做 `ping -n 4 -w 800`（并发 ≤8），用 `RE_PING_LOSS` 拿丢包率、`RE_PING_AVG` 拿平均 RTT；jitter = 相邻 RTT 差绝对值均值。`时间<1ms` 记 0。
4. **状态分级**：`state` 判定顺序 `isSelf → online`；`arp 在位 && TCP 有响应 → online`；`arp 在位但 ping 超时 → degraded`（**不要判 offline**，本网段大量主机禁 ICMP）；`连续 3 轮不在 ARP 且 ping 无响应 → offline`。
5. **osHint** 不要靠 TTL（实测网关 TTL=64、打印机 TTL=255/64，经典规则失效）；优先 `port→kind` 与 OUI 前缀，`osHint` 允许为 `null`。

### D. 调度

1. **分频**：`netstat -e` 2s；`arp -a` 5s（85ms，很便宜）；`ping` 全量子网 60s（≈6s 耗时，**必须错峰**，不要与 2s 带宽采样同 tick 触发，避免事件循环与进程创建争抢）；spooler 15s（`Get-Printer`+`CIM` 约 1.6s）。
2. **所有 OS 调用串行闸门**：全局同时存活子进程 ≤64（`ping` 扫描用），PowerShell 调用**单飞（同一时刻只跑 1 个）**——PowerShell 冷启动 ~700-900ms，并发多个会互相拖慢，实测单次 765ms vs 并发场景未见收益。
3. **超时硬保证**：每个 spawn 挂 `setTimeout` 强杀（ping 1200ms，PowerShell 8000ms，`netstat` 3000ms），并在 `close` 后清 timer；**`ping -a` 这类不可控命令直接不给入口**。
4. **扫描期间不阻塞**：ping 扫描用 `Promise.all` + worker 池（并发 64），进度按批 `webContents.send('lan:scanProgress')`；扫描总预算 10s，超时即用已得结果出快照（保证 UI < 1s 有反馈）。
5. **降级判据**：`arp -a` 解析 0 条 **或** 全量子网 ping 后 ARP 仍 0 条 → `dataSource='demo'`；`printers.length===0` 单独不触发 demo（本机有 3 台，但空环境也可能真无打印机）。

---

## 7. 未验证项（明确标注，禁止当成已完成）

| 项 | 状态 | 原因 |
|---|---|---|
| SNMP `sysDescr` / 耗材 / 页计数真实取值 | **未验证** | 4 主机 × 2 community 全部 timeout，无任何 SNMP 目标 |
| SNMPv2c/v3 解码器与真实设备互操作 | **未验证** | 同上，仅能用构造报文做单测 |
| `Get-PrintJob` 有作业时的字段真实性 | **未验证** | 实测时队列为空（`jobs=0`），只能确认"可调用、无报错" |
| `Get-PrinterProperty` 在支持耗材的驱动上的行为 | **未验证** | 本机 2 台网络打印机均无耗材属性 |
| 172.x 虚拟网段的设备形态 | **未验证** | 仅观察到 WSL/Default Switch 条目，未做探测（不在任务网段） |
| 跨网段（非 /24）子网扫描 | **未验证** | 仅实测 192.168.2.0/24 |
| `netstat -e` 与 `Get-NetAdapterStatistics` 差值在空闲/满载下的线性关系 | **未验证** | 仅 2 个 2s 采样点，未做负载对照 |
| IPv6 / 多宿主主机识别 | **未验证** | 未探测 |
| 非管理员权限下 spooler 全量读取 | **未验证** | 当前会话已是可读状态，未降权对照实验 |
| 扫描时对网络的实际扰动 | **未验证** | 无流量镜像/交换机计数，仅记录耗时 |
| `ping -n 4` 抖动计算的有效样本量 | **未验证** | 仅对网关做了 1 次 4 包采样 |

---

## 8. IPP 探测（补充 · 2026-10-25 追加）

目的：SNMP 全不通后，验证 IPP（631）能否作为 `marker-levels` 耗材余量的替代通路。
脚本：`probe/ipp.js`（首轮）、`probe/ipp_sweep.cjs`（端口×路径×版本穷举）、`probe/ipp_host.cjs`（Host 头/尾斜杠）、`probe/ipp_last.cjs`（版本/URI 语义变体）。全部只读（单次 `Get-Printer-Attributes`），无副作用。

> 说明：探测期间 `C:/github/svesc/package.json` 已由 Max-1 创建且含 `"type":"module"`，因此 Node 22 会把 `probe/*.js` 当 ESM，`require` 报 `ReferenceError: require is not defined in ES module scope`。**后续复跑请用 `.cjs`（已补 `ipp_sweep.cjs`）或改用 `import`。** 这条同样影响 Max 的 `scripts/smoke.ts`——若用 `.js` 包装需注意。

### 8.1 结论（三选一）

**`IPP 不可用`** —— 两台在线打印机的 IPP 服务**都在线、都回合法 IPP 报文，但都拒绝 Get-Printer-Attributes**，`marker-levels` / `marker-names` / `marker-colors` / `printer-state` / `queued-job-count` **一个都拿不到**。响应只回显 `attributes-charset` 与 `attributes-natural-language` 两条，无任何 printer 属性组。

### 8.2 逐台实测（HTTP 层）

| 主机 | 端口 | 路径 | HTTP | Content-Type | 字节 | Server | IPP status | 版本 |
|---|---|---|---|---|---|---|---|---|
| .235 Xerox AltaLink C8055 | 631 | `/ipp/print` | **200** | `application/ipp` | **72** | `Apache` | **0x0400** | 2.0 |
| .235 | 631 | `/printers` | 200 | `application/ipp` | 72 | Apache | 0x0400 | 2.0 |
| .235 | 631 | `/ipp/port1` | 200 | `application/ipp` | 72 | Apache | 0x0400 | 2.0 |
| .235 | 631 | `/ipp` | **301** | `text/html; charset=iso-8859-1` | 237 | Apache | —（HTTP 重定向，非 IPP） | — |
| .235 | **80** | `/ipp/print`、`/ipp`、`/printers`、`/ipp/port1` | 200 | `application/ipp` | 72 | Apache | **0x0400** | 2.0 |
| .235 | **443**(TLS) | 同上 4 条路径 | 200 | `application/ipp` | 72 | Apache | **0x0400** | 2.0 |
| .170 SHARP MX-B4621R | 631 | `/ipp/print` | **404** | `text/html` | 306 | `JC-SHTTPD/1.17.22` | —（无 IPP 体） | — |
| .170 | 631 | **`/ipp`** | **200** | **`application/ipp`** | **78** | JC-SHTTPD/1.17.22 | **0x0503**（v2.0）/ **0x0406**（v1.0、v1.1） | 回显 1.0 |
| .170 | 631 | `/ipp/`、`/ipp/port1`、`/printers` | 404 | text/html | 306 | JC-SHTTPD | — | — |
| .170 | 80 | 4 条路径 | 404 | `text/html` | 89 | `Rapid Logic/1.1` | —（Web UI，非 IPP） | — |
| .170 | 443 | 4 条路径 | `EPROTO` | — | — | — | 该端口**不是 TLS**（握手失败） | — |
| .213 Canon MF750C | 631 | — | **timeout(2s)** | — | — | — | 主机不可达（与 §2.7 一致） | — |

要点：
- **路径不通用**：Xerox 在 `/ipp/print`（标准）；SHARP 只在 **`/ipp`**，`/ipp/print` 是 404。写引擎时**必须遍历候选路径** `['/ipp/print','/ipp']`。
- **Xerox 的 IPP 在 631/80/443 三处都监听**，且 443 上是可用 TLS（`rejectUnauthorized:false` 下握手成功）；但三处**全部回 0x0400**。
- SHARP 的 631 服务是 `JC-SHTTPD/1.17.22`，80 是另一个 `Rapid Logic/1.1` Web 服务，443 不提供 TLS。

### 8.3 逐台实测（IPP 层：属性解析）

我手写的 IPP 解析器（`probe/ipp.js` 的 `parseIpp()`）对两份响应解出的**完整属性表**：

Xerox .235（72 字节，v2.0，status 0x0400）：

```
version=2.0  statusCode=0x0400  requestId=1  attrs=2  errors=[]
attributes-charset            = "utf-8"   (tag=charset 0x47)
attributes-natural-language   = "en"      (tag=naturalLanguage 0x48)
duplicate-attr-names = [] (count=0)
```

SHARP .170（78 字节，回显 v1.0，status 0x0503）：

```
version=1.0  statusCode=0x503  requestId=45  attrs=2  errors=[]
attributes-charset            = "us-ascii"  (tag=charset 0x47)
attributes-natural-language   = "en-us"     (tag=naturalLanguage 0x48)
```

- **没有** `marker-levels`(0x21) / `marker-names`(0x42) / `marker-colors`(0x42) / `marker-types` / `printer-state`(0x23) / `printer-state-reasons` / `queued-job-count`(0x21) / `printer-name` / `printer-device-id` / `printer-alert`。属性数恒为 2，即只有 RFC 8010 §4.1.4 要求"出错时也必须回显"的那两条。
- 报文结构合法（我解出 8 字节头 + 属性组 + `0x03` 结束符无残余、`errors=[]`），**说明不是解析失败，而是设备真的没给**。

### 8.4 认证 / Cookie

- 所有 24 次请求（3 IP × 多端口 × 多路径 × 多版本）**均未出现 401/403**。
- 响应头中**无 `WWW-Authenticate`、无 `Set-Cookie`**，只有 `Server`（`Apache` / `JC-SHTTPD/1.17.22`）与 `Content-Type: application/ipp`。
- 结论：**不需要也不接受认证**，因此 0x0400 不是"未授权"（授权失败应为 0x0401 `client-error-not-authorized`）。

### 8.5 失败原因判定

已确认（有证据）：

| 事实 | 证据 |
|---|---|
| 请求字节合法 | 同一份 body 用 `curl --data-binary` 重放，Xerox 返回完全相同的 72 字节 0x0400 |
| 协议版本无关 | v1.0 / v1.1 / v2.0 三种版本都试，Xerox 全 0x0400，SHARP 只在 1.x→0x0406、2.0→0x0503 |
| URI 形式无关 | `ipp://ip:631/ipp/print`、`ipp://ip/ipp/print`、`ipps://...`、`http://...`、带主机名 `ipp://XRX9C934E9C6A76.lan:631/ipp/print` 全 0x0400 |
| Host 头无关 | `Host: <ip>`、`<ip>:631`、`localhost`、主机名，全 0x0400 |
| 尾斜杠无关 | `/ipp/print/` 同样 0x400 |
| 附加属性无关 | 加 `requested-attributes=all` / `printer-state` 结果不变 |
| printer-uri 路径无关（SHARP 侧 6 种全试） | `/ipp`、`/`、`/printers/1`、`/ipp/port1`、`/ipp/print` 及无端口形式，全部 0x406（见 §8.5-3） |

**未验证的成因假设（明确标注为假设，不作为结论）**：
1. 设备侧 IPP 打印功能被管理员关闭，但 HTTP 端点仍在监听 → 统一回 `0x0400 bad-request`（Xerox 的常见行为）。
2. 设备只接受来自已注册客户端 / 需 TLS 客户端证书的 IPPS（0x0400 是拒绝而非 401），我们只做了 `rejectUnauthorized:false` 的单向 TLS，未带客户端证书。
3. SHARP 的 `0x0406 client-error-not-found` 表示"该 `printer-uri` 未被识别为可用 Printer 对象"。我额外试了 6 种 URI（`ipp://ip:631/ipp`、`ipp://ip/ipp`、`ipp://ip:631/`、`ipp://ip:631/printers/1`、`ipp://ip:631/ipp/port1`、`ipp://ip:631/ipp/print`）**全部 0x406**；其中 `ipp://ip:631/` 直接 HTTP 超时。故 SHARP 侧不是"路径写错"，而是服务端不接受任何 URI（`0x0503` 则是 v2.0 下的"服务不可用"）。

状态码语义（RFC 8010 §13.1，供 Max 写映射，**已核对编号**）：

```
0x0000 successful-ok                    0x0400 client-error-bad-request
0x0401 client-error-forbidden           0x0402 client-error-not-authenticated
0x0403 client-error-not-authorized      0x0404 client-error-not-possible
0x0405 client-error-timeout             0x0406 client-error-not-found
0x0407 client-error-gone                0x040B client-error-attributes-or-values-not-supported
0x0500 server-error-internal-error      0x0503 server-error-service-unavailable
```

引擎判定规则：**只有 `0x0000` 才解析属性；其余一律 `supplies=unknown`，且 0x04xx 不重试（客户端错误）、0x05xx 最多重试 1 次。**

### 8.6 解析难度评估（即使将来通了，也要注意）

我这次实现的解析器已可用（`probe/ipp.js` 的 `parseIpp()`），坑如下：

1. **属性是"名在首值上、后续值名为空"**：`1setOf` 多值属性（`marker-levels` 就是）第一条带 name，后续条 `name-length=0`（tag `0x00` additional-value），必须**继承上一个 name**，否则只会拿到 1 个值。我的实现用 `lastName` 继承，已覆盖。
2. **delimiter tag（0x01~0x05）没有长度字段**，占 1 字节，必须在读 name-length 前先判断 `tag ∈ [0x01,0x05]`。
3. **collection 值（0x34 begCollection … 0x37 endCollection）内部是嵌套的 memberAttrName(0x4A)+value 序列**，`media-col-database` 之类会出现；若不支持嵌套会解析错位，必须按 `0x37` 逐层退出。本次响应里没有 collection，**未验证**。
4. **整数统一 4 字节大端有符号**：`marker-levels` 的 `-3` 是合法值（RFC 8010：`-1`=unknown、`-2`=unknown 但已知容量、`-3`=remaining 未知但可用）；**绝不能 clamp 到 0**，否则"设备不报告"会被画成"0% 已耗尽"——这正是 plan 第 3 节"绝不编造 0%"要防的事。
5. **enum 与 integer 都是 4 字节**，只靠 tag（0x23 vs 0x21）区分；`printer-state` 必须按 enum 读。
6. **中文属性值（`printer-info`、`marker-names`）是 UTF-8 字节**，`attributes-charset` 可能是 `us-ascii`（SHARP 回显），不能假设响应编码。
7. **HTTP 200 不代表成功**：必须读第 3~4 字节的 status-code。本次两台都是 HTTP 200 + IPP 错误码，只判 HTTP 会误以为成功。

### 8.7 对"墨盒余量"需求的影响与建议

- **结论：本机环境无法通过 IPP 拿到任何耗材数据**（SNMP 也不通，spooler 也不提供 → 三条通路全部落空）。
- 因此 `Consumable.levelPct` 在本机**只能是 `null`**，`source:'unknown'`，UI 必须显示"设备不报告"。**这不再是"可能的降级"，而是已确认的必然结果。**
- 给 Max 的建议（按性价比排序）：
  1. **不要为 IPP 单独建模块**。若要保留通路，只写一个 ≤80 行、单文件、可注入 transport 的 `ippGetAttributes(ip, {timeout:2500})`，作为 `supplies` 的**可选探测**，并把 `statusCode !== 0x0000` 一律视为"该设备不可查询"（不重试、不换路径重试超过 2 次）。
  2. 若仍要实现，**候选路径顺序固定为 `['/ipp/print','/ipp']`、版本固定 `0x02 0x00`，失败直接放弃**（不要再穷举 1.0/1.1/ports/Host，本次实测证明全部无效，只会浪费 12 次请求 × 2.5s）。
  3. **耗材 UI 必须按 `null` 优先设计**：进度条骨架 + "设备不报告"文案 + 可选的"手动录入"占位，而不是 0%。
  4. `printer-state` 不要依赖 IPP；用 spooler（`PrinterStatus`/`WorkOffline`/`DetectedErrorState`）+ TCP 9100/631/515 探活来判 (见 §3.6、§6-B3)。
  5. 若将来在有 SNMP 或 IPP 可用的现场部署，`marker-levels` 与 SNMP `prtMarkerSuppliesLevel` 应**共用同一个 `Consumable` 模型**，只改 `source` 字段；本次已把 `Consumable.source` 定为 `'snmp'|'spooler'|'unknown'`，**建议扩展为再加上 `'ipp'`**（需 team-lead 决定，属契约变更）。

### 8.8 本节未验证项

| 项 | 状态 |
|---|---|
| `marker-levels` 的真实数值 | **未验证**（设备不回该属性） |
| 0x0400/0x0406 的确切成因（策略关闭 / 客户端证书 / URI 白名单） | **未验证**（仅为假设） |
| IPPS + 客户端证书能否通过 | **未验证**（未持有证书） |
| IPP collection 属性（0x34/0x37）解析 | **未验证**（本次响应无 collection） |
| .213 在开机后 IPP 是否可用 | **未验证**（主机不可达） |
| 其他网段/其他型号打印机的 IPP 行为 | **未验证**（仅 2 台可测样本） |
