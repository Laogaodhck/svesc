/**
 * A. SNMP BER 编解码（`src/main/engine/printers/snmp-ber.ts`）
 *
 * 全部断言基于 **构造字节**，不发起任何 UDP 请求 —— 无网络、无 SNMP 设备也可运行。
 * 长度域/截断/伪造长度的用例是"防脏数据"的关键：宁可抛错，也不许返回半截 value。
 */
import { describe, expect, it } from 'vitest';
import {
  TAG,
  buildGetNextRequest,
  buildGetRequest,
  compareOid,
  decodeInteger,
  decodeLength,
  decodeOid,
  decodeTlv,
  encodeInteger,
  encodeLength,
  encodeNull,
  encodeOctetString,
  encodeOid,
  encodeSequence,
  encodeTlv,
  oidStartsWith,
  parseResponse,
  walkChildren,
  walkTlv,
} from '../src/main/engine/printers/snmp-ber';

const hex = (b: Buffer): string => b.toString('hex');

/** 构造一个 GetResponse 报文（version=1 / community=public）。 */
function getResponse(varbinds: Buffer[], requestId: number, errorStatus = 0): Buffer {
  const pdu = encodeTlv(
    TAG.GET_RESPONSE,
    Buffer.concat([
      encodeInteger(requestId),
      encodeInteger(errorStatus),
      encodeInteger(0),
      encodeSequence(varbinds),
    ]),
  );
  return encodeSequence([encodeInteger(1), encodeOctetString('public'), pdu]);
}

function varbind(oid: string, encodedValue: Buffer): Buffer {
  return encodeSequence([encodeOid(oid), encodedValue]);
}

describe('A. BER 长度域', () => {
  it('encodeLength(0) 应为短格式单字节 00', () => {
    expect(hex(encodeLength(0))).toBe('00');
  });

  it('encodeLength(127) 应仍为短格式 7f（不上长格式）', () => {
    expect(hex(encodeLength(127))).toBe('7f');
  });

  it('encodeLength(128) 应切换为长格式 81 80', () => {
    expect(hex(encodeLength(128)), '127/128 是短格式与 0x81 的分界').toBe('8180');
  });

  it('encodeLength(300) 应为两字节长度 82 01 2c', () => {
    expect(hex(encodeLength(300))).toBe('82012c');
  });

  it('decodeLength 应回读 0x82 01 2c 为 300', () => {
    const r = decodeLength(Buffer.from([0x82, 0x01, 0x2c]), 0);
    expect({ length: r.length, bytes: r.bytes }).toEqual({ length: 300, bytes: 3 });
  });

  it('decodeLength 遇不定长编码 0x80 必须抛 RangeError', () => {
    expect(() => decodeLength(Buffer.from([0x80, 0x01]), 0), 'SNMP 不支持不定长，必须报错').toThrow(
      RangeError,
    );
  });

  it('decodeLength 遇被截断的长度域必须抛 RangeError', () => {
    expect(() => decodeLength(Buffer.from([0x82, 0x01]), 0), '声明 2 字节但只有 1 字节').toThrow(
      RangeError,
    );
  });
});

describe('A. INTEGER 编解码（含 SNMP 的 -3 = 未知容量）', () => {
  it('encodeInteger(0) 应为 02 01 00', () => {
    expect(hex(encodeInteger(0))).toBe('020100');
  });

  it('encodeInteger(127) 应为 02 01 7f', () => {
    expect(hex(encodeInteger(127))).toBe('02017f');
  });

  it('encodeInteger(128) 应补前导 00 避免被读成负数（02 02 00 80）', () => {
    expect(hex(encodeInteger(128))).toBe('02020080');
  });

  it('encodeInteger(-1) 应为 02 01 ff', () => {
    expect(hex(encodeInteger(-1))).toBe('0201ff');
  });

  it('encodeInteger(-3) 应为 02 01 fd（SNMP 里 -3 表示"未知容量但可用"）', () => {
    expect(hex(encodeInteger(-3)), '-3 是 RFC 3805 的合法取值，不能被当成非法输入').toBe('0201fd');
  });

  it('decodeInteger 应把 02 01 fd 的值段读回 -3', () => {
    expect(decodeInteger(Buffer.from([0xfd]))).toBe(-3);
  });

  it('encodeInteger 对非整数应抛 RangeError', () => {
    expect(() => encodeInteger(1.5)).toThrow(RangeError);
  });
});

describe('A. OID 编解码', () => {
  it('encodeOid(1.3.6.1.2.1.1.1.0) 应为 06 08 2b 06 01 02 01 01 01 00', () => {
    expect(hex(encodeOid('1.3.6.1.2.1.1.1.0'))).toBe('06082b06010201010100');
  });

  it('OID 1.3.6.1.2.1.43.11.1.1.9.1.1 编码后解码应原样往返', () => {
    const oid = '1.3.6.1.2.1.43.11.1.1.9.1.1';
    const tlv = decodeTlv(encodeOid(oid), 0);
    expect(decodeOid(tlv.value), `编码字节 ${hex(tlv.value)} 应能还原原始 OID`).toBe(oid);
  });

  it('子标识 9999（≥128）应编码为两字节 ce 0f 且可往返', () => {
    const tlv = decodeTlv(encodeOid('1.3.6.1.4.1.9999.1'), 0);
    expect(hex(tlv.value), '9999 = 0b0100111000001111 → 0xce 0x0f（首字节高位置 1 表示续行）').toBe(
      '2b060104' + '01ce0f01',
    );
  });

  it('含大子标识的 OID 1.3.6.1.4.1.11.2.3.9.1 解码应与原文一致', () => {
    const oid = '1.3.6.1.4.1.11.2.3.9.1';
    const tlv = decodeTlv(encodeOid(oid), 0);
    expect(decodeOid(tlv.value)).toBe(oid);
  });

  it('oidStartsWith 应识别子树但不误判前缀相近的兄弟节点', () => {
    expect(oidStartsWith('1.3.6.1.2.1.43.11', '1.3.6.1.2.1.43')).toBe(true);
  });

  it('oidStartsWith 不得把 1.3.6.1.2.1.430 当作 43 的子树', () => {
    expect(oidStartsWith('1.3.6.1.2.1.430', '1.3.6.1.2.1.43')).toBe(false);
  });

  it('compareOid(1.3.5, 1.3.6.1) 应为负（GETNEXT 按字典序前进）', () => {
    expect(compareOid('1.3.5', '1.3.6.1')).toBeLessThan(0);
  });
});

describe('A. TLV 结构与损坏报文', () => {
  it('嵌套 sequence 的父子标签应可逐层遍历', () => {
    const inner = encodeSequence([encodeInteger(7), encodeNull()]);
    const outer = encodeSequence([inner, encodeInteger(9)]);
    const children = walkChildren(decodeTlv(outer, 0));
    expect(children.map((c) => c.tag)).toEqual([TAG.SEQUENCE, TAG.INTEGER]);
  });

  it('walkTlv 应遍历同级全部 TLV 且总长度可累加到 buffer 末尾', () => {
    const buf = Buffer.concat([encodeInteger(1), encodeOctetString('public'), encodeNull()]);
    const out = walkTlv(buf, 0);
    expect(out.map((t) => t.tag), `解析出 ${out.length} 个 TLV`).toEqual([
      TAG.INTEGER,
      TAG.OCTET_STRING,
      TAG.NULL,
    ]);
  });

  it('截断报文必须抛 RangeError 而不是产出半个 value', () => {
    // 声明内容长度 5，实际只剩 2 字节
    expect(() => decodeTlv(Buffer.from([0x30, 0x05, 0x02, 0x01]))).toThrow(RangeError);
  });

  it('被伪造的 4 字节长度 0xFFFFFFFF 必须抛错且不得耗尽内存/死循环', () => {
    const forged = Buffer.from([0x30, 0x84, 0xff, 0xff, 0xff, 0xff]);
    expect(() => decodeTlv(forged), '长度 4.29GB 越界，必须立即抛错').toThrow(RangeError);
  });

  it('长度域超过 4 字节应立即抛错（拒绝 4GB+ 声明）', () => {
    expect(() => decodeLength(Buffer.from([0x85, 1, 2, 3, 4, 5]), 0)).toThrow(RangeError);
  });
});

describe('A. SNMP 请求构造与响应解析', () => {
  it('buildGetRequest 顶层应为 SEQUENCE 30，内含 version=1 / community=public / PDU a0', () => {
    const req = buildGetRequest(['1.3.6.1.2.1.1.1.0'], { community: 'public', requestId: 42 });
    expect(req.toString('hex'), '整体结构：30 26 | 02 01 01 | 04 06 public | a0 19 | reqId/err/idx | varbindList').toBe(
      '302602010104067075626c6963a01902012a020100020100300e300c06082b060102010101000500',
    );
  });

  it('buildGetNextRequest 的 PDU 标签应为 a1', () => {
    const req = buildGetNextRequest(['1.3.6.1.2.1.1.1.0'], { community: 'public', requestId: 42 });
    const top = decodeTlv(req, 0);
    const pdu = walkChildren(top)[2] as ReturnType<typeof decodeTlv>;
    expect(pdu.tag, 'GETNEXT 的 PDU tag 与 GET 不同，否则 walk 会原地打转').toBe(0xa1);
  });

  it('parseResponse 应解出自造 GetResponse 的 requestId=42 与 varbind OID', () => {
    const buf = getResponse([varbind('1.3.6.1.2.1.1.1.0', encodeOctetString('SHARP MX-B4621R'))], 42);
    const res = parseResponse(buf);
    expect({ requestId: res.requestId, oid: res.varbinds[0]?.oid }).toEqual({
      requestId: 42,
      oid: '1.3.6.1.2.1.1.1.0',
    });
  });

  it('parseResponse 应把 Counter32(0x41) 解为 number 而不是字符串', () => {
    const buf = getResponse(
      [varbind('1.3.6.1.2.1.43.10.2.1.4.1.1', encodeTlv(TAG.COUNTER32, Buffer.from([0x00, 0x01, 0xcb, 0x93])))],
      42,
    );
    const value = parseResponse(buf).varbinds[0]?.value;
    expect(value, '页计数器 117651 必须是数字，字符串会让 UI 无法比较/求和').toBe(117651);
  });

  it('parseResponse 应把 Gauge32(0x42) 解为 number', () => {
    const buf = getResponse(
      [varbind('1.3.6.1.2.1.43.11.1.1.9.1.1', encodeTlv(TAG.GAUGE32, Buffer.from([0x00, 0x00, 0x00, 0x4b])))],
      42,
    );
    expect(parseResponse(buf).varbinds[0]?.value).toBe(75);
  });

  it('parseResponse 应把 NULL 值解为 null（"设备不报告"与"0%"必须可区分）', () => {
    const buf = getResponse([varbind('1.3.6.1.2.1.43.11.1.1.9.1.1', encodeNull())], 42);
    expect(parseResponse(buf).varbinds[0]?.value).toBeNull();
  });

  it('parseResponse 遇顶层非 SEQUENCE 应抛错而不是静默返回空 varbinds', () => {
    expect(() => parseResponse(encodeInteger(1))).toThrow(/SEQUENCE/);
  });

  it('parseResponse 遇元素不足的报文应抛错', () => {
    expect(() => parseResponse(encodeSequence([encodeInteger(1)]))).toThrow(/元素不足/);
  });
});
