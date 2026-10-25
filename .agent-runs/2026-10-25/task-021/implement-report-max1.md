# task-021 实现报告（Max-1：引擎 + 主进程 + 共享契约）

日期：2026-10-25 · 权威规格：`plan.md` 队长裁定节 + `brief-max1.md` · 调查依据：`investigation-report.md`（Vera）

## 一、改动文件清单（文件:行号为当前磁盘实况）

### F1 告警清除（语义 A + manualClears 冷静期）

| 文件:行号 | 改动 |
|---|---|
| `src/shared/types.ts:244-248` | `AlarmTraceEntry.type` 增加 `'cleared-by-user'`；`by` 注释同步（acked/cleared-by-user 时为操作人） |
| `src/main/engine/alarms.ts:82-89` | 新增 `private manualClears = new Map<key, timestamp>()`（冷静期台账，含语义说明注释） |
| `src/main/engine/alarms.ts:192-214` | 新增 `clear(id, by): boolean`：不存在或已 cleared → false；成功置 resolvedAt + `pushTrace('cleared-by-user', by)` + `active.delete` + `manualClears.set(key, at)`。**recentByKey 保持原样**（按任务书，不摘除——重开合并由冷静期在 raise 路径前置拦截） |
| `src/main/engine/alarms.ts:215-217` | 新增 `clearMany(ids, by): number`：逐条调 clear，返回成功数 |
| `src/main/engine/alarms.ts:235-238` | `evaluate()` 入口清理过窗 manualClears 条目（防膨胀） |
| `src/main/engine/alarms.ts:253-260` | raise 路径（抑制窗口判定**之前**）：key 在 manualClears 且 `now-ts < ALARM_THRESHOLDS.suppressWindowMs` → **完全静默 return**（不新建/不重开/不推送/不进 reopened）；已过窗 → 删除条目走正常流程 |
| `src/main/engine/index.ts:40-43` | `Engine` 接口加 `clearAlarm(id, by): boolean` / `clearAlarms(ids, by): number` |
| `src/main/engine/index.ts:266-272` | 门面实现透传 scheduler（stop 路径未动：语义 A 记录保留，全量 REPLACE 天然不复活） |
| `src/main/engine/scheduler.ts:1062-1074` | `clearAlarm(id, by)` / `clearAlarms(ids, by)` 仿 ackAlarm；成功（任一）后 `emitSnapshot()` 立即推帧 |
| `src/shared/channels.ts:9-10` | `alarmsClear: 'alarms:clear'`（payload = ids 数组，单条也是数组） |
| `src/main/ipc.ts:59-70` | 新 handler：`by` 注入 `os.userInfo().username`（异常/空串兜底"未知用户"，与 ackAlarm 同款），ids 归一化为 string[] 后调 `engine.clearAlarms` |
| `src/main/preload.ts:41` | `alarmsClear(ids): Promise<void>` |
| `src/shared/types.ts:336-337` | `LanApi.alarmsClear(ids: Alarm['id'][]): Promise<void>` |

### F2 开机自启动（主进程链路，OS 唯一事实源）

| 文件:行号 | 改动 |
|---|---|
| `src/shared/channels.ts:32-33` | `launchAtLoginSet: 'settings:launch-at-login'` |
| `src/main/ipc.ts:120-131` | `settingsGet` 返回值注入 `launchAtLogin: app.getLoginItemSettings().openAtLogin` 与 `launchAtLoginAvailable: app.isPackaged`（照抄 appVersion 注入模式；**未进** store/settingsUpdate 白名单） |
| `src/main/ipc.ts:137-150` | 新 handler：`app.isPackaged === false` → `{ ok:false, error:'开发模式下不可用，请使用安装版开启开机自启' }`；否则 `setLoginItemSettings({ openAtLogin })` 后**立即回读** `getLoginItemSettings().openAtLogin` 比对，不符 → `{ ok:false, error:'设置未生效（可能被系统策略限制）' }`，相符 → `{ ok:true, error:null }` |
| `src/shared/types.ts:162-166` | `SettingsPayload` 增加 `launchAtLogin: boolean` / `launchAtLoginAvailable: boolean` |
| `src/shared/types.ts:358-359` | `LanApi.setLaunchAtLogin(on): Promise<{ ok, error }>` |
| `src/main/preload.ts:70-71` | 同步暴露 |
| `src/shared/global.d.ts` | **无需改动**（只声明 `window.lanApi: LanApi`，形状由 types.ts 提供） |
| `tray.ts` | 未动（按任务书：读 OS 状态天然同步） |

### F3 手机识别（识别层）

| 文件:行号 | 改动 |
|---|---|
| `src/main/engine/discovery/fingerprint.ts:49-57` | `RE_MOBILE_HOST` 补高置信品牌词根 `oneplus\|realme\|nokia\|zenfone\|huawei\|sm-[a-z]\d{3}`；注释逐条记录误伤面评估（含"禁 moto 泛匹配"理由）；`sm-[a-z]\d{3}` 的位数约束防泛匹配 |
| `src/main/engine/discovery/fingerprint.ts:111-113` | 主机名命中 mobile 的返回 osHint 由 `null` 改为 `'手机（主机名特征）'`（与 camera/printer 路径风格一致） |
| `mdns-devices.ts` | **一个字未动**（按裁定：_apple-mobdev 未实测，宁缺勿滥） |

### F4：引擎零改动，未参与（按裁定）。

## 二、API 形状落地对照（plan.md 冻结形状逐条）

| 冻结形状 | 落地 | 一致 |
|---|---|---|
| `LanApi.alarmsClear(ids: Alarm['id'][]): Promise<void>`（单条传 [id]） | types.ts:337 + preload.ts:41 | ✓ |
| settingsGet 返回增加 `launchAtLogin: boolean; launchAtLoginAvailable: boolean` | types.ts:162-166 + ipc.ts:123-124 | ✓ |
| `LanApi.setLaunchAtLogin(on: boolean): Promise<{ ok: boolean; error: string \| null }>` | types.ts:359 + preload.ts:70-71 | ✓ |
| `AlarmTraceEntry.type` 增加 `'cleared-by-user'` | types.ts:246 | ✓ |
| F1 冷静期语义（10 分钟内同因再触发完全静默） | alarms.ts:253-260，置于抑制窗口判定之前 | ✓ |
| F2 不进 store | settingsGet 注入 + 独立 handler，settingsUpdate 白名单未动 | ✓ |
| F3 mDNS 表不动 | 未改 | ✓ |

补充说明（形状冻结之外的一处实现取舍）：`alarmsClear` 的 IPC handler 入参声明为 `unknown` 并在内部 `Array.isArray` 归一化后 `String()`——IPC 边界不信任渲染层输入，畸形 payload 静默归零处理（0 条清除），不会抛未处理异常。

## 三、既有测试修正说明

**零修正**。改前核查过两类潜在冲突点：
1. `tests/fingerprint.test.ts` 无任何 "mobile 主机名命中 → osHint 为 null" 的断言（:143-144 是 mDNS 路径，不受影响）；
2. `tests/alarms.test.ts` 的 trace 断言（:76 `['raised','resolved','re-raised']`）锁的是抑制窗口合并路径，clear/clearMany/manualClears 全部是新增 API 与前置拦截，不改变既有流转。

定向 4 文件 82 用例全绿；全量 **503/503**（基线只增不减：0 新增用例——新用例由 Tess 按分派补）。

## 四、验证

```
npm run typecheck                                          → 0 error（node+web 由 typecheck 脚本覆盖）
npx vitest run tests/alarms/alarm-state/fingerprint/settings → 82 passed
npx vitest run                                             → 503/503 passed（146s，含真实进程/网络用例）
```

## 五、遗留风险

1. **F1 冷静期与 hydrate**：`manualClears` 是内存态，进程重启后清零——重启后若同因条件仍满足，首个 evaluate 会正常产生全新告警（不是复活旧记录）。可辩护（重启本身是"新鲜视角"），但若要跨重启冷静期需落盘，本版未做（任务书未要求）。
2. **F2 回读验证的时效**：`getLoginItemSettings` 回读在 Windows 上读 HKCU Run，MSIX/策略受限环境下仍可能"回读通过但开机实际不拉起"（注册项存在但被禁用）——这超出 Electron 可观测范围，已用中文文案兜底说明。
3. **F3 `huawei` 词根**：主机名含 huawei 的华为路由器会被判 mobile（管理页/端口路径在其之前已被端口信号截住的情况除外——即无特征端口+主机名 huawei 的路由器会误判）。裁定接受此风险（手机占比高、收益为正），测试样例由 Tess 补；若后续实测误伤面大，候选缓解是把 `huawei` 移到 router 判定之后或加后缀约束（如 `huawei[-_]phone`）。
4. **clear 后 detail 面板**：`cleared-by-user` 的 trace 展示由渲染层 TRACE_LABEL 负责（Max-2 领地），引擎侧 by 字段已就位。
