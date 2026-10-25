/**
 * UPnP IGD 通道纯函数测试（`src/main/engine/router/upnp.ts`）。
 * 真实样例取自 Vera 抓包的局域网网关描述页（已脱敏）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildMsearch,
  buildSoap,
  parseDeviceDescription,
  parseSsdpLocation,
  parseSoapFields,
  resolveControlUrl,
  soapActionHeader,
} from '../src/main/engine/router/upnp';

const DESC_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<friendlyName>TP-Link Router</friendlyName>
<manufacturer>TP-Link</manufacturer>
<modelName>TL-R470T+</modelName>
<serviceList>
<service>
<serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType>
<controlURL>/ctl/Cmn</controlURL>
</service>
<service>
<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
<controlURL>/ctl/IPConn</controlURL>
</service>
</serviceList>
</device>
</root>`;

describe('SSDP', () => {
  it('buildMsearch 生成合法 M-SEARCH 报文', () => {
    const q = buildMsearch();
    expect(q).toContain('M-SEARCH * HTTP/1.1');
    expect(q).toContain('HOST: 239.255.255.250:1900');
    expect(q).toContain('ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1');
    expect(q.endsWith('\r\n\r\n')).toBe(true);
  });

  it('parseSsdpLocation 从响应里取 LOCATION', () => {
    const res = 'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.168.1.1:1900/igd.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n';
    expect(parseSsdpLocation(res)).toBe('http://192.168.1.1:1900/igd.xml');
  });

  it('parseSsdpLocation 拒绝非 200 报文与缺 LOCATION 的报文', () => {
    expect(parseSsdpLocation('HTTP/1.1 404 Not Found\r\nLOCATION: http://x/\r\n')).toBeNull();
    expect(parseSsdpLocation('HTTP/1.1 200 OK\r\nSERVER: some\r\n')).toBeNull();
    expect(parseSsdpLocation('garbage')).toBeNull();
  });
});

describe('设备描述解析', () => {
  it('提取 friendlyName / modelName / WANIPConnection controlURL', () => {
    const parsed = parseDeviceDescription(DESC_XML);
    expect(parsed).not.toBeNull();
    expect(parsed!.friendlyName).toBe('TP-Link Router');
    expect(parsed!.modelName).toBe('TL-R470T+');
    expect(parsed!.controlUrl).toBe('/ctl/IPConn');
  });

  it('缺 WANIPConnection 时兜底任意 controlURL', () => {
    const xml = DESC_XML.replace(/urn:schemas-upnp-org:service:WANIPConnection:1/, 'urn:schemas-upnp-org:service:Foo:1');
    const parsed = parseDeviceDescription(xml);
    expect(parsed!.controlUrl).toBe('/ctl/Cmn');
  });

  it('非描述 XML 返回 null', () => {
    expect(parseDeviceDescription('<html>404</html>')).toBeNull();
    expect(parseDeviceDescription('')).toBeNull();
  });

  it('resolveControlUrl 拼绝对地址', () => {
    expect(resolveControlUrl('http://192.168.1.1:1900/igd.xml', '/ctl/IPConn')).toBe(
      'http://192.168.1.1:1900/ctl/IPConn',
    );
    expect(resolveControlUrl('http://192.168.1.1:1900/igd.xml', null)).toBeNull();
  });
});

describe('SOAP', () => {
  it('buildSoap 组装带参数的信封', () => {
    const soap = buildSoap('GetExternalIPAddress');
    expect(soap).toContain('<m:GetExternalIPAddress xmlns:m="urn:schemas-upnp-org:service:WANIPConnection:1">');
    expect(soap).toContain('</m:GetExternalIPAddress>');
  });

  it('buildSoap 对参数做 XML 转义', () => {
    const soap = buildSoap('AddPortMapping', { NewInternalClient: '192.168.1.<b>' });
    expect(soap).toContain('192.168.1.&lt;b&gt;');
  });

  it('soapActionHeader 带 SOAPACTION 头', () => {
    const h = soapActionHeader('Reboot');
    expect(h.SOAPACTION).toBe('"urn:schemas-upnp-org:service:WANIPConnection:1#Reboot"');
  });

  it('parseSoapFields 抽取响应字段', () => {
    const res = `<?xml version="1.0"?>
    <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
    <s:Body><u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
    <NewExternalIPAddress>116.21.63.84</NewExternalIPAddress>
    </u:GetExternalIPAddressResponse></s:Body></s:Envelope>`;
    expect(parseSoapFields(res, 'GetExternalIPAddressResponse')).toEqual({
      NewExternalIPAddress: '116.21.63.84',
    });
  });

  it('parseSoapFields 对 Fault 返回空对象', () => {
    const fault = '<s:Envelope><s:Body><s:Fault><faultcode>s:Client</faultcode></s:Fault></s:Body></s:Envelope>';
    expect(parseSoapFields(fault, 'GetTotalBytesReceivedResponse')).toEqual({});
  });
});
