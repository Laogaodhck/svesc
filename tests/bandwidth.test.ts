/**
 * E. 带宽差分与连接归集（`src/main/engine/network/bandwidth.ts`）
 *
 * fixture 采用 investigation-report.md §2.9 / §3.4 的真实 `netstat -e` / `-ano` 原文；
 * 不执行真实 netstat，`statFor` 的采样状态直接注入（避免依赖本机流量）。
 */
import { describe, expect, it } from 'vitest';
import {
  BandwidthMeter,
  aggregateLanConnections,
  bpsFromDelta,
  emptyBandwidth,
  parseNetstatConnections,
  parseNetstatE,
  type BandwidthSample,
} from '../src/main/engine/network/bandwidth';
import { T0 } from './fixtures';

/** Vera §2.9：中文 `netstat -e` 原文。 */
const NETSTAT_E_ZH = `接口统计

                           接收的            发送的

字节                    2636111916      1811382196
单播数据包            34576280        46071108
非单播数据包         9359160           66228
丢弃                          0               0
错误                            0               0
未知协议                 0
`;

/** 英文 locale 同结构。 */
const NETSTAT_E_EN = `Interface Statistics

                           Received            Sent

Bytes                    2636111916      1811382196
Unicast packets          34576280        46071108
`;

/** Vera §3.4 行格式 + 真实环境里的噪音行（TIME_WAIT / 回环 / 自身 / UDP）。 */
const NETSTAT_ANO = `活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    192.168.2.179:52344    192.168.2.170:445    ESTABLISHED    1234
  TCP    192.168.2.179:52345    192.168.2.170:445    ESTABLISHED    1234
  TCP    192.168.2.179:52346    192.168.2.235:631    TIME_WAIT    0
  TCP    192.168.2.179:52347    192.168.2.1:80    ESTABLISHED    1234
  TCP    127.0.0.1:52348    127.0.0.1:5432    ESTABLISHED    999
  TCP    192.168.2.179:52349    192.168.2.179:9000    ESTABLISHED    1234
  UDP    192.168.2.179:137    *:*    1234
`;

describe('E. 计数器差分', () => {
  it('2 秒内 +100 字节应为 400 bps（Δ×8/Δt）', () => {
    const r = bpsFromDelta({ rxBytes: 100, txBytes: 0, at: 0 }, { rxBytes: 200, txBytes: 0, at: 2000 });
    expect(r.rxBps).toBe(400);
  });

  it('计数器重置为 0（curr<prev）应返回 0，不得出现负值或天文数字', () => {
    const r = bpsFromDelta(
      { rxBytes: 2636111916, txBytes: 1811382196, at: 0 },
      { rxBytes: 0, txBytes: 0, at: 2000 },
    );
    expect({ rx: r.rxBps, tx: r.txBps }, '回绕/重置只能按"无增量"处理，不能算出 -1e10 或 1e19').toEqual({
      rx: 0,
      tx: 0,
    });
  });

  it('采样间隔为 0 应返回 0（不得除零）', () => {
    const r = bpsFromDelta({ rxBytes: 0, txBytes: 0, at: 5000 }, { rxBytes: 500, txBytes: 500, at: 5000 });
    expect({ rx: r.rxBps, tx: r.txBps, interval: r.intervalMs }).toEqual({ rx: 0, tx: 0, interval: 0 });
  });

  it('采样间隔为负（时钟回拨）应返回 0', () => {
    const r = bpsFromDelta({ rxBytes: 0, txBytes: 0, at: 9000 }, { rxBytes: 500, txBytes: 500, at: 8000 });
    expect(r.rxBps).toBe(0);
  });
});

describe('E. netstat -e 解析', () => {
  it('应从中文本地化原文取到 rx/tx 字节数', () => {
    expect(parseNetstatE(NETSTAT_E_ZH), '取错行会拿到"丢弃/错误"的 0 0').toEqual({
      rxBytes: 2636111916,
      txBytes: 1811382196,
    });
  });

  it('英文 Bytes 行应同样命中', () => {
    expect(parseNetstatE(NETSTAT_E_EN)).toEqual({ rxBytes: 2636111916, txBytes: 1811382196 });
  });

  it('无字节行时应返回 null 而不是 0（0 与"没读到"必须可区分）', () => {
    expect(parseNetstatE('接口统计\n\n丢弃 0 0\n')).toBeNull();
  });
});

describe('E. netstat -ano 解析与归集', () => {
  it('应解析出 6 条 TCP 连接，并忽略表头与 UDP *:* 行', () => {
    const rows = parseNetstatConnections(NETSTAT_ANO);
    expect(rows.map((r) => `${r.proto} ${r.remoteIp}:${r.remotePort}`)).toEqual([
      'TCP 192.168.2.170:445',
      'TCP 192.168.2.170:445',
      'TCP 192.168.2.235:631',
      'TCP 192.168.2.1:80',
      'TCP 127.0.0.1:5432',
      'TCP 192.168.2.179:9000',
    ]);
  });

  it('归集只算 TCP+ESTABLISHED+网段内+非自身+非回环', () => {
    const per = aggregateLanConnections(parseNetstatConnections(NETSTAT_ANO), '192.168.2.', '192.168.2.179');
    expect(
      Object.fromEntries(per),
      'TIME_WAIT/回环/自身/UDP 都不该计入，否则会凭空给设备分摊流量',
    ).toEqual({ '192.168.2.170': 2, '192.168.2.1': 1 });
  });

  it('prefix 为 null 时不得归集任何流量（无法判断是否局域网）', () => {
    const per = aggregateLanConnections(parseNetstatConnections(NETSTAT_ANO), null, '192.168.2.179');
    expect(per.size).toBe(0);
  });
});

describe('E. 设备级分摊 statFor', () => {
  type WithLast = { last: BandwidthSample | null };

  function meterWith(sample: BandwidthSample): BandwidthMeter {
    const meter = new BandwidthMeter('192.168.2.', '192.168.2.179');
    (meter as unknown as WithLast).last = sample;
    return meter;
  }

  const sample = (over: Partial<BandwidthSample> = {}): BandwidthSample => ({
    at: T0,
    rxBps: 8000,
    txBps: 4000,
    lanConnections: 4,
    perDevice: new Map([['192.168.2.170', 4]]),
    intervalMs: 2000,
    error: null,
    ...over,
  });

  it('单设备独占全部连接时 share 应为 1 且 attributable=true', () => {
    const stat = meterWith(sample()).statFor('192.168.2.170');
    expect({ share: stat.share, attributable: stat.attributable, rx: stat.rxBps }).toEqual({
      share: 1,
      attributable: true,
      rx: 8000,
    });
  });

  it('局域网连接数为 0 时不得除零：全 0 且 attributable=false', () => {
    const stat = meterWith(sample({ lanConnections: 0, perDevice: new Map() })).statFor('192.168.2.170');
    expect({ share: stat.share, connections: stat.connections, attributable: stat.attributable }).toEqual({
      share: 0,
      connections: 0,
      attributable: false,
    });
  });

  it('share 应按 4 位小数取整（1/3 不能用长浮点污染 UI）', () => {
    const stat = meterWith(
      sample({ perDevice: new Map([['192.168.2.170', 1], ['192.168.2.1', 2]]), lanConnections: 3 }),
    ).statFor('192.168.2.170');
    expect(stat.share).toBe(0.3333);
  });

  it('尚未采样时 statFor 应返回空状态而不是抛异常', () => {
    expect(new BandwidthMeter('192.168.2.', '192.168.2.179').statFor('192.168.2.170')).toEqual(
      emptyBandwidth(),
    );
  });

  it('emptyBandwidth 必须是 attributable=false + estimated=true（UI 显示"无流量归集"）', () => {
    expect(emptyBandwidth()).toEqual({
      rxBps: 0,
      txBps: 0,
      share: 0,
      connections: 0,
      attributable: false,
      estimated: true,
    });
  });
});
