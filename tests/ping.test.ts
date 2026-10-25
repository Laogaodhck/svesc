/**
 * P1：ping 输出解析（`src/main/engine/discovery/ping.ts`）
 *
 * fixture 全部来自 investigation-report.md §2.3 的**真实原文**（中文 locale 实测）。
 * 中文 Windows 是最容易埋雷的地方：设 UTF8 会让 MUI 程序回退英文资源（Vera §2.5），
 * 所以中英两套文案都必须能解析。纯函数，不执行 ping。
 */
import { describe, expect, it } from 'vitest';
import { parsePingOutput, parsePingStats } from '../src/main/engine/discovery/ping';

/** Vera §2.3：中文可达（`时间=3ms`）。 */
const ZH_OK = `正在 Ping 192.168.2.1 具有 32 字节的数据:
来自 192.168.2.1 的回复: 字节=32 时间=3ms TTL=64

192.168.2.1 的 Ping 统计信息:
    数据包: 已发送 = 1，已接收 = 1，丢失 = 0 (0% 丢失)，
往返行程的估计时间(以毫秒为单位):
    最短 = 3ms，最长 = 3ms，平均 = 3ms
`;

/** Vera §2.3：中文可达但 `<1ms` 变体。 */
const ZH_SUBMS = `正在 Ping 192.168.2.1 具有 32 字节的数据:
来自 192.168.2.1 的回复: 字节=32 时间<1ms TTL=64

192.168.2.1 的 Ping 统计信息:
    数据包: 已发送 = 1，已接收 = 1，丢失 = 0 (0% 丢失)，
`;

/** Vera §2.3：死地址原文。 */
const ZH_TIMEOUT = `正在 Ping 192.168.2.249 具有 32 字节的数据:
请求超时。

192.168.2.249 的 Ping 统计信息:
    数据包: 已发送 = 1，已接收 = 0，丢失 = 1 (100% 丢失)，
`;

/** Vera §2.3：英文 locale 对应文案（设 UTF8 后就会变成这样）。 */
const EN_OK = `Pinging 192.168.2.1 with 32 bytes of data:
Reply from 192.168.2.1: bytes=32 time=3ms TTL=64

Ping statistics for 192.168.2.1:
    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),
`;

const EN_TIMEOUT = `Pinging 192.168.2.249 with 32 bytes of data:
Request timed out.
`;

/** Vera §2.10：TTL 实测值（SHARP 打印机 255、网关 64）。 */
const ZH_TTL_255 = `正在 Ping 192.168.2.170 具有 32 字节的数据:
来自 192.168.2.170 的回复: 字节=32 时间=1ms TTL=255
`;

describe('P1. 中文回复行', () => {
  it('应解析出 alive=true / rtt=3 / ttl=64', () => {
    const r = parsePingOutput('192.168.2.1', ZH_OK, 0);
    expect({ alive: r.alive, rttMs: r.rttMs, ttl: r.ttl }).toEqual({ alive: true, rttMs: 3, ttl: 64 });
  });

  it('时间<1ms 应记为 rtt=0（不是 1，也不是 null）', () => {
    const r = parsePingOutput('192.168.2.1', ZH_SUBMS, 0);
    expect(r.rttMs, '<1ms 若记成 1 会高估，记成 null 会把可达主机算成"没采到"').toBe(0);
  });

  it('TTL=255 应原样提取（SHARP 打印机的真实值）', () => {
    const r = parsePingOutput('192.168.2.170', ZH_TTL_255, 0);
    expect(r.ttl).toBe(255);
  });

  it('全角冒号与全角等号混排时仍应解析成功', () => {
    const fullWidth = '来自 192.168.2.1 的回复：字节＝32 时间＝3ms TTL＝64';
    const r = parsePingOutput('192.168.2.1', fullWidth, 0);
    expect({ alive: r.alive, rttMs: r.rttMs }).toEqual({ alive: true, rttMs: 3 });
  });
});

describe('P1. 超时（最危险的误判面）', () => {
  it('请求超时 应判 alive=false', () => {
    const r = parsePingOutput('192.168.2.249', ZH_TIMEOUT, 1);
    expect(r.alive).toBe(false);
  });

  it('请求超时 不得产出 rtt=0 的"成功"样本', () => {
    const r = parsePingOutput('192.168.2.249', ZH_TIMEOUT, 1);
    expect(r.rttMs, '超时若给 rtt=0，丢包率会算成 0% 且延迟极佳 —— 恰好把最差的链路评成满分').toBeNull();
  });

  it('请求超时 应标记 timedOut=true 且不算"解析失败"', () => {
    const r = parsePingOutput('192.168.2.249', ZH_TIMEOUT, 1);
    expect({ timedOut: r.timedOut, parseWarning: r.parseWarning }).toEqual({
      timedOut: true,
      parseWarning: false,
    });
  });

  it('英文 Request timed out. 同样应判 alive=false', () => {
    expect(parsePingOutput('192.168.2.249', EN_TIMEOUT, 1).alive).toBe(false);
  });
});

describe('P1. 英文回复行', () => {
  it('Reply from … time=3ms TTL=64 应解析出 alive=true / rtt=3 / ttl=64', () => {
    const r = parsePingOutput('192.168.2.1', EN_OK, 0);
    expect({ alive: r.alive, rttMs: r.rttMs, ttl: r.ttl }).toEqual({ alive: true, rttMs: 3, ttl: 64 });
  });
});

describe('P1. 无法解析时不得编造结论', () => {
  it('垃圾文本 + exitCode=0 应 alive=true 但标记 parseWarning', () => {
    const r = parsePingOutput('192.168.2.1', '??? 乱码 ???', 0);
    expect({ alive: r.alive, parseWarning: r.parseWarning }).toEqual({ alive: true, parseWarning: true });
  });

  it('垃圾文本 + exitCode=1 应 alive=false 且不标记超时', () => {
    const r = parsePingOutput('192.168.2.1', '??? 乱码 ???', 1);
    expect({ alive: r.alive, timedOut: r.timedOut }).toEqual({ alive: false, timedOut: false });
  });
});

describe('P1. ping -n 4 统计（质量采样输入）', () => {
  const ZH_4OK = `正在 Ping 192.168.2.1 具有 32 字节的数据:
来自 192.168.2.1 的回复: 字节=32 时间<1ms TTL=64
来自 192.168.2.1 的回复: 字节=32 时间=1ms TTL=64
来自 192.168.2.1 的回复: 字节=32 时间=1ms TTL=64
来自 192.168.2.1 的回复: 字节=32 时间<1ms TTL=64

192.168.2.1 的 Ping 统计信息:
    数据包: 已发送 = 4，已接收 = 4，丢失 = 0 (0% 丢失)，
往返行程的估计时间(以毫秒为单位):
    最短 = 0ms，最长 = 1ms，平均 = 0ms
`;

  const ZH_4LOST = `正在 Ping 192.168.2.249 具有 32 字节的数据:
请求超时。
请求超时。
请求超时。
请求超时。

192.168.2.249 的 Ping 统计信息:
    数据包: 已发送 = 4，已接收 = 0，丢失 = 4 (100% 丢失)，
`;

  const ZH_4HALF = `正在 Ping 192.168.2.249 具有 32 字节的数据:
来自 192.168.2.249 的回复: 字节=32 时间=2ms TTL=64
请求超时。
来自 192.168.2.249 的回复: 字节=32 时间=4ms TTL=64
请求超时。

192.168.2.249 的 Ping 统计信息:
    数据包: 已发送 = 4，已接收 = 2，丢失 = 2 (50% 丢失)，
`;

  it('4 包全通应得 loss 0% / 逐包 rtt [0,1,1,0]', () => {
    const s = parsePingStats(ZH_4OK);
    expect({ lossPct: s.lossPct, rtts: s.rtts }).toEqual({ lossPct: 0, rtts: [0, 1, 1, 0] });
  });

  it('4 包全丢应得 loss 100% 且 rtts 为空（绝不编造 0ms 成功样本）', () => {
    const s = parsePingStats(ZH_4LOST);
    expect({ lossPct: s.lossPct, rtts: s.rtts }, '全丢却产出 rtt 样本 = 把 100% 丢包评成满分').toEqual({
      lossPct: 100,
      rtts: [],
    });
  });

  it('半丢应得 loss 50% 且只含 2 个 rtt 样本', () => {
    const s = parsePingStats(ZH_4HALF);
    expect({ lossPct: s.lossPct, rtts: s.rtts }).toEqual({ lossPct: 50, rtts: [2, 4] });
  });

  it('平均 RTT 应从统计行取到（平均 = 0ms）', () => {
    expect(parsePingStats(ZH_4OK).avgRttMs).toBe(0);
  });

  it('无统计行时应返回 null 而不是 0（"没读到"≠"0% 丢包"）', () => {
    const s = parsePingStats('来自 192.168.2.1 的回复: 字节=32 时间=3ms TTL=64');
    expect({ lossPct: s.lossPct, avgRttMs: s.avgRttMs }).toEqual({ lossPct: null, avgRttMs: null });
  });
});
