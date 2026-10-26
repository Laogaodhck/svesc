/**
 * mDNS 打印机发现（可选增强）。
 *
 * 组播 224.0.0.251:5353，查询 `_ipp._tcp.local` 与 `_pdl-datastream._tcp.local`，1.5s 超时。
 * **任何异常都静默吞掉并返回 []**：这是增强路径，绝不允许拖垮主流程（brief §3 printers/mdns.ts）。
 */
import dgram from 'node:dgram';
import { TIMEOUTS } from '../../../shared/constants';

export interface MdnsPrinter {
  name: string;
  ip: string | null;
  port: number | null;
  service: string;
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
}

/** 读取带压缩指针的 DNS 名称。 */
function readName(buf: Buffer, offset: number, depth = 0): { name: string; next: number } {
  if (depth > 8) return { name: '', next: offset + 1 };
  const labels: string[] = [];
  let cursor = offset;
  let advanced = false;
  let next = offset;
  for (;;) {
    if (cursor >= buf.length) return { name: labels.join('.'), next };
    const len = buf[cursor] as number;
    if (len === 0) {
      cursor += 1;
      if (!advanced) next = cursor;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | (buf[cursor + 1] as number);
      if (!advanced) next = cursor + 2;
      const sub = readName(buf, ptr, depth + 1);
      if (sub.name) labels.push(sub.name);
      break;
    }
    const label = buf.subarray(cursor + 1, cursor + 1 + len).toString('utf8');
    labels.push(label);
    cursor += 1 + len;
    if (!advanced) next = cursor;
  }
  return { name: labels.join('.'), next };
}

/** 解析 DNS/mDNS 报文中的 answer/authority/additional 记录（失败返回 []）。 */
export function parseMdnsRecords(buf: Buffer): DnsRecord[] {
  const records: DnsRecord[] = [];
  if (buf.length < 12) return records;
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8);
  const ar = buf.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < qd; i += 1) {
    const { next } = readName(buf, offset);
    offset = next + 4;
  }
  const total = an + ns + ar;
  for (let i = 0; i < total; i += 1) {
    const { name, next } = readName(buf, offset);
    offset = next;
    if (offset + 10 > buf.length) break;
    const type = buf.readUInt16BE(offset);
    const rdLength = buf.readUInt16BE(offset + 8);
    const rdataStart = offset + 10;
    const rdataEnd = rdataStart + rdLength;
    if (rdataEnd > buf.length) break;
    records.push({ name, type, data: buf.subarray(rdataStart, rdataEnd) });
    offset = rdataEnd;
  }
  return records;
}

/**
 * 发现局域网内的 IPP / RAW 打印机。
 * 返回去重后的 `{name, ip, port, service}`；无响应返回 []。
 */
export async function discoverMdnsPrinters(timeoutMs = TIMEOUTS.mdns): Promise<MdnsPrinter[]> {
  const hits = await mdnsQuery([...MDNS_SERVICES], timeoutMs);
  return hits.map((h) => ({ name: h.name, ip: h.ip, port: h.port, service: h.service }));
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

/** 从 TXT 记录里取设备自报型号（纯函数）：model > md > ty，最后一个同名键生效。 */
export function parseTxtModel(data: Buffer): string | null {
  if (data.length === 0) return null;
  const fields = data.toString('utf8').split('|');
  let model: string | null = null;
  for (const field of fields) {
    const eq = field.indexOf('=');
    if (eq <= 0) continue;
    const key = field.slice(0, eq).trim().toLowerCase();
    if (key !== 'model' && key !== 'md' && key !== 'ty') continue;
    const value = field.slice(eq + 1).trim();
    if (value) model = value;
  }
  return model;
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
  const found = new Map<string, MdnsHit>();
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
        try {
          const records = parseMdnsRecords(msg);
          const ipByName = new Map<string, string>();
          for (const rec of records) {
            if (rec.type === 1 && rec.data.length === 4) {
              ipByName.set(rec.name.toLowerCase(), Array.from(rec.data).join('.'));
            }
          }
          for (const rec of records) {
            if (rec.type !== 12) continue; // PTR only
            const instance = readName(rec.data, 0).name;
            if (!instance) continue;
            const service = rec.name.replace(/\.$/, '');
            const srv = records.find((r) => r.type === 33 && r.name.toLowerCase() === instance.toLowerCase());
            const target = srv ? readName(srv.data, 6).name : '';
            const port = srv && srv.data.length >= 6 ? srv.data.readUInt16BE(4) : null;
            const ip = ipByName.get(target.toLowerCase()) ?? null;
            const txt = records.find((r) => r.type === 16 && r.name.toLowerCase() === instance.toLowerCase());
            const model = txt ? parseTxtModel(txt.data) : null;
            const friendly = instance.replace(new RegExp(`\\.${service.replace(/\./g, '\\.')}$`, 'i'), '');
            const key = `${friendly}|${ip ?? ''}|${service}`;
            if (!found.has(key)) found.set(key, { name: friendly, ip, port, service, model });
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
  return Array.from(found.values());
}
