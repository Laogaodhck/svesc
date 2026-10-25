/**
 * 运行日志环形缓冲（诊断中心 / 日志页数据源）。
 *
 * 设计要点：
 *  - 引擎层各模块调用 push() 写入运行事件，list() 按 ts 倒序吐给渲染层；
 *  - 环形上限默认 DIAG.logRingMax，超出裁最旧：truncated=true 表示
 *    "缓冲内还有更早数据被裁掉"，UI 必须提示而不是假装全量；
 *  - exportNdjson 一次性同步写文件（主进程低频操作，无需异步流），
 *    失败（磁盘满 / 权限）必须返回 { ok:false, error }，绝不抛——
 *    日志导出失败不能拖垮调用方（数据诚实铁律：失败要有文案）。
 *
 * 本文件不 import electron，可被 vitest 在纯 Node 下直接导入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIAG } from '../../../shared/constants';
import type { LogBundle, LogEntry } from '../../../shared/types';

export type LogLevel = LogEntry['level'];

export class NetLog {
  private entries: LogEntry[] = [];
  private readonly ringMax: number;
  /** 环形滚动累计裁掉的条数：只要 > 0，list() 就必须置 truncated=true（有更早数据已丢失） */
  private dropped = 0;

  constructor(ringMax: number = DIAG.logRingMax) {
    this.ringMax = ringMax;
  }

  /**
   * 写入一条日志。at 缺省取当前时间（引擎层偶尔需要回填测试时间戳）。
   * 环形滚动：超过 ringMax 时裁掉最旧的一条。
   */
  push(level: LogLevel, source: string, message: string, at?: number): void {
    const entry: LogEntry = {
      ts: at ?? Date.now(),
      level,
      source,
      message,
    };
    this.entries.push(entry);
    while (this.entries.length > this.ringMax) {
      this.entries.shift();
      this.dropped += 1;
    }
  }

  /**
   * 查询最近 limit 条（按 ts 倒序，最新在前）。
   * total = 缓冲内全部条数；truncated = 环形滚动裁掉过数据（dropped > 0）
   * 或本次 limit 裁掉了缓冲内的更早条目——两种情况都表示
   * "entries 不是全量历史"，UI 必须可感知。
   */
  list(limit: number = 100): LogBundle {
    const sorted = [...this.entries].sort((a, b) => b.ts - a.ts);
    const entries = sorted.slice(0, Math.max(0, limit));
    return {
      entries,
      total: this.entries.length,
      truncated: this.dropped > 0 || this.entries.length > entries.length,
    };
  }

  /**
   * 导出 NDJSON 到 dir。文件名 `svesc-logs-<ISO时间戳>.ndjson`
   * （冒号替换为 '-'，Windows 路径不允许冒号）。
   * 文件第一行写 _meta（导出时间与条数），之后每行一个 LogEntry JSON。
   * 成功返回 { ok:true, path }；任何 I/O 失败返回 { ok:false, error }，绝不抛。
   */
  exportNdjson(
    dir: string,
    limit: number = DIAG.logExportLimit,
  ): { ok: boolean; path: string | null; error?: string } {
    try {
      const sorted = [...this.entries].sort((a, b) => b.ts - a.ts);
      const picked = sorted.slice(0, Math.max(0, limit));
      // ISO 时间戳形如 2026-10-25T09:30:00.000Z，Windows 文件名不允许冒号
      const stamp = new Date().toISOString().replace(/:/g, '-');
      const file = path.join(dir, `svesc-logs-${stamp}.ndjson`);
      fs.mkdirSync(dir, { recursive: true });
      const meta = JSON.stringify({
        _meta: { exportedAt: Date.now(), count: picked.length },
      });
      const body = picked.map((e) => JSON.stringify(e)).join('\n');
      fs.writeFileSync(file, body ? `${meta}\n${body}\n` : `${meta}\n`, 'utf8');
      return { ok: true, path: file };
    } catch (err) {
      return {
        ok: false,
        path: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 清空缓冲（日志页"清空"按钮）。dropped 一并归零：用户已主动放弃历史。 */
  clear(): void {
    this.entries = [];
    this.dropped = 0;
  }
}
