/**
 * G4. mDNS 全设备类型侦测（task-020：`src/main/engine/discovery/mdns-devices.ts`）
 *
 * 关键约束：只收录高置信服务映射（数据诚实——拿不准的服务不进表）；
 * 同 IP 多命中优先级 mobile > iot > apple（apple 不定类型，让位）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEVICE_MDNS_SERVICES,
  MDNS_DEVICE_TIMEOUT_MS,
  hintsFromHits,
  type MdnsDeviceHint,
} from '../src/main/engine/discovery/mdns-devices';
import type { MdnsHit } from '../src/main/engine/printers/mdns';

const hit = (service: string, ip: string, name = 'dev'): MdnsHit => ({ name, ip, port: null, service });

describe('G4. hintsFromHits 服务映射', () => {
  it('已知服务应映射到对应类型（iot/mobile/apple）', () => {
    const hints = hintsFromHits([
      hit('_googlecast._tcp.local', '192.168.1.30', '客厅电视'),
      hit('_companion._tcp.local', '192.168.1.51', 'iPhone'),
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
    const a = hintsFromHits([hit('_airplay._tcp.local', '10.0.0.5'), hit('_companion._tcp.local', '10.0.0.5')]);
    expect(a[0]?.kind).toBe('mobile');
    // mobile 先、iot 后 → mobile 仍胜（rank 高者赢，不是最后写入者赢）
    const b = hintsFromHits([hit('_companion._tcp.local', '10.0.0.6'), hit('_googlecast._tcp.local', '10.0.0.6')]);
    expect(b[0]?.kind).toBe('mobile');
    // iot 先、apple 后 → iot 胜
    const c = hintsFromHits([hit('_hap._tcp.local', '10.0.0.7'), hit('_raop._tcp.local', '10.0.0.7')]);
    expect(c[0]?.kind).toBe('iot');
  });

  it('大小写不敏感：服务名大写也应命中映射', () => {
    expect(hintsFromHits([hit('_GOOGLECAST._TCP.LOCAL', '10.0.0.9')])[0]?.kind).toBe('iot');
  });

  it('服务映射表只含高置信条目：_airplay/_raop 必须是 apple（不定类型）', () => {
    expect(DEVICE_MDNS_SERVICES['_airplay._tcp.local']).toBe('apple');
    expect(DEVICE_MDNS_SERVICES['_raop._tcp.local']).toBe('apple');
    expect(DEVICE_MDNS_SERVICES['_companion._tcp.local']).toBe('mobile');
    expect(Object.keys(DEVICE_MDNS_SERVICES).length).toBe(9);
  });

  it('超时预算默认 1s（phaseFingerprint 预算内）', () => {
    expect(MDNS_DEVICE_TIMEOUT_MS).toBe(1000);
  });
});
