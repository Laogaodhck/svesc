/**
 * RFC 3805（Printer MIB）OID 常量与解析。
 *
 * 数据诚实原则（brief §9.6 / plan.md §3）：
 *  - 耗材无数据 → `consumables: []` + 无告警，**绝不填 0**
 *  - `prtMarkerSuppliesMaxCapacity` 为 -1/-2/-3 时按 RFC 语义视为"未知/无限/无限但有余量"
 *    → `levelPct = null`，只保留 `current`/`maxCapacity` 原值
 *  - 页计数拿不到 → `pageCount: null`
 */
import type { Consumable, ConsumableKind } from '../../../shared/types';
import type { Varbind } from './snmp-ber';

export const OID = {
  /** 1.3.6.1.2.1.1.1.0 */
  sysDescr: '1.3.6.1.2.1.1.1.0',
  /** 1.3.6.1.2.1.1.5.0 */
  sysName: '1.3.6.1.2.1.1.5.0',
  /** 1.3.6.1.2.1.25.3.2.1.5 —— hrDeviceStatus */
  hrDeviceStatus: '1.3.6.1.2.1.25.3.2.1.5',
  /** 1.3.6.1.2.1.43.10.2.1.4 —— prtMarkerLifeCount */
  prtMarkerLifeCount: '1.3.6.1.2.1.43.10.2.1.4',
  /** 1.3.6.1.2.1.43.11.1.1 —— prtMarkerSupplies 表 */
  suppliesTable: '1.3.6.1.2.1.43.11.1.1',
  /** 43.11.1.1.5 —— prtMarkerSuppliesType */
  suppliesType: '1.3.6.1.2.1.43.11.1.1.5',
  /** 43.11.1.1.6 —— prtMarkerSuppliesDescription */
  suppliesDescription: '1.3.6.1.2.1.43.11.1.1.6',
  /** 43.11.1.1.8 —— prtMarkerSuppliesMaxCapacity */
  suppliesMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8',
  /** 43.11.1.1.9 —— prtMarkerSuppliesLevel */
  suppliesLevel: '1.3.6.1.2.1.43.11.1.1.9',
  /** 43.18.1.1.8 —— prtAlertDescription */
  prtAlertDescription: '1.3.6.1.2.1.43.18.1.1.8',
  /** 43.16.5.1.2 —— prtConsoleDisplayBufferText（面板文本） */
  prtConsoleDisplayBufferText: '1.3.6.1.2.1.43.16.5.1.2',
} as const;

/** RFC 3805 prtMarkerSuppliesType 枚举（只列与本项目相关的值）。 */
export const SUPPLY_TYPE = {
  other: 1,
  unknown: 2,
  toner: 3,
  wasteToner: 4,
  ink: 5,
  inkCartridge: 6,
  inkRibbon: 7,
  wasteInk: 8,
  opc: 9,
  developer: 10,
  fuser: 11,
  cleaner: 12,
  transfer: 13,
  staples: 21,
  wasteStaples: 22,
  bindingSupply: 23,
  bandingSupply: 24,
} as const;

/** 由 description 文本推断耗材颜色/类型（brief §3 printer-mib.ts 规定）。 */
export function inferSupplyKind(description: string, typeCode?: number | null): ConsumableKind {
  const d = description.toLowerCase();
  if (/waste|废粉|廢碳|回收|waste\s*toner/.test(d)) return 'waste';
  if (/drum|感光|感光鼓|opc|photoconductor/.test(d)) return 'drum';
  if (/cyan|青色|青/.test(d)) return 'cyan';
  if (/magenta|品红|洋红|洋紅|红/.test(d) && !/yellow/.test(d)) return 'magenta';
  if (/yellow|黄色|黃/.test(d)) return 'yellow';
  if (/black|黑色|黑/.test(d)) return 'black';

  switch (typeCode ?? 0) {
    case SUPPLY_TYPE.wasteToner:
    case SUPPLY_TYPE.wasteInk:
    case SUPPLY_TYPE.wasteStaples:
      return 'waste';
    case SUPPLY_TYPE.opc:
      return 'drum';
    default:
      return 'other';
  }
}

/**
 * 计算百分比。maxCapacity <= 0 表示符合 RFC 3805 的"未知/无限"语义 → null。
 * level < 0 同样表示"未知/有余量"→ null。绝不把 -3 换算成 -3%。
 */
export function toLevelPct(current: number | null, maxCapacity: number | null): number | null {
  if (current === null || maxCapacity === null) return null;
  if (current < 0) return null;
  if (maxCapacity <= 0) return null;
  const pct = (current / maxCapacity) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

function defaultLabel(kind: ConsumableKind): string {
  switch (kind) {
    case 'black':
      return '黑色';
    case 'cyan':
      return '青色';
    case 'magenta':
      return '品红';
    case 'yellow':
      return '黄色';
    case 'drum':
      return '感光鼓';
    case 'waste':
      return '废粉仓';
    default:
      return '耗材';
  }
}

interface SupplyRow {
  description: string;
  typeCode: number | null;
  maxCapacity: number | null;
  level: number | null;
}

/** 从 supplies 表 walk 结果中按 `<column>.<hrIndex>.<supplyIndex>` 聚合出行。 */
export function groupSupplyRows(varbinds: Varbind[]): SupplyRow[] {
  const rows = new Map<string, SupplyRow>();
  for (const vb of varbinds) {
    if (!vb.oid.startsWith(`${OID.suppliesTable}.`)) continue;
    const parts = vb.oid.split('.');
    if (parts.length < 13) continue;
    const column = Number(parts[10]);
    const key = `${parts[11]}.${parts[12]}`;
    const row = rows.get(key) ?? { description: '', typeCode: null, maxCapacity: null, level: null };
    if (column === 5 && typeof vb.value === 'number') row.typeCode = vb.value;
    if (column === 6) row.description = typeof vb.value === 'string' ? vb.value : String(vb.value ?? '');
    if (column === 8 && typeof vb.value === 'number') row.maxCapacity = vb.value;
    if (column === 9 && typeof vb.value === 'number') row.level = vb.value;
    rows.set(key, row);
  }
  return Array.from(rows.values()).filter(
    (r) => r.description !== '' || r.typeCode !== null || r.level !== null || r.maxCapacity !== null,
  );
}

/** supplies walk 结果 → 契约 Consumable[]。source 恒为 'snmp'。 */
export function parseSupplies(varbinds: Varbind[]): Consumable[] {
  return groupSupplyRows(varbinds).map((row) => {
    const kind = inferSupplyKind(row.description, row.typeCode);
    return {
      kind,
      label: row.description.trim() || defaultLabel(kind),
      levelPct: toLevelPct(row.level, row.maxCapacity),
      maxCapacity: row.maxCapacity,
      current: row.level,
      source: 'snmp',
    };
  });
}

/**
 * prtMarkerLifeCount → pageCount。
 * 多 marker 时取**最大值**（单通道页计数），不做求和（求和会把彩色/黑白重复计入，属于造数）。
 */
export function parseMarkerLifeCount(varbinds: Varbind[]): number | null {
  let max: number | null = null;
  for (const vb of varbinds) {
    if (!vb.oid.startsWith(`${OID.prtMarkerLifeCount}.`)) continue;
    if (typeof vb.value !== 'number' || vb.value < 0) continue;
    if (max === null || vb.value > max) max = vb.value;
  }
  return max;
}

/** sysDescr 原文（首行、截断 120 字符，保留给详情排查固件）。取不到返回 null。 */
export function parseSysDescr(value: number | string | null): string | null {
  if (typeof value !== 'string') return null;
  const firstLine = value.split(/\r?\n/)[0]?.trim() ?? '';
  if (!firstLine) return null;
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

/** 型号上限（字符）：超过用 `…` 截断，避免把固件版本串拖进卡片。 */
export const MODEL_MAX_CHARS = 40;

/**
 * 清洗型号字符串（**纯函数**，Tess 可直接断言）。
 *
 * sysDescr 原文常见形态：
 *   `Xerox AltaLink C8055; SS 103.002.042.33200; NC 103.003.032.33200; ...`
 * 取第一个 `;` 之前的部分即可得到人能读的型号；其余固件版本号不属于型号。
 *
 * 规则：null/空白 → null；只取首行；截到首个 `;`/`；`；合并空白；去首尾成对括号/引号；
 * 超 `MODEL_MAX_CHARS` 用 `…` 截断（保留前 39 字符 + 省略号）。
 */
export function sanitizeModel(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const firstLine = raw.split(/\r?\n/)[0] ?? '';
  const head = firstLine.split(/[;；]/)[0] ?? '';
  let text = head.replace(/\s+/g, ' ').trim();
  text = text.replace(/^[\s（(\[【"'“]+|[\s）)\]】"'”]+$/g, '').trim();
  if (!text) return null;
  if (text.length > MODEL_MAX_CHARS) {
    text = `${text.slice(0, MODEL_MAX_CHARS - 1).trimEnd()}…`;
  }
  return text;
}

/** 面板文本拼接（prtConsoleDisplayBufferText 通常被切成多行）。 */
export function parsePanelText(varbinds: Varbind[]): string | null {
  const lines = varbinds
    .filter((vb) => vb.oid.startsWith(OID.prtConsoleDisplayBufferText))
    .map((vb) => (typeof vb.value === 'string' ? vb.value : ''))
    .filter((s) => s.trim() !== '');
  if (lines.length === 0) return null;
  return lines.join(' ').trim();
}

/** hrDeviceStatus → PrinterState 的粗粒度映射（1=other,2=unknown,3=running,4=warning,5=testing,6=down）。 */
export function mapHrDeviceStatus(status: number | string | null): 'idle' | 'warning' | 'error' | 'unknown' {
  switch (status) {
    case 3:
      return 'idle';
    case 4:
      return 'warning';
    case 5:
      return 'warning';
    case 6:
      return 'error';
    default:
      return 'unknown';
  }
}
