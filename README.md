# SVESC 局域网监控台

Windows 桌面端局域网监控应用（Electron 45 + React 19 + Vite 7 + TypeScript）。零后台服务、零驱动安装：全部探测走 Windows 自带命令（`ping` / `arp` / `netstat` / `route` / `nbtstat` / PowerShell）+ 标准协议（SNMPv2c / mDNS / SSDP / WS-Discovery / IPP）。

## 功能

- **设备发现与指纹识别**：/24 网段 ARP + ping 扫描，多通道设备类型推断（网关 / 摄像头 / 路由器 / 无线AP / 交换机 / 打印机 / 手机 / 平板 / 工作站 / NAS / IoT 等）
- **打印机管理**：Spooler + SNMP + IPP 三源合并，TCP 探活覆盖"假在线"，耗材余量、打印任务、故障告警
- **网络质量**：冻结公式的丢包/延迟评分，每设备滑窗 RTT 历史与趋势
- **带宽估算**：`netstat -e` 差分 + 连接按进程归集
- **路由器通道**：支持路由器 Web 会话读取 DHCP 租约，回填设备主机名
- **告警**：新设备接入、离线、多 MAC 冲突、打印故障、网络退化等 7 条规则，去重 + 自动恢复 + 手动确认
- **托盘驻留**：关闭窗口不退出，托盘菜单快速查看设备数与告警

## 设备识别能力

识别遵循"证据优先、不猜"原则——没有任何证据时显示 unknown，绝不定编造：

| 通道 | 原理 | 典型收益 |
|---|---|---|
| ONVIF WS-Discovery | UDP 3702 组播 Probe，设备自报 `NetworkVideoTransmitter` / `NetworkVideoRecorder` | 摄像头 / NVR 精准自报 |
| SSDP 自报 | `ssdp:all` M-SEARCH + 描述 XML `deviceType` | 路由器 / 无线AP / IoT 自报 |
| mDNS | 17 项服务表（IPP / 扫描仪 / Axis 视频 / Apple 等） | 打印机 / Apple / 工作站 |
| NetBIOS | `nbtstat -A` 远查机器名 | 禁 ping 且无 rDNS 的 Windows 设备 |
| 端口指纹 | 16 个特征端口（9100/631/515/445/3389/554/8000/37777/8899/5000…） | 打印机 / Windows / NAS / 摄像头 |
| OUI 厂商表 | 手写主表 + IEEE 官方数据生成表（`scripts/build-oui.mjs`） | 手机 / 摄像头 / 网络设备厂商 |
| 随机 MAC 识别 | 本地管理位检测 | 诚实标注"随机 MAC（厂商不可判）" |

## 下载安装

从 [Releases](https://github.com/Laogaodhck/svesc/releases) 下载：

- `Setup`：安装版（NSIS 安装向导）
- `Portable`：免安装绿色版

系统要求：Windows 10/11 x64。

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发模式（如未配置可使用 npm run start）
npm run build      # 构建 renderer + main + preload
npm test           # Vitest 全量单元测试（不碰网络）
npm run typecheck  # TypeScript 类型检查
npm run engine-check  # 纯 Node 引擎自检：真实扫描一轮 + 预算断言
npm run dist       # 打包 Windows 安装包 / 便携版
```

### 架构

三层铁律架构，详见 [ARCHITECTURE.md](ARCHITECTURE.md)：

```
Renderer（只读快照，不发探测） → Main（唯一 import electron） → Engine（纯 Node 可测）
```

`src/main/engine/**` 内禁止 `import 'electron'`——单元测试无需启动 Electron，`engine-check` 能在纯 Node 下跑完真实扫描。

### 数据诚实约束

- 拿不到的数据返回 `null` / `unknown` / `—`，绝不编造
- 推断类字段（`osHint`）明示推断来源（如"手机（主机名特征）"）
- ICMP 不可达绝不单独判离线；采样不足不出质量分级

## 作者

浩玥工作室（老高）
