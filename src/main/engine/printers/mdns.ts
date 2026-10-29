/**
 * mDNS 打印机发现（可选增强）。
 *
 * 组播 224.0.0.251:5353，查询 `_ipp._tcp.local` 与 `_pdl-datastream._tcp.local`，1.5s 超时。
 * **任何异常都静默吞掉并返回 []**：这是增强路径，绝不允许拖垮主流程（brief §3 printers/mdns.ts）。
 */
import { isUtf8 } from 'node:buffer';
import dgram from 'node:dgram';
import { TIMEOUTS } from '../../../shared/constants';

export interface MdnsPrinter {
  name: string;
  ip: string | null;
  port: number | null;
  service: string;
  model?: string | null;
}

export const MDNS_SERVICES = ['_ipp._tcp.local', '_pdl-datastream._tcp.local'] as const;
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

/** 编码 DNS 名称（label 长度前缀，无压缩）。 */
export function encodeDnsName(name: string): Buffer {
  const parts = name.split('.').filter((p) => p.length > 0);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const buf = Buffer.from(part, 'utf8');
    chunks.push(Buffer.from([buf.length]), buf);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/**
 * 构造一个 PTR 查询报文（QDCOUNT=1）。
 * `unicastResponse=true` 时把 QU 位置 1（QCLASS=0x8001），要求响应方单播回复——
 * 只有绑定 5353 失败、退回临时端口的兜底路径才需要。
 */
export function buildMdnsQuery(service: string, txId = 0, unicastResponse = false): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(txId, 0);
  header.writeUInt16BE(0x0000, 2); // flags: 标准查询
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const question = Buffer.concat([
    encodeDnsName(service),
    Buffer.from([0x00, 0x0c]), // QTYPE = PTR
    Buffer.from(unicastResponse ? [0x80, 0x01] : [0x00, 0x01]), // QCLASS = IN (+ QU)
  ]);
  return Buffer.concat([header, question]);
}

interface DnsRecord {
  name: string;
  type: number;
  data: Buffer;
  /** PTR 实例或 SRV 主机名：压缩指针必须在完整报文上解引用。 */
  target?: string;
  port?: number;
}

const MAX_DNS_RECORDS = 1024;
const MAX_CACHE_ENTRIES = 1024;

/** end 限制名称本体；指针跳转后才允许读取报文其它位置。畸形名称不返回部分结果。 */
function readName(buf: Buffer, offset: number, end = buf.length): { name: string; next: number } | null {
  const labels: string[] = [];
  const visited = new Set<number>();
  let cursor = offset;
  let limit = end;
  let next: number | null = null;
  let wireLength = 1; // 包含结尾的根标签，展开后最多 255 字节
  for (let steps = 0; steps < 128; steps += 1) {
    if (cursor >= limit || visited.has(cursor)) return null;
    visited.add(cursor);
    const len = buf[cursor]!;
    if (len === 0) return { name: labels.join('.'), next: next ?? cursor + 1 };
    if ((len & 0xc0) === 0xc0) {
      if (cursor + 2 > limit) return null;
      const ptr = ((len & 0x3f) << 8) | buf[cursor + 1]!;
      if (ptr < 12 || ptr >= buf.length) return null;
      next ??= cursor + 2;
      cursor = ptr;
      limit = buf.length;
      continue;
    }
    if ((len & 0xc0) !== 0 || cursor + 1 + len > limit) return null;
    wireLength += len + 1;
    if (wireLength > 255) return null;
    labels.push(buf.subarray(cursor + 1, cursor + 1 + len).toString('utf8'));
    cursor += 1 + len;
  }
  return null;
}

/** 解析响应中的有效 IN answer/authority/additional；结构截断时丢弃整包。 */
export function parseMdnsRecords(buf: Buffer): DnsRecord[] {
  const records: DnsRecord[] = [];
  if (buf.length < 12 || buf.length > 65535) return records;
  const flags = buf.readUInt16BE(2);
  if ((flags & 0x8000) === 0 || (flags & 0x780f) !== 0) return records;
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  if (qd + total > MAX_DNS_RECORDS) return records;
  let offset = 12;
  for (let i = 0; i < qd; i += 1) {
    const question = readName(buf, offset);
    if (!question || question.next + 4 > buf.length) return [];
    offset = question.next + 4;
  }
  for (let i = 0; i < total; i += 1) {
    const owner = readName(buf, offset);
    if (!owner || owner.next + 10 > buf.length) return [];
    offset = owner.next;
    const type = buf.readUInt16BE(offset);
    const klass = buf.readUInt16BE(offset + 2) & 0x7fff; // cache-flush 位不是 class
    const ttl = buf.readUInt32BE(offset + 4);
    const rdLength = buf.readUInt16BE(offset + 8);
    const start = offset + 10;
    const end = start + rdLength;
    if (end > buf.length) return [];
    offset = end;
    if (klass !== 1 || ttl === 0) continue;
    const rec: DnsRecord = { name: owner.name, type, data: buf.subarray(start, end) };
    if (type === 12 || type === 33) {
      if (type === 33 && rdLength < 7) continue;
      const target = readName(buf, start + (type === 33 ? 6 : 0), end);
      if (!target || !target.name || target.next !== end) continue;
      rec.target = target.name;
      if (type === 33) rec.port = buf.readUInt16BE(start + 4);
    } else if (type === 1 && rdLength !== 4) {
      continue;
    }
    records.push(rec);
  }
  return records;
}

/**
 * 发现局域网内的 IPP / RAW 打印机。
 * 返回去重后的 `{name, ip, port, service}`；无响应返回 []。
 */
export async function discoverMdnsPrinters(timeoutMs = TIMEOUTS.mdns): Promise<MdnsPrinter[]> {
  return mdnsQuery([...MDNS_SERVICES], timeoutMs);
}

/** mDNS 命中（PTR 实例 + SRV 端口 + A 地址尽力解析 + TXT 自报型号）。 */
export interface MdnsHit {
  name: string;
  ip: string | null;
  port: number | null;
  service: string;
  /** TXT 自报型号（`model=` / `md=` / `ty=`），没有则 null。 */
  model?: string | null;
}

/** 标准 DNS TXT 长度前缀字节串：model > md > ty，最后一个同名键生效。 */
export function parseTxtModel(data: Buffer): string | null {
  const values: Partial<Record<'model' | 'md' | 'ty', string | null>> = {};
  let offset = 0;
  while (offset < data.length) {
    const length = data[offset]!;
    offset += 1;
    if (offset + length > data.length) return null;
    const bytes = data.subarray(offset, offset + length);
    offset += length;
    const eq = bytes.indexOf(0x3d);
    if (eq <= 0) continue;
    const key = bytes.subarray(0, eq).toString('utf8').trim().toLowerCase();
    if (key !== 'model' && key !== 'md' && key !== 'ty') continue;
    const value = bytes.subarray(eq + 1);
    values[key] = isUtf8(value) ? value.toString('utf8').trim() || null : null;
  }
  return values.model ?? values.md ?? values.ty ?? null;
}

/**
 * 通用 mDNS 查询（task-020 从 discoverMdnsPrinters 抽出）：对一组服务发 PTR 查询，
 * 聚合响应里的 PTR / SRV / A / TXT 记录。任何异常静默返回 []（增强路径，不拖垮主流程）。
 *
 * task-028 修复（实测本机只在绑定 5353 并加入组播组后才能收到局域网应答）：
 *  - 优先 bind(5353, reuseAddr) + addMembership(224.0.0.251)：不加入组播组时，
 *    内核根本不会把 224.0.0.251:5353 的应答递交给本 socket；
 *  - 5353 被占用/绑定失败时退回临时端口，并把查询 QCLASS 的 QU 位置 1，
 *    让响应方单播回来（老实现只有这一条路，且没有 QU 位，基本收不到包）；
 *  - 查询在窗口内重发一次，抵消 UDP 丢包与设备延迟应答。
 */
export async function mdnsQuery(services: readonly string[], timeoutMs: number = TIMEOUTS.mdns): Promise<MdnsHit[]> {
  if (services.length === 0) return [];
  const normalize = (name: string): string => name.replace(/\.$/, '').toLowerCase();
  const requested = new Set(services.map(normalize));
  const requestedServices = [...requested];
  // 本次窗口内按实例保存 PTR/SRV/TXT；即使容量已满，旧实例仍能补齐首个型号。
  const instances = new Map<string, {
    name: string;
    service: string;
    hasPtr: boolean;
    target: string | null;
    port: number | null;
    model: string | null;
  }>();
  const addresses = new Map<string, string>();
  const isRequestedInstance = (name: string, service: string): boolean =>
    name.endsWith(`.${service}`) && name.length > service.length + 1;
  try {
    await new Promise<void>((resolve) => {
      let socket: dgram.Socket;
      try {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      } catch {
        resolve();
        return;
      }
      let closed = false;
      let sent = false;
      let retry: NodeJS.Timeout | null = null;
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (retry) clearTimeout(retry);
        try {
          socket.close();
        } catch {
          /* 已关闭 */
        }
        resolve();
      };

      const timer = setTimeout(close, timeoutMs);

      socket.on('message', (msg) => {
        if (closed) return;
        try {
          for (const rec of parseMdnsRecords(msg)) {
            const owner = normalize(rec.name);
            if (rec.type === 1) {
              // A 可以早于 SRV 到达，但绝不使用 UDP 来源地址代替 SRV target。
              if (addresses.has(owner) || addresses.size < MAX_CACHE_ENTRIES) {
                addresses.set(owner, Array.from(rec.data).join('.'));
              }
              continue;
            }
            if (rec.type !== 12 && rec.type !== 33 && rec.type !== 16) continue;
            const service = rec.type === 12
              ? (requested.has(owner) ? owner : undefined)
              : requestedServices.find((s) => isRequestedInstance(owner, s));
            const rawInstance = rec.type === 12 ? rec.target : rec.name;
            if (!service || !rawInstance) continue;
            const instance = normalize(rawInstance);
            if (!isRequestedInstance(instance, service)) continue;
            const model = rec.type === 16 ? parseTxtModel(rec.data) : null;
            if (rec.type === 16 && model === null) continue;
            const key = `${service}\0${instance}`;
            let entry = instances.get(key);
            if (!entry) {
              if (instances.size >= MAX_CACHE_ENTRIES) continue;
              entry = {
                name: rawInstance.slice(0, -(service.length + 1)), service,
                hasPtr: false, target: null, port: null, model: null,
              };
              instances.set(key, entry);
            }
            if (rec.type === 12) {
              entry.hasPtr = true;
              entry.name = rawInstance.slice(0, -(service.length + 1));
            } else if (rec.type === 33 && rec.target && rec.port !== undefined) {
              entry.target = normalize(rec.target);
              entry.port = rec.port;
            } else if (rec.type === 16) {
              entry.model = model;
            }
          }
        } catch {
          /* 单包解析失败忽略 */
        }
      });

      /** 发一轮查询；multicastOk=false 时用 QU 位请对方单播回复。 */
      const sendAll = (multicastOk: boolean): void => {
        if (closed) return;
        for (const service of services) {
          socket.send(buildMdnsQuery(service, 0, !multicastOk), MDNS_PORT, MDNS_ADDR, (err) => {
            if (err && !multicastOk) close();
          });
        }
        sent = true;
      };

      socket.on('error', () => {
        // bind 5353 失败（被 Bonjour/其它守护进程独占）→ 换临时端口 + QU 查询
        if (!sent) {
          try {
            socket.bind(0, () => sendAll(false));
            return;
          } catch {
            /* 落到 close */
          }
        }
        close();
      });

      // 先绑 5353 再入组：顺序反了会 EADDRINUSE（Windows）
      try {
        socket.bind(MDNS_PORT, () => {
          let multicastOk = false;
          try {
            socket.addMembership(MDNS_ADDR);
            try {
              socket.setMulticastTTL(255);
            } catch {
              /* 部分平台不支持，忽略 */
            }
            multicastOk = true;
          } catch {
            /* 无可用网卡/不支持组播：仍尝试组播发送，多半收不到 */
          }
          sendAll(multicastOk);
          if (timeoutMs >= 800) {
            retry = setTimeout(() => sendAll(multicastOk), Math.min(500, Math.floor(timeoutMs / 2)));
          }
        });
      } catch {
        close();
      }
    });
  } catch {
    return [];
  }
  // 窗口结束才关联快照，PTR 重传或后到 A/TXT 不会产生旧的、不完整的重复命中。
  return Array.from(instances.values())
    .filter((entry) => entry.hasPtr)
    .map(({ name, service, target, port, model }) => ({
      name, service, port, model,
      ip: target ? addresses.get(target) ?? null : null,
    }));
}
