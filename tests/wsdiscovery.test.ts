/**
 * task-023：WS-Discovery（ONVIF）摄像头发现纯函数。
 * 覆盖：Probe 报文构造 / ProbeMatches 解析（前缀无关）/ Types 分类 / 多包聚合。
 */
import { describe, expect, it } from 'vitest';
import {
  buildProbeMessage,
  classifyTypes,
  extractIpv4,
  hintsFromMatches,
  parseProbeMatches,
} from '../src/main/engine/discovery/wsdiscovery';

const SAMPLE = (types: string, xaddrs: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
  <e:Body>
    <d:ProbeMatches>
      <d:ProbeMatch>
        <d:Types>${types}</d:Types>
        <d:XAddrs>${xaddrs}</d:XAddrs>
      </d:ProbeMatch>
    </d:ProbeMatches>
  </e:Body>
</e:Envelope>`;

describe('wsdiscovery.buildProbeMessage', () => {
  it('ONVIF 专用 Probe 带 dn:NetworkVideoTransmitter Types', () => {
    const msg = buildProbeMessage('test-uuid', 'dn:NetworkVideoTransmitter');
    expect(msg).toContain('urn:uuid:test-uuid');
    expect(msg).toContain('dn:NetworkVideoTransmitter');
    expect(msg).toContain('http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe');
  });

  it('通配 Probe 不带 d:Types', () => {
    expect(buildProbeMessage('u2', null)).not.toContain('d:Types');
  });
});

describe('wsdiscovery.parseProbeMatches', () => {
  it('解析标准 ONVIF 响应：Types + XAddrs + IP', () => {
    const out = parseProbeMatches(
      SAMPLE(
        'dn:NetworkVideoTransmitter dn:Device',
        'http://192.168.2.64:8899/onvif/device_service',
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.types).toContain('NetworkVideoTransmitter');
    expect(out[0]?.ip).toBe('192.168.2.64');
    expect(out[0]?.xaddr).toBe('http://192.168.2.64:8899/onvif/device_service');
  });

  it('前缀无关：无前缀（wsdp:Device 无命名空间样式）也能解析', () => {
    const out = parseProbeMatches(
      '<ProbeMatch><Types>dn:NetworkVideoRecorder</Types><XAddrs>http://10.0.0.8/onvif/</XAddrs></ProbeMatch>',
    );
    expect(out[0]?.ip).toBe('10.0.0.8');
  });

  it('宽容解析：畸形 Types 也完整提取 XAddrs（分类阶段自然过滤），不因单字段残缺丢包', () => {
    const out = parseProbeMatches(
      '<d:ProbeMatch><d:Types>garbage-no-close</d:Types><d:XAddrs>http://1.2.3.4/</d:XAddrs></d:ProbeMatch>',
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.ip).toBe('1.2.3.4');
    // 非摄像头 Types 在归类层被丢弃（不猜）
    expect(hintsFromMatches(out)).toEqual([]);
  });

  it('无 ProbeMatch / 空串 / 噪音文本返回空数组', () => {
    expect(parseProbeMatches('')).toEqual([]);
    expect(parseProbeMatches('not xml at all')).toEqual([]);
    expect(parseProbeMatches('<e:Envelope></e:Envelope>')).toEqual([]);
  });
});

describe('wsdiscovery.classifyTypes', () => {
  it('NetworkVideoTransmitter → ipc（前缀无关、大小写无关）', () => {
    expect(classifyTypes('dn:NetworkVideoTransmitter')).toBe('ipc');
    expect(classifyTypes('networkvideotransmitter')).toBe('ipc');
  });

  it('NetworkVideoRecorder → nvr', () => {
    expect(classifyTypes('dn:NetworkVideoRecorder')).toBe('nvr');
  });

  it('非摄像头参与者（Windows WSD / 打印机 / 空值）一律 null——不猜', () => {
    expect(classifyTypes('pub:Computer wsdp:Device')).toBeNull();
    expect(classifyTypes('PrintBasic')).toBeNull();
    expect(classifyTypes('')).toBeNull();
  });
});

describe('wsdiscovery.hintsFromMatches', () => {
  it('聚合去重：同 IP 取优先级更高 kind（ipc > nvr）', () => {
    const hints = hintsFromMatches([
      { ip: '192.168.2.64', types: 'dn:NetworkVideoRecorder', xaddr: 'http://192.168.2.64/a' },
      { ip: '192.168.2.64', types: 'dn:NetworkVideoTransmitter', xaddr: 'http://192.168.2.64/b' },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.kind).toBe('ipc');
  });

  it('无 IP 的命中丢弃；非摄像头类型丢弃', () => {
    const hints = hintsFromMatches([
      { ip: null, types: 'dn:NetworkVideoTransmitter', xaddr: null },
      { ip: '192.168.2.1', types: 'pub:Computer', xaddr: 'http://192.168.2.1/' },
    ]);
    expect(hints).toEqual([]);
  });
});

describe('wsdiscovery.extractIpv4', () => {
  it('从 URL 提取 IPv4；无 IPv4 返回 null', () => {
    expect(extractIpv4('http://192.168.2.64:8899/onvif/device_service')).toBe('192.168.2.64');
    expect(extractIpv4('http://device.local/onvif/')).toBeNull();
  });
});
