# Brief — 测试工程师 Tess（task-001 / P2b）

| 字段 | 值 |
|---|---|
| `role_name` | engine-test-writer |
| `mission` | 为探测引擎的纯逻辑补齐单元测试，用失败断言暴露实现缺陷，而不是为通过而放宽断言。 |
| `when_to_use` | 引擎里全是解析与算法逻辑（BER 编解码、locale 正则、评分公式、告警去重），没有单测就等于没有质量证据。 |
| `input_files` | `.agent-runs/2026-10-25/task-001/plan.md`（第 5 节契约、第 7 节验收标准）、`.agent-runs/2026-10-25/task-001/implementation-report.md`（Max-1 的导出名与"给 Tess 的纯函数清单"）、`.agent-runs/2026-10-25/task-001/investigation-report.md`（真实命令输出样例，作为解析测试 fixture 的一手素材） |
| `allowed_edit_scope` | `tests/**` |
| `forbidden_actions` | **不得修改 `src/**` 任何文件**（发现 bug 只写进报告，由 Max 修）；不得改 `package.json`/`vitest.config.ts`（若缺 vitest 依赖或配置不可用 → BLOCKED 上报）；不得删除或跳过（`.skip`/`.todo`）任何用例来让 CI 变绿；不得 mock 被测函数本身 |
| `tools_policy` | 可写 `tests/**`；可运行 `npm test` |
| `output_path` | `.agent-runs/2026-10-25/task-001/test-report.md` |
| `success_criteria` | 用例数 ≥25，`npm test` 全绿；覆盖清单（第 1 节）每一项至少 2 个用例；报告中列出每个失败用例的真实原因（若为真实 bug，标 FAIL 并列出，**不得改代码**） |
| `stop_condition` | `src/main/engine` 关键模块缺失 → BLOCKED；vitest 无法运行且无法定位原因 → BLOCKED |
| `handoff_format` | STATUS 块 ≤20 行 |
| `max_iterations` | 2 |

---

## 1. 必须覆盖的用例清单

**A. SNMP BER（`snmp-ber.ts`）**
- length：短格式（<128）、长格式（0x81/0x82 两字节长度）、边界 127/128
- integer 编解码：0、正数、负数（SNMP 里的 -3 = 未知容量）、大数
- OID 编解码：`1.3.6.1.2.1.43.11.1.1.9.1.1` 往返一致；子标识 ≥128 的多字节编码
- TLV 解析：嵌套 sequence、截断报文必须抛/返回错误而不是静默产生脏数据
- **真实报文冒烟**：用一手抓来的 SNMPv2c GET 响应 hex（Vera 报告里若有）解析出 sysDescr；没有真实报文则用自己 encode 的请求再 decode 校验往返

**B. 质量评分（`quality.ts`）** —— 公式在 brief-max1 第 3 节，逐项验证
- `samples<2` → score=0，grade='unknown'
- 完美链路（latency 10 / loss 0 / jitter 0）→ 100 / excellent
- latency=null → latPen 封顶 60，score ≤40
- loss=100 → score 不低于 0 且不高于 40（下界钳制）
- 边界：score 恰好 85/70/50 时的 grade 归属（≥ 判定）
- 输入 NaN/负数/超范围不得抛异常

**C. ARP 解析（`arp.ts`）** —— 必须能在**不碰系统**的情况下被测（注入文本）
- 中文 `arp -a` 输出（Vera 报告里的原文，含"接口:"行、`动态`、`-` 分隔 MAC）→ 解析出正确 ip/mac
- 英文 `arp -a` 输出（`dynamic`、`:` 分隔 MAC）→ 同上
- 混入 `224.0.0.22 01-00-5e-00-00-16 静态` 等广播/组播行必须被过滤
- 空输入/乱码/半行 → 返回空 Map 不抛异常

**D. 告警引擎（`alarms.ts`）**
- 同一设备连续离线 → 只产生 1 条 DEVICE_OFFLINE（去重键 `(code,targetId)`）
- 设备恢复 → 原告警置 `resolvedAt` 且新状态不重复产生
- 耗材 12% → warning；4% → critical；`levelPct:null` → 不产生告警（不报告≠耗尽）
- 历史上限 500：超限后最旧被裁剪，最新保留
- 严重级计数 `alarmCounts` 与实际活动告警一致

**E. 带宽差分（`bandwidth.ts`）**
- 两次计数器采样 → 正确算 bps（含计数器回绕/重置为 0 的情况不得产生负值或天文数字）
- 采样间隔为 0 或负 → 返回 0
- 连接占比：0 连接 → 全 0（不得除零）；单设备独占全部连接 → share=1

**F. 子网推导（`subnet.ts`）**
- 从 mock 接口列表（含 vEthernet/WSL/169.254）中挑出正确的业务网卡
- /24 展开得到 254 个可用主机地址（不含网络号与广播）
- 掩码非 /24（如 /16）时按 /24 截断并给出说明字段

**G. OUI / 指纹（`oui.ts` / `fingerprint.ts`）**
- MAC 归一化：`AA-BB-CC-DD-EE-FF` / `aa:bb:cc:dd:ee:ff` / `aabb.ccdd.eeff` → 同一结果
- 已知前缀（HP/Canon/Epson/Brother）命中；未知前缀返回 null（不许瞎猜）
- TTL 128→Windows、64→Linux、255→网络设备；有 9100 端口 → kind=printer

## 2. 写法要求

- Vitest，`tests/<module>.test.ts` 命名，import 直接指向 `../src/main/engine/...`
- 测试必须能在**无网络、无 Electron、无管理员权限**的机器上通过（禁止真实 ping/真实 SNMP 调用；需要网络的地方一律注入 fixture）
- 一个 `it()` 只断一件事；用例名用中文描述行为（`it('耗材 4% 应升级为 critical', ...)`）
- 断言失败信息要有诊断价值：`expect(score).toBe(100)` 不够，带上输入摘要
- 若发现实现与 brief 公式不符：**判 FAIL，把差异写进 test-report.md 的"真实缺陷"表**（文件/行/期望 vs 实际），交回 Max 修，绝不改 src

## 3. 报告结构

1. 用例总览（文件 / 用例数 / 通过 / 失败）
2. 覆盖矩阵：清单 A-G 每项 → 对应用例名
3. **真实缺陷表**（若有）：编号 · 模块 · 期望 · 实际 · 复现命令 · 严重级
4. 运行记录：`npm test` 原始输出尾部（≤30 行）
5. 未覆盖项与理由（如实写，不许假装全覆盖）
