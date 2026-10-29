# SVESC 局域网监控台

Windows 桌面端局域网监控应用（Electron 45 + React 19 + Vite 7 + TypeScript）。无需单独部署后台服务或安装抓包驱动：探测使用 Windows 自带命令（`ping` / `arp` / `netstat` / `route` / `nbtstat` / PowerShell）和标准协议（SNMPv2c / mDNS / SSDP / WS-Discovery / IPP）。

- 源码：[GitHub](https://github.com/Laogaodhck/svesc) · [Gitee](https://gitee.com/laogao-tall/svesc.git)
- 下载：[GitHub Releases](https://github.com/Laogaodhck/svesc/releases)
- 设计与实现：[ARCHITECTURE.md](ARCHITECTURE.md)

仅用于自有或已获授权的局域网。当前应用版本为 **0.4.0**；不同增强构建可能保留相同内部版本，下载时请同时核对 Release 标签、源码提交和附件 SHA256。

## 功能

- **设备发现与指纹识别**：/24 网段 ARP、ICMP、TCP 与协议自报联合发现，识别网关、摄像头、无线 AP、交换机、打印机、手机、平板、工作站、NAS、IoT 等。
- **实时监控**：默认 5 秒心跳与 60 秒深度扫描；新设备观测后提前推送快照。离线判断结合 ARP、ICMP 和端口证据，不把禁 ping 当作离线。
- **在线历史**：设备详情展示跨重启的状态转移记录（在线 / 离线 / 降级，SQLite 持久化，最多回溯 50 条）。
- **双通道租约回填**：OpenWrt ubus 与管理页租约通道按各自会话采集，合并后实时补充设备主机名。
- **打印机管理**：Spooler、SNMP、IPP 数据合并，TCP 探活、耗材与任务状态展示；支持手动添加、忽略、别名、测试页和队列操作。
- **打印机异常提醒**：离线、故障、耗材不足（≤10%）与恢复时弹系统通知，可在设置中关闭；仅对状态变化提醒，带冷却，演示/虚拟/被忽略打印机不提醒。
- **网络质量与持续 Ping**：丢包、延迟评分、滑窗 RTT 历史；持续监控目标独立运行，无样本显示未知。
- **带宽估算**：`netstat -e` 计数器差分与连接归集，展示吞吐趋势；单设备带宽是估算，不是抓包计量。
- **运维工具**：设备备注与标签、诊断与端口扫描、WOL、JSON / HTML 报告、配置导入导出。
- **托盘驻留**：按设置关闭到托盘，可查看设备数量、切换实时监控和退出应用。

当前版本已移除独立告警中心、桌面告警与告警 Webhook；设备离线、IP 冲突、打印故障及采集降级仍在对应界面如实呈现。

## 设备发现与识别

识别遵循“证据优先、不猜”原则，没有证据时显示 `unknown`。

| 通道 | 实现与边界 | 典型收益 |
|---|---|---|
| ARP / ICMP / TCP | 在位、回包和端口响应分别记账；一次 ICMP 超时不单独判离线 | 常规设备发现与状态观测 |
| ONVIF / WS-Discovery | 解析明确的摄像头自报类型；对已发现的候选补充 ONVIF 信息 | 摄像头 / NVR |
| SSDP | `ssdp:all` 查询与描述 XML，提取设备类型及友好名称 | 路由器 / AP / 打印机 / IoT |
| mDNS | 解析压缩 PTR / SRV，关联查询窗口内跨包的 A / TXT；提取 `model` / `md` / `ty` 型号 | Apple、投屏、智能家居、打印扫描等生态 |
| NetBIOS / 反向 DNS | 定向查询主机名，失败保留空值 | Windows 与未提供其他名称的设备 |
| HTTP / 端口指纹 | 候选管理页的 title / Server 与特征端口；分类冲突时不猜类型 | 打印机 / Windows / NAS / 摄像头 |
| OUI 厂商表 | 手写主表优先，叠加 IEEE 全量 24-bit MA-L 前缀表 | 厂商证据；不等同于整机型号 |
| 随机 MAC | 检查本地管理位；无可信厂商证据时标注“随机 MAC（厂商不可判）” | 避免手机随机地址误标 |

mDNS、SSDP、WS-Discovery 与扫描中的 ICMP 阶段并行，不要求设备先进入 ARP 表或回应 ping。仅接收当前扫描范围内的地址；协议回包可建立设备记录，但不会被伪装成 ICMP 或 TCP 探活成功。扫描截止后不再接纳该轮迟到的协议身份结果。

AirPlay 等跨设备服务只提供生态证据，不单凭服务名认定手机；有明确 TXT 型号时再细分。查询服务与端口集合以 [mDNS 服务表](src/main/engine/discovery/mdns-devices.ts) 和 [共享常量](src/shared/constants.ts) 为准。

## 路由器登录与租约主机名

路由器页面目前只保留登录、退出和内嵌管理页，不再展示 WAN、DHCP、无线客户端或重启操作卡片；引擎仍在后台采集可用数据，并将租约名称回填到设备列表。

| 路径 | 条件 | 能力边界 |
|---|---|---|
| OpenWrt ubus | 路由器提供 `/ubus`，账号有对应 RPC 权限 | 读取 DHCP 租约等协议数据；单对象无权限或网络失败不等同于会话失效 |
| 内嵌管理页 | 用户在真实管理页登录，隔离分区内检测到会话 Cookie | 启用管理页租约实验通道；Cookie 关键词检测不是协议级认证 |
| Basic 认证 | ubus 登录失败且管理页明确返回 Basic 质询 | 验证并展示登录状态，本身不提供 ubus 或 DHCP 数据 |

### 回填规则

1. 两路租约都先校验 IPv4、MAC、主机名和租期，拒绝占位名称与已过期记录；同一来源内同 MAC + IP 的名称冲突置空，不按输入顺序选名字。
2. **ubus 优先**：只有同 MAC + IP 且 ubus 缺名时，管理页名称才补入；ubus 已出现的 MAC 不采用管理页的其他 IP，避免旧地址串名。
3. 设备列表只对 **MAC + 当前 IP 同时匹配** 的记录补名，已有主机名和用户别名仍优先。租约不创建设备、不更新存活时间、不改变在线判断。
4. 有效名称变化立即推送快照；仅续租或输入顺序变化不制造额外推送，但会保存新的租期。租约期限在每次投影时检查，退出或会话变化后撤回失效提示。

### 刷新与安全边界

- 路由器默认每 10 秒轮询；同会话刷新合并，租约结果不等待较慢的 WAN 结果才推送。
- 管理页单轮共用 6 秒预算，每个外部操作最多 1.2 秒，最多尝试 6 个去重候选页。连续失败按 10 / 20 / 40 / 60 秒退避，不永久停用；失败原因保留在路由器状态中。
- 管理页路径尚未逐台真机验证；登录成功不保证固件提供可解析租约，登录页或无法识别的空表不会冒充成功。
- 管理页 Cookie 存于独立分区并绑定网关；逐 URL 取 Cookie，不跨域、路径或安全属性复用。首次升级遇到未绑定的旧 Cookie，或网关变化时会先清理，可能需要重新登录。
- Cookie 清理期间或失败后阻止后台读取和该分区的原生请求；会话修订检查阻止迟到结果恢复旧会话或继续发送旧 Cookie。
- “记住密码”使用 Electron 异步 `safeStorage`（Windows DPAPI）加密密码；密钥环不可用时拒绝保存，不降级明文。退出、关闭记住密码或更新登录会阻止旧异步保存覆盖新状态。
- 网关绑定针对管理页 Cookie，不代表持久化的 ubus 账号按网关分库存储。切换网络前应检查记住密码设置；仅在可信且已授权的管理网络中登录。

## 下载安装

从已公开的 [GitHub Releases](https://github.com/Laogaodhck/svesc/releases) 选择对应构建：

- `SVESC-Setup-0.4.0.exe`：安装版（NSIS 安装向导）。
- `SVESC-Portable-0.4.0.exe`：免安装便携版。

系统要求：**Windows 10/11 x64**。当前构建未配置代码签名证书，Windows 可能提示未知发布者；请核对来源与 Release 提供的 SHA256。代码推送、打包成功或创建 Release 草稿不代表附件已经公开可下载，Gitee 代码同步也不自动同步 GitHub Release 附件。

## 开发与验证

建议使用 Windows x64、Node.js 24 和 npm。持久化使用 Node 内置 `node:sqlite`，无需编译 `better-sqlite3`；安装依赖时需要能够下载 Electron 二进制。

```bash
npm ci                                  # 按 package-lock.json 安装依赖
npm start                               # 先构建，再启动 Electron 应用
npm run build                           # 构建 renderer + main + preload
npm test                                # Vitest 单元与本地集成测试
npm run typecheck                       # 主进程 / Node TypeScript 检查
npx tsc --noEmit -p tsconfig.web.json     # 渲染器 TypeScript 检查
```

`npm test` 同时包含 Node 引擎测试与 `tests/*.tsx` 组件测试（jsdom + Testing Library，按文件声明 `@vitest-environment jsdom`），组件测试通过 mock `window.lanApi` 运行，不触达真实 IPC 或打印机。

当前没有 `dev` 脚本；`npm start` 不是热更新开发服务器。单元与本地集成测试使用模拟数据或回环服务，不应与下面会执行真实采集的检查混用：

```bash
npm run engine-check                    # 纯 Node 引擎：真实扫描与预算断言
npm run soak                            # 真实采集长跑检查
npm run smoke                           # 构建并启动 Electron 冒烟检查
```

运行真实采集前确认目标网络授权；不应把扫描结果、真实账号密码、Cookie 或用户数据目录提交到仓库。

### 打包与发布

```bash
npm run dist
# 再次构建时更换为尚未存在的输出目录，例如：
npm run dist -- --config.directories.output=release-0.4.0-build-20261029
```

`dist` 脚本构建 Windows x64 的 NSIS 与 portable 包，使用 `--publish never`，**不会自动创建 Release 或上传附件**。默认输出目录和图标设置见 [electron-builder.yml](electron-builder.yml)；当前环境重用旧输出目录可能触发 ASAR 清理限制，应使用新目录，而不是关闭安全检查。

NSIS 安装器使用独立的 `setup-icon.ico`，应用、便携版和卸载器保留应用图标。发布前应确认源码提交、包内版本、附件大小与 SHA256，先完成草稿附件核验再公开；不要移动旧标签或覆盖旧附件来冒充新构建。

### 验证范围

双通道租约增强代码（`7e0cf25`）已通过 **38 个测试文件、892 项测试**，主进程、渲染器及修改测试的类型检查通过；安装版和便携版已构建，并核验包内构建文件与资源。该轮没有进行真实路由器登录或安装后 UI 实测，不能据此承诺所有固件兼容；历史真机记录与当前设计边界见 [架构文档](ARCHITECTURE.md)。

## 架构与数据诚实约束

```text
Renderer（快照展示 / 用户操作）
    ↕ contextBridge + 白名单 IPC
Main（Electron 生命周期 / Cookie / 加密凭据 / 推送）
    ↕ 注入依赖与回调
Engine（纯 Node 探测 / 调度 / 租约合并 / SQLite）
```

`src/main/engine/**` 禁止导入 Electron；渲染器不直接执行局域网探测。缺失数据返回 `null` / `unknown` / `—`，推断字段说明证据来源；采样不足不出质量分级，估算带宽不冒充真实计量。首次扫描完成后真实设备少于阈值时可能叠加演示数据，界面用 `demo` / `mixed` 标识，不应当作真实资产。

## 作者

浩玥工作室（老高）
