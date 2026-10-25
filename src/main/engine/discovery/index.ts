/**
 * discovery 门面：子网 / ping / arp / ports / oui / fingerprint 的统一出口，
 * 外加带缓存与限并发的反向 DNS（替代被禁用的 `ping -a`）。
 */
import dns from 'node:dns';
import { CONCURRENCY, TIMEOUTS } from '../../../shared/constants';

export * from './subnet';
export * from './ping';
export * from './arp';
export * from './ports';
export * from './oui';
export * from './fingerprint';

export interface ReverseDnsEntry {
  hostname: string | null;
  at: number;
}

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-_.]*[a-z0-9])?$/i;

/**
 * 反向 DNS 缓存：800ms 超时、并发 ≤8、命中缓存 ≥10 分钟、失败不重试（Vera §6.A.3）。
 * `ping -a` 单次 4.6s 已在扫描路径彻底移除。
 */
export class ReverseDnsCache {
  private cache = new Map<string, ReverseDnsEntry>();
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly timeoutMs = TIMEOUTS.dnsReverse,
    private readonly limit = CONCURRENCY.dnsReverse,
  ) {}

  get(ip: string): string | null {
    const hit = this.cache.get(ip);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) return null;
    return hit.hostname;
  }

  /** 已知缓存直接返回；否则发起反查（失败即 null 并写入负缓存，避免反复超时）。 */
  async lookup(ip: string): Promise<string | null> {
    const cached = this.cache.get(ip);
    if (cached && Date.now() - cached.at <= this.ttlMs) return cached.hostname;

    await this.acquire();
    try {
      const hostname = await this.reverse(ip);
      this.cache.set(ip, { hostname, at: Date.now() });
      return hostname;
    } finally {
      this.release();
    }
  }

  /** 批量反查（主机名只用于展示，失败不影响主流程）。 */
  async lookupMany(ips: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    await Promise.all(
      ips.map(async (ip) => {
        out.set(ip, await this.lookup(ip));
      }),
    );
    return out;
  }

  private reverse(ip: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const done = (value: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), this.timeoutMs);
      try {
        dns.reverse(ip, (err, hostnames) => {
          if (err || !hostnames || hostnames.length === 0) {
            done(null);
            return;
          }
          const name = hostnames[0]?.replace(/\.$/, '') ?? '';
          done(HOSTNAME_RE.test(name) && name.length > 0 ? name : null);
        });
      } catch {
        done(null);
      }
    });
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}
