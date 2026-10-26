/**
 * 全面审计修复（2026-10-25）的回归锁（告警子系统移除后仅存 JsonStore 项）：
 *
 *  JsonStore：落盘失败必须经 onWriteError 通报（err）并在恢复后通报（null）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/main/engine/store';

describe('审计：JsonStore 落盘失败可感知 + 重试', () => {
  it('写入失败 → onWriteError(Error)；恢复后 → onWriteError(null)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svesc-store-fail-'));
    // 让"状态文件"路径变成一个目录：writeFileSync 必然失败（EISDIR/EPERM，跨平台）
    const filePath = path.join(dir, 'svesc-state.json');
    mkdirSync(filePath);

    const events: Array<Error | null> = [];
    const store = new JsonStore(dir, 'svesc-state.json', 10, (err) => events.push(err));
    store.setAlias('dev-1', '别名');

    // debounce(10ms) 后的落盘失败必须被通报
    await new Promise((r) => setTimeout(r, 80));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toBeInstanceOf(Error);

    // 排除障碍 → 重试定时器（5s）来不及跑，手动 flush 应成功并通报恢复
    rmSync(filePath, { recursive: true });
    store.flush();
    expect(events[events.length - 1]).toBeNull();
    const raw = JSON.parse(readFileSync(store.filePath, 'utf8')) as { aliases?: Record<string, string> };
    expect(raw.aliases?.['dev-1']).toBe('别名');
  });
});
