import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPowerShell, type RunResult } from '../src/main/engine/exec';
import { MODEL_MAX_CHARS } from '../src/main/engine/printers/printer-mib';
import {
  modelFromDriver,
  parsePortName,
  readSpooler,
  resolvePrinterPort,
  type RawPrinterPort,
  type SpoolerSnapshot,
} from '../src/main/engine/printers/spooler';

// 保留真实 JSON 编解码；所有子进程入口均替换，不进行真实采集或打印。
vi.mock('../src/main/engine/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/exec')>();
  return { ...actual, runPowerShell: vi.fn() };
});

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    cmd: 'powershell', args: [], code: 0, stdout: '', stderr: '',
    timedOut: false, spawnError: null, ms: 0, ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(runPowerShell).mockReset();
  vi.mocked(runPowerShell).mockResolvedValue(result());
});

describe('parsePortName：只接受明确、严格合法的 IPv4', () => {
  it.each([
    ['192.168.1.3', '192.168.1.3'],
    ['  IP_192.168.1.3  ', '192.168.1.3'],
    ['IP_192.168.1.3_1', '192.168.1.3'],
    ['ip_192.168.1.3_12', '192.168.1.3'],
    ['http://192.168.1.3:631/printers/queue', '192.168.1.3'],
    ['https://192.168.1.3/ipp/print?job=1', '192.168.1.3'],
    ['ipp://192.168.1.3:631/ipp/print', '192.168.1.3'],
    ['IPPS://192.168.1.3/ipp/print', '192.168.1.3'],
  ])('%s → %s', (port, ip) => {
    expect(parsePortName(port)).toEqual({ ip, raw: port.trim(), connection: 'network', macInName: null });
  });

  it.each([
    undefined, null, '', 'printer.local', '192.168.1.256', '999.1.1.1',
    '192.168.01.3', '127.1', '0x7f000001', '2130706433', '::1',
    'IP_999.1.1.1', 'IP_192.168.1.256_1', 'IP_192.168.01.3_1',
    'IP_192.168.1.3_backup', 'IP_192.168.1.3_1_2', 'IP_192.168.1.3_',
    'http://999.1.1.1/ipp', 'http://127.1/ipp', 'http://2130706433/ipp',
    'http://0xc0a80103/ipp', 'http://192.168.001.3/ipp', 'http://%31%39%32.168.1.3/ipp',
    'ipp://192.168.1.256/ipp', 'https://192.168.1.3:65536/ipp',
    'http://192.168.1.3:bad/ipp', 'http://192.168.1.3.evil/ipp',
    'http://192.168.1.3@printer.local/ipp', 'ipp://printer.local/192.168.1.3',
    'https://[::1]/ipp', 'socket://192.168.1.3',
  ])('拒绝地址推测：%s', (port) => {
    expect(parsePortName(port)).toMatchObject({ ip: null, connection: 'unknown' });
  });

  it.each(['USB001', 'DOT4_001', 'LPT1:', 'COM1:'])('%s 保持本地连接', (port) => {
    expect(parsePortName(port)).toMatchObject({ connection: 'usb', ip: null });
  });

  it.each(['PORTPROMPT:', 'SHRFAX:', 'FILE:', 'NUL:', 'XPSPort:', 'C:\\Documents\\out.pdf', '\\\\server\\out.xps'])('%s 保持虚拟连接', (port) => {
    expect(parsePortName(port)).toMatchObject({ connection: 'virtual', ip: null });
  });

  it('保留 WSD 名称中的 MAC，但不从名称推断 IP', () => {
    expect(parsePortName('WSD-device', 'Canon (AA:BB:CC:DD:EE:FF) 192.168.1.3')).toEqual({
      raw: 'WSD-device', ip: null, connection: 'network', macInName: 'AA:BB:CC:DD:EE:FF',
    });
    expect(parsePortName('WSD-(aa-bb-cc-dd-ee-ff)')).toMatchObject({ macInName: 'aa-bb-cc-dd-ee-ff' });
    expect(parsePortName('\\\\print-server\\queue')).toMatchObject({ connection: 'network', ip: null });
  });
});

describe('resolvePrinterPort：TCP/IP 端口映射是真实地址证据', () => {
  it('按端口名精确匹配，HostAddress 优先于过时的 IP_ 名称', () => {
    const ports: readonly RawPrinterPort[] = [
      { Name: 'Other', HostAddress: '192.168.1.99' },
      { Name: 'IP_192.168.1.3_1', HostAddress: '192.168.1.8' },
    ];
    expect(resolvePrinterPort({ PortName: 'IP_192.168.1.3_1' }, ports)).toEqual({
      raw: 'IP_192.168.1.3_1', ip: '192.168.1.8', connection: 'network', macInName: null,
    });
  });

  it('自定义端口和 WSD 都可以使用精确匹配的 IPv4，保留 MAC', () => {
    expect(resolvePrinterPort({ PortName: 'OfficePort' }, [{ Name: 'OfficePort', HostAddress: '192.168.1.8' }]))
      .toMatchObject({ ip: '192.168.1.8', connection: 'network' });
    expect(resolvePrinterPort(
      { PortName: 'WSD-device', Name: 'Canon (aa:bb:cc:dd:ee:ff)' },
      [{ Name: 'WSD-device', HostAddress: '192.168.1.8' }],
    )).toMatchObject({ ip: '192.168.1.8', macInName: 'aa:bb:cc:dd:ee:ff' });
  });

  it.each(['printer.local', '192.168.1.256', '192.168.01.3', ' 192.168.1.3 ', '::1', 'http://192.168.1.3', '', undefined])(
    'HostAddress=%s 不能成为 IPv4 证据', (host) => {
      expect(resolvePrinterPort({ PortName: 'OfficePort' }, [{ Name: 'OfficePort', HostAddress: host }]))
        .toMatchObject({ ip: null, connection: 'unknown' });
      expect(resolvePrinterPort({ PortName: 'IP_192.168.1.3_1' }, [{ Name: 'IP_192.168.1.3_1', HostAddress: host }]))
        .toMatchObject({ ip: '192.168.1.3', connection: 'network' });
    },
  );

  it('不做模糊匹配、大小写折叠、空名称匹配或打印机名称匹配', () => {
    const ports = [{ Name: 'OfficePort', HostAddress: '192.168.1.8' }];
    for (const PortName of ['officeport', 'OfficePort_1', ' OfficePort', '', undefined]) {
      expect(resolvePrinterPort({ PortName, Name: 'OfficePort' }, ports).ip).toBeNull();
    }
    expect(resolvePrinterPort({}, [{ HostAddress: '192.168.1.8' }]).ip).toBeNull();
  });

  it.each(['PORTPROMPT:', 'FILE:', 'SHRFAX:', 'XPSPort:', 'USB001', 'DOT4_001', 'LPT1:', 'COM1:'])(
    '错误的 TCP/IP 映射不能把 %s 升级为网络打印机', (PortName) => {
      expect(resolvePrinterPort({ PortName }, [{ Name: PortName, HostAddress: '192.168.1.8' }]))
        .toEqual(parsePortName(PortName));
    },
  );

  it.each(['Microsoft Print to PDF', 'Microsoft XPS Document Writer', 'Send to OneNote 16 Driver', 'Adobe PDF'])(
    '%s 虚拟驱动即使绑定了 IP 端口也不升级为网络打印机', (DriverName) => {
      expect(resolvePrinterPort(
        { PortName: 'IP_192.168.1.3', DriverName },
        [{ Name: 'IP_192.168.1.3', HostAddress: '192.168.1.8' }],
      )).toMatchObject({ ip: null, connection: 'virtual' });
    },
  );

  it('Microsoft IPP 类驱动仍可用于物理网络打印机', () => {
    expect(resolvePrinterPort(
      { PortName: 'OfficePort', DriverName: 'Microsoft IPP Class Driver' },
      [{ Name: 'OfficePort', HostAddress: '192.168.1.8' }],
    )).toMatchObject({ ip: '192.168.1.8', connection: 'network' });
  });

  it('ports 缺失时兼容旧 fixture', () => {
    const oldSnapshot: SpoolerSnapshot = {
      printers: [{ PortName: 'IP_192.168.1.3_1' }], cim: [], jobs: [],
      errors: { printers: null, cim: null, jobs: null }, ms: 0, fallbackUsed: false,
    };
    expect(resolvePrinterPort(oldSnapshot.printers[0]!, oldSnapshot.ports).ip).toBe('192.168.1.3');
  });
});

describe('modelFromDriver：通用驱动不冒充具体型号', () => {
  it.each([
    undefined, null, '', '  ', 'Microsoft IPP Class Driver', 'Canon Generic Plus PCL6',
    'Canon Generic Plus PS3', 'HP Universal Printing PCL 6', 'Xerox Global Universal PS',
    'Generic / Text Only', 'Canon PCL6 Class Driver', '佳能通用打印驱动',
    'PCL6', 'PCL 5e', 'PCL 5/6', 'PS', 'PS3', 'PostScript 3', 'PostScript Level 3', 'Canon PCL6 Printer Driver',
    'HP PS3 (x64)', 'PCL6 Driver 64-bit', 'PCL6 Driver V4', 'Canon Printer Driver',
  ])('%s → null', (driver) => {
    expect(modelFromDriver(driver)).toBeNull();
  });

  it.each(['Canon MF750C', 'Canon MF750C Series UFR II', 'Canon imageCLASS MF750C', 'SHARP MX-B4621R PCL6', 'HP LaserJet M404dn', 'Xerox AltaLink C8055'])('%s 保留具体型号', (driver) => {
    expect(modelFromDriver(driver)).toBe(driver);
  });

  it('清洗并限长，过滤发生在截断之前', () => {
    expect(modelFromDriver('  (Canon MF750C)  ; firmware 1.2')).toBe('Canon MF750C');
    expect(modelFromDriver(`Canon MF750C ${'Series '.repeat(10)}`)).toHaveLength(MODEL_MAX_CHARS);
    expect(modelFromDriver(`Canon MF750C ${'Series '.repeat(10)}Universal`)).toBeNull();
  });
});

describe('readSpooler：本地 mock 采集集成', () => {
  it('采集四个来源并暴露端口证据及成功状态', async () => {
    const printer = { Name: "Office's (printer)", PortName: 'OfficePort', PrinterStatus: 4 };
    const port = { Name: 'OfficePort', HostAddress: '192.168.1.8' };
    vi.mocked(runPowerShell)
      .mockResolvedValueOnce(result({ stdout: JSON.stringify(printer) }))
      .mockResolvedValueOnce(result({ stdout: '[{"Name":"Office","Default":true}]' }))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ stdout: JSON.stringify(port) }));
    const snapshot = await readSpooler();
    expect(snapshot).toMatchObject({
      printers: [printer], cim: [{ Name: 'Office', Default: true }], jobs: [], ports: [port],
      errors: { printers: null, cim: null, jobs: null, ports: null }, fallbackUsed: false,
    });
    expect(snapshot.printers).toStrictEqual([printer]);
    expect(resolvePrinterPort(printer, snapshot.ports).ip).toBe('192.168.1.8');
    expect(runPowerShell).toHaveBeenCalledTimes(4);
    const commands = vi.mocked(runPowerShell).mock.calls.map(([command]) => command);
    expect(commands[3]).toContain('Get-CimInstance -ClassName Win32_TCPIPPrinterPort | Select-Object Name,HostAddress');
    for (const command of commands) {
      expect(command).toContain("$ErrorActionPreference='Stop'");
      expect(command).toContain('ConvertTo-Json');
      expect(command).not.toContain(printer.Name);
    }
  });

  it('只有执行成功的空输出才是成功的空快照，不触发回退', async () => {
    const snapshot = await readSpooler();
    expect(snapshot).toMatchObject({
      printers: [], cim: [], jobs: [], ports: [],
      errors: { printers: null, cim: null, jobs: null, ports: null }, fallbackUsed: false,
    });
    expect(runPowerShell).toHaveBeenCalledTimes(4);
  });

  const failures: Array<[string, Partial<RunResult>, string]> = [
    ['非零退出码', { code: 1, stderr: 'Access denied' }, 'Access denied'],
    ['非零退出且无 stderr', { code: 7 }, 'code 7'],
    ['未取得退出码', { code: null }, 'code null'],
    ['spawn 失败', { code: null, spawnError: 'ENOENT' }, 'ENOENT'],
    ['超时', { code: null, timedOut: true }, 'timed out'],
    ['code=0 但包含错误', { stderr: 'CIM unavailable' }, 'CIM unavailable'],
    ['失败时仍输出合法 JSON', { code: 1, stdout: '[{"Name":"untrusted"}]' }, 'code 1'],
    ['JSON 损坏', { stdout: 'not JSON' }, ''],
  ];

  it.each(failures)('端口采集失败：%s 不伪装为空列表成功', async (_label, failure, message) => {
    vi.mocked(runPowerShell).mockImplementation(async (command) =>
      result(command.includes('Win32_TCPIPPrinterPort') ? failure : {}),
    );
    const snapshot = await readSpooler();
    expect(snapshot.ports).toEqual([]);
    expect(snapshot.errors.ports).toBeTypeOf('string');
    expect(snapshot.errors.ports).toContain(message);
    expect(snapshot.errors.printers).toBeNull();
    expect(snapshot.errors.cim).toBeNull();
    expect(snapshot.errors.jobs).toBeNull();
    expect(snapshot.fallbackUsed).toBe(false);
  });

  it.each(failures)('其它来源也检查执行结果：%s', async (_label, failure) => {
    vi.mocked(runPowerShell).mockResolvedValue(result(failure));
    const snapshot = await readSpooler();
    expect(snapshot.printers).toEqual([]);
    expect(snapshot.cim).toEqual([]);
    expect(snapshot.jobs).toEqual([]);
    expect(Object.values(snapshot.errors).every((error) => typeof error === 'string' && error.length > 0)).toBe(true);
    expect(snapshot.fallbackUsed).toBe(true);
    expect(runPowerShell).toHaveBeenCalledTimes(6);
  });

  it('主源失败后成功回退，正确标记并保留 Win32 作业转换', async () => {
    vi.mocked(runPowerShell).mockImplementation(async (command) => {
      if (command.includes('Get-Printer |') || command.includes('Get-PrintJob |')) {
        return result({ code: 1, stderr: 'Cmdlet unavailable' });
      }
      if (command.includes('Win32_Printer | Select-Object Name,DriverName')) {
        return result({ stdout: '[{"Name":"Office","DriverName":"Canon MF750C","PrinterStatus":3}]' });
      }
      if (command.includes('Win32_PrintJob |')) {
        return result({ stdout: JSON.stringify({ JobId: 12, Name: 'Office, west, 12', Document: 'Test', Owner: 'User', JobStatus: 'Printing', TotalPages: 2, PagesPrinted: 1, StartTime: '2026-01-01T00:00:00Z' }) });
      }
      return result();
    });
    const snapshot = await readSpooler();
    expect(snapshot.printers).toStrictEqual([{ Name: 'Office', DriverName: 'Canon MF750C', CimStatus: 3 }]);
    expect(snapshot.jobs).toEqual([{
      Id: 12, PrinterName: 'Office, west', DocumentName: 'Test', Owner: 'User',
      JobStatus: 'Printing', TotalPages: 2, PagesPrinted: 1, SubmittedTime: '2026-01-01T00:00:00Z',
    }]);
    expect(snapshot.errors).toEqual({ printers: null, cim: null, jobs: null, ports: null });
    expect(snapshot.fallbackUsed).toBe(true);
  });

  it.each([false, true])('CIM 回退隔离状态枚举并保留自身字段（补采失败=%s）', async (cimFailed) => {
    const fallback = {
      Name: 'Office', DriverName: 'Canon MF750C', PortName: 'OfficePort',
      PrinterStatus: 4, Shared: false, JobCount: 0,
      Default: true, WorkOffline: false, DetectedErrorState: 2,
    };
    const cim = { Name: 'Office', PrinterStatus: 4, Default: true, WorkOffline: false, DetectedErrorState: 2 };
    vi.mocked(runPowerShell)
      .mockResolvedValueOnce(result({ code: 1, stderr: 'Cmdlet unavailable' }))
      .mockResolvedValueOnce(result({ stdout: JSON.stringify(fallback) }))
      .mockResolvedValueOnce(result(cimFailed
        ? { code: 1, stderr: 'CIM failed' }
        : { stdout: JSON.stringify(cim) }));

    const snapshot = await readSpooler();
    expect(snapshot.printers).toStrictEqual([{
      Name: 'Office', DriverName: 'Canon MF750C', PortName: 'OfficePort',
      CimStatus: 4, Shared: false, JobCount: 0,
      Default: true, WorkOffline: false, DetectedErrorState: 2,
    }]);
    expect(snapshot.printers[0]).not.toHaveProperty('PrinterStatus');
    expect(snapshot.cim).toStrictEqual(cimFailed ? [] : [cim]);
    expect(snapshot.errors).toEqual({ printers: null, cim: cimFailed ? 'CIM failed' : null, jobs: null, ports: null });
    expect(snapshot.fallbackUsed).toBe(true);
    expect(runPowerShell).toHaveBeenCalledTimes(5);
  });

  it('仅 CIM 补充失败不误报发生了主源回退', async () => {
    vi.mocked(runPowerShell)
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ code: 1, stderr: 'CIM failed' }));
    const snapshot = await readSpooler();
    expect(snapshot.errors.cim).toBe('CIM failed');
    expect(snapshot.fallbackUsed).toBe(false);
  });
});
