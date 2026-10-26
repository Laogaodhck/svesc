/**
 * G5. NetBIOS 名采集（task-020：`src/main/engine/discovery/netbios.ts`）
 *
 * 关键约束：parseNbtstat 取第一条 `<00> Unique` 为机器名；纯 Group（无 Unique）返回 null。
 * 采集约束（≤8 台/轮、并发 4、单台 2s）为常量锁，防止后续误调把预算吃穿。
 */
import { describe, expect, it } from 'vitest';
import {
  NBTSTAT_CONCURRENCY,
  NBTSTAT_MAX_HOSTS,
  NBTSTAT_TIMEOUT_MS,
  parseNbtstat,
} from '../src/main/engine/discovery/netbios';

describe('G5. parseNbtstat 解析', () => {
  it('应取第一条 <00> Unique 记录为机器名', () => {
    const out = [
      '',
      '    名称             类型             状态',
      '------------------------------------------------------------',
      'WS-FIN-02      <00>  Unique          Registered',
      'WORKGROUP      <00>  Group           Registered',
      'WS-FIN-02      <20>  Unique          Registered',
    ].join('\r\n');
    expect(parseNbtstat(out)).toEqual({ name: 'WS-FIN-02' });
  });

  it('纯 Group 记录（无 Unique）应返回 null（不拿组名当机器名）', () => {
    const out = [
      'WORKGROUP      <00>  Group           Registered',
      'WORKGROUP      <1E>  Group           Registered',
    ].join('\r\n');
    expect(parseNbtstat(out)).toEqual({ name: null });
  });

  it('空输出 / Host not found 应返回 null', () => {
    expect(parseNbtstat('')).toEqual({ name: null });
    expect(parseNbtstat('Host not found.')).toEqual({ name: null });
  });

  it('机器名两端的空白应被裁剪', () => {
    const out = '\r\n   DESK-ABC       <00>  Unique          Registered\r\n';
    expect(parseNbtstat(out)).toEqual({ name: 'DESK-ABC' });
  });

  it('采集约束常量锁（预算保护）', () => {
    // task-027 8→16、并发 4→16：并发=上限 → 16 台单波完成，最坏墙钟=单台超时 2s（2.6s 旅标内）
    expect(NBTSTAT_MAX_HOSTS).toBe(16);
    expect(NBTSTAT_CONCURRENCY).toBe(16);
    expect(NBTSTAT_TIMEOUT_MS).toBe(2000);
  });
});
