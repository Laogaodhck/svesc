/**
 * §5.1 状态判定语义（`src/main/engine/scheduler.ts` · `resolveLinkState`）
 *
 * 这是本任务最关键的一组断言：本网段大量主机禁 ICMP，"ping 不通"绝不等于离线；
 * 唯一判离线路径是 **连续缺席观测轮**（task-026：心跳 5s 与扫描轮统一推进，4 轮 ≈ 20s）。
 * 纯函数，无需扫描。
 */
import { describe, expect, it } from 'vitest';
import { resolveLinkState } from '../src/main/engine/scheduler';
import { HEARTBEAT_PROBE } from '../src/shared/constants';
import { quality } from './fixtures';

const idle = {
  isSelf: false,
  isGateway: false,
  arpPresent: false,
  pingAlive: false,
  portResponded: false,
  arpMissStreak: 0,
  quality: quality({ samples: 0, score: 0, grade: 'unknown', latencyMs: null, jitterMs: null }),
};

describe('§5.1 在线判定优先级', () => {
  it('ARP 在位但 ICMP 不通时必须判 online（禁 ping 主机，ECMP 反例）', () => {
    expect(resolveLinkState({ ...idle, arpPresent: true, pingAlive: false })).toBe('online');
  });

  it('ARP 缺席但端口有响应时应判 online', () => {
    expect(resolveLinkState({ ...idle, arpPresent: false, portResponded: true })).toBe('online');
  });

  it('本机即使采集全失败也必须 online（自己不可能离线）', () => {
    expect(resolveLinkState({ ...idle, isSelf: true, arpMissStreak: 9 })).toBe('online');
  });

  it('网关即使采集全失败也必须 online', () => {
    expect(resolveLinkState({ ...idle, isGateway: true, arpMissStreak: 9 })).toBe('online');
  });
});

describe('§5.1 离线判定（唯一路径，task-026 加速）', () => {
  it(`连续缺席 ${HEARTBEAT_PROBE.offlineArpMisses} 个观测轮且 ping 不通时应判 offline`, () => {
    expect(resolveLinkState({ ...idle, arpMissStreak: HEARTBEAT_PROBE.offlineArpMisses })).toBe('offline');
  });

  it('缺席不足阈值时不得提前判 offline（确认窗口防抖）', () => {
    expect(resolveLinkState({ ...idle, arpMissStreak: HEARTBEAT_PROBE.offlineArpMisses - 1 })).toBe('online');
  });
});

describe('§5.1 质量退化覆盖', () => {
  it('已采到样本且延迟 300ms 时应覆盖为 degraded', () => {
    const q = quality({ samples: 10, latencyMs: 300, jitterMs: 0, packetLossPct: 0, score: 40, grade: 'poor' });
    expect(resolveLinkState({ ...idle, arpPresent: true, quality: q })).toBe('degraded');
  });

  it('本机质量退化时同样应显示 degraded（覆盖第 1 条）', () => {
    const q = quality({ samples: 10, latencyMs: 300, jitterMs: 0, packetLossPct: 0, score: 40, grade: 'poor' });
    expect(resolveLinkState({ ...idle, isSelf: true, quality: q })).toBe('degraded');
  });

  it('只有 1 个样本（单次扫描 ping）时不得判 degraded', () => {
    const q = quality({ samples: 1, latencyMs: 300, jitterMs: 0, packetLossPct: 0, score: 0, grade: 'unknown' });
    expect(
      resolveLinkState({ ...idle, arpPresent: true, quality: q }),
      '扫描阶段的存活 ping 不是质量样本，一次高 RTT 不能把设备标成"网络劣化"',
    ).toBe('online');
  });
});
