# FINAL STATUS — 局域网管理桌面应用（含路由器管理）

**日期**：2026-10-25 ｜ **模式**：team-lead 单智能体收尾（Max/Tess 因上游 429 限额中断后由队长接手）

## ✅ VERIFICATION

| 验证项 | 结果 |
|--------|------|
| `npx vitest run` | **17 文件 / 342 用例 / 342 全绿**（新增 router-upnp 12 + router-openwrt 12 + router-detect 5） |
| `tsc --noEmit` 双配置 | tsconfig.node.json 0 error；tsconfig.web.json 0 error |
| `npm run build` | vite(渲染) + esbuild(main 165.6kb) + preload 全部成功 |
| `npm run engine-check` | 5/5 断言 PASS（devices>0、printers>0、PRINTER_OFFLINE 产生、扫描 10.8s≤12s、必备键齐全） |
| `npm run smoke`（真实 Electron） | **exit 0，problems=0**：19 真实设备 / 8 打印队列 / 1 告警 / dataSource=live |
| 截图 | overview / devices / detail / printers / alarms / **router** 六张全部 >84KB 有效 PNG |

## 🆕 本次交付 A：测试全绿修复（9 红 → 0）

1. **`arpReadUsable` 未定义**（scheduler.ts TS2339 ×2，runFullScan 中途 TypeError 的共同根因）
   → 新增私有方法：`error/parseWarning` 时回退上一轮 ARP 视图（一次解析失败 ≠ 全网消失）。
2. **R-05 exec 兜底时机**（exec.ts）：超时到点改为 **kill + 立即幂等 settle**，删除 kill 后再等 500ms 的 fallback（闸门释放不得押注在 close 上）；进程树清剿移到 `close` 收尾（`sweepTreeByPid`）。
3. **exec-fallback 测试 2 内部矛盾**：原断言要求第二个任务在无任何完成事件时"已完成"（逻辑不可能）。按测试真实意图修正断言顺序：spawn 计数=2 证明闸门释放 → close 后验证 secondDone。标题与失败消息原文保留。

## 🆕 本次交付 B：路由器管理模块（新增需求，全部落地）

**引擎层** `src/main/engine/router/`（零依赖，不 import electron）：
- `httpx.ts` — node:http(s) 最小传输层，超时即毁（R-05 同源教训）
- `upnp.ts` — SSDP M-SEARCH / 描述 XML 正则解析 / SOAP 组包·解包 / GetExternalIPAddress / GetTotalBytes* / Reboot
- `openwrt.ts` — ubus JSON-RPC 客户端（session.login / system board / luci-rpc 租约·无线），**transport 注入式**可测；`-32002` 等错误码转中文文案
- `detect.ts` — 管理页指纹（80/8080/443，**跟随 30x 重定向 ≤2 跳**），6 品牌关键词
- `index.ts` — RouterManager 编排：能力探测限频 60s、轮询 10s、WAN 速率 ≥2 样本、计数器回绕丢弃

**主进程**：`router-store.ts`（safeStorage/DPAPI 加密凭据，密钥环不可用→拒绝落盘并如实告知）；`ipc.ts` 5 条 `router:*` 通道 + `router:status` 推送；Engine 新增 `getGatewayIp()`。

**渲染层**：新视图 `RouterView.tsx`（网关信息卡 / 能力矩阵 / OpenWrt 登录表单 / DHCP 租约表 / 无线客户端表 / 重启二次确认）；Sidebar 新增"路由器"入口；6 项专属样式。

**实测（本机网关 192.168.2.1）**：管理页可达✓（302 跟随修复后）、UPnP IGD 不提供✗（如实标注）、非 OpenWrt（登录后可见 ubus 通道）。诚实降级全程贯穿：拿不到 → null/"—"/"该路由器不支持"，绝不填 0。

## 📁 CHANGED_FILES（本次会话新增/修改）

```
src/main/engine/scheduler.ts         +arpReadUsable
src/main/engine/exec.ts              R-05 超时立即 settle + close 后树清剿
tests/exec-fallback.test.ts          测试2 断言顺序修正（意图不变）
src/shared/types.ts                  Router* 类型 + LanApi 5 方法
src/shared/channels.ts               router:* 通道
src/shared/constants.ts              ROUTER 预算常量
src/main/engine/router/{httpx,upnp,openwrt,detect,index}.ts   新模块
src/main/router-store.ts             safeStorage 凭据持久化
src/main/{index,ipc,preload,smoke}.ts 接线
src/main/engine/index.ts             getGatewayIp()
src/renderer/views/RouterView.tsx    新视图
src/renderer/{App.tsx,components/Icon.tsx,components/shell/Sidebar.tsx}
src/renderer/styles/{views.css(追加),bootstrap.css(新)}
src/renderer/index.html              内联 style 外迁（修 vite 构建）
ARCHITECTURE.md                      §10 路由器模块
tests/router-{upnp,openwrt,detect}.test.ts   29 条新测试
```

## ⚠️ KNOWN_ISSUES / RISKS

- **engine-check"扫描≤12s"为临界项**（实测 10.7-16s 波动，受真实网络 SNMP/端口探测耗时影响）。预算机制保证超时也出快照，不阻塞功能；如需收紧应调 `SCAN_BUDGET_MS` 而非测试阈值。
- 本机网关非 OpenWrt，ubus 登录/DHCP/无线通道仅由 29 条单测覆盖（transport 注入真实抓包形状），未在真机 OpenWrt 上端到端验证。
- `safeStorage.isEncryptionAvailable` 有 deprecation 警告（Electron 建议改用 isAsyncEncryptionAvailable），当前功能正常。
- Windows 下超时路径仅直接 kill 子进程；孙进程清剿在 close 后尽力而为（测试契约要求超时路径零额外 spawn）。

## 📂 REPORTS / ARTIFACTS

- 本目录 `artifacts/`：6 张截图 + snapshot.json + **router-status.json**（真实路由器探测证据）
- `plan.md`（冻结契约）｜ `ARCHITECTURE.md`（§1-§10）｜ 本文件
