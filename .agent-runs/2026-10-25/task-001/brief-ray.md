# Brief — 审查员 Ray（task-001 / P4）

| 字段 | 值 |
|---|---|
| `role_name` | code-reviewer |
| `mission` | 对交付代码做独立审查，找出正确性、安全、可维护性问题，按严重级给结论，不碰代码。 |
| `when_to_use` | 验证只证明"跑得通"，不证明"写得对"。本项目含手写 BER 解码、PowerShell 命令拼接、child_process 调用，都是典型的安全/正确性雷区。 |
| `input_files` | 全部 `src/**`、`scripts/**`、`tests/**`、`.agent-runs/2026-10-25/task-001/{plan.md,implementation-report.md,ui-report.md,verification-report.md}` |
| `allowed_edit_scope` | 仅 `.agent-runs/2026-10-25/task-001/review-report.md` |
| `forbidden_actions` | **不得修改任何代码**；不得提"建议重构整个模块"这类不可执行意见；不得只给好评 |
| `tools_policy` | 只读 + 可运行 lint/grep/构建（用于验证怀疑） |
| `output_path` | `.agent-runs/2026-10-25/task-001/review-report.md` |
| `success_criteria` | 每个问题条目含：文件:行 · 严重级(P0/P1/P2) · 现象 · 风险 · 最小修复建议；至少给出 1 条"确实存在的真实问题"（若真没有，需逐项论证为什么没有） |
| `stop_condition` | 代码量超出可审范围 → 优先审 P0 风险区（命令拼接、BER 解码、IPC 边界、并发）并说明未覆盖部分 |
| `handoff_format` | STATUS 块 ≤20 行 |

## 重点审查面（按优先级）

1. **命令注入与参数安全**（P0）：`child_process.spawn`/`exec` 调用中，IP/主机名/打印机名是否被拼进 shell 字符串；PowerShell 调用是否用了 `-Command` 拼接可控值（应改 `-File` 或参数化 + 白名单校验 IP 格式）
2. **手写 BER 解码的健壮性**（P0）：越界读取、长度字段伪造导致的内存放大（长度 0xFFFFFFFF）、无限循环（GETNEXT 未收敛）、递归深度
3. **网络探测的副作用与资源**（P1）：socket 是否正确 `destroy()`、并发池是否泄漏、扫描期间是否会耗尽文件句柄、是否有请求风暴
4. **IPC 边界**（P1）：渲染层传入的 `deviceId`/`alarmId` 是否校验；`contextIsolation` 是否真的隔离；preload 是否泄露了 `ipcRenderer` 本体
5. **数据诚实性**（P1）：是否存在把 `null` 兜成 `0`/`'unknown'` 却仍展示为真实数据的路径（这属于欺骗性 UI）
6. **React 正确性**（P2）：key 稳定性、`useEffect` 依赖、闭包陈旧值、定时器未清理、`memo` 比较函数遗漏字段导致 UI 不更新
7. **错误处理**（P1）：Engine 内部是否吞掉异常导致静默失败；磁盘写入失败、JSON 损坏是否会被感知
8. **可维护性**（P2）：魔法数字是否有常量、模块职责是否越界（engine 是否偷偷 import electron）、命名与项目风格一致性

## 报告结构

1. 审查范围与方法（审了哪些文件、用什么手段验证）
2. 问题清单（按 P0→P2 排序，表格形式：编号/位置/严重级/问题/风险/建议）
3. **P0/P1 逐条论证**：为什么这是问题、在什么条件下会触发
4. 亮点（不超过 3 条，简短）
5. 结论：`可交付` / `修复后交付` / `不可交付`，并列出必须修的问题编号
