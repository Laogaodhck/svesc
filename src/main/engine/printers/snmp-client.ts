/**
 * SNMPv2c 客户端（UDP 161），基于 snmp-ber 手写编解码。
 *
 * 实测背景（investigation-report.md §2.8）：本机 4 主机 × public/private 全部 timeout，
 * 因此本模块的正确性只能靠构造报文的单元测试保证；集成层面必须"失败即 null，不抛错"。
 * 超时 900ms、重试 1 次，总耗时上限受控。
 */
import dgram from 'node:dgram';
import {
  buildGetNextRequest,
  buildGetRequest,
  compareOid,
  oidStartsWith,
  parseResponse,
  type Varbind,
} from './snmp-ber';
import { TIMEOUTS } from '../../../shared/constants';
import { isValidIpv4 } from '../discovery/subnet';

export interface SnmpSession {
  host: string;
  port?: number;
  community?: string;
  timeoutMs?: number;
  retries?: number;
}

export interface SnmpGetResult {
  ok: boolean;
  varbinds: Varbind[];
  error: string | null;
  ms: number;
}

export interface SnmpWalkResult {
  ok: boolean;
  varbinds: Varbind[];
  error: string | null;
  ms: number;
  /** walk 提前终止原因（调试用） */
  stoppedBy: 'subtree-end' | 'max-steps' | 'no-progress' | 'timeout' | 'ok';
}

function effective(session: SnmpSession): Required<SnmpSession> {
  return {
    host: session.host,
    port: session.port ?? 161,
    community: session.community ?? 'public',
    timeoutMs: session.timeoutMs ?? TIMEOUTS.snmp,
    retries: session.retries ?? 1,
  };
}

/** 单次 UDP 往返：发报文 → 等到 requestId 匹配的响应或超时。 */
function exchange(
  host: string,
  port: number,
  packet: Buffer,
  requestId: number,
  timeoutMs: number,
): Promise<{ ok: true; varbinds: Varbind[]; pduTag: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (result: { ok: true; varbinds: Varbind[]; pduTag: number } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);

    socket.on('error', (err) => finish({ ok: false, error: err.message }));
    socket.on('message', (msg) => {
      try {
        const resp = parseResponse(msg);
        if (resp.requestId !== requestId) return; // 不是本次请求的应答
        if (resp.errorStatus !== 0) {
          finish({ ok: false, error: `snmp error-status=${resp.errorStatus} index=${resp.errorIndex}` });
          return;
        }
        finish({ ok: true, varbinds: resp.varbinds, pduTag: resp.pduTag });
      } catch (err) {
        finish({ ok: false, error: `decode: ${err instanceof Error ? err.message : String(err)}` });
      }
    });

    socket.send(packet, port, host, (err) => {
      if (err) finish({ ok: false, error: err.message });
    });
  });
}

function nextRequestId(): number {
  return Math.floor(Math.random() * 0x3fffffff) + 1;
}

/** SNMP GET（一次可取多个 OID）。失败返回 ok:false，不抛异常。 */
export async function snmpGet(session: SnmpSession, oids: string[]): Promise<SnmpGetResult> {
  const started = Date.now();
  const cfg = effective(session);
  if (!isValidIpv4(cfg.host)) {
    return { ok: false, varbinds: [], error: `非法主机地址: ${cfg.host}`, ms: 0 };
  }
  if (oids.length === 0) return { ok: true, varbinds: [], error: null, ms: 0 };

  const attempts = cfg.retries + 1;
  let lastError: string | null = null;
  for (let i = 0; i < attempts; i += 1) {
    const requestId = nextRequestId();
    const packet = buildGetRequest(oids, { community: cfg.community, requestId });
    const res = await exchange(cfg.host, cfg.port, packet, requestId, cfg.timeoutMs);
    if (res.ok) {
      return { ok: true, varbinds: res.varbinds, error: null, ms: Date.now() - started };
    }
    lastError = res.error;
    if (res.error.startsWith('snmp error-status')) break; // 协议级错误，重试无意义
  }
  return { ok: false, varbinds: [], error: lastError, ms: Date.now() - started };
}

/** 取单个标量（.0 结尾的 OID），返回值或 null。 */
export async function snmpGetScalar(session: SnmpSession, oid: string): Promise<number | string | null> {
  const res = await snmpGet(session, [oid]);
  if (!res.ok) return null;
  const vb = res.varbinds.find((v) => v.oid === oid) ?? res.varbinds[0];
  return vb ? vb.value : null;
}

/**
 * SNMP GETNEXT 表遍历。
 * 终止条件：OID 离开 base 子树 / 无前进 / 达到 maxSteps。
 */
export async function snmpWalk(
  session: SnmpSession,
  baseOid: string,
  opts: { maxSteps?: number; maxColumns?: number } = {},
): Promise<SnmpWalkResult> {
  const started = Date.now();
  const cfg = effective(session);
  const maxSteps = opts.maxSteps ?? 40;
  if (!isValidIpv4(cfg.host)) {
    return { ok: false, varbinds: [], error: `非法主机地址: ${cfg.host}`, ms: 0, stoppedBy: 'timeout' };
  }

  const collected: Varbind[] = [];
  let cursor = baseOid;
  let stoppedBy: SnmpWalkResult['stoppedBy'] = 'max-steps';
  let lastError: string | null = null;

  for (let step = 0; step < maxSteps; step += 1) {
    const requestId = nextRequestId();
    const packet = buildGetNextRequest([cursor], { community: cfg.community, requestId });
    const res = await exchange(cfg.host, cfg.port, packet, requestId, cfg.timeoutMs);
    if (!res.ok) {
      lastError = res.error;
      stoppedBy = 'timeout';
      break;
    }
    const vb = res.varbinds[0];
    if (!vb) {
      stoppedBy = 'subtree-end';
      break;
    }
    if (vb.type === 0x05 || vb.value === null) {
      stoppedBy = 'subtree-end';
      break;
    }
    if (!oidStartsWith(vb.oid, baseOid)) {
      stoppedBy = 'subtree-end';
      break;
    }
    if (compareOid(vb.oid, cursor) <= 0) {
      stoppedBy = 'no-progress';
      break;
    }
    collected.push(vb);
    cursor = vb.oid;
    stoppedBy = 'ok';
  }

  const ok = collected.length > 0 && lastError === null;
  return {
    ok,
    varbinds: collected,
    error: lastError,
    ms: Date.now() - started,
    stoppedBy: collected.length > 0 && stoppedBy === 'max-steps' ? 'max-steps' : stoppedBy,
  };
}

/** 快速探活：GET sysDescr.0 是否回包（用于决定是否继续深入采集）。 */
export async function snmpProbe(host: string, community = 'public', timeoutMs = TIMEOUTS.snmp): Promise<boolean> {
  const res = await snmpGet({ host, community, timeoutMs, retries: 0 }, ['1.3.6.1.2.1.1.1.0']);
  return res.ok;
}
