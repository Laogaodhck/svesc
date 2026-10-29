/**
 * 测试夹具：按 plan.md 第 5 节契约构造 Device / Printer / Consumable / NetQuality。
 * 只用于 tests/**，不含任何真实系统调用。
 */
import type { Consumable, Device, NetQuality, Printer } from '../src/shared/types';

/** 固定时间基准，避免断言依赖 Date.now()。 */
export const T0 = 1_700_000_000_000;

export function quality(over: Partial<NetQuality> = {}): NetQuality {
  return {
    latencyMs: 5,
    jitterMs: 1,
    packetLossPct: 0,
    score: 97,
    grade: 'excellent',
    samples: 10,
    ...over,
  };
}

export function emptyBandwidthStat(): Device['bandwidth'] {
  return { rxBps: 0, txBps: 0, share: 0, connections: 0, attributable: false, estimated: true };
}

export function device(over: Partial<Device> & { id: string; ip: string }): Device {
  return {
    mac: 'aa-bb-cc-00-00-01',
    hostname: null,
    vendor: null,
    osHint: null,
    kind: 'workstation',
    state: 'online',
    firstSeen: T0,
    lastSeen: T0,
    openPorts: [],
    quality: quality(),
    bandwidth: emptyBandwidthStat(),
    rttHistory: [],
    isGateway: false,
    isSelf: false,
    displayName: null,
    ipConflict: false,
    ...over,
  };
}

export function supply(over: Partial<Consumable> = {}): Consumable {
  return {
    kind: 'black',
    label: 'Black Toner',
    levelPct: 100,
    maxCapacity: 100,
    current: 100,
    source: 'snmp',
    ...over,
  };
}

export function printer(over: Partial<Printer> & { id: string; name: string }): Printer {
  return {
    alias: null,
    queueName: null,
    model: null,
    ip: null,
    mac: null,
    connection: 'network',
    state: 'idle',
    stateDetail: null,
    isDefault: false,
    shared: false,
    manual: false,
    pageCount: null,
    consumables: [],
    jobs: [],
    source: 'spooler',
    lastSeen: T0,
    ...over,
  };
}
