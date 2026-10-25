/**
 * G. OUI 厂商表（`src/main/engine/discovery/oui.ts`）
 *
 * 核心断言：三种 MAC 写法归一化到同一结果；未命中返回 null（绝不猜）。
 */
import { describe, expect, it } from 'vitest';
import { OUI_TABLE, isValidMac, lookupVendor, normalizeMac, ouiTableSize } from '../src/main/engine/discovery/oui';

describe('G. MAC 归一化', () => {
  it('大写连字符应归一化为小写连字符', () => {
    expect(normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('aa-bb-cc-dd-ee-ff');
  });

  it('冒号分隔应归一化为连字符', () => {
    expect(normalizeMac('aa:bb:cc:dd:ee:ff')).toBe('aa-bb-cc-dd-ee-ff');
  });

  it('点分格式 aabb.ccdd.eeff 应归一化为 aa-bb-cc-dd-ee-ff', () => {
    expect(
      normalizeMac('aabb.ccdd.eeff'),
      'Cisco/部分 IPP 报文使用点分格式；三种写法必须收敛到同一 key，否则厂商查询会静默返回 null',
    ).toBe('aa-bb-cc-dd-ee-ff');
  });

  it('isValidMac 应接受连字符与冒号两种写法', () => {
    expect(['9c-93-4e-9c-6a-76', '9C:93:4E:9C:6A:76'].filter((m) => !isValidMac(m))).toEqual([]);
  });

  it('isValidMac 应拒绝段数不足/非十六进制', () => {
    expect(['9c-93-4e-9c-6a', '9c-93-4e-9c-6a-zz'].filter((m) => isValidMac(m))).toEqual([]);
  });
});

describe('G. 厂商查询（真实前缀）', () => {
  it('HP 前缀 3c-d9-2b 应命中 HP', () => {
    expect(lookupVendor('3C-D9-2B-11-22-33')).toBe('HP');
  });

  it('Canon 前缀 00-00-85 应命中 Canon', () => {
    expect(lookupVendor('00-00-85-11-22-33')).toBe('Canon');
  });

  it('Epson 前缀 00-00-48 应命中 Epson', () => {
    expect(lookupVendor('00:00:48:11:22:33')).toBe('Epson');
  });

  it('Brother 前缀 00-80-77 应命中 Brother', () => {
    expect(lookupVendor('00-80-77-11-22-33')).toBe('Brother');
  });

  it('本机实测的 Xerox 设备 9c-93-4e-9c-6a-76 应命中 Xerox', () => {
    expect(lookupVendor('9C:93:4E:9C:6A:76')).toBe('Xerox');
  });

  it('未知前缀必须返回 null（不许按概率瞎猜）', () => {
    expect(lookupVendor('02-00-00-00-00-01')).toBeNull();
  });

  it('非法 MAC 应返回 null', () => {
    expect(lookupVendor('not-a-mac')).toBeNull();
  });

  it('ouiTableSize 应不少于 60 条（契约下限）', () => {
    expect(ouiTableSize()).toBeGreaterThanOrEqual(60);
  });

  it('厂商表键必须是小写连字符格式（防止写入时大小写混用导致查不到）', () => {
    const bad = Object.keys(OUI_TABLE).filter((k) => !/^[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2}$/.test(k));
    expect(bad, `非法键：${bad.join(',')}`).toEqual([]);
  });
});
