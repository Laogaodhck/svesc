# Brief — 验证员 Vic（task-001 / P3）

| 字段 | 值 |
|---|---|
| `role_name` | delivery-verifier |
| `mission` | 用命令与截图证据对整机交付做 PASS/FAIL 判定，逐条对照 plan.md 第 7 节 6 条验收标准。 |
| `when_to_use` | 引擎由 Max-1 写、UI 由 Max-2 写、测试由 Tess 写，写的人不能给自己判分。 |
| `input_files` | `.agent-runs/2026-10-25/task-001/plan.md`、`implementation-report.md`、`ui-report.md`、`test-report.md`、`brief-max1.md`（第 7 节验收自查）、`brief-max2.md`（第 6 节） |
| `allowed_edit_scope` | 仅 `.agent-runs/2026-10-25/task-001/artifacts/**`（放日志与截图） |
| `forbidden_actions` | **不得修改任何 `src/**`、`tests/**`、`package.json`、配置文件**；不得"重跑一次就好了"式轻描淡写——失败就回 FAIL 并给证据；不得把环境限制（如无图形会话）当 PASS |
| `tools_policy` | 可运行任意构建/测试/启动命令；可截图；可读全部文件 |
| `output_path` | `.agent-runs/2026-10-25/task-001/verification-report.md` |
| `success_criteria` | 六条验收标准每条都有 PASS/FAIL + 证据文件路径；结论只有 PASS 或 FAIL |
| `stop_condition` | 无法构建且原因不在代码（缺依赖/无网络）→ BLOCKED 并说明；Electron 无法启动（无图形会话）→ 记录证据后继续用非 GUI 证据判定，并在结论中标注降级 |
| `handoff_format` | STATUS 块 ≤20 行 |
| `max_iterations` | 2 |

---

## 验证步骤（按序执行，每步留证据）

1. **依赖与构建**
   - `npm ci`（无 lock 则 `npm install`）→ 记录耗时与告警
   - `npm run build` → 退出码 + 尾部 20 行日志；检查三件产物：`dist/renderer/index.html`、`dist/main/index.cjs`、`dist/main/preload.cjs`，记录字节数
2. **单测**
   - `npm test` → 用例数、通过数、失败数、耗时；原始输出存 `artifacts/test-output.log`
   - 交叉核对：Tess 报告的用例数是否 ≥25，是否与实跑一致（虚报即 FAIL）
3. **分层铁律**
   - `grep` 检查 `src/main/engine/**` 无 `from 'electron'`（记录命中数，必须为 0）
4. **真机启动与截图**
   - `npm run smoke` → 检查 `artifacts/*.png` 至少 5 张（overview/devices/printers/detail/alarms）
   - **每张图必须目视检查**（用 Read 工具真的打开看），确认：非全黑/非全白、有真实文字与表格、状态色正确、演示数据角标存在（若走降级）
   - 记录尺寸与像素统计（可用 node 脚本读 PNG 头 + 简单方差，若无图像库则记录文件大小与目视结论）
5. **数据契约断言**（读 `artifacts/snapshot.json`）
   - `devices.length>0`、`printers.length>0`
   - 每台设备含 `ip/mac/hostname/osHint/quality/bandwidth` 六个键（值可 null）
   - 每台打印机 `consumables` 数组存在，且至少一台有 `levelPct!==null` 或明确 `source:'unknown'`
   - `system.alarmCounts` 与 `alarms` 实况自洽
6. **性能**
   - 从 smkoe 日志或自测脚本取全量子网扫描耗时（≤12s）
   - 记录应用冷启动到首帧时间（若可测）
7. **健壮性抽查**（只读，不许改代码）
   - 无 SNMP 设备时应用是否仍可用（把 `LAN_DEMO=0` 且断网场景尽量模拟；若无法模拟，如实标注"未验证"）
   - 应用连续运行 ≥60s，stderr 无未捕获异常、无 `UnhandledPromiseRejection`
8. **UI 静态审查**
   - `src/renderer/**` 中搜索 `TODO`、`FIXME`、`alert(`、`console.log(` 残留数量
   - 搜索 `levelPct ?? 0` / `levelPct || 0` 这类把 null 兜成 0 的写法（必须为 0 处）

## 报告结构

1. 验证环境（OS 版本、Node/Electron 版本、是否图形会话）
2. 执行记录（命令 → 退出码 → 关键输出 ≤10 行）
3. **六条验收标准逐条判定表**：标准 / 结果 / 证据路径
4. 证据索引（全部 artifacts 相对路径 + 每张截图的目视结论）
5. 缺陷清单（编号 · 严重级 · 现象 · 证据 · 建议归属：Max-1/Max-2）
6. **最终结论**：`PASS` 或 `FAIL`（FAIL 时给修复优先级顺序）
7. 未验证项（如实列出，禁止含糊）
