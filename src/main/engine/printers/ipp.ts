/**
 * IPP Get-Printer-Attributes（opt-in 耗材通路，P2）。
 * 实测本机 .235 回 0x0400、.170 回 0x0406/0x0503（investigation-report §8），拿不到 marker-*；
 * 保留为可选 provider，供支持 IPP 的现场机型使用。
 *
 * 铁律：statusCode!==0x0000 立即放弃（不重试/不换路径重试）；marker-levels 负值
 * （RFC 8010: -1 unknown / -2 capacity-known / -3 remaining-unknown）→ levelPct=null，
 * 绝不 clamp 成 0；任何异常返回 null，绝不上抛。
 */
import http from 'node:http';
import type { Consumable } from '../../../shared/types';
import { inferSupplyKind } from './printer-mib';

export const IPP_PATHS = ['/ipp/print', '/ipp'] as const;
const REQUESTED = [
  'marker-levels', 'marker-names', 'marker-colors', 'printer-state',
  'printer-state-reasons', 'queued-job-count', 'printer-make-and-model',
];

export interface IppAttribute { name: string; tag: number; values: (string | number)[] }
export interface IppResult { statusCode: number; path: string; attrs: Map<string, IppAttribute> }

/** RFC 8010：tag | nameLen(2) | name | valueLen(2) | value */
function attr(tag: number, name: string, value: string): Buffer {
  const n = Buffer.from(name, 'utf8');
  const v = Buffer.from(value, 'utf8');
  const head = Buffer.alloc(3);
  head[0] = tag;
  head.writeUInt16BE(n.length, 1);
  const vlen = Buffer.alloc(2);
  vlen.writeUInt16BE(v.length, 0);
  return Buffer.concat([head, n, vlen, v]);
}

/** IPP 2.0 / operation 0x0009；requested-attributes 首条带名，其余重复值 nameLen=0。 */
export function buildGetPrinterAttributesRequest(ip: string, path: string, requestId = 1): Buffer {
  const header = Buffer.from([0x02, 0x00, 0x00, 0x09, 0, 0, 0, 0]);
  header.writeUInt32BE(requestId >>> 0, 4);
  const parts: Buffer[] = [Buffer.from([0x01])];
  parts.push(attr(0x47, 'attributes-charset', 'utf-8'));
  parts.push(attr(0x48, 'attributes-natural-language', 'en'));
  parts.push(attr(0x45, 'printer-uri', `ipp://${ip}:631${path}`));
  REQUESTED.forEach((name, i) => parts.push(attr(0x44, i === 0 ? 'requested-attributes' : '', name)));
  parts.push(Buffer.from([0x03]));
  return Buffer.concat([header, ...parts]);
}

/** delimiter(0x01-0x05) 无长度域；多值属性后续条 nameLen=0 → 继承上一个名字。 */
export function parseIppResponse(buf: Buffer): { statusCode: number; attrs: Map<string, IppAttribute> } {
  if (buf.length < 8) throw new RangeError('ipp: 报文过短');
  const statusCode = buf.readUInt16BE(2);
  const attrs = new Map<string, IppAttribute>();
  let off = 8;
  let lastName = '';
  while (off < buf.length) {
    const tag = buf[off] as number;
    if (tag === 0x03) break;
    if (tag >= 0x01 && tag <= 0x05) { off += 1; continue; }
    if (off + 5 > buf.length) throw new RangeError('ipp: 属性头截断');
    const nameLen = buf.readUInt16BE(off + 1);
    const valueLen = buf.readUInt16BE(off + 3 + nameLen);
    const valueStart = off + 5 + nameLen;
    if (valueStart + valueLen > buf.length) throw new RangeError('ipp: 值长度越界');
    if (nameLen > 0) lastName = buf.subarray(off + 3, off + 3 + nameLen).toString('utf8');
    const raw = buf.subarray(valueStart, valueStart + valueLen);
    off = valueStart + valueLen;
    if (!lastName) continue;
    let value: string | number;
    if (tag === 0x33) value = raw.length >= 8 ? raw.readInt32BE(0) : 0; // resolution：只取 x
    else if (tag === 0x21 || tag === 0x23) value = raw.length >= 4 ? raw.readInt32BE(0) : 0; // integer / enum
    else if (tag === 0x22) value = raw.length >= 1 ? raw.readInt8(0) : 0;
    else value = raw.toString('utf8'); // text / name / keyword / uri / charset / language
    const entry = attrs.get(lastName) ?? { name: lastName, tag, values: [] };
    entry.values.push(value);
    attrs.set(lastName, entry);
  }
  return { statusCode, attrs };
}

function post(ip: string, path: string, body: Buffer, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Buffer | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const req = http.request(
      {
        host: ip, port: 631, path, method: 'POST',
        headers: {
          'Content-Type': 'application/ipp',
          'Content-Length': String(body.length),
          Connection: 'close',
        },
      },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); finish(null); return; }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => finish(Buffer.concat(chunks)));
        res.on('error', () => finish(null));
      },
    );
    const timer = setTimeout(() => { req.destroy(); finish(null); }, timeoutMs);
    req.on('error', () => finish(null));
    req.end(body);
  });
}

/** 只试 2 个固定路径；HTTP 404/连接失败才换下一个；statusCode 非 0 立即放弃。 */
export async function ippGetAttributes(
  ip: string,
  opts: { timeoutMs?: number; requestId?: number } = {},
): Promise<IppResult | null> {
  for (const path of IPP_PATHS) {
    const body = buildGetPrinterAttributesRequest(ip, path, opts.requestId ?? 1);
    const res = await post(ip, path, body, opts.timeoutMs ?? 2500);
    if (!res) continue;
    try {
      const parsed = parseIppResponse(res);
      if (parsed.statusCode !== 0x0000) return null;
      return { statusCode: parsed.statusCode, path, attrs: parsed.attrs };
    } catch {
      return null;
    }
  }
  return null;
}

/** marker-* → Consumable[]。负值 level 视为未知（levelPct=null），不编造 0%。 */
export function toConsumables(result: IppResult): Consumable[] {
  const levels = result.attrs.get('marker-levels')?.values ?? [];
  const names = result.attrs.get('marker-names')?.values ?? [];
  const colors = result.attrs.get('marker-colors')?.values ?? [];
  return levels.map((level, i) => {
    const label = String(names[i] ?? colors[i] ?? `Marker ${i + 1}`);
    const numeric = typeof level === 'number' ? level : Number.NaN;
    return {
      kind: inferSupplyKind(`${label} ${String(colors[i] ?? '')}`),
      label,
      levelPct: Number.isFinite(numeric) && numeric >= 0 ? Math.min(100, Math.round(numeric)) : null,
      maxCapacity: 100,
      current: Number.isFinite(numeric) ? numeric : null,
      source: 'ipp',
    };
  });
}
