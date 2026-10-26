/**
 * task-017 回归锁（告警子系统移除后仅存两项）：
 *  D. 设备首次接入时间持久化（store roundtrip + scheduler 覆盖表）
 *  E. ARP 同 IP 多 MAC 冲突解析（collectArpConflicts 纯函数，IP 冲突徽标独立于告警引擎）
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectArpConflicts } from '../src/main/engine/discovery/arp';
import { JsonStore } from '../src/main/engine/store';
import { Scheduler } from '../src/main/engine/scheduler';
import { T0 } from './fixtures';

// ———————— D. firstSeen 持久化 ————————

describe('D. 设备首次接入时间持久化（task-017）', () => {
  it('JsonStore roundtrip：setFirstSeen → 重开读回原值', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-firstseen-'));
    const store = new JsonStore(dir);
    store.setFirstSeen({ '192.168.2.52': T0, '192.168.2.53': T0 + 1 });
    store.flush();

    const reopened = new JsonStore(dir);
    expect(reopened.get().firstSeen).toEqual({ '192.168.2.52': T0, '192.168.2.53': T0 + 1 });
  });

  it('落盘脏数据（非法 IP key / 非法时间戳）读回时丢弃，合法记录保留', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-firstseen-bad-'));
    const store = new JsonStore(dir);
    store.flush();
    writeFileSync(
      store.filePath,
      JSON.stringify({
        version: 1,
        aliases: {},
        firstSeen: {
          '192.168.2.52': T0, // 合法
          '999.999.999.999': T0, // 非法 IP
          'not-an-ip': T0, // 非法 key
          '192.168.2.53': -1, // 非法时间戳
          '192.168.2.54': 'abc', // 类型不对
        },
        settings: { autoScan: true, autoScanIntervalSec: 60 },
        printers: { manual: [], ignored: [] },
      }),
      'utf8',
    );
    const reopened = new JsonStore(dir);
    expect(reopened.get().firstSeen).toEqual({ '192.168.2.52': T0 });
  });

  it('旧版本状态文件（无 firstSeen 字段）读回为空表，不报错不丢其它数据', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-firstseen-legacy-'));
    const store = new JsonStore(dir);
    store.flush();
    writeFileSync(
      store.filePath,
      JSON.stringify({
        version: 1,
        aliases: { 'dev-192.168.2.1': '网关' },
        settings: { autoScan: true, autoScanIntervalSec: 60 },
        printers: { manual: [], ignored: [] },
      }),
      'utf8',
    );
    const reopened = new JsonStore(dir);
    expect(reopened.get().firstSeen).toEqual({});
    expect(reopened.get().aliases['dev-192.168.2.1']).toBe('网关');
  });

  it('Scheduler：hydrateFirstSeen 后新建记录用持久值；未覆盖的 IP 用当前时间', () => {
    const scheduler = new Scheduler({
      prefix: '192.168.2.',
      hosts: [],
      selfIp: null,
      gateway: null,
      subnetLabel: '192.168.2.0/24',
      autoScanIntervalSec: 0,
      forceDemo: false,
      snmpEnabled: true,
      useMdns: false,
    });
    scheduler.hydrateFirstSeen({ '192.168.2.52': T0 });
    const inner = scheduler as unknown as {
      ensureRecord: (ip: string, at: number) => { firstSeen: number };
    };
    expect(inner.ensureRecord('192.168.2.52', T0 + 999_999).firstSeen).toBe(T0);
    expect(inner.ensureRecord('192.168.2.99', T0 + 999_999).firstSeen).toBe(T0 + 999_999);
    expect(scheduler.exportFirstSeen()).toEqual({ '192.168.2.52': T0, '192.168.2.99': T0 + 999_999 });
  });
});

// ———————— E. ARP 冲突解析 ————————

describe('E. collectArpConflicts（同 IP 多 MAC 侦测）', () => {
  it('同 IP 两个不同 MAC → 1 条冲突，macs 保序去重', () => {
    const conflicts = collectArpConflicts([
      { ip: '192.168.2.52', mac: 'aa-aa-aa-aa-aa-aa', iface: '以太网' },
      { ip: '192.168.2.52', mac: 'bb-bb-bb-bb-bb-bb', iface: 'WLAN' },
    ]);
    expect(conflicts).toEqual([{ ip: '192.168.2.52', macs: ['aa-aa-aa-aa-aa-aa', 'bb-bb-bb-bb-bb-bb'] }]);
  });

  it('同 IP 同 MAC 重复行（多网卡同条目）不算冲突', () => {
    const conflicts = collectArpConflicts([
      { ip: '192.168.2.1', mac: 'aa-aa-aa-aa-aa-aa', iface: '以太网' },
      { ip: '192.168.2.1', mac: 'aa-aa-aa-aa-aa-aa', iface: 'WLAN' },
    ]);
    expect(conflicts).toEqual([]);
  });

  it('无冲突时返回空数组；不同 IP 各自独立判定', () => {
    const conflicts = collectArpConflicts([
      { ip: '192.168.2.1', mac: 'aa-aa-aa-aa-aa-aa', iface: null },
      { ip: '192.168.2.2', mac: 'bb-bb-bb-bb-bb-bb', iface: null },
    ]);
    expect(conflicts).toEqual([]);
  });
});
