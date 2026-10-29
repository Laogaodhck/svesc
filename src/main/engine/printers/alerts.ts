// 打印机提醒账本仅属于本次运行；采集样本推进观察，读取投影无副作用。
import type { Printer, PrinterState } from '../../../shared/types';

export type PrinterAlertKind = 'fault' | 'recovered';

export interface PrinterAlert {
  printerId: string;
  printerName: string;
  kind: PrinterAlertKind;
  state: PrinterState;
  reason: string;
  firstObservedAt: number;
}

const FAULT_STATES: ReadonlySet<PrinterState> = new Set(['offline', 'error', 'warning']);
const STATE_REASON: Record<string, string> = {
  offline: '设备离线',
  error: '打印机故障',
  warning: '打印机警告',
};
const LOW_SUPPLY_PCT = 10;
export const DEFAULT_ALERT_COOLDOWN_MS = 10 * 60_000;
export const DEFAULT_ALERT_REPEAT_MS = 30 * 60_000;
export const OFFLINE_CONFIRM_MS = 30_000;

function isAlertsExcluded(printer: Printer): boolean {
  return printer.source === 'simulated' || printer.id.startsWith('sim-') || printer.connection === 'virtual';
}

/** null 表示没有已知问题，但 unknown 状态不能据此判为恢复。 */
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

interface FaultEpisode {
  firstObservedAt: number;
  initialNotifyAt: number;
  offlineSince: number | null;
  lastNotifiedAt: number | null;
  lastNotifiedReason: string | null;
}

interface ObservedPrinter {
  lastSeen: number;
  fault: FaultEpisode | null;
}

export class PrinterAlertTracker {
  private readonly observed = new Map<string, ObservedPrinter>();

  constructor(private readonly cooldownMs: number = DEFAULT_ALERT_COOLDOWN_MS) {}

  /** 仅在快照推送时调用；notify 返回 true 才记为已发送，关闭/无出口时仍保留观察时间。 */
  evaluate(
    printers: readonly Printer[],
    now: number = Date.now(),
    notify?: (alert: PrinterAlert) => boolean,
  ): PrinterAlert[] {
    const alerts: PrinterAlert[] = [];
    const seen = new Set<string>();

    for (const printer of printers) {
      if (isAlertsExcluded(printer)) continue;
      seen.add(printer.id);
      const previous = this.observed.get(printer.id);
      // 心跳、元数据推送和乱序旧样本都不能确认新异常或恢复，也不以陈旧数据补发提醒。
      if (!Number.isFinite(printer.lastSeen) || (previous && printer.lastSeen <= previous.lastSeen)) continue;
      const entry: ObservedPrinter = previous ?? { lastSeen: printer.lastSeen, fault: null };
      entry.lastSeen = printer.lastSeen;
      this.observed.set(printer.id, entry);
      const issue = printerIssue(printer);
      const base = { printerId: printer.id, printerName: printer.alias ?? printer.name, state: printer.state };

      if (issue === null) {
        if (printer.state === 'unknown') {
          if (entry.fault) entry.fault.offlineSince = null;
          continue;
        }
        const fault = entry.fault;
        entry.fault = null;
        if (fault?.lastNotifiedAt == null) continue;
        const alert: PrinterAlert = { ...base, kind: 'recovered', reason: '已恢复正常', firstObservedAt: fault.firstObservedAt };
        if (notify?.(alert)) alerts.push(alert);
        continue;
      }

      entry.fault ??= {
        firstObservedAt: now,
        initialNotifyAt: previous ? now : now + DEFAULT_ALERT_REPEAT_MS,
        offlineSince: null,
        lastNotifiedAt: null,
        lastNotifiedReason: null,
      };
      const fault = entry.fault;
      fault.offlineSince = printer.state === 'offline' ? (fault.offlineSince ?? now) : null;
      if (fault.offlineSince !== null && now - fault.offlineSince < OFFLINE_CONFIRM_MS) continue;
      if (now < fault.initialNotifyAt) continue;
      if (fault.lastNotifiedAt !== null) {
        const interval = issue === fault.lastNotifiedReason ? DEFAULT_ALERT_REPEAT_MS : this.cooldownMs;
        if (now - fault.lastNotifiedAt < interval) continue;
      }
      const alert: PrinterAlert = { ...base, kind: 'fault', reason: issue, firstObservedAt: fault.firstObservedAt };
      if (!notify?.(alert)) continue;
      fault.lastNotifiedAt = now;
      fault.lastNotifiedReason = issue;
      alerts.push(alert);
    }

    for (const id of this.observed.keys()) {
      if (!seen.has(id)) this.observed.delete(id);
    }
    return alerts;
  }

  /** 只读投影；首次观察不是设备真实故障起点，不跨运行持久化。 */
  project(printers: readonly Printer[]): Printer[] {
    return printers.map((printer) => ({
      ...printer,
      firstObservedAt: isAlertsExcluded(printer) ? null : (this.observed.get(printer.id)?.fault?.firstObservedAt ?? null),
    }));
  }
}
