/**
 * G4. mDNS 全设备类型侦测（task-020：`src/main/engine/discovery/mdns-devices.ts`）
 *
 * 关键约束：只收录高置信服务映射（数据诚实——拿不准的服务不进表）；
 * 同 IP 多命中优先级 mobile > iot > apple（apple 不定类型，让位）。
 */
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_MDNS_SERVICES,
  MDNS_DEVICE_TIMEOUT_MS,
  hintsFromHits,
} from '../src/main/engine/discovery/mdns-devices';
import {
  buildMdnsQuery,
  encodeDnsName,
  mdnsQuery,
  parseMdnsRecords,
  parseTxtModel,
  type MdnsHit,
} from '../src/main/engine/printers/mdns';

vi.mock('node:dgram', () => ({ default: { createSocket: vi.fn() } }));

const hit = (service: string, ip: string, name = 'dev'): MdnsHit => ({ name, ip, port: null, service });

describe('G4. hintsFromHits 服务映射', () => {
  it('已知服务应映射到对应类型（iot/mobile/apple）', () => {
    const hints = hintsFromHits([
      hit('_googlecast._tcp.local', '192.168.1.30', '客厅电视'),
      // task-028：_companion-link 同时被 macOS/iOS 自报（Handoff/接力），降为 apple；
      // mobile 语义由 iOS 专属的 _apple-mobdev2 承担
      hit('_apple-mobdev2._tcp.local', '192.168.1.51', 'iPhone'),
      hit('_airplay._tcp.local', '192.168.1.60', 'MacBook'),
    ]);
    const byIp = new Map(hints.map((h) => [h.ip, h]));
    expect(byIp.get('192.168.1.30')?.kind).toBe('iot');
    expect(byIp.get('192.168.1.51')?.kind).toBe('mobile');
    expect(byIp.get('192.168.1.60')?.kind).toBe('apple');
  });

  it('未知服务必须被忽略（不进映射表就不判定——数据诚实）', () => {
    expect(hintsFromHits([hit('_unknown-thing._tcp.local', '192.168.1.77')])).toEqual([]);
  });

  it('无 IP 的命中必须被忽略', () => {
    const hints = hintsFromHits([{ name: 'ghost', ip: null, port: null, service: '_hap._tcp.local' }]);
    expect(hints).toEqual([]);
  });

  it('同 IP 多命中：mobile > iot > apple（优先级，不看先后顺序）', () => {
    // apple 先、mobile 后 → mobile 胜
    const a = hintsFromHits([hit('_airplay._tcp.local', '10.0.0.5'), hit('_apple-mobdev2._tcp.local', '10.0.0.5')]);
    expect(a[0]?.kind).toBe('mobile');
    // mobile 先、iot 后 → mobile 仍胜（rank 高者赢，不是最后写入者赢）
    const b = hintsFromHits([hit('_apple-mobdev2._tcp.local', '10.0.0.6'), hit('_googlecast._tcp.local', '10.0.0.6')]);
    expect(b[0]?.kind).toBe('mobile');
    // iot 先、apple 后 → iot 胜
    const c = hintsFromHits([hit('_hap._tcp.local', '10.0.0.7'), hit('_raop._tcp.local', '10.0.0.7')]);
    expect(c[0]?.kind).toBe('iot');
  });

  it('大小写不敏感：服务名大写也应命中映射', () => {
    expect(hintsFromHits([hit('_GOOGLECAST._TCP.LOCAL', '10.0.0.9')])[0]?.kind).toBe('iot');
  });

  it('服务映射表只含高置信条目：_airplay/_raop/_companion-link 必须是 apple（不定类型）', () => {
    expect(DEVICE_MDNS_SERVICES['_airplay._tcp.local']).toBe('apple');
    expect(DEVICE_MDNS_SERVICES['_raop._tcp.local']).toBe('apple');
    // task-028：_companion-link 为 macOS/iOS 共用 → 降为 apple；mobile 由 iOS 专属
    // _apple-mobdev2 承担
    expect(DEVICE_MDNS_SERVICES['_companion-link._tcp.local']).toBe('apple');
    expect(DEVICE_MDNS_SERVICES['_apple-mobdev2._tcp.local']).toBe('mobile');
    // task-023 扩充（9 → 17）+ task-027 扩充（17 → 21）+ task-028 AP/IoT/printer 生态（→ 29）
    expect(DEVICE_MDNS_SERVICES['_nvstream._tcp.local']).toBe('workstation');
    expect(DEVICE_MDNS_SERVICES['_ipp._tcp.local']).toBe('printer');
    expect(DEVICE_MDNS_SERVICES['_axis-video._tcp.local']).toBe('camera');
    expect(DEVICE_MDNS_SERVICES['_sleep-proxy._tcp.local']).toBe('apple');
    expect(DEVICE_MDNS_SERVICES['_googlerpc._tcp.local']).toBe('iot');
    expect(DEVICE_MDNS_SERVICES['_miio._udp.local']).toBe('iot');
    expect(DEVICE_MDNS_SERVICES['_ipp-tls._tcp.local']).toBe('printer');
    expect(DEVICE_MDNS_SERVICES['_uscan._tcp.local']).toBe('printer');
    expect(DEVICE_MDNS_SERVICES['_uscans._tcp.local']).toBe('printer');
    expect(DEVICE_MDNS_SERVICES['_airport._tcp.local']).toBe('ap');
    expect(DEVICE_MDNS_SERVICES['_ubnt._tcp.local']).toBe('ap');
    expect(DEVICE_MDNS_SERVICES['_matter._tcp.local']).toBe('iot');
    expect(DEVICE_MDNS_SERVICES['_printer._tcp.local']).toBe('printer');
    expect(DEVICE_MDNS_SERVICES['_workstation._tcp.local']).toBe('workstation');
    expect(Object.keys(DEVICE_MDNS_SERVICES).length).toBe(29);
  });

  it('超时预算默认 1s（phaseFingerprint 预算内）', () => {
    expect(MDNS_DEVICE_TIMEOUT_MS).toBe(1000);
  });

  it('同类不同服务的显式型号不被先到的无型号记录丢掉，反序也保留', () => {
    const plain = hit('_hap._tcp.local', '10.0.0.10', 'HomeKit');
    const explicit = { ...hit('_googlecast._tcp.local', plain.ip!, '电视'), model: '客厅电视 X1' };
    for (const hits of [[plain, explicit], [explicit, plain]]) {
      expect(hintsFromHits(hits)).toEqual([{
        ip: plain.ip, name: '电视', service: explicit.service, kind: 'iot', model: explicit.model,
      }]);
    }
  });

  it('自报型号不能覆盖更高类别优先级，也不据未知型号猜类型', () => {
    const mobile = hit('_apple-mobdev2._tcp.local', '10.0.0.10');
    const iot = { ...hit('_hap._tcp.local', mobile.ip!), model: 'iPhone17,1' };
    for (const hits of [[mobile, iot], [iot, mobile]]) {
      expect(hintsFromHits(hits)[0]).toMatchObject({ kind: 'mobile', model: null });
    }
    expect(hintsFromHits([
      hit('_device-info._tcp.local', '10.0.0.11', 'iPhone'),
      { ...hit('_device-info._tcp.local', '10.0.0.12'), model: 'Unknown' },
      { ...hit('_unknown._tcp.local', '10.0.0.13'), model: 'iPhone17,1' },
    ])).toEqual([]);
  });
});

/** 以下均构造真实 DNS wire bytes，不把文本或伪解析结果塞给生产代码。 */
const txtData = (...fields: string[]): Buffer => Buffer.concat(fields.map((field) => {
  const data = Buffer.from(field, 'utf8');
  return Buffer.concat([Buffer.from([data.length]), data]);
}));

const pointer = (offset: number): Buffer => {
  const data = Buffer.alloc(2);
  data.writeUInt16BE(0xc000 | offset);
  return data;
};

function record(name: string | Buffer, type: number, data: Buffer, options: { klass?: number; ttl?: number } = {}): Buffer {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(options.klass ?? 0x8001, 2);
  header.writeUInt32BE(options.ttl ?? 120, 4);
  header.writeUInt16BE(data.length, 8);
  return Buffer.concat([typeof name === 'string' ? encodeDnsName(name) : name, header, data]);
}

function response(records: Buffer[], options: {
  flags?: number; question?: Buffer; answers?: number; authorities?: number;
} = {}): Buffer {
  const header = Buffer.alloc(12);
  const answers = options.answers ?? records.length;
  const authorities = options.authorities ?? 0;
  header.writeUInt16BE(options.flags ?? 0x8400, 2);
  header.writeUInt16BE(options.question ? 1 : 0, 4);
  header.writeUInt16BE(answers, 6);
  header.writeUInt16BE(authorities, 8);
  header.writeUInt16BE(records.length - answers - authorities, 10);
  return Buffer.concat([header, options.question ?? Buffer.alloc(0), ...records]);
}

function srvData(target: string | Buffer, port = 8009): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16BE(port, 4);
  return Buffer.concat([header, typeof target === 'string' ? encodeDnsName(target) : target]);
}

const service = '_googlecast._tcp.local';
const instance = `客厅电视.${service}`;
const target = 'tv-host.local';
const address = Buffer.from([10, 0, 0, 20]);
const ptrRecord = (): Buffer => record(service, 12, encodeDnsName(instance));
const srvRecord = (): Buffer => record(instance, 33, srvData(target));
const aRecord = (): Buffer => record(target, 1, address);
const txtRecord = (): Buffer => record(instance, 16, txtData('md=Chromecast', 'model=电视 X1', 'ty=Generic'));

function compressedResponse(): Buffer {
  const question = Buffer.concat([encodeDnsName(service), Buffer.from([0, 12, 0, 1])]);
  const instanceStart = 12 + question.length + 2 + 10;
  const ptr = record(pointer(12), 12, Buffer.concat([
    encodeDnsName('客厅电视').subarray(0, -1), pointer(12),
  ]));
  const localStart = 12 + encodeDnsName('_googlecast._tcp').length - 1;
  const targetStart = 12 + question.length + ptr.length + 2 + 10 + 6;
  const srv = record(pointer(instanceStart), 33, srvData(Buffer.concat([
    encodeDnsName('tv-host').subarray(0, -1), pointer(localStart),
  ])));
  return response([
    ptr, srv,
    record(pointer(instanceStart), 16, txtData('model=电视 X1', 'md=Chromecast', 'ty=Generic')),
    record(pointer(targetStart), 1, address),
  ], { question, answers: 1, authorities: 1 });
}

// 一个受控的 EventEmitter socket；createSocket 始终 mock，绝不触碰真实网络。
class MockMdnsSocket extends EventEmitter {
  bind = vi.fn((_port: number, callback: () => void) => { callback(); return this; });
  addMembership = vi.fn();
  setMulticastTTL = vi.fn();
  send = vi.fn((_data: Buffer, _port: number, _host: string, callback: (err: Error | null) => void) => callback(null));
  close = vi.fn();

  receive(packet: Buffer): void {
    this.emit('message', packet, { address: '198.51.100.99', family: 'IPv4', port: 5353, size: packet.length });
  }
}

const expectedHit: MdnsHit = { name: '客厅电视', service, ip: '10.0.0.20', port: 8009, model: '电视 X1' };

// packetOrder 的全部排列用于证明关联不依赖 PTR、SRV、A、TXT 的到达顺序。
function permutations<T>(items: T[]): T[][] {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]));
}

describe('DNS TXT wire 解析', () => {
  it.each(permutations(['model=明确型号', 'md=投屏型号', 'ty=打印型号']))('字段优先级与顺序无关：%j', (...fields) => {
    expect(parseTxtModel(txtData(...fields))).toBe('明确型号');
  });

  it('保留中文与值中的 |/=，忽略非型号字段，同名键最后一次生效', () => {
    expect(parseTxtModel(txtData('', 'fn=iPhone', 'model=旧', ' MD =中间', 'MODEL= 中文|系列=二代 ', 'ty=低'))).toBe('中文|系列=二代');
    expect(parseTxtModel(txtData('ty=低', 'md=中'))).toBe('中');
    expect(parseTxtModel(txtData('md=中', 'ty=低'))).toBe('中');
    expect(parseTxtModel(txtData('model=', 'md= ', 'ty=后备'))).toBe('后备');
    expect(parseTxtModel(txtData('model=旧', 'model=', 'md=后备'))).toBe('后备');
  });

  it('无关二进制 TXT 字段不影响合法型号，损坏的高优先级型号可回退', () => {
    const binary = Buffer.concat([Buffer.from('blob='), Buffer.from([0xff, 0xfe])]);
    expect(parseTxtModel(Buffer.concat([
      txtData('model=电视 X1'), Buffer.from([binary.length]), binary,
    ]))).toBe('电视 X1');
    const invalidModel = Buffer.concat([Buffer.from('model='), Buffer.from([0xff])]);
    expect(parseTxtModel(Buffer.concat([
      Buffer.from([invalidModel.length]), invalidModel, txtData('md=备用型号'),
    ]))).toBe('备用型号');
  });

  it('缺失、伪分隔符、长度截断和无效 UTF-8 均不伪造型号', () => {
    expect(parseTxtModel(Buffer.alloc(0))).toBeNull();
    expect(parseTxtModel(txtData('', 'fn=iPhone', 'friendly=电视', 'model', 'model= '))).toBeNull();
    expect(parseTxtModel(Buffer.from('model=Fake|md=Fake'))).toBeNull();
    expect(parseTxtModel(txtData('model=中文').subarray(0, -1))).toBeNull();
    expect(parseTxtModel(Buffer.concat([txtData('model=不可信'), Buffer.from([20, 65])]))).toBeNull();
    const badUtf8 = Buffer.concat([Buffer.from('model='), Buffer.from([0xe4, 0xb8])]);
    expect(parseTxtModel(Buffer.concat([Buffer.from([badUtf8.length]), badUtf8]))).toBeNull();
  });
});

describe('DNS 二进制记录解析', () => {
  it('PTR/SRV/A owner 多级压缩均引用原报文，跨 answer/authority/additional 读取', () => {
    const records = parseMdnsRecords(compressedResponse());
    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({ name: service, type: 12, target: instance });
    expect(records[1]).toMatchObject({ name: instance, type: 33, target, port: 8009 });
    expect(records[3]).toMatchObject({ name: target, type: 1, data: address });
  });

  it('查询包、非 IN 与 TTL0 不提供有效记录；cache-flush IN 正常接收', () => {
    expect(parseMdnsRecords(response([ptrRecord()], { flags: 0 }))).toEqual([]);
    expect(parseMdnsRecords(buildMdnsQuery(service))).toEqual([]);
    expect(parseMdnsRecords(response([
      record(service, 12, encodeDnsName(instance), { klass: 3 }),
      record(service, 12, encodeDnsName(instance), { ttl: 0 }),
      ptrRecord(),
    ]))).toHaveLength(1);
  });

  it('拒绝循环、越界、单字节指针以及非法标签，不抛异常', () => {
    const malformedOwners = [pointer(12), pointer(0x3fff), pointer(0), Buffer.from([0xc0]), Buffer.from([0x40, 0]), Buffer.from([0x80, 0])];
    for (const owner of malformedOwners) {
      expect(parseMdnsRecords(response([record(owner, 1, address)]))).toEqual([]);
    }
    // 两个指针互指，带足够的字节，不能只靠越界检查阻止递归。
    expect(parseMdnsRecords(response([Buffer.concat([pointer(14), pointer(12), Buffer.alloc(14)])]))).toEqual([]);
    expect(parseMdnsRecords(response([Buffer.from([63, 65, 66])]))).toEqual([]);
    const overlong = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`;
    expect(parseMdnsRecords(response([record(overlong, 1, address)]))).toEqual([]);
  });

  it('名称不得越过 RDLENGTH 借用下一条记录，坏 PTR/SRV/A 不影响完整有效记录', () => {
    const rdataStart = 12 + encodeDnsName(service).length + 10;
    const records = parseMdnsRecords(response([
      record(service, 12, pointer(rdataStart)), // PTR 自环
      record(service, 12, Buffer.from([0xc0])), // 下条记录的首字节不能补齐指针
      record(service, 12, Buffer.from([1, 65])), // 缺终结符
      record(service, 12, Buffer.concat([encodeDnsName(instance), Buffer.from([0])])), // 多余 RDATA
      record(instance, 33, Buffer.alloc(5)),
      record(instance, 33, srvData(Buffer.from([0xc0]))),
      record(target, 1, Buffer.from([10, 0, 0])),
      aRecord(),
    ]));
    expect(records).toEqual([expect.objectContaining({ name: target, type: 1, data: address })]);
  });

  it('截断报头/问题/RR header/RDATA 和虚假计数均安全返回空', () => {
    const packet = response([ptrRecord(), srvRecord(), aRecord()]);
    for (let length = 0; length < packet.length; length += 1) {
      expect(parseMdnsRecords(packet.subarray(0, length))).toEqual([]);
    }
    const question = Buffer.concat([encodeDnsName(service), Buffer.from([0, 12])]);
    expect(parseMdnsRecords(response([], { question }))).toEqual([]);
    const badCount = response([aRecord()]);
    badCount.writeUInt16BE(0xffff, 6);
    expect(parseMdnsRecords(badCount)).toEqual([]);
  });
});

describe('mdnsQuery 跨包发现（mock dgram + fake timers）', () => {
  let socket: MockMdnsSocket;
  beforeEach(() => {
    vi.useFakeTimers();
    socket = new MockMdnsSocket();
    // 只实现本模块实际用到的 Socket 表面，其余接口不参与测试。
    vi.mocked(dgram.createSocket).mockReturnValue(socket as unknown as dgram.Socket);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('完整压缩报文端到端输出正确实例，重传不重复，超时关闭 socket', async () => {
    const pending = mdnsQuery([service], 1000);
    expect(dgram.createSocket).toHaveBeenCalledWith({ type: 'udp4', reuseAddr: true });
    expect(socket.bind).toHaveBeenCalledWith(5353, expect.any(Function));
    expect(socket.addMembership).toHaveBeenCalledWith('224.0.0.251');
    expect(socket.send.mock.calls[0]?.[0]).toEqual(buildMdnsQuery(service));
    socket.receive(compressedResponse());
    socket.receive(compressedResponse());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([expectedHit]);
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(permutations(['PTR', 'SRV', 'A', 'TXT']))('跨独立 UDP 包乱序关联：%j', async (...order) => {
    const packets: Record<string, Buffer> = { PTR: ptrRecord(), SRV: srvRecord(), A: aRecord(), TXT: txtRecord() };
    const pending = mdnsQuery([service], 1000);
    for (const type of order) {
      socket.receive(response([packets[type]!]));
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([expectedHit]);
  });

  it('后到 A/TXT、SRV target 和地址变化补全已有实例，不留下旧 IP 或重复项', async () => {
    const pending = mdnsQuery([service], 1000);
    socket.receive(response([ptrRecord(), srvRecord()]));
    await vi.advanceTimersByTimeAsync(50);
    socket.receive(response([aRecord(), txtRecord()]));
    socket.receive(response([ptrRecord(), record(instance, 33, srvData('new-host.local', 1234))]));
    socket.receive(response([record('new-host.local', 1, Buffer.from([10, 0, 0, 30]))]));
    socket.receive(response([record('new-host.local', 1, Buffer.from([10, 0, 0, 31]))]));
    socket.receive(response([record(instance, 16, txtData('model=新型号'))]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([{ ...expectedHit, ip: '10.0.0.31', port: 1234, model: '新型号' }]);
  });

  it('同名实例按服务独立，主机共享 A，大小写与查询尾点不影响关联', async () => {
    const otherService = '_hap._tcp.local';
    const otherInstance = `客厅电视.${otherService}`;
    const pending = mdnsQuery([`${service.toUpperCase()}.`, otherService], 1000);
    socket.receive(response([
      record(target.toUpperCase(), 1, address),
      record(instance.toUpperCase(), 16, txtData('model=电视 X1')),
      record(otherInstance, 16, txtData('model=HomeKit X2')),
      record(otherInstance, 33, srvData(target.toUpperCase(), 1234)),
      srvRecord(), ptrRecord(),
      record(service.toUpperCase(), 12, encodeDnsName(instance.toUpperCase())),
      record(otherService, 12, encodeDnsName(otherInstance)),
    ]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([
      expectedHit,
      { ...expectedHit, service: otherService, port: 1234, model: 'HomeKit X2' },
    ]);
  });

  it('只输出查询服务的有效 PTR：不输出未查询服务或孤立 SRV/TXT', async () => {
    const otherService = '_ipp._tcp.local';
    const otherInstance = `Printer.${otherService}`;
    const pending = mdnsQuery([service], 1000);
    socket.receive(response([
      record(otherService, 12, encodeDnsName(otherInstance)),
      record(otherInstance, 33, srvData(target)),
      record(otherInstance, 16, txtData('model=Printer')),
      record(service, 12, encodeDnsName(otherInstance)), // PTR owner 不能冒充另一服务
      srvRecord(), txtRecord(), aRecord(),
    ]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([]);
  });

  it('缺目标 A 时 IP 为 null，不使用来源 IP、不用实例 A 或无关 A 猜测', async () => {
    const pending = mdnsQuery([service], 1000);
    socket.receive(response([
      ptrRecord(), srvRecord(),
      record(instance, 1, address),
      record('unrelated.local', 1, address),
    ]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([{ ...expectedHit, ip: null, model: null }]);
  });

  it('仅 PTR 不猜端口/型号，即使友好名或 A 看似可识别', async () => {
    const pending = mdnsQuery([service], 1000);
    socket.receive(response([ptrRecord(), aRecord()]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([{ ...expectedHit, ip: null, port: null, model: null }]);
  });

  it('忽略查询 known-answer、非 IN、TTL0 及恶意包，并能继续接收合法响应', async () => {
    const pending = mdnsQuery([service], 1000);
    socket.receive(response([ptrRecord(), srvRecord(), aRecord(), txtRecord()], { flags: 0 }));
    socket.receive(response([
      record(service, 12, encodeDnsName(instance), { klass: 3 }),
      record(service, 12, encodeDnsName(instance), { ttl: 0 }),
    ]));
    socket.receive(response([record(pointer(12), 12, pointer(12))]));
    socket.receive(response([ptrRecord(), srvRecord()]).subarray(0, -1));
    // 若前面的无效 PTR 被缓存，以下合法孤立记录便会错误地生成命中。
    socket.receive(response([srvRecord(), aRecord(), txtRecord()]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([]);

    const next = mdnsQuery([service], 1000);
    socket.receive(response([ptrRecord()]));
    await vi.advanceTimersByTimeAsync(1000);
    // 查询窗口不共享先前缓存，上一窗口的 SRV/A/TXT 不得泄漏。
    expect(await next).toEqual([{ ...expectedHit, ip: null, port: null, model: null }]);
  });

  it('无效 A/SRV/TXT 不能补全有效 PTR，TTL0/非 IN 适用于所有 RR 类型', async () => {
    const pending = mdnsQuery([service], 1000);
    socket.receive(response([ptrRecord(), srvRecord()]));
    for (const options of [{ ttl: 0 }, { klass: 3 }]) {
      socket.receive(response([
        record(target, 1, address, options),
        record(instance, 33, srvData('bad.local', 9999), options),
        record(instance, 16, txtData('model=Fake'), options),
      ]));
    }
    socket.receive(response([
      record(target, 1, Buffer.from([10, 0, 0])),
      record(instance, 16, txtData('model=假型号').subarray(0, -1)),
      record(instance, 33, srvData(Buffer.from([0xc0]))),
    ]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([{ ...expectedHit, ip: null, model: null }]);
  });

  it('缓存限量，洪泛不能无限增加结果，已缓存实例仍可被后到型号补全', async () => {
    const pending = mdnsQuery([service], 1000);
    socket.receive(response([ptrRecord(), srvRecord(), aRecord()]));
    // 分批避免单包上限，覆盖窗口累计缓存上限。
    for (let start = 0; start < 1200; start += 100) {
      const records: Buffer[] = [];
      for (let i = start; i < start + 100; i += 1) {
        const name = `device-${i}.${service}`;
        records.push(
          record(service, 12, encodeDnsName(name)),
          record(name, 33, srvData(`host-${i}.local`)),
          record(name, 16, txtData(`model=model-${i}`)),
          record(`host-${i}.local`, 1, address),
        );
      }
      socket.receive(response(records));
    }
    socket.receive(response([record(`device-0.${service}`, 16, txtData('model=更新型号'))]));
    socket.receive(response([txtRecord()])); // 已有实例的首个型号也不能因缓存已满而丢失
    await vi.advanceTimersByTimeAsync(1000);
    const hits = await pending;
    expect(hits).toHaveLength(1024);
    expect(hits.find((h) => h.name === 'device-0')?.model).toBe('更新型号');
    expect(hits[0]).toEqual(expectedHit);
  });

  it('无响应按时返回空，空服务列表不建 socket', async () => {
    expect(await mdnsQuery([], 1000)).toEqual([]);
    expect(dgram.createSocket).not.toHaveBeenCalled();
    const pending = mdnsQuery([service], 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([]);
  });
});
