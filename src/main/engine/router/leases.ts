import type { DhcpLease } from '../../../shared/types';

/** 只接受完整、分隔符一致的常见 MAC 写法。 */
export function normalizeLeaseMac(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const mac = value.trim();
  if (!/^(?:[\da-f]{12}|[\da-f]{2}(?::[\da-f]{2}){5}|[\da-f]{2}(?:-[\da-f]{2}){5}|[\da-f]{4}(?:\.[\da-f]{4}){2})$/i.test(mac)) {
    return null;
  }
  return mac.replace(/[:.-]/g, '').toLowerCase().match(/.{2}/g)!.join('-');
}

/** 仅清理设备自报名称，不推测、补造名称。 */
export function normalizeLeaseHostname(value: unknown): string | null {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  const hostname = value.trim();
  if (!hostname || hostname.length > 253 || /^(?:\*|-|--|unknown|\(unknown\)|n\/a|none)$/i.test(hostname)) return null;
  return hostname;
}

/** 过滤、复制、合并租约；同 MAC+IP 的名称冲突不能靠输入顺序裁决。 */
export function normalizeDhcpLeases(leases: readonly DhcpLease[], now = Date.now()): DhcpLease[] {
  const grouped = new Map<string, { lease: DhcpLease; conflict: boolean }>();
  for (const item of leases) {
    if (!item || typeof item.ip !== 'string') continue;
    const ip = item.ip.trim();
    if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip) || ip.split('.').some((part) => Number(part) > 255)) continue;
    const mac = normalizeLeaseMac(item.mac);
    const expiresAt = item.expiresAt;
    if (!mac || (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now))) continue;
    const hostname = normalizeLeaseHostname(item.hostname);
    const key = `${mac}/${ip}`;
    const previous = grouped.get(key);
    if (!previous) {
      grouped.set(key, { lease: { ip, mac, hostname, expiresAt }, conflict: false });
      continue;
    }
    const lease = previous.lease;
    if (hostname !== null && lease.hostname !== null && hostname !== lease.hostname) previous.conflict = true;
    lease.hostname = previous.conflict ? null : lease.hostname ?? hostname;
    // null 代表未知/无限；不能从另一条有限期限推导出它已经过期。
    lease.expiresAt = lease.expiresAt === null || expiresAt === null ? null : Math.max(lease.expiresAt, expiresAt);
  }
  const ipNumber = (ip: string): number => ip.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
  return [...grouped.values()].map(({ lease }) => lease).sort((a, b) =>
    ipNumber(a.ip) - ipNumber(b.ip) || (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0),
  ).slice(0, 512);
}
