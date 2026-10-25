/**
 * 演示数据源（降级路径）。
 *
 * 触发条件（plan.md §3 / brief §3 simulator.ts）：真实设备 < 3 台，或显式 `LAN_DEMO=1`。
 * 此时 `dataSource` 标 `demo`（无真实设备）/ `mixed`（真实 + 演示混合），UI 顶部必须显示角标。
 * 全部数据由 mulberry32 种子随机生成 —— **绝不混入真实统计**，两者在快照中凭 id 前缀区分。
 */
import type { Consumable, Device, DeviceKind, PrintJob, Printer } from '../../shared/types';
import { computeQuality } from './network/quality';

export const SIM_ID_PREFIX = 'sim-';

/** 确定性 PRNG（同一种子 → 同一世界，便于截图与测试复现）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimDeviceSeed {
  last: number;
  kind: DeviceKind;
  host: string;
  vendor: string;
  os: string | null;
  ports: number[];
  isGateway?: boolean;
}

const DEVICE_SEEDS: SimDeviceSeed[] = [
  { last: 1, kind: 'router', host: 'GW-Office', vendor: 'TP-Link', os: '网络设备固件', ports: [80, 443], isGateway: true },
  { last: 10, kind: 'server', host: 'SRV-FILE01', vendor: 'Dell', os: 'Windows (SMB)', ports: [80, 443, 445, 3389] },
  { last: 21, kind: 'workstation', host: 'WS-DESIGN-01', vendor: 'Lenovo', os: 'Windows (SMB)', ports: [445, 3389] },
  { last: 22, kind: 'workstation', host: 'WS-FIN-02', vendor: 'HP', os: 'Windows (SMB)', ports: [445] },
  { last: 23, kind: 'workstation', host: 'WS-DEV-03', vendor: 'Apple', os: 'macOS (AFP)', ports: [22, 445, 548] },
  { last: 24, kind: 'workstation', host: 'WS-OPS-04', vendor: 'Intel', os: 'Linux/Unix (SSH)', ports: [22, 80] },
  { last: 31, kind: 'mobile', host: 'iPhone-Li', vendor: 'Apple', os: 'iOS', ports: [62078] },
  { last: 32, kind: 'mobile', host: 'Redmi-K40', vendor: 'Xiaomi', os: null, ports: [] },
  { last: 40, kind: 'camera', host: 'cam-lobby', vendor: 'Hikvision', os: '监控摄像固件 (RTSP)', ports: [80, 554] },
  { last: 41, kind: 'iot', host: 'tv-meeting', vendor: 'Samsung', os: null, ports: [80, 443] },
  { last: 52, kind: 'server', host: 'NAS-BACKUP', vendor: 'Synology', os: null, ports: [80, 443, 445] },
  { last: 77, kind: 'unknown', host: null as unknown as string, vendor: 'Realtek', os: null, ports: [] },
];

const PRINTER_SEEDS = [
  { last: 170, name: 'HP LaserJet M404dn', model: 'HP LaserJet M404dn', brand: 'HP' },
  { last: 213, name: 'Canon iR-ADV C3530', model: 'Canon iR-ADV C3530', brand: 'Canon' },
  { last: 235, name: 'Epson WF-C5790', model: 'Epson WF-C5790', brand: 'Epson' },
  { last: 240, name: 'Brother HL-L5100DN', model: 'Brother HL-L5100DN', brand: 'Brother' },
];

const TONER_SETS: Record<string, Consumable[]> = {
  HP: [
    { kind: 'black', label: 'Black Cartridge', levelPct: 72, maxCapacity: 100, current: 72, source: 'snmp' },
    { kind: 'drum', label: 'Imaging Drum', levelPct: 46, maxCapacity: 100, current: 46, source: 'snmp' },
  ],
  Canon: [
    { kind: 'black', label: 'Black Toner', levelPct: 8, maxCapacity: 100, current: 8, source: 'snmp' },
    { kind: 'cyan', label: 'Cyan Toner', levelPct: 34, maxCapacity: 100, current: 34, source: 'snmp' },
    { kind: 'magenta', label: 'Magenta Toner', levelPct: 27, maxCapacity: 100, current: 27, source: 'snmp' },
    { kind: 'yellow', label: 'Yellow Toner', levelPct: 61, maxCapacity: 100, current: 61, source: 'snmp' },
  ],
  Epson: [
    { kind: 'black', label: 'Ink Black', levelPct: 4, maxCapacity: 100, current: 4, source: 'snmp' },
    { kind: 'cyan', label: 'Ink Cyan', levelPct: 55, maxCapacity: 100, current: 55, source: 'snmp' },
    { kind: 'waste', label: 'Waste Ink Pad', levelPct: 88, maxCapacity: 100, current: 88, source: 'snmp' },
  ],
  Brother: [
    { kind: 'black', label: 'Toner Black', levelPct: 93, maxCapacity: 100, current: 93, source: 'snmp' },
  ],
};

export interface SimulatedWorld {
  devices: Device[];
  printers: Printer[];
}

export class Simulator {
  private readonly rand: () => number;
  private startedAt = Date.now();
  private jobSeq = 0;

  constructor(
    seed = 20261025,
    private readonly prefix = '192.168.99.',
  ) {
    this.rand = mulberry32(seed);
  }

  /** 生成/推进一帧模拟世界。同一实例内耗材缓慢下降、偶发故障。 */
  tick(now = Date.now()): SimulatedWorld {
    const elapsedMin = Math.max(0, (now - this.startedAt) / 60000);
    const devices: Device[] = DEVICE_SEEDS.map((seed, idx) => this.buildDevice(seed, idx, now));
    const printers: Printer[] = PRINTER_SEEDS.map((seed, idx) => this.buildPrinter(seed, idx, now, elapsedMin));
    return { devices, printers };
  }

  private buildDevice(seed: SimDeviceSeed, idx: number, now: number): Device {
    const ip = `${this.prefix}${seed.last}`;
    const offline = idx === 11;
    const latency = 1 + Math.round(this.rand() * 8);
    const jitter = Math.round(this.rand() * 3 * 10) / 10;
    const loss = this.rand() > 0.9 ? 5 : 0;
    const quality = offline
      ? computeQuality({ latencyMs: null, jitterMs: null, packetLossPct: 0, samples: 0 })
      : computeQuality({ latencyMs: latency, jitterMs: jitter, packetLossPct: loss, samples: 12 });
    const share = idx === 2 ? 0.42 : idx === 1 ? 0.31 : 0;
    return {
      id: `${SIM_ID_PREFIX}dev-${ip}`,
      ip,
      mac: `02-00-5e-${(idx + 1).toString(16).padStart(2, '0')}-${(idx * 7 + 11).toString(16).padStart(2, '0')}-${(idx * 13 + 3).toString(16).padStart(2, '0')}`,
      hostname: seed.host ?? null,
      vendor: seed.vendor,
      osHint: seed.os,
      kind: seed.kind,
      state: offline ? 'offline' : 'online',
      firstSeen: this.startedAt,
      lastSeen: offline ? now - 120000 : now,
      openPorts: seed.ports,
      quality,
      bandwidth: {
        rxBps: Math.round(share * 1_240_000),
        txBps: Math.round(share * 380_000),
        share,
        connections: share > 0 ? Math.round(share * 12) : 0,
        attributable: share > 0,
        estimated: true,
      },
      rttHistory: offline
        ? []
        : Array.from({ length: 20 }, (_, i) => Math.max(0, latency + Math.round(Math.sin(i / 2) * jitter * 2))),
      isGateway: seed.isGateway === true,
      isSelf: false,
      displayName: seed.host ?? null,
      ipConflict: false,
    };
  }

  private buildPrinter(
    seed: (typeof PRINTER_SEEDS)[number],
    idx: number,
    now: number,
    elapsedMin: number,
  ): Printer {
    const ip = `${this.prefix}${seed.last}`;
    const fault = idx === 2;
    const consumables = (TONER_SETS[seed.brand] ?? []).map((c) => {
      if (c.levelPct === null) return { ...c };
      const dropped = Math.floor(elapsedMin / 10);
      const level = Math.max(0, c.levelPct - dropped);
      return { ...c, levelPct: level, current: level };
    });
    const jobs: PrintJob[] = fault
      ? []
      : Array.from({ length: idx === 0 ? 2 : 0 }, () => {
          this.jobSeq += 1;
          return {
            id: `${SIM_ID_PREFIX}job-${this.jobSeq}`,
            documentName: `Q3-报告-${this.jobSeq}.pdf`,
            owner: 'li.wei',
            status: 'Printing',
            pages: 12 + Math.round(this.rand() * 20),
            pagesPrinted: 3,
            submittedAt: now - 45000,
          };
        });
    return {
      id: `${SIM_ID_PREFIX}prn-${ip}`,
      name: seed.name,
      alias: null,
      model: seed.model,
      ip,
      mac: `02-11-22-${idx}${idx}-aa-bb`,
      connection: 'network',
      state: fault ? 'error' : jobs.length > 0 ? 'printing' : 'idle',
      stateDetail: fault ? 'spooler=Error · detected=Jammed' : null,
      isDefault: idx === 1,
      shared: false,
      manual: false,
      pageCount: 12000 + idx * 3456,
      consumables,
      jobs,
      source: 'simulated',
      lastSeen: now,
    };
  }
}
