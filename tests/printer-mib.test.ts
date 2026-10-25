/**
 * printer-mib 纯函数单测 —— 型号清洗 + 耗材百分比 + Supplie 表聚合 + 状态映射。
 *
 * 这些函数全部注入式、无网络、无 Electron，是本项目"数据诚实原则"（brief §9.6）的落地点：
 *  - 耗材拿不到 → `levelPct: null`，**绝不填 0**
 *  - 型号被塞进完整 sysDescr → 只保留人能读的部分，**不把固件版本拖进卡片**
 */
import { describe, expect, it } from 'vitest';
import {
  MODEL_MAX_CHARS,
  OID,
  SUPPLY_TYPE,
  groupSupplyRows,
  inferSupplyKind,
  mapHrDeviceStatus,
  parseMarkerLifeCount,
  parsePanelText,
  parseSupplies,
  parseSysDescr,
  sanitizeModel,
  toLevelPct,
} from '../src/main/engine/printers/printer-mib';
import type { Varbind } from '../src/main/engine/printers/snmp-ber';

/** 构造 SNMP varbind（type/raw 对纯函数无意义，占位即可）。 */
function vb(oid: string, value: number | string | null): Varbind {
  const type = value === null ? 0x05 : typeof value === 'number' ? 0x02 : 0x04;
  return { oid, type, value, raw: Buffer.alloc(0) };
}

/** supplies 表某列某行：`<table>.<column>.<hrIndex>.<supplyIndex>` */
function supplyVb(column: number, row: number, value: number | string | null): Varbind {
  return vb(`${OID.suppliesTable}.${column}.1.${row}`, value);
}

describe('sanitizeModel —— 型号清洗（纯函数，Max-1 导出）', () => {
  it('null 输入应返回 null', () => {
    expect(sanitizeModel(null)).toBeNull();
  });

  it('undefined 输入应返回 null', () => {
    expect(sanitizeModel(undefined)).toBeNull();
  });

  it('空字符串应返回 null', () => {
    expect(sanitizeModel('')).toBeNull();
  });

  it('全空白（空格/制表/换行）应返回 null', () => {
    expect(sanitizeModel('   \t \n ')).toBeNull();
  });

  it('多行输入只取首行（sysDescr 第二行常是固件串）', () => {
    expect(sanitizeModel('Xerox\nSS 123')).toBe('Xerox');
  });

  it('半角分号后的固件版本必须被切掉', () => {
    const raw = 'Xerox AltaLink C8055; SS 103.002.042.33200; NC 103.003.032.33200';
    expect(sanitizeModel(raw)).toBe('Xerox AltaLink C8055');
  });

  it('全角分号（中文设备常见）同样必须被切掉', () => {
    expect(sanitizeModel('SHARP MX-B4621R PCL6；固件 01.02')).toBe('SHARP MX-B4621R PCL6');
  });

  it('清洗结果不得残留固件版本号（防止只做长度截断不做分号切分）', () => {
    const model = sanitizeModel('Xerox AltaLink C8055; SS 103.002.042.33200');
    expect(model).not.toMatch(/SS\s*\d|103\.002/);
  });

  it('连续空白应合并为单个空格并去首尾（真机 DriverName 常带双空格）', () => {
    expect(sanitizeModel('  HP LaserJet  M404dn  ')).toBe('HP LaserJet M404dn');
  });

  it('成对的圆括号应被去掉', () => {
    expect(sanitizeModel('(Canon MF750C)')).toBe('Canon MF750C');
  });

  it('成对的双引号应被去掉', () => {
    expect(sanitizeModel('"Epson L3250"')).toBe('Epson L3250');
  });

  it('首个字符就是分号时（型号缺失）应返回 null 而不是空串', () => {
    expect(sanitizeModel('; SS 103')).toBeNull();
  });

  it('只有括号没有内容时应返回 null', () => {
    expect(sanitizeModel('(  )')).toBeNull();
  });

  it(`恰好 ${MODEL_MAX_CHARS} 字符不应被截断（边界内）`, () => {
    const exact = 'A'.repeat(MODEL_MAX_CHARS);
    expect(sanitizeModel(exact)).toBe(exact);
  });

  it(`超过 ${MODEL_MAX_CHARS} 字符应保留前 ${MODEL_MAX_CHARS - 1} 字符加省略号`, () => {
    expect(sanitizeModel('A'.repeat(MODEL_MAX_CHARS + 1))).toBe(`${'A'.repeat(MODEL_MAX_CHARS - 1)}…`);
  });

  it('超长截断后的总长度必须等于上限（不多不少）', () => {
    expect(sanitizeModel('A'.repeat(60))).toHaveLength(MODEL_MAX_CHARS);
  });

  it('截断必须用中文省略号 …，不得用三个点（表格列宽按 1 字符算）', () => {
    const model = sanitizeModel('A'.repeat(60));
    expect(model?.endsWith('…')).toBe(true);
    expect(model).not.toContain('...');
  });

  it('任意输入清洗后长度都不得超过 MODEL_MAX_CHARS', () => {
    const inputs = ['A'.repeat(200), '佳能 imageRUNNER ADVANCE C5535i 多功能数码复合机 打印机 复印机', '(HP '.repeat(30)];
    for (const input of inputs) {
      const model = sanitizeModel(input);
      expect(model === null || model.length <= MODEL_MAX_CHARS).toBe(true);
    }
  });

  it('清洗应是幂等的（对已清洗结果再清一次不得变化），否则调用点两次清洗会漂移', () => {
    const once = sanitizeModel('Xerox AltaLink C8055; SS 103.002.042.33200');
    expect(sanitizeModel(once)).toBe(once);
  });

  it('中文长型号截断后不得把首尾空白留在结果里', () => {
    const model = sanitizeModel('佳能 imageRUNNER ADVANCE C5535i 多功能数码复合机 打印机 复印机');
    expect(model?.startsWith('佳能')).toBe(true);
    expect(model?.endsWith(' ')).toBe(false);
  });
});

describe('toLevelPct —— 耗材百分比（RFC 3805 诚实语义）', () => {
  it('正常值应按比例换算（75/100 → 75）', () => {
    expect(toLevelPct(75, 100)).toBe(75);
  });

  it('结果保留一位小数（1/3 → 33.3，不得四舍五入到整数丢精度）', () => {
    expect(toLevelPct(1, 3)).toBe(33.3);
  });

  it('超过最大容量时钳到 100（个别设备 maxCapacity 填错也不得产出 150%）', () => {
    expect(toLevelPct(150, 100)).toBe(100);
  });

  it('maxCapacity 为 0 时应返回 null（不得产生 NaN 或 Infinity）', () => {
    expect(toLevelPct(10, 0)).toBeNull();
  });

  it('maxCapacity 为 -1（RFC 3805 "无限"）时应返回 null', () => {
    expect(toLevelPct(10, -1)).toBeNull();
  });

  it('current 为 -3（RFC "未知/有余量"）时应返回 null，绝不换算成 -3%', () => {
    expect(toLevelPct(-3, 100)).toBeNull();
  });

  it('current 为 null 时应返回 null（不得把未知当 0%）', () => {
    expect(toLevelPct(null, 100)).toBeNull();
  });

  it('maxCapacity 为 null 时应返回 null（数据缺失不得填 0）', () => {
    expect(toLevelPct(10, null)).toBeNull();
  });
});

describe('inferSupplyKind —— 耗材种类推断', () => {
  it('描述含 black 应识别为黑色', () => {
    expect(inferSupplyKind('Black Toner Cartridge')).toBe('black');
  });

  it('描述含 cyan 应识别为青色', () => {
    expect(inferSupplyKind('Cyan Toner')).toBe('cyan');
  });

  it('描述含 magenta 应识别为品红', () => {
    expect(inferSupplyKind('Magenta Toner')).toBe('magenta');
  });

  it('部件类型优先于颜色：Magenta Drum 归为 drum（label 仍保留原文，颜色信息不丢）', () => {
    expect(inferSupplyKind('Magenta Drum')).toBe('drum');
  });

  it('四色鼓的真实描述 Cyan Drum Unit 必须归为 drum，不得被拆成 4 条碳粉条', () => {
    expect(
      inferSupplyKind('Cyan Drum Unit'),
      '若把 drum 排到颜色之后，四色鼓会变成 cyan/magenta/yellow/black 四条耗材，UI 会把"鼓"当碳粉条显示',
    ).toBe('drum');
  });

  it('描述含 yellow 应识别为黄色（不得被品红规则里的"红"误吞）', () => {
    expect(inferSupplyKind('Yellow Toner')).toBe('yellow');
  });

  it('描述含 waste 应识别为废粉仓（waste 优先于 toner）', () => {
    expect(inferSupplyKind('Waste Toner Box')).toBe('waste');
  });

  it('描述含 drum 应识别为感光鼓', () => {
    expect(inferSupplyKind('Drum Unit')).toBe('drum');
  });

  it('中文描述"废粉"应识别为废粉仓', () => {
    expect(inferSupplyKind('废粉仓')).toBe('waste');
  });

  it('描述无线索时按 typeCode 兜底（4=wasteToner → waste）', () => {
    expect(inferSupplyKind('', SUPPLY_TYPE.wasteToner)).toBe('waste');
  });

  it('描述与 typeCode 都无线索时应落到 other，不得瞎猜颜色', () => {
    expect(inferSupplyKind('', SUPPLY_TYPE.staples)).toBe('other');
  });
});

describe('parseSupplies / groupSupplyRows —— supplies 表聚合', () => {
  const rows: Varbind[] = [
    supplyVb(6, 1, 'Black Toner Cartridge'),
    supplyVb(5, 1, SUPPLY_TYPE.toner),
    supplyVb(8, 1, 200),
    supplyVb(9, 1, 50),
    supplyVb(6, 2, 'Cyan Toner'),
    supplyVb(8, 2, 200),
    supplyVb(9, 2, 40),
  ];

  it('同一 supplyIndex 的四列应聚合成一条耗材而不是四条', () => {
    expect(groupSupplyRows(rows)).toHaveLength(2);
  });

  it('聚合后应带出 description / level / maxCapacity', () => {
    expect(parseSupplies(rows)[0]).toEqual({
      kind: 'black',
      label: 'Black Toner Cartridge',
      levelPct: 25,
      maxCapacity: 200,
      current: 50,
      source: 'snmp',
    });
  });

  it('耗材 source 恒为 snmp（UI 据此显示数据来源）', () => {
    expect(parseSupplies(rows).every((c) => c.source === 'snmp')).toBe(true);
  });

  it('maxCapacity 为 -1 时 levelPct 必须为 null，但 current/maxCapacity 原值要保留', () => {
    const unknown = parseSupplies([supplyVb(6, 1, 'Toner'), supplyVb(8, 1, -1), supplyVb(9, 1, 10)]);
    expect(unknown[0]?.levelPct).toBeNull();
    expect(unknown[0]?.current).toBe(10);
    expect(unknown[0]?.maxCapacity).toBe(-1);
  });

  it('description 为空时应回落到中文默认标签，不得显示空白行', () => {
    const noDesc = parseSupplies([supplyVb(5, 1, SUPPLY_TYPE.toner), supplyVb(9, 1, 10), supplyVb(8, 1, 100)]);
    expect(noDesc[0]?.label).toBe('耗材');
  });

  it('非 supplies 表的 OID（如 sysDescr）不得被当成耗材', () => {
    expect(parseSupplies([vb(OID.sysDescr, 'Xerox AltaLink C8055')])).toEqual([]);
  });

  it('完全没有 supplies 数据时应返回空数组而不是伪造一条 0% 耗材', () => {
    expect(parseSupplies([])).toEqual([]);
  });
});

describe('parseMarkerLifeCount —— 页计数', () => {
  it('多个 marker 时应取最大值而不是求和（求和会把彩色/黑白重复计入）', () => {
    const varbinds = [vb(`${OID.prtMarkerLifeCount}.1.1`, 12000), vb(`${OID.prtMarkerLifeCount}.1.2`, 8000)];
    expect(parseMarkerLifeCount(varbinds)).toBe(12000);
  });

  it('负值（设备未实现）应被忽略', () => {
    expect(parseMarkerLifeCount([vb(`${OID.prtMarkerLifeCount}.1.1`, -1)])).toBeNull();
  });

  it('没有该 OID 时应返回 null，不得填 0', () => {
    expect(parseMarkerLifeCount([vb(OID.sysDescr, 'Xerox')])).toBeNull();
  });
});

describe('parseSysDescr —— sysDescr 原文（排查固件用）', () => {
  it('多行时只取首行并去除首尾空白', () => {
    expect(parseSysDescr('  Xerox AltaLink C8055  \nSS 103.002')).toBe('Xerox AltaLink C8055');
  });

  it('超过 120 字符应截断并加省略号', () => {
    const long = 'A'.repeat(130);
    expect(parseSysDescr(long)).toBe(`${'A'.repeat(120)}…`);
  });

  it('非字符串输入应返回 null', () => {
    expect(parseSysDescr(42)).toBeNull();
  });

  it('空字符串应返回 null', () => {
    expect(parseSysDescr('   ')).toBeNull();
  });
});

describe('parsePanelText —— 面板文本', () => {
  it('被切成多行的面板文本应用空格拼接成一行', () => {
    const varbinds = [
      vb(`${OID.prtConsoleDisplayBufferText}.1.1`, 'Toner Low'),
      vb(`${OID.prtConsoleDisplayBufferText}.1.2`, 'Load Paper'),
    ];
    expect(parsePanelText(varbinds)).toBe('Toner Low Load Paper');
  });

  it('全是空白行时应返回 null 而不是空串', () => {
    expect(parsePanelText([vb(`${OID.prtConsoleDisplayBufferText}.1.1`, '   ')])).toBeNull();
  });
});

describe('mapHrDeviceStatus —— RFC 2790 hrDeviceStatus 映射', () => {
  it('3=running 应映射为 idle', () => {
    expect(mapHrDeviceStatus(3)).toBe('idle');
  });

  it('4=warning 应映射为 warning', () => {
    expect(mapHrDeviceStatus(4)).toBe('warning');
  });

  it('6=down 应映射为 error', () => {
    expect(mapHrDeviceStatus(6)).toBe('error');
  });

  it('未知状态码/null 应映射为 unknown（不得乐观当成 idle）', () => {
    expect([mapHrDeviceStatus(1), mapHrDeviceStatus(2), mapHrDeviceStatus(null)]).toEqual([
      'unknown',
      'unknown',
      'unknown',
    ]);
  });
});
