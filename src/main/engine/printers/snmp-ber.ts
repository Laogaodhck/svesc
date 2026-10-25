/**
 * 手写 BER 编解码（SNMP 用子集）—— 零原生依赖、零三方库。
 *
 * 为什么手写：net-snmp 需编译原生模块，node-gyp 在中文 Windows + 企业网络下失败率高；
 * 而 SNMPv2c 只需要 BER 的一个极小子集（INTEGER / OCTET STRING / NULL / OID /
 * SEQUENCE / 上下文标签 PDU），百余行即可闭合，且完全可被 Vitest 用构造字节验证。
 *
 * 支持：SNMPv2c GET (0xA0) / GETNEXT (0xA1)、GetResponse (0xA2) 解析。
 * 不支持：多字节 tag、不定长（indefinite）长度、SNMPv3 加密。
 *
 * 全部函数为纯函数，可直接单测。
 */

export interface Tlv {
  tag: number;
  /** 内容长度（不含 tag/len 头） */
  length: number;
  /** 内容起始偏移（即 buf 中 header 之后） */
  valueOffset: number;
  /** 整个 TLV 起始偏移 */
  start: number;
  headerLength: number;
  /** 整个 TLV 总长 */
  totalLength: number;
  value: Buffer;
}

export const TAG = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
  IP_ADDRESS: 0x40,
  COUNTER32: 0x41,
  GAUGE32: 0x42,
  TIMETICKS: 0x43,
  OPAQUE: 0x44,
  COUNTER64: 0x46,
  GET_REQUEST: 0xa0,
  GET_NEXT_REQUEST: 0xa1,
  GET_RESPONSE: 0xa2,
} as const;

/** BER 长度域编码（短格式 <128，长格式 0x80|n + n 字节大端）。 */
export function encodeLength(len: number): Buffer {
  if (!Number.isInteger(len) || len < 0) throw new RangeError(`encodeLength: 非法长度 ${len}`);
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let rest = len;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** BER 长度域解码；不定长（0x80）与截断一律抛错（调用方必须 catch）。 */
export function decodeLength(buf: Buffer, offset: number): { length: number; bytes: number } {
  if (offset >= buf.length) throw new RangeError('decodeLength: 偏移越界');
  const first = buf[offset] as number;
  if ((first & 0x80) === 0) return { length: first, bytes: 1 };
  const count = first & 0x7f;
  if (count === 0) throw new RangeError('decodeLength: 不支持不定长编码');
  if (count > 4) throw new RangeError(`decodeLength: 长度域过长 (${count})`);
  if (offset + 1 + count > buf.length) throw new RangeError('decodeLength: 长度域被截断');
  let length = 0;
  for (let i = 0; i < count; i += 1) length = length * 256 + (buf[offset + 1 + i] as number);
  return { length, bytes: 1 + count };
}

/** 组合 TLV。 */
export function encodeTlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

export function encodeSequence(items: Buffer[]): Buffer {
  return encodeTlv(TAG.SEQUENCE, Buffer.concat(items));
}

/** INTEGER：最小长度二进制补码（SNMP request-id / error-status 用）。 */
export function encodeInteger(value: number): Buffer {
  if (!Number.isInteger(value)) throw new RangeError(`encodeInteger: 非整数 ${value}`);
  const bytes: number[] = [];
  let v = value;
  if (v >= 0) {
    do {
      bytes.unshift(v & 0xff);
      v = Math.floor(v / 256);
    } while (v > 0);
    if (((bytes[0] as number) & 0x80) !== 0) bytes.unshift(0x00);
  } else {
    let v2 = value;
    do {
      bytes.unshift(v2 & 0xff);
      v2 = Math.floor(v2 / 256);
    } while (v2 < -1);
    if (((bytes[0] as number) & 0x80) === 0) bytes.unshift(0xff);
  }
  return encodeTlv(TAG.INTEGER, Buffer.from(bytes));
}

export function encodeOctetString(value: string | Buffer): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return encodeTlv(TAG.OCTET_STRING, body);
}

export function encodeNull(): Buffer {
  return Buffer.from([TAG.NULL, 0x00]);
}

/** OID 编码：首两段合并为 40*a+b，其后每段 base-128 变长。 */
export function encodeOid(oid: string): Buffer {
  const parts = oid
    .replace(/^\./, '')
    .split('.')
    .map((p) => Number(p));
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new RangeError(`encodeOid: 非法 OID ${oid}`);
  }
  const first = (parts[0] as number) * 40 + (parts[1] as number);
  const arcs = [first, ...parts.slice(2)];
  const out: number[] = [];
  for (const arc of arcs) {
    if (arc < 0x80) {
      out.push(arc);
      continue;
    }
    const chunk: number[] = [];
    let v = arc;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length; i += 1) {
      const isLast = i === chunk.length - 1;
      out.push(isLast ? (chunk[i] as number) : ((chunk[i] as number) | 0x80));
    }
  }
  return encodeTlv(TAG.OID, Buffer.from(out));
}

/** OID 解码（供解析响应用）。 */
export function decodeOid(value: Buffer): string {
  if (value.length === 0) return '';
  const arcs: number[] = [];
  let acc = 0;
  for (let i = 0; i < value.length; i += 1) {
    const byte = value[i] as number;
    acc = acc * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(acc);
      acc = 0;
    }
  }
  const firstArc = arcs.shift() ?? 0;
  const a = Math.min(2, Math.floor(firstArc / 40));
  const b = firstArc - a * 40;
  return [a, b, ...arcs].join('.');
}

/** 有符号整数（INTEGER 类型）。 */
export function decodeInteger(value: Buffer): number {
  if (value.length === 0) return 0;
  let result = (value[0] as number) & 0x80 ? -1 : 0;
  for (const byte of value) result = result * 256 + byte;
  return result;
}

/** 无符号整数（Counter32 / Gauge32 / TimeTicks / Counter64）。 */
export function decodeUnsigned(value: Buffer): number {
  let result = 0;
  for (const byte of value) result = result * 256 + byte;
  return result;
}

/** 解码单个 TLV。overLimit 表示长度域越过 buffer 末尾（视为损坏）。 */
export function decodeTlv(buf: Buffer, offset = 0): Tlv {
  if (offset >= buf.length) throw new RangeError('decodeTlv: 偏移越界');
  const tag = buf[offset] as number;
  if ((tag & 0x1f) === 0x1f) throw new RangeError('decodeTlv: 不支持多字节 tag');
  const { length, bytes } = decodeLength(buf, offset + 1);
  const valueOffset = offset + 1 + bytes;
  const end = valueOffset + length;
  if (end > buf.length) throw new RangeError(`decodeTlv: 长度 ${length} 越界`);
  return {
    tag,
    length,
    valueOffset,
    start: offset,
    headerLength: 1 + bytes,
    totalLength: 1 + bytes + length,
    value: buf.subarray(valueOffset, end),
  };
}

/** 遍历同一层级的所有 TLV（顺序读取到 buffer 末尾）。 */
export function walkTlv(buf: Buffer, offset = 0): Tlv[] {
  const out: Tlv[] = [];
  let cursor = offset;
  while (cursor < buf.length) {
    const tlv = decodeTlv(buf, cursor);
    out.push(tlv);
    cursor += tlv.totalLength;
  }
  return out;
}

/** 解析某个构造型 TLV 的子元素（如 SEQUENCE / PDU 的内容）。 */
export function walkChildren(tlv: Tlv): Tlv[] {
  return walkTlv(tlv.value, 0);
}

// —— SNMP 报文构造 / 解析 ——

export interface Varbind {
  oid: string;
  type: number;
  /** 数值型返回 number，字符串/其他返回 string；NULL 返回 null */
  value: number | string | null;
  raw: Buffer;
}

export interface SnmpMessageOptions {
  community?: string;
  requestId?: number;
  version?: number;
}

function encodeVarbind(oid: string): Buffer {
  return encodeSequence([encodeOid(oid), encodeNull()]);
}

function buildPdu(
  pduTag: number,
  oids: string[],
  requestId: number,
): Buffer {
  const varbinds = encodeSequence(oids.map((oid) => encodeVarbind(oid)));
  const body = Buffer.concat([
    encodeInteger(requestId),
    encodeInteger(0), // error-status
    encodeInteger(0), // error-index
    varbinds,
  ]);
  return encodeTlv(pduTag, body);
}

export function buildGetRequest(oids: string[], opts: SnmpMessageOptions = {}): Buffer {
  const { community = 'public', requestId = Math.floor(Math.random() * 0x7fffffff), version = 1 } = opts;
  return encodeSequence([
    encodeInteger(version),
    encodeOctetString(community),
    buildPdu(TAG.GET_REQUEST, oids, requestId),
  ]);
}

export function buildGetNextRequest(oids: string[], opts: SnmpMessageOptions = {}): Buffer {
  const { community = 'public', requestId = Math.floor(Math.random() * 0x7fffffff), version = 1 } = opts;
  return encodeSequence([
    encodeInteger(version),
    encodeOctetString(community),
    buildPdu(TAG.GET_NEXT_REQUEST, oids, requestId),
  ]);
}

export interface SnmpResponse {
  version: number;
  community: string;
  pduTag: number;
  requestId: number;
  errorStatus: number;
  errorIndex: number;
  varbinds: Varbind[];
}

function decodeVarbindValue(tlv: Tlv): { value: number | string | null; type: number } {
  switch (tlv.tag) {
    case TAG.INTEGER:
      return { value: decodeInteger(tlv.value), type: tlv.tag };
    case TAG.COUNTER32:
    case TAG.GAUGE32:
    case TAG.TIMETICKS:
    case TAG.COUNTER64:
      return { value: decodeUnsigned(tlv.value), type: tlv.tag };
    case TAG.OCTET_STRING:
      return { value: tlv.value.toString('utf8'), type: tlv.tag };
    case TAG.OID:
      return { value: decodeOid(tlv.value), type: tlv.tag };
    case TAG.IP_ADDRESS:
      return {
        value: Array.from(tlv.value).join('.'),
        type: tlv.tag,
      };
    case TAG.NULL:
      return { value: null, type: tlv.tag };
    default:
      return { value: tlv.value.toString('hex'), type: tlv.tag };
  }
}

/** 解析 GetResponse；结构不合法时抛错，由 snmp-client 决定降级。 */
export function parseResponse(buf: Buffer): SnmpResponse {
  const top = decodeTlv(buf, 0);
  if (top.tag !== TAG.SEQUENCE) throw new Error(`parseResponse: 顶层不是 SEQUENCE (0x${top.tag.toString(16)})`);
  const items = walkChildren(top);
  if (items.length < 3) throw new Error('parseResponse: 报文元素不足');

  const versionTlv = items[0] as Tlv;
  const communityTlv = items[1] as Tlv;
  const pduTlv = items[2] as Tlv;

  const pduItems = walkChildren(pduTlv);
  if (pduItems.length < 4) throw new Error('parseResponse: PDU 元素不足');
  const requestId = decodeInteger((pduItems[0] as Tlv).value);
  const errorStatus = decodeInteger((pduItems[1] as Tlv).value);
  const errorIndex = decodeInteger((pduItems[2] as Tlv).value);
  const vbListTlv = pduItems[3] as Tlv;

  const varbinds: Varbind[] = [];
  for (const varbindTlv of walkChildren(vbListTlv)) {
    const pair = walkChildren(varbindTlv);
    if (pair.length < 2) continue;
    const oidTlv = pair[0] as Tlv;
    const valueTlv = pair[1] as Tlv;
    const decoded = decodeVarbindValue(valueTlv);
    varbinds.push({
      oid: decodeOid(oidTlv.value),
      type: decoded.type,
      value: decoded.value,
      raw: valueTlv.value,
    });
  }

  return {
    version: decodeInteger(versionTlv.value),
    community: communityTlv.value.toString('utf8'),
    pduTag: pduTlv.tag,
    requestId,
    errorStatus,
    errorIndex,
    varbinds,
  };
}

/** OID 前缀比较（walk 终止与子树判断用）。 */
export function oidStartsWith(oid: string, prefix: string): boolean {
  return oid === prefix || oid.startsWith(`${prefix}.`);
}

/** OID 字典序比较（GETNEXT 前进判断）。 */
export function compareOid(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const va = pa[i];
    const vb = pb[i];
    if (va === undefined) return -1;
    if (vb === undefined) return 1;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}
