/**
 * 打印机异常主动提醒的判定层（纯逻辑，不 import electron，可在 Node 下直测）。
 *
 * 语义：
 *  - 只在**状态转移**时产生提醒：从正常进入离线/故障/警告/耗材不足 → fault；
 *    回到正常 → recovered。同一问题不会每帧重复通知。
 *  - 首次 evaluate 只建立基线，不产生通知——应用启动时不应把存量故障刷成弹窗。
 *  - 同一台打印机的故障通知有冷却窗口（默认 10 分钟），避免抖动刷屏；
 *    冷却期内的问题变化仍更新基线，恢复后再次异常会重新通知。
 *  - 演示数据（source=simulated）与本机虚拟打印机（PDF/XPS/Fax）不参与。
 *  - 恢复提醒只在"曾通知过故障"后发出，避免启动/冷却期产生伪恢复。
 */
import type { Printer, PrinterState } from '../../../shared/types';

export type PrinterAlertKind = 'fault' | 'recovered';

export interface PrinterAlert {
  printerId: string;
  /** 显示名（别名优先） */
  printerName: string;
  kind: PrinterAlertKind;
  state: PrinterState;
  /** 中文原因；恢复时为"已恢复正常" */
  reason: string;
}

const FAULT_STATES: ReadonlySet<PrinterState> = new Set(['offline', 'error', 'warning']);
const STATE_REASON: Record<string, string> = {
  offline: '设备离线',
  error: '打印机故障',
  warning: '打印机警告',
};
const LOW_SUPPLY_PCT = 10;
export const DEFAULT_ALERT_COOLDOWN_MS = 10 * 60_000;

function isAlertsExcluded(printer: Printer): boolean {
  return printer.source === 'simulated' || printer.connection === 'virtual';
}

/**
 * 该打印机当前的问题描述；null = 正常（无可提醒问题）。
 * 状态与耗材可同时成立（如"设备离线 · 耗材不足：Black Toner 8%"）。
 */
export function printerIssue(printer: Printer): string | null {
  if (isAlertsExcluded(printer)) return null;
  const parts: string[] = [];
  if (FAULT_STATES.has(printer.state)) {
    const detail = printer.stateDetail?.trim();
    parts.push(detail ? `${STATE_REASON[printer.state] ?? printer.state}（${detail}）` : (STATE_REASON[printer.state] ?? printer.state));
  }
  const low = printer.consumables.filter(
    (c) => c.source !== 'unknown' && c.levelPct !== null && c.levelPct <= LOW_SUPPLY_PCT,
  );
  if (low.length > 0) {
    const labels = low.map((c) => `${c.label || c.kind} ${Math.max(0, Math.round(c.levelPct ?? 0))}%`);
    parts.push(`耗材不足：${labels.join('、')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** 有状态的时间线判定器：每次快照喂一遍，返回本轮应产生的提醒。 */
export class PrinterAlertTracker {
  private baseline = new Map<string, string | null>();
  private lastNotifiedAt = new Map<string, number>();
  private seeded = false;

  constructor(private readonly cooldownMs: number = DEFAULT_ALERT_COOLDOWN_MS) {}

  /** `printers` 应为快照中"未被忽略"的打印机列表（忽略项已在引擎侧过滤）。 */
  evaluate(printers: readonly Printer[], now: number = Date.now()): PrinterAlert[] {
    const alerts: PrinterAlert[] = [];
    const seen = new Set<string>();

    for (const printer of printers) {
      seen.add(printer.id);
      const issue = printerIssue(printer);
      const name = printer.alias ?? printer.name;
      if (!this.seeded) {
        this.baseline.set(printer.id, issue);
        continue;
      }
      // 新出现的条目（含被恢复监控/新发现）只建基线：没有"转移"可比，不补弹存量故障
      if (!this.baseline.has(printer.id)) {
        this.baseline.set(printer.id, issue);
        continue;
      }
      const previous = this.baseline.get(printer.id) ?? null;
      if (issue === previous) continue;
      this.baseline.set(printer.id, issue);

      if (issue !== null) {
        const last = this.lastNotifiedAt.get(printer.id);
        if (last !== undefined && now - last < this.cooldownMs) continue;
        this.lastNotifiedAt.set(printer.id, now);
        alerts.push({ printerId: printer.id, printerName: name, kind: 'fault', state: printer.state, reason: issue });
        continue;
      }
      // 恢复到正常：只有确实通知过故障才提醒恢复
      if (!this.lastNotifiedAt.has(printer.id)) continue;
      this.lastNotifiedAt.delete(printer.id);
      alerts.push({ printerId: printer.id, printerName: name, kind: 'recovered', state: printer.state, reason: '已恢复正常' });
    }

    if (!this.seeded) {
      this.seeded = true;
    } else {
      // 从快照消失（被忽略/移除）的打印机清账本：重新出现时重建基线，不误报恢复
      for (const id of [...this.baseline.keys()]) {
        if (seen.has(id)) continue;
        this.baseline.delete(id);
        this.lastNotifiedAt.delete(id);
      }
    }
    return alerts;
  }
}
