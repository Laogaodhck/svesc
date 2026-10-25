/**
 * C. ARP 解析（`src/main/engine/discovery/arp.ts`）
 *
 * fixture 全部来自 investigation-report.md §2.1 / §2.2 的**真实原文**（中文与英文 locale 各一），
 * 不调用真实 `arp` —— 无网卡、无权限的机器上也能确定地跑。
 */
import { describe, expect, it } from 'vitest';
import { findIpByMac, isSkippableArpIp, parseArp, parseNeighborRows } from '../src/main/engine/discovery/arp';

/** Vera §2.1：中文 locale `arp -a` 原文（含组播 / 广播行）。 */
const ARP_ZH = `接口: 192.168.2.179 --- 0x5
  Internet 地址         物理地址              类型
  192.168.2.1           e4-67-1e-12-68-a9     动态
  192.168.2.17          00-e0-4c-3b-41-31     动态
  192.168.2.24          48-5f-08-41-4f-d1     动态
  192.168.2.235         9c-93-4e-9c-6a-76     动态
  192.168.2.255         ff-ff-ff-ff-ff-ff     静态
  224.0.0.22            01-00-5e-00-00-16     静态
`;

/** 英文 locale 同结构（Windows `arp -a` 的 MAC 分隔符同样是连字符，见 Vera §2.1）。 */
const ARP_EN = `Interface: 192.168.2.179 --- 0x5
  Internet Address      Physical Address      Type
  192.168.2.1           e4-67-1e-12-68-a9     dynamic
  192.168.2.255         ff-ff-ff-ff-ff-ff     static
`;

describe('C. 中文 arp -a 原文', () => {
  it('应解析出 4 条真实设备（组播/广播/全 f MAC 被过滤）', () => {
    const { entries } = parseArp(ARP_ZH);
    expect(
      entries.map((e) => e.ip),
      `实际解析出：${JSON.stringify(entries)}`,
    ).toEqual(['192.168.2.1', '192.168.2.17', '192.168.2.24', '192.168.2.235']);
  });

  it('MAC 应归一化为小写连字符，且挂在正确的接口段下', () => {
    const { entries } = parseArp(ARP_ZH);
    expect({ mac: entries[3]?.mac, iface: entries[3]?.iface }).toEqual({
      mac: '9c-93-4e-9c-6a-76',
      iface: '192.168.2.179',
    });
  });

  it('224.0.0.22 组播条目不得出现在结果里', () => {
    const { entries } = parseArp(ARP_ZH);
    expect(entries.some((e) => e.ip === '224.0.0.22'), '组播地址当成设备会虚增设备数').toBe(false);
  });

  it('广播地址 192.168.2.255 与全 f MAC 不得出现在结果里', () => {
    const { entries } = parseArp(ARP_ZH);
    expect(entries.some((e) => e.ip.endsWith('.255') || e.mac === 'ff-ff-ff-ff-ff-ff')).toBe(false);
  });
});

describe('C. 英文 arp -a 原文', () => {
  it('Interface: 段头 + dynamic 行应解析出 1 条', () => {
    const { entries } = parseArp(ARP_EN);
    expect(entries.map((e) => e.ip)).toEqual(['192.168.2.1']);
  });

  it('英文段的接口地址应被记录，供"本机/网关"判定使用', () => {
    const { entries } = parseArp(ARP_EN);
    expect(entries[0]?.iface).toBe('192.168.2.179');
  });
});

describe('C. 网段过滤', () => {
  it('给定 prefix=192.168.2. 时应丢弃 172.25.x 虚拟网卡条目', () => {
    const text = `${ARP_ZH}接口: 172.25.8.1 --- 0x13
  Internet 地址         物理地址              类型
  172.25.8.169          00-15-5d-42-a0-f1     动态
`;
    const { entries } = parseArp(text, '192.168.2.');
    expect(entries.every((e) => e.ip.startsWith('192.168.2.'))).toBe(true);
  });

  it('isSkippableArpIp 应过滤组播/广播/网络号，但保留正常主机', () => {
    const skipped = ['224.0.0.22', '239.255.255.250', '192.168.2.255', '192.168.2.0'];
    expect(skipped.filter((ip) => !isSkippableArpIp(ip)), '这些地址不应被当作设备').toEqual([]);
  });
});

describe('C. 空输入 / 乱码 / 半行不得抛异常', () => {
  it('空字符串应返回空结果且不抛异常', () => {
    const { entries } = parseArp('');
    expect(entries).toHaveLength(0);
  });

  it('乱码文本应返回空结果且不抛异常', () => {
    const { entries } = parseArp('����� ����\n�ӿ�: ???\n随便写点什么 ###\n');
    expect(entries).toHaveLength(0);
  });

  it('半行（只有 IP 没有 MAC）应被忽略且不抛异常', () => {
    const { entries } = parseArp('  192.168.2.1\n  192.168.2.44  48-5f\n');
    expect(entries).toHaveLength(0);
  });

  it('中文表头被错误解码但 IP/MAC 完整时仍应解析出条目（locale 韧性）', () => {
    // Vera §2.1：utf8 误读 GBK 后只有中文标签成乱码，IP/MAC 字节不受影响
    const mangled = `�ӿ�: 192.168.2.179 --- 0x5
  Internet ��ַ         ������ַ              ����
  192.168.2.1           e4-67-1e-12-68-a9     ��̬
`;
    const { entries } = parseArp(mangled);
    expect(entries.map((e) => `${e.ip}/${e.mac}`)).toEqual(['192.168.2.1/e4-67-1e-12-68-a9']);
  });
});

describe('C. Get-NetNeighbor 回退路径', () => {
  it('State=Unreachable 的条目应跳过（MAC 可能是残留值）', () => {
    const rows = [
      { IPAddress: '192.168.2.212', LinkLayerAddress: '00-E0-4C-3B-46-99', State: 'Unreachable' },
      { IPAddress: '192.168.2.240', LinkLayerAddress: '00-E0-4C-3B-46-25', State: 'Stale' },
    ];
    expect(parseNeighborRows(rows).map((e) => e.ip)).toEqual(['192.168.2.240']);
  });

  it('全零 MAC 即使 State=Stale 也不得当成设备（Vera §2.2 的 .212 假条目）', () => {
    const rows = [
      { IPAddress: '192.168.2.212', LinkLayerAddress: '00-00-00-00-00-00', State: 'Stale' },
      { IPAddress: '192.168.2.240', LinkLayerAddress: '00-E0-4C-3B-46-25', State: 'Stale' },
    ];
    expect(parseNeighborRows(rows).map((e) => e.ip)).toEqual(['192.168.2.240']);
  });

  it('Permanent 条目应跳过（单播地址 + Permanent 同样不是设备条目）', () => {
    const rows = [
      { IPAddress: '192.168.2.1', LinkLayerAddress: 'E4-67-1E-12-68-A9', State: 'Permanent' },
      { IPAddress: '192.168.2.211', LinkLayerAddress: '00-E0-4C-3C-D0-F3', State: 'Stale' },
    ];
    expect(parseNeighborRows(rows).map((e) => e.ip)).toEqual(['192.168.2.211']);
  });

  it('冒号分隔的大写 MAC 应归一化为小写连字符', () => {
    const rows = [{ IPAddress: '192.168.2.170', LinkLayerAddress: '00:1B:A9:11:22:33', State: 'Stale' }];
    expect(parseNeighborRows(rows)[0]?.mac).toBe('00-1b-a9-11-22-33');
  });
});

describe('C. findIpByMac', () => {
  const map = new Map(
    parseArp(ARP_ZH).entries.map((e) => [e.ip, e] as const),
  );

  it('大小写与分隔符不敏感：用冒号大写也能反查到 IP', () => {
    expect(findIpByMac(map, '9C:93:4E:9C:6A:76')).toBe('192.168.2.235');
  });

  it('未命中应返回 null（不许返回近似匹配）', () => {
    expect(findIpByMac(map, '9c-93-4e-9c-6a-77')).toBeNull();
  });
});
