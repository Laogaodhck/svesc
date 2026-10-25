# Brief — 调查员 Vera（task-001 / P1）

| 字段 | 值 |
|---|---|
| `role_name` | lan-capability-investigator |
| `mission` | 实测本机（中文 Windows）可用的局域网探测手段与其真实输出格式，为探测引擎定稿解析规则与降级路径。 |
| `when_to_use` | 仓库为空、无既有代码可读；但应用全部数据来自 OS 命令，中文 locale、编码、权限三个坑必须先用实测证据钉死，否则引擎会写成"在英文环境能跑"的假实现。 |
| `input_files` | `.agent-runs/2026-10-25/task-001/plan.md`（第 5 节契约、第 8 节风险登记册） |
| `allowed_edit_scope` | `.agent-runs/2026-10-25/task-001/**`（报告 + 临时探测脚本 `probe/`） |
| `forbidden_actions` | 不得创建/修改 `src/**`、`package.json`、任何项目源码；不得 `npm install`；不得写死或伪造数据；不得声称未实测的结论。 |
| `tools_policy` | 只读 + 可执行只读系统命令（arp/ping/nslookup/netstat/PowerShell Get-*）；可写 `.agent-runs/**` 下的临时脚本。 |
| `output_path` | `.agent-runs/2026-10-25/task-001/investigation-report.md` |
| `success_criteria` | 报告必须包含：① 每类命令的真实原始输出样例（中文原文，不可翻译）；② 可直接粘贴使用的正则/解析规则；③ 编码与 locale 陷阱清单及规避方案；④ 本机实测：真实打印机是否存在、SNMP 是否可达、spooler 是否可读、并发 ping 的实际耗时数据；⑤ 明确给出"引擎应采用/应避免"的结论清单。 |
| `stop_condition` | 单项探测连续失败 3 次即记录失败证据并跳过；总耗时超过 12 分钟立即停止并交出已完成部分。 |
| `handoff_format` | `references/contracts/task-result-format.md` 的 STATUS 块，≤20 行 |

## 必须回答的问题（逐条给证据）

1. **ARP**：`arp -a` 中文输出结构？表头与"动态/静态"字样、MAC 用 `-` 还是 `:`？获取方式选 `arp -a` 还是 `Get-NetNeighbor`（含 `-State Reachable/Stale`）？后者字段是否更稳？
2. **ping**：`ping -n 1 -w 800 <ip>` 与 `ping -n 4 <ip>` 的中文输出里，RTT、TTL、丢包率分别是哪几行哪个模式？`ping -a` 能否反解主机名？
3. **并发**：用 node `child_process.spawn` 并发 ping 16 个地址（并发 16 / 8）实际耗时多少？254 个地址按并发 64 估算是否 ≤12s？Windows 下是否需要 `-w` 调优？
4. **编码**：node spawn powershell 时中文输出是否乱码？给出可靠方案（`[Console]::OutputEncoding`、`chcp 65001`、`-OutputFormat` 对比实测）。
5. **Spooler**：`Get-Printer` / `Get-PrintJob` / `Get-CimInstance Win32_Printer` / `Get-PrinterProperty` 在本机是否可用？返回哪些可用字段（状态、队列、默认打印机、共享）？有无权限报错？
6. **打印机发现**：对 ARP 表中主机探测 TCP 9100/631/515/161，是否存在可疑打印机？真实打印机数量为几？
7. **SNMP**：向网关/可疑打印机的 UDP 161 发一次最简 SNMPv2c GET（community `public`/`private`），是否收到回包？若收到，记录返回的 sysDescr 摘要（这是唯一可用的真实集成测试目标）。
8. **带宽**：`Get-NetAdapterStatistics` 与 `netstat -e` 的取数差异与刷新粒度；`Get-NetTCPConnection` 是否可用于按远端 IP 聚合连接数？耗时多少（254 设备场景下的可行性）。
9. **OS 指纹**：实测到的 TTL 值分布（如 128/64/255）与对应的系统推断是否成立。

## 硬性要求

- 所有结论必须附命令原文与输出片段；未实测的项目写"未验证"，禁止推测性陈述。
- 报告末尾给出一节 **"给 Max-1 的实现建议"**：按模块列 3-5 条可直接照做的技术决定。
