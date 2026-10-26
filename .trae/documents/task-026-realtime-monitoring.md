# task-026：从「自动刷新/自动扫描」升级为「实时动态更新、实时监控」

## Context

现状瓶颈：新设备发现最长等 60s 全量扫描；离线判定需 3 个扫描轮缺席（~3min）；UI 是「自动扫描开关 + 倒计时 + 最后扫描」周期语义；心跳只轮转 ping 32 台。

用户已确认范围（AskUserQuestion）：
1. **引擎真实时化**：心跳每 5s 探测全部在线设备 + 未知 IP 滚动探测（新设备 ~10-20s 发现）+ 状态变化即时推帧。
2. **离线判定加速**：心跳与扫描轮统一推进「连续缺席轮数」，连续 4 轮（各 5s）→ offline（~20s）；ARP 在位即使 ping 不通仍在线（不变）；10 分钟告警抑制兜底抖动。
3. UI 语义从「自动扫描」改为「实时监控」；off = 暂停实时探测（设备状态冻结），带宽/打印机本机观测继续；`autoScanIntervalSec` 字段名不变，语义改「深度扫描间隔」（避免破坏持久化设置）。

铁律不变：engine/ 禁 import electron；exec.ts 唯一子进程出口；无证据不猜（R-02/R-03）；未经用户确认不 commit/push。

## 实施步骤

### 1. `src/shared/constants.ts`
- 新增 `HEARTBEAT_PROBE = { onlineCap: 112, unknownPerRound: 64, absentProbeCap: 32 } as const;`
  （最坏 112+64+32=208 目标 @64 并发 ≈ 2.4s < 5s 周期；254 未知 ÷64 ≈ 4 轮 ≈ 20s 覆盖）
- `ALARM_THRESHOLDS.offlineArpMisses` 3→4，注释改：「连续缺席观测轮（心跳 5s / 扫描轮统一推进），≈20s；ARP 在位设备不计缺席」。

### 2. `src/main/engine/scheduler.ts`
- **heartbeat()**（L462-495）：
  - 首行加 `if (!this.autoScan) return;`（off = 暂停实时探测；带宽/质量/打印机/持续 Ping 定时器不动）。
  - 开头对全部记录 `pingAlive = false`（对齐扫描轮 R-06①，防 pingAlive 陈旧粘滞——关键，遗漏则静默设备永不缺席）。
  - `pickHeartbeatTargets` 重写为三集合去重合并、单次 pingSweep：
    - 缺席确认：`!rec.arpPresent` 的记录（第一轮丢失即进队列），按 arpMissStreak 降序取 ≤absentProbeCap；
    - 在线全量：`arpPresent || pingAlive`，超 onlineCap 用 heartbeatCursor 轮转；
    - 未知滚动：`cfg.hosts` 减去已有记录 IP，新字段 `unknownCursor` 轮转取 ≤unknownPerRound。
  - 探测后：缺席设备（本轮无 ARP 且 ping 失败）`portResponded = false`（失效陈旧 TCP 证据，否则打印机等端口设备仍被旧证据钉住在线）；`applyArpPresence(undefined, true)` 心跳推进缺席计数。
- **mergeArp()**（L865-873）：返回新建记录数；heartbeat 与 `phaseInitialArp`（L671+）在 >0 时于本轮 ping 前早推一帧 `emitSnapshot()`（新设备 <100ms 可见，不必等扫描完成）。
- **applyArpPresence()**（L883-895）：JSDoc 重写为「心跳 5s / 扫描轮统一推进缺席轮数，4 轮 ≈ 20s」；逻辑本身（present 重置 / advanceMisses 递增）保持。
- **nextScanInMs() / SystemStat 组装**（L1120-1125）：逻辑不变，注释改「深度扫描间隔/下次深度扫描」。

### 3. `src/shared/types.ts`
- 仅注释：`SystemStat.autoScanIntervalSec` 语义改「深度扫描间隔（秒）」；`autoScan` 语义改「实时监控开关」。字段名与 IPC 契约不动。

### 4. 渲染层文案与接线
- `TopBar.tsx`（L134-177）：
  - 开关文案「自动扫描」→「实时监控」，title 同步；间隔徽标 `{autoScanIntervalSec}s` → `深度扫描 {autoScanIntervalSec}s`。
  - 倒计时区：on → 「实时监控中」+ 实时脉冲点（新增 `.topbar__live-dot` 动画，styles/layout.css L93 switch-field 区域旁）；off → 「实时监控已暂停 · 设备状态冻结」。
  - 「最后扫描 X」→「最近更新 X」（新 prop `updatedAt` = snapshot.ts），lastScanAt 降级为 title 提示。
- `StatusBar.tsx`（L10-52）：同步「自动扫描已关闭 · 仍持续监控」→「实时监控已暂停」等文案与 nextScanAt 语义。
- `SettingsView.tsx`（L333-334、L381 及间隔控件说明）：label「自动扫描」→「实时监控」，toast「已暂停实时监控/已开启实时监控」，间隔描述「深度扫描间隔」，补一句 off 时设备状态冻结的说明。
- `App.tsx`（L50-55、L341-354）：传 `updatedAt`；nextScanAt 变量保留（深度扫描倒计时用）。

### 5. 测试（tests/）
**必改**：
- `scheduler-resilience.test.ts` R-06 describe（L587-660）改语义为「心跳与扫描统一推进缺席，4 轮 ≈ 20s」：
  - L604-614「36 次心跳不得 offline」→ 改为「4 次心跳（20s）必须 offline」；
  - L616-621 → 缺席 1-3 轮（心跳驱动）仍 online；
  - L631-640 → 20s 内 DEVICE_OFFLINE 为 0；
  - L650-660 pingAlive 归零守卫保留 + 新增心跳版；
  - 新增「ARP 在位但 ping 不通：任意轮数都不得 offline」。
- `scheduler.test.ts`（L39-47）resolveLinkState 单测：streak 3 不得 offline、4 必须 offline。

**新增**：
- 未知 IP 滚动发现：io.pingAlive 含新 IP → ≤4 轮心跳后 records 出现该设备；
- mergeArp 新建记录触发早推帧（onSnapshot 调用计数）；
- 缺席设备心跳回包复活（streak 归零、回到 online）;
- autoScan=false：心跳零探测（ping 计数为 0）但 rxBps 仍更新（衔接 L564-584 现有用例）；
- 缺席时 portResponded 失效（有端口史的静默设备 4 轮后 offline）。

### 6. `ARCHITECTURE.md`
- §5.1 状态判定（离线 4 连续缺席观测轮 ≈ 20s）、§3 心跳职责（全量在线探测 + 未知滚动 + 早推帧）、autoScan 语义（实时监控开关）、§10 变更记录。

## 验证
1. `npm test` 全绿（636 + 新增）；
2. `npm run typecheck`（node + web 双 tsconfig）；
3. engine 纯度：grep `from 'electron'` in src/main/engine = 0；
4. `node scripts/engine-check.mjs` 兼容（已确认其不引用 heartbeat/applyArpPresence/offlineArpMisses）；
5. 真实网络实测（dev 启动）：拔线设备 ~20s 变 offline + 告警、插回恢复；新设备接入 10-20s 出现并早推帧；关实时监控后设备冻结、带宽曲线继续。

## 产出后
- 汇报结果；提交/打包/推送待用户确认（当前后台仍有 v0.3.0 推送重试 job 在跑，互不阻塞）。
