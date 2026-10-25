/**
 * F. 子网推导（`src/main/engine/discovery/subnet.ts`）
 *
 * 用 mock 的 `os.networkInterfaces()` 结果（含 vEthernet / WSL / 169.254 / 环回）驱动，
 * 不读取真实网卡 —— 在没有局域网、甚至没有物理网卡的机器上结果一致。
 */
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import {
  buildHosts,
  isExcludedIface,
  isValidIpv4,
  listCandidates,
  pickSubnet,
  to24Prefix,
} from '../src/main/engine/discovery/subnet';

function info(address: string, netmask = '255.255.255.0', internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00-00-00-00-00-00',
    internal,
    cidr: `${address}/24`,
    scopeid: 0,
  } as os.NetworkInterfaceInfo;
}

/** 本机真实拓扑的缩影：2 个 vEthernet + 环回 + APIPA + 蓝牙 + 唯一业务网卡。 */
const IFACES: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
  'vEthernet (WSL)': [info('172.25.8.1', '255.255.240.0')],
  'vEthernet (Default Switch)': [info('172.20.144.1', '255.255.240.0')],
  'Loopback Pseudo-Interface 1': [info('127.0.0.1', '255.0.0.0', true)],
  以太网: [info('192.168.2.179')],
  '本地连接* 2': [info('169.254.55.3', '255.255.0.0')],
  'Bluetooth Network Connection': [info('192.168.99.1')],
};

describe('F. 网卡筛选', () => {
  it('从含 vEthernet/WSL/环回/APIPA/蓝牙的接口表中只应留下业务网卡', () => {
    const got = listCandidates(IFACES);
    expect(
      got.map((c) => `${c.iface}=${c.address}`),
      '虚拟网卡被选中会导致扫到 172.25.x 空网段',
    ).toEqual(['以太网=192.168.2.179']);
  });

  it('isExcludedIface 应排除 vEthernet/WSL/Loopback/internal/169.254', () => {
    const cases: [string, string, boolean][] = [
      ['vEthernet (WSL)', '172.25.8.1', false],
      ['Loopback Pseudo-Interface 1', '127.0.0.1', true],
      ['以太网', '169.254.55.3', false],
      ['以太网', '192.168.2.179', true],
    ];
    expect(cases.filter(([n, a, i]) => !isExcludedIface(n, a, i))).toEqual([]);
  });

  it('非 IPv4（IPv6）条目应被忽略', () => {
    const ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
      以太网: [{ ...info('192.168.2.179'), address: 'fe80::1', family: 'IPv6' } as os.NetworkInterfaceInfo],
    };
    expect(listCandidates(ifaces)).toEqual([]);
  });
});

describe('F. 主网段选择', () => {
  const candidates = listCandidates(IFACES);

  it('preferredAddress 命中时应选中该接口（默认路由所在网卡优先）', () => {
    const s = pickSubnet(candidates, '192.168.2.179', '192.168.2.1');
    expect({ iface: s?.iface, prefix: s?.prefix, gateway: s?.gateway }).toEqual({
      iface: '以太网',
      prefix: '192.168.2.',
      gateway: '192.168.2.1',
    });
  });

  it('无 preferredAddress 时应优先选 192.168 私有网段而不是 172.25 虚拟网段', () => {
    const s = pickSubnet(
      [
        { iface: 'vEthernet (WSL)', address: '172.25.8.1', netmask: '255.255.240.0' },
        { iface: '以太网', address: '192.168.2.179', netmask: '255.255.255.0' },
      ],
      null,
    );
    expect(s?.address).toBe('192.168.2.179');
  });

  it('无候选接口时应返回 null（上层降级为 demo，不得瞎猜网段）', () => {
    expect(pickSubnet([], null)).toBeNull();
  });

  it('to24Prefix 应只保留前三段', () => {
    expect(to24Prefix('192.168.2.179')).toBe('192.168.2.');
  });
});

describe('F. 主机地址展开', () => {
  it('/24 应展开 254 个可用地址，且首尾为 .1 / .254', () => {
    const hosts = buildHosts('192.168.2.');
    expect({ count: hosts.length, first: hosts[0], last: hosts[253] }).toEqual({
      count: 254,
      first: '192.168.2.1',
      last: '192.168.2.254',
    });
  });

  it('展开结果不得包含网络号 .0 与广播地址 .255', () => {
    const hosts = buildHosts('192.168.2.');
    expect(hosts.filter((h) => h === '192.168.2.0' || h === '192.168.2.255')).toEqual([]);
  });

  it('掩码为 /16 时仍应只扫所属 /24 块（254 个地址，前缀不变）', () => {
    const s = pickSubnet([{ iface: '以太网', address: '192.168.2.179', netmask: '255.255.0.0' }], null);
    expect(
      { count: s?.hosts.length, first: s?.hosts[0], prefix: s?.prefix },
      '跨 254 个 /24 块全扫会打 6 万个地址，必须按 /24 截断',
    ).toEqual({ count: 254, first: '192.168.2.1', prefix: '192.168.2.' });
  });
});

describe('F. IPv4 校验', () => {
  it('isValidIpv4 应接受 0..255 的四段地址', () => {
    expect(['1.2.3.4', '192.168.2.254', '0.0.0.0'].filter((ip) => !isValidIpv4(ip))).toEqual([]);
  });

  it('isValidIpv4 应拒绝 256 / 段数不足 / 带空格 / 非数字', () => {
    expect(['1.2.3.256', '1.2.3', ' 1.2.3.4', '1.2.3.a'].filter((ip) => isValidIpv4(ip))).toEqual([]);
  });
});
