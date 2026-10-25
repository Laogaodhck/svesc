/**
 * HTTP 管理页指纹探测（品牌识别）。
 * FINGERPRINTS 与 matchFingerprint 为纯函数，测试直接覆盖。
 */
import { ROUTER } from '../../../shared/constants';
import { httpRequest } from './httpx';
import type { RouterBrand } from '../../../shared/types';

export interface FingerprintRule {
  brand: Exclude<RouterBrand, null>;
  /** 命中关键词（对 Server 头与页面正文做大小写不敏感匹配） */
  keywords: string[];
}

export const FINGERPRINTS: readonly FingerprintRule[] = [
  { brand: 'openwrt', keywords: ['openwrt', 'luci', 'lede'] },
  { brand: 'tplink', keywords: ['tp-link', 'tplink'] },
  { brand: 'xiaomi', keywords: ['miwifi', 'xiaomi', '小米路由'] },
  { brand: 'asus', keywords: ['asus', 'asusrouter'] },
  { brand: 'huawei', keywords: ['huawei', 'hg8145', 'hg5', 'tc7102'] },
  { brand: 'netgear', keywords: ['netgear'] },
] as const;

/** 指纹匹配（纯函数）：Server 头 + <title> + 正文前 8KB。未命中返回 null（不猜 generic）。 */
export function matchFingerprint(serverHeader: string | null, body: string): { brand: RouterBrand; hint: string | null } {
  const title = body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '';
  const haystacks = [serverHeader ?? '', title, body.slice(0, 8192)];
  for (const rule of FINGERPRINTS) {
    for (const kw of rule.keywords) {
      const hit = haystacks.some((h) => h.toLowerCase().includes(kw.toLowerCase()));
      if (hit) {
        // Server 头优先（固件名直给），标题兜底
        const hint = serverHeader?.trim() || title.trim() || null;
        return { brand: rule.brand, hint };
      }
    }
  }
  return { brand: null, hint: null };
}

export interface PageProbeResult {
  reachable: boolean;
  brand: RouterBrand;
  hint: string | null;
  error: string | null;
  /** 最终可达的管理页 URL（含重定向落点），供内置浏览器直接打开；不可达为 null */
  url: string | null;
}

/** 依次探测 ROUTER.pagePorts 里的管理页端口，首个可达的为准（跟随最多 2 次 30x 重定向）。 */
export async function detectManagementPage(ip: string, timeoutMs = ROUTER.pageProbeTimeoutMs): Promise<PageProbeResult> {
  let lastError: string | null = null;
  for (const port of ROUTER.pagePorts) {
    const scheme = port === 443 ? 'https' : 'http';
    let url = `${scheme}://${ip}/`;
    // 最多跟 2 跳：家用路由器普遍 302 → /login 或 → https
    for (let hop = 0; hop < 3; hop += 1) {
      const u = new URL(url);
      const effectivePort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      const res = await httpRequest(url, { port: effectivePort, path: u.pathname + u.search, timeoutMs });
      if (res.error) {
        lastError = res.error;
        break;
      }
      const status = res.status;
      if (status === null || status !== 200) {
        lastError = `HTTP ${status ?? 'no-response'}`;
        if (status !== null && status >= 300 && status < 400 && hop < 2) {
          const locRaw = res.headers['location'];
          const loc = Array.isArray(locRaw) ? locRaw[0] : locRaw;
          if (loc) {
            try {
              url = new URL(loc, url).toString();
              continue; // 跟随重定向
            } catch {
              /* Location 非法，按失败处理 */
            }
          }
        }
        break;
      }
      const server = Array.isArray(res.headers['server']) ? res.headers['server'][0] : res.headers['server'];
      const { brand, hint } = matchFingerprint(server ?? null, res.body);
      return { reachable: true, brand: brand ?? 'generic', hint, error: null, url };
    }
  }
  return { reachable: false, brand: null, hint: null, error: lastError, url: null };
}
