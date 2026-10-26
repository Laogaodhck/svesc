/**
 * HTTP 管理页指纹（task-027，设备识别增强的第 6 路证据）。
 *
 * 原理：路由器/打印机/摄像头/NAS 的 Web 管理页 <title> 与 Server 头自带
 * 厂商/型号（"TP-Link 路由器"、"HP LaserJet M1136"、"Hikvision-Web"）——
 * **设备自己的 Web 服务自报**，比 OUI 厂商名细、比主机名正则真。
 * 只对已探明 80/8080 端口开放的候选发请求（不新增端口面），GET / 一发即收。
 *
 * 分类规则（数据诚实）：
 *  - 厂商/型号关键词只收录无歧义名单，恰好命中 1 类才定 kind；
 *  - 同名命中 ≥2 类（如 "Camera Printer Server"）→ 不定 kind，仅 osHint；
 *  - 无命中但有 title → osHint 原文（截断），kind 不动；
 *  - 401/403 也是有效响应：认证页的 `WWW-Authenticate` realm 常自报厂商名
 *    （task-028，旧实现把 >=400 全部丢弃，只回 403 的设备因此永远无指纹）；
 *  - 任何异常静默跳过（增强路径，绝不拖垮扫描主流程）。
 */
import { httpRequest } from '../router/httpx';

/** 单轮最多探测的设备数（轮转覆盖，phaseFingerprint 预算内）。 */
export const HTTP_PROBE_MAX_TARGETS = 6;
/** 并发上限与单请求超时。 */
export const HTTP_PROBE_CONCURRENCY = 4;
export const HTTP_PROBE_TIMEOUT_MS = 900;
/** osHint 允许的最大长度（title 原文兜底时截断）。 */
export const HTTP_TITLE_MAX_LEN = 48;

export type HttpFingerprintKind = 'printer' | 'router' | 'camera' | 'server' | 'iot';

export interface HttpFingerprintHint {
  ip: string;
  /** 仅当命中且**恰好 1 类**时给出；0 类或 ≥2 类为 null（不猜）。 */
  kind: HttpFingerprintKind | null;
  /** 管理页自报文案（命中时带型号；未命中时 title 原文兜底；全无则 null）。 */
  osHint: string | null;
}

/** 探测目标：已探明管理口开放的候选设备。 */
export interface HttpProbeTarget {
  ip: string;
  port: 80 | 8080;
}

/** 注入式传输结果（真实实现包一层 httpRequest；测试注入假数据）。 */
export interface HttpProbeResponse {
  status: number | null;
  server: string | null;
  body: string;
  /** `WWW-Authenticate` 原文（401 时管理页常自报 realm 厂商名，task-028）。 */
  wwwAuthenticate?: string | null;
}

type HttpFetcher = (ip: string, port: number) => Promise<HttpProbeResponse | null>;

/** 从头记录里取单值（node:http 的 headers 值可能是 string[]）。 */
function singleHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const defaultFetcher: HttpFetcher = async (ip, port) => {
  const res = await httpRequest(`http://${ip}/`, {
    port,
    path: '/',
    timeoutMs: HTTP_PROBE_TIMEOUT_MS,
    headers: { Accept: 'text/html' },
  });
  // 401/403 同样是真实响应：认证页的 WWW-Authenticate realm / 登录页 title 常带
  // 厂商名（旧实现把 >=400 全部丢弃，导致只回 403 的 TP-Link 设备永远无指纹）。
  if (res.error || res.status === null) return null;
  return {
    status: res.status,
    server: singleHeader(res.headers['server']),
    body: res.body,
    wwwAuthenticate: singleHeader(res.headers['www-authenticate']),
  };
};

/** 从 `Basic realm="TP-Link"` 里提取 realm 原文（纯函数；无则 null）。 */
export function parseAuthRealm(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /realm\s*=\s*"([^"]*)"/i.exec(header) ?? /realm\s*=\s*([^,\s]+)/i.exec(header);
  const realm = (m?.[1] ?? '').trim();
  return realm.length > 0 ? realm : null;
}

/** 提取 HTML <title>（纯函数；无则 null；容忍大小写与多空白）。 */
export function parseHttpTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const title = (m[1] ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return title.length > 0 ? title : null;
}

/** osHint 组装：管理页自报前缀 + 截断原文（纯函数）。 */
export function buildHttpOsHint(text: string, confident: boolean): string {
  const clipped = text.length > HTTP_TITLE_MAX_LEN ? `${text.slice(0, HTTP_TITLE_MAX_LEN)}…` : text;
  return confident ? `管理页自报：${clipped}` : clipped;
}

/** 关键词 → 类别。名单按"该词只属于一类"原则收录，跨类词不进表。 */
const KEYWORD_KINDS: ReadonlyArray<readonly [RegExp, HttpFingerprintKind]> = [
  // 打印机：品牌 + 打印机型号系列词（title 里常见完整型号）
  [/laserjet|deskjet|inkjet|pixma|maxify|imageclass|ecosys|pagescope|workcentre|officejet|打印|printer|print server/i, 'printer'],
  [/epson|canon|brother|xerox|ricoh|kyocera|lexmark|konica/i, 'printer'],
  // 摄像头（task-028 补 tapo/vigi/v380/wyze/arlo/eufy/ring/onvif；小米/萤石系常用
  // "Mi Home"/"EZVIZ" 登录页，ezviz 已在名单，mi home 太泛不进）
  [/hikvision|dahua|uniview|ezviz|imou|xiongmai|ipcam|ip-cam|network.?camera|webcam|netcam|nvr|dvr|foscam|reolink|amcrest|vivotek|hanwha|pelco|onvif|\btapo\b|\bvigi\b|\bv380\b|\bwyze\b|\barlo\b|\beufy\b|\bring\b|硬盘录像机|摄像头|摄像机/i, 'camera'],
  // NAS / 存储服务器
  [/synology|qnap|diskstation|truenas|freenas|unraid|openmediavault|群晖|威联通|nas/i, 'server'],
  // 路由器（'router'/'gateway' 单词本身 + 路由器管理页品牌词；task-028 补固件名/品牌；
  // task-030 补 TP-LINK dynaform 型号自报：title 即型号名（真机 "TL-7DR7290"），
  // tl- 后接 1-3 个字母 + 数字的都是 TP-LINK 型号命名法）
  [/router|gateway|路由器|网关|tplink|tp-link|tenda|openwrt|asusrouter|netgear|d-link|dlink|miwifi|hiwifi|mercury\s*router|fast\s*router|asuswrt|padavan|gl[.-]inet|cudy|linksys|\bdeco\b|\barcher\b|\borbi\b|nighthawk|\bunifi\b|\btl-[a-z]{1,3}\d{2,}/i, 'router'],
  // IoT / 影音终端（task-028 补 tuya 涂鸦生态、Alexa/Shelly/Matter）
  [/chromecast|androidtv|android.?tv|bravia|sonos|firetv|fire.?tv|airplay|homekit|小爱|电视|机顶盒|smart ?tv|tuya|shelly|meross|sonoff|matter/i, 'iot'],
];

/**
 * HTTP 指纹分类（纯函数）。
 * @param wwwAuthenticate 401 响应的 `WWW-Authenticate`（realm 常含厂商名）。
 * @returns kind：恰好命中 1 类时该类；0 类或 ≥2 类为 null（不猜）。
 */
export function classifyHttpFingerprint(
  server: string | null,
  title: string | null,
  wwwAuthenticate: string | null = null,
): HttpFingerprintKind | null {
  const realm = parseAuthRealm(wwwAuthenticate);
  const text = `${server ?? ''}\n${title ?? ''}\n${realm ?? ''}`;
  if (!text.trim()) return null;
  const hits = new Set<HttpFingerprintKind>();
  for (const [re, kind] of KEYWORD_KINDS) {
    if (re.test(text)) hits.add(kind);
  }
  return hits.size === 1 ? ([...hits][0] ?? null) : null;
}

/**
 * 批量探测：目标列表（调用方已做轮转切片）→ 并发 GET / → 分类。
 * 单个失败静默跳过；title 原文永远保留为 osHint 候补（哪怕未命中类别）。
 */
export async function discoverHttpFingerprints(
  targets: readonly HttpProbeTarget[],
  fetcher: HttpFetcher = defaultFetcher,
): Promise<HttpFingerprintHint[]> {
  if (targets.length === 0) return [];
  const slice = targets.slice(0, HTTP_PROBE_MAX_TARGETS);
  const out: HttpFingerprintHint[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      const t = slice[idx];
      if (!t) return;
      try {
        const res = await fetcher(t.ip, t.port);
        if (!res) continue;
        const title = parseHttpTitle(res.body);
        const realm = parseAuthRealm(res.wwwAuthenticate);
        const kind = classifyHttpFingerprint(res.server, title, res.wwwAuthenticate);
        // 自报文案优先级：页面 title > Server 头 > 401 realm（都有才是完整故事）
        const fallback = title ?? res.server ?? realm;
        const osHint = fallback !== null ? buildHttpOsHint(fallback, kind !== null) : null;
        if (kind === null && osHint === null) continue;
        out.push({ ip: t.ip, kind, osHint });
      } catch {
        /* 单个探测失败忽略（增强路径） */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HTTP_PROBE_CONCURRENCY, slice.length) }, () => worker()));
  return out;
}
