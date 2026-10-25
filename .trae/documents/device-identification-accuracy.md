# 设备识别精度提升（手机/平板/摄像头/路由器/交换机/无线AP）

## Context

用户反馈设备类型识别精度低。当前 [fingerprint.ts](file:///e:/GitHub/svesc/src/main/engine/discovery/fingerprint.ts) 只用 端口/主机名正则/~110 条 OUI/mDNS(9 服务)/网关判定。核心瓶颈：

1. **MAC 随机化**（安卓 10+/iOS 14+ 默认）→ OUI 查不到，手机平板大量落 unknown
2. **缺行业标准自报协议**：摄像头 ONVIF WS-Discovery (UDP 3702)、网络设备 UPnP SSDP 均未接入设备发现（[router/upnp.ts](file:///e:/GitHub/svesc/src/main/engine/router/upnp.ts) 已有 M-SEARCH 但仅用于路由器模块）
3. **端口探测表窄**：海康 8000 / 大华 37777 / ONVIF 8899 未探测
4. 无 平板/无线AP/交换机 类型（用户已确认新增）

诚实原则不动摇：无证据不猜，非管理型交换机无 IP 本身不可见（文档如实说明）。

## 改动清单

### 1. 新增 `src/main/engine/discovery/wsdiscovery.ts` — ONVIF 摄像头发现
- UDP 3702 组播 Probe（`dn:NetworkVideoTransmitter` + 通配 `wsdp:Device`），1.2s 窗口，纯 node:dgram
- 纯函数 `parseProbeMatches(xml)`：提取 ProbeMatch 的 `XAddrs`（取 IP）与 `Types`
- 映射：`NetworkVideoTransmitter` → IPC、`NetworkVideoRecorder` → NVR，均 kind='camera'（osHint 区分）
- 任何异常静默 `[]`（增强路径）

### 2. 新增 `src/main/engine/discovery/ssdp-devices.ts` — SSDP 全网自报发现
- M-SEARCH `ST: ssdp:all`（1.5s 窗口）；复用 [router/upnp.ts](file:///e:/GitHub/svesc/src/main/engine/router/upnp.ts) 的 M-SEARCH 构造模式（抽公共或复制小段），LOCATION 描述 XML 用 [router/httpx.ts](file:///e:/GitHub/svesc/src/main/engine/router/httpx.ts) `httpRequest` 拉取（≤1 跳、1s 超时）
- 纯函数 `parseSsdpDeviceType(xml)`：`deviceType` 正则提取
- 映射：`InternetGatewayDevice` → router（osHint 'UPnP IGD 网关'）；`WLANAccessPointDevice` → ap（osHint '无线AP (UPnP)'）；`MediaRenderer` → iot（osHint '投屏/音响 (UPnP)'）；`MediaServer` 不定 kind，仅 osHint 兜底

### 3. `mdns-devices.ts` 服务表扩充（高置信才收）
- 新增：`_sleep-proxy`→apple、`_nvstream`→workstation（GeForce 串流 PC）、`_ipp`/`_ipps`/`_pdl-datastream`/`_scanner`→printer、`_axis-video`→camera、`_googlerpc`→iot

### 4. `fingerprint.ts` 规则与优先级
- `FingerprintInput` 新增：`wsdiscoveryKind?: 'camera'|'nvr'|null`、`ssdpKind?: 'router'|'ap'|'iot'|null`、`ssdpOsHint?: string|null`
- 新优先级段"设备自报身份"（端口打印机判定之后、SMB 之前……实际放法：打印机端口 → SMB/RDP → **自报层（wsdiscovery/ssdp/mDNS）** → RTSP/SSH/62078/548 → 主机名 → OUI → 网关 → TTL）。自报层内部：camera(NVR/IPC) > ap > router(IGD) > mDNS mobile/iot > apple
- 主机名正则扩充：平板 `ipad|matepad|tablet|mi[-_ ]?pad`（新增 kind tablet，判在 mobile 之前）；摄像头加 `hik|ezviz|imou|dahua|uniview|tpipc`；交换机 `switch|交换机|\bsw[-_]?\d+`（kind switch）；AP `\bap[-_]?\d|wireless.?ap`
- OUI vendor 分支：海康/大华已有；`ruijie|mercury|h3c|huawei` + 端口/主机名佐证时才判 switch/ap，避免路由器 OUI 误判交换机

### 5. `types.ts` + UI
- `DeviceKind` 增加 `'tablet' | 'ap' | 'switch'`
- [format.ts](file:///e:/GitHub/svesc/src/renderer/lib/format.ts) `KIND_LABEL` 补：平板/无线AP/交换机（DevicesView 筛选 chips 由 kind 动态生成，无需改）

### 6. `oui.ts` 扩充 + 随机 MAC 识别
- 一次性脚本 `scripts/build-oui.mjs`：下载 IEEE `standards-oui.ieee.org/oui/oui.txt`（~10MB），按厂商白名单（手机/平板：Apple/Samsung/Huawei/Honor/Xiaomi/OPPO/vivo/OnePlus/Realme/Google/Motorola；摄像头：Hikvision/Dahua/Uniview/EZVIZ/Imou/Axis；网络：TP-Link/Mercury/Fast/Ruijie/H3C/Cisco/Ubiquiti/MikroTik/Netgear/ASUS/Tenda/Zyxel；NAS/打印机补齐）过滤生成紧凑表 `oui-extended.ts`（每厂商前缀合并，预计 300-600 条，几十 KB，提交生成结果不提交原始文件）
- `lookupVendor` 保持签名；新导出 `isRandomizedMac(mac)`（首字节第二 nibble ∈ {2,6,a,e}）→ vendor 显示"随机 MAC（厂商不可判）"，osHint 不猜

### 7. `constants.ts` 端口表
- `PROBE_PORTS` 增：8000（海康）、37777/37778（大华）、8899（ONVIF）、8080（设备管理页）、5000（群晖）；确认 phasePorts 在 SCAN_BUDGET_MS=10s 预算 + AbortController 下无回归（LAN 内关闭端口 RST 快，风险低）

### 8. `scheduler.ts` 接线（[augmentDeviceIdentity L714](file:///e:/GitHub/svesc/src/main/engine/scheduler.ts#L714)）
- mDNS(1s) / WS-Discovery(1.2s) / SSDP(1.5s) 三个窗口 **Promise.all 并行**（总耗时 ≈ 最长 1.5s，不超预算）；结果分别入 `mdnsHints` / `wsdiscoveryHints` / `ssdpHints`（ip→hint，负缓存语义同现有）
- `composeDevicesAndPrinters` 组装 `inferFingerprint` 输入时透传新 hint；`isRandomizedMac` 命中时 vendor 置换为诚实标签

### 9. 测试（Vitest 纯函数风格，同 [tests/fingerprint.test.ts](file:///e:/GitHub/svesc/tests/fingerprint.test.ts)）
- 新 `tests/wsdiscovery.test.ts`（构造字节/样例 XML 解析、IP 提取、多 ProbeMatch 聚合）
- 新 `tests/ssdp-devices.test.ts`（描述 XML deviceType 解析、USN/ST 映射）
- `tests/fingerprint.test.ts` 扩：tablet/ap/switch 判定、自报层优先级、随机 MAC 不误判
- `tests/oui.test.ts` 扩：isRandomizedMac、新表条目抽查

### 10. 文档
- [ARCHITECTURE.md](file:///e:/GitHub/svesc/ARCHITECTURE.md) §2 模块表补 wsdiscovery/ssdp-devices 行；明确"非管理型交换机无 IP 不可见"的诚实边界

## 验证
1. `npm run typecheck` + `npm test`（全绿）
2. `npm run engine-check`（真实网段 192.168.2.0/24 回归：扫描预算不超时、新信号在快照 warnings 无异常）
3. `npm start` 实机观察设备页：手机/平板能否识别（随机 MAC 场景给诚实标签）、摄像头/路由器/AP 判定与筛选 chips
4. 已有测试（scheduler/fingerprint/oui）零回归
