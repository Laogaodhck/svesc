/**
 * task-023：SSDP 全网设备自报发现纯函数。
 * 覆盖：M-SEARCH 构造 / LOCATION 提取 / 描述 XML deviceType 解析 / 分类与聚合。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateSsdpHints,
  buildMsearchAll,
  classifySsdpDeviceType,
  parseDeviceTypeFromXml,
  parseSsdpLocation,
} from '../src/main/engine/discovery/ssdp-devices';

const DESC_XML = (deviceType: string): string =>
  `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>${deviceType}</deviceType>
    <friendlyName>Test Device</friendlyName>
  </device>
</root>`;

describe('ssdp-devices.buildMsearchAll', () => {
  it('M-SEARCH 报文：ssdp:all + CRLF 行尾', () => {
    const msg = buildMsearchAll(2);
    expect(msg).toContain('M-SEARCH * HTTP/1.1');
    expect(msg).toContain('ST: ssdp:all');
    expect(msg).toContain('MX: 2');
    expect(msg).toContain('\r\n');
  });
});

describe('ssdp-devices.parseSsdpLocation', () => {
  it('200-OK 响应取 LOCATION', () => {
    const pkt = 'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.168.2.1:5000/description.xml\r\nST: upnp:rootdevice\r\n\r\n';
    expect(parseSsdpLocation(pkt)).toBe('http://192.168.2.1:5000/description.xml');
  });

  it('NOTIFY alive 报文同样可取 LOCATION（大小写/空白宽容）', () => {
    const pkt = 'NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nlocation:http://10.0.0.5/dd.xml\r\nNT: upnp:rootdevice\r\nNTS: ssdp:alive\r\n\r\n';
    expect(parseSsdpLocation(pkt)).toBe('http://10.0.0.5/dd.xml');
  });

  it('无 LOCATION 返回 null', () => {
    expect(parseSsdpLocation('M-SEARCH * HTTP/1.1\r\nST: ssdp:all\r\n\r\n')).toBeNull();
  });
});

describe('ssdp-devices.parseDeviceTypeFromXml', () => {
  it('标准描述页取首个 deviceType', () => {
    expect(parseDeviceTypeFromXml(DESC_XML('urn:schemas-upnp-org:device:InternetGatewayDevice:1'))).toBe(
      'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    );
  });

  it('无 deviceType / 畸形 XML 返回 null', () => {
    expect(parseDeviceTypeFromXml('<root></root>')).toBeNull();
    expect(parseDeviceTypeFromXml('')).toBeNull();
  });
});

describe('ssdp-devices.classifySsdpDeviceType', () => {
  it('InternetGatewayDevice → router', () => {
    expect(classifySsdpDeviceType('urn:schemas-upnp-org:device:InternetGatewayDevice:1')).toEqual({
      kind: 'router',
      osHint: 'UPnP IGD（网关）',
    });
  });

  it('WLANAccessPointDevice → ap', () => {
    expect(classifySsdpDeviceType('urn:schemas-upnp-org:device:WLANAccessPointDevice:1')).toEqual({
      kind: 'ap',
      osHint: '无线AP (UPnP)',
    });
  });

  it('MediaRenderer → iot；MediaServer → kind=null 仅 osHint', () => {
    expect(classifySsdpDeviceType('urn:schemas-upnp-org:device:MediaRenderer:1')?.kind).toBe('iot');
    const ms = classifySsdpDeviceType('urn:schemas-upnp-org:device:MediaServer:1');
    expect(ms?.kind).toBeNull();
    expect(ms?.osHint).toBe('媒体服务器 (UPnP)');
  });

  it('未收录类型（Basic/Camera 等）返回 null——不猜', () => {
    expect(classifySsdpDeviceType('urn:schemas-upnp-org:device:Basic:1')).toBeNull();
    expect(classifySsdpDeviceType('urn:schemas-upnp-org:device:Printer:1')).toBeNull();
  });
});

describe('ssdp-devices.aggregateSsdpHints', () => {
  it('同 IP 按优先级聚合：ap > router > iot > 仅 osHint', () => {
    const out = aggregateSsdpHints([
      { ip: '192.168.2.1', classification: { kind: 'router', osHint: 'UPnP IGD（网关）' } },
      { ip: '192.168.2.2', classification: { kind: 'iot', osHint: '投屏/音响 (UPnP)' } },
      { ip: '192.168.2.2', classification: { kind: null, osHint: '媒体服务器 (UPnP)' } },
      { ip: '192.168.2.3', classification: { kind: 'ap', osHint: '无线AP (UPnP)' } },
    ]);
    expect(out).toHaveLength(3);
    expect(out.find((h) => h.ip === '192.168.2.2')).toEqual({
      ip: '192.168.2.2',
      kind: 'iot',
      osHint: '投屏/音响 (UPnP)',
    });
    expect(out.find((h) => h.ip === '192.168.2.3')?.kind).toBe('ap');
  });
});
