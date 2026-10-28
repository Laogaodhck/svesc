/** IPP 查询：有界读取；协议错误不换路径；未知耗材余量不伪造为 0。 */
import http from 'node:http';
import type { Consumable, PrinterState } from '../../../shared/types';
import { inferSupplyKind } from './printer-mib';

export const IPP_PATHS = ['/ipp/print', '/ipp'] as const;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ATTRIBUTE_VALUES = 16384;
const MAX_DETAIL_CHARS = 256;
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

/** IPP 2.0 / operation 0x0009；requested-attributes 后续值使用空名称。 */
export function buildGetPrinterAttributesRequest(ip: string, path: string, requestId = 1, port = 631): Buffer {
  const header = Buffer.from([0x02, 0x00, 0x00, 0x09, 0, 0, 0, 0]);
  header.writeUInt32BE(requestId >>> 0, 4);
  const parts: Buffer[] = [Buffer.from([0x01])];
  parts.push(attr(0x47, 'attributes-charset', 'utf-8'));
  parts.push(attr(0x48, 'attributes-natural-language', 'en'));
  const host = ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
  parts.push(attr(0x45, 'printer-uri', `ipp://${host}:${port}${path}`));
  REQUESTED.forEach((name, i) => parts.push(attr(0x44, i === 0 ? 'requested-attributes' : '', name)));
  parts.push(Buffer.from([0x03]));
  return Buffer.concat([header, ...parts]);
}

function decodeValue(tag: number, raw: Buffer): string | number {
  const length = tag === 0x21 || tag === 0x23 ? 4
    : tag === 0x22 ? 1 : tag === 0x33 ? 9 : tag === 0x32 ? 8 : tag === 0x31 ? 11
      : tag >= 0x10 && tag <= 0x1f ? 0 : undefined;
  if (length !== undefined && raw.length !== length) throw new RangeError('ipp: 属性值长度错误');
  if (tag === 0x21 || tag === 0x23 || tag === 0x33) return raw.readInt32BE(0);
  if (tag === 0x22) {
    if (raw[0] !== 0 && raw[0] !== 1) throw new RangeError('ipp: 布尔值错误');
    return raw[0];
  }
  return raw.toString('utf8');
}

/** 只解析有界属性响应；空名称仅继承当前组内的上一属性。 */
export function parseIppResponse(buf: Buffer): {
  statusCode: number; requestId: number; attrs: Map<string, IppAttribute>;
} {
  if (buf.length < 9 || buf.length > MAX_RESPONSE_BYTES) throw new RangeError('ipp: 报文长度错误');
  if (!((buf[0] === 1 && buf[1] <= 1) || (buf[0] === 2 && buf[1] <= 2))) {
    throw new RangeError('ipp: 不支持的版本');
  }
  const statusCode = buf.readUInt16BE(2);
  const requestId = buf.readInt32BE(4);
  if (requestId <= 0) throw new RangeError('ipp: requestId 错误');
  const attrs = new Map<string, IppAttribute>();
  let off = 8;
  let inGroup = false;
  let previous: IppAttribute | undefined;
  let count = 0;
  while (off < buf.length) {
    const tag = buf.readUInt8(off++);
    if (tag === 0x03) {
      if (off !== buf.length) throw new RangeError('ipp: 属性结束后有多余数据');
      return { statusCode, requestId, attrs };
    }
    if (tag >= 0x01 && tag <= 0x0a) {
      inGroup = true;
      previous = undefined;
      continue;
    }
    // 本通路只请求标量属性，不将 collection/扩展 tag 误解为普通字符串。
    if (!inGroup || tag < 0x10 || tag >= 0x7f || tag === 0x34 || tag === 0x37 || tag === 0x4a) {
      throw new RangeError('ipp: 属性 tag 错误或不支持');
    }
    if (++count > MAX_ATTRIBUTE_VALUES) throw new RangeError('ipp: 属性数量超限');
    if (off + 2 > buf.length) throw new RangeError('ipp: 名称长度截断');
    const nameLen = buf.readUInt16BE(off);
    off += 2;
    if (off + nameLen + 2 > buf.length) throw new RangeError('ipp: 名称或值长度截断');
    const name = buf.subarray(off, off + nameLen).toString('utf8');
    off += nameLen;
    const valueLen = buf.readUInt16BE(off);
    off += 2;
    if (off + valueLen > buf.length) throw new RangeError('ipp: 值长度越界');
    const value = decodeValue(tag, buf.subarray(off, off + valueLen));
    off += valueLen;
    if (nameLen > 0) {
      previous = attrs.get(name) ?? { name, tag, values: [] };
      attrs.set(name, previous);
    }
    if (!previous || previous.tag !== tag) throw new RangeError('ipp: 多值属性名称或类型错误');
    previous.values.push(value);
  }
  throw new RangeError('ipp: 缺少属性结束 tag');
}

function post(
  ip: string, port: number, path: string, body: Buffer, timeoutMs: number,
): Promise<{ body: Buffer | null; retry: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    let req: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (body: Buffer | null, retry = false): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chunks.length = 0;
      response?.destroy();
      req?.destroy();
      resolve({ body, retry });
    };
    const timer = setTimeout(() => finish(null, true), timeoutMs);
    try {
      req = http.request(
        {
          host: ip, port, path, method: 'POST',
          headers: {
            'Content-Type': 'application/ipp',
            'Content-Length': String(body.length),
            Connection: 'close',
          },
        },
        (res) => {
          response = res;
          res.on('error', () => finish(null, true));
          res.on('aborted', () => finish(null, true));
          res.on('close', () => { if (!res.complete) finish(null, true); });
          if (done) { res.destroy(); return; }
          if (res.statusCode !== 200) { finish(null, res.statusCode === 404); return; }
          const contentLength = res.headers['content-length'];
          if (contentLength !== undefined && Number(contentLength) > MAX_RESPONSE_BYTES) {
            finish(null);
            return;
          }
          res.on('data', (chunk: Buffer) => {
            if (done) return;
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) { finish(null); return; }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (!done) finish(res.complete ? Buffer.concat(chunks, size) : null);
          });
        },
      );
      req.on('error', () => finish(null, true));
      req.end(body);
    } catch {
      finish(null);
    }
  });
}

function isSuccessfulStatus(statusCode: number): boolean {
  return statusCode === 0x0000 || statusCode === 0x0001 || statusCode === 0x0002;
}

/** 只试两个固定路径；仅 HTTP 404/传输失败换路径，协议错误立即放弃。 */
export async function ippGetAttributes(
  ip: string,
  opts: { timeoutMs?: number; requestId?: number; port?: number } = {},
): Promise<IppResult | null> {
  const { requestId = 1, port = 631, timeoutMs = 2500 } = opts;
  if (!Number.isInteger(requestId) || requestId <= 0 || requestId > 0x7fffffff
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) return null;
  try {
    for (const path of IPP_PATHS) {
      const body = buildGetPrinterAttributesRequest(ip, path, requestId, port);
      const res = await post(ip, port, path, body, timeoutMs);
      if (!res.body) {
        if (res.retry) continue;
        return null;
      }
      const parsed = parseIppResponse(res.body);
      if (parsed.requestId !== requestId || !isSuccessfulStatus(parsed.statusCode)) return null;
      return { statusCode: parsed.statusCode, path, attrs: parsed.attrs };
    }
  } catch {
    return null;
  }
  return null;
}

const ERROR_REASONS = new Set([
  'media-empty', 'media-needed', 'media-jam', 'toner-empty', 'ink-empty', 'marker-supply-empty',
  'door-open', 'cover-open', 'interlock-open', 'paused', 'shutdown',
]);
const WARNING_REASONS = new Set([
  'media-low', 'toner-low', 'ink-low', 'marker-supply-low', 'moving-to-paused',
]);

/** 状态与原因合并：error > warning > 设备原始状态；报告性原因不制造故障。 */
export function toPrinterState(result: IppResult): { state: PrinterState; detail: string | null } {
  if (!isSuccessfulStatus(result.statusCode)) return { state: 'unknown', detail: null };
  const rawState = result.attrs.get('printer-state')?.values[0];
  let state: PrinterState = rawState === 3 ? 'idle' : rawState === 4 ? 'printing'
    : rawState === 5 ? 'error' : 'unknown';
  const reasons: { text: string; severity: number }[] = [];
  for (const value of result.attrs.get('printer-state-reasons')?.values ?? []) {
    if (typeof value !== 'string') continue;
    const text = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    const reason = text.toLowerCase();
    if (!reason || reason === 'none') continue;
    const severity = reason.endsWith('-error') ? 2 : reason.endsWith('-warning') ? 1
      : reason.endsWith('-report') ? 0 : ERROR_REASONS.has(reason) ? 2 : WARNING_REASONS.has(reason) ? 1 : 0;
    if (severity === 2) state = 'error';
    else if (severity === 1 && state !== 'error') state = 'warning';
    reasons.push({ text, severity });
  }
  const detail = reasons.sort((a, b) => b.severity - a.severity).map((reason) => reason.text).join('; ');
  return {
    state,
    detail: !detail ? null : detail.length <= MAX_DETAIL_CHARS ? detail : `${detail.slice(0, MAX_DETAIL_CHARS - 1)}…`,
  };
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
