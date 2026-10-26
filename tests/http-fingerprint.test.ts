/**
 * task-027：HTTP 管理页指纹（`src/main/engine/discovery/http-fingerprint.ts`）。
 *
 * 关键约束：恰好命中 1 类才定 kind（≥2 类不猜）；title 原文永远保留为 osHint 候补；
 * 传输层注入（测试不碰网络）；单轮上限 6 台。
 */
import { describe, expect, it } from 'vitest';
import {
  buildHttpOsHint,
  classifyHttpFingerprint,
  discoverHttpFingerprints,
  HTTP_PROBE_MAX_TARGETS,
  parseHttpTitle,
  type HttpProbeResponse,
} from '../src/main/engine/discovery/http-fingerprint';

const resp = (body: string, server: string | null = null): HttpProbeResponse => ({
  status: 200,
  server,
  body,
});

describe('http-fingerprint.parseHttpTitle', () => {
  it('标准 HTML 取 <title> 并压缩空白', () => {
    expect(parseHttpTitle('<html><head><title>  TP-LINK   路由器 </title></head></html>')).toBe(
      'TP-LINK 路由器',
    );
  });

  it('HTML 实体解码（&amp; &nbsp; 等）', () => {
    expect(parseHttpTitle('<title>DiskStation&nbsp;&amp;&nbsp;DS220+</title>')).toBe('DiskStation & DS220+');
  });

  it('无 title / 空 title 返回 null', () => {
    expect(parseHttpTitle('<html><body>hi</body></html>')).toBeNull();
    expect(parseHttpTitle('<title>   </title>')).toBeNull();
    expect(parseHttpTitle('')).toBeNull();
  });
});

describe('http-fingerprint.buildHttpOsHint', () => {
  it('命中时加「管理页自报：」前缀', () => {
    expect(buildHttpOsHint('HP LaserJet M1136 MFP', true)).toBe('管理页自报：HP LaserJet M1136 MFP');
  });

  it('未命中时返回原文（无前缀）', () => {
    expect(buildHttpOsHint('Login Page', false)).toBe('Login Page');
  });

  it('超长 title 截断到 48 字符 + 省略号', () => {
    const long = 'X'.repeat(60);
    const out = buildHttpOsHint(long, false);
    expect(out.length).toBe(49);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('http-fingerprint.classifyHttpFingerprint', () => {
  it('路由器管理页 title → router', () => {
    expect(classifyHttpFingerprint(null, 'TP-LINK 路由器登录页')).toBe('router');
  });

  it('打印机管理页 title → printer', () => {
    expect(classifyHttpFingerprint(null, 'HP LaserJet M1136 MFP')).toBe('printer');
  });

  it('摄像头 Server 头 → camera（Server 单独命中也可判）', () => {
    expect(classifyHttpFingerprint('Hikvision-Webs', null)).toBe('camera');
  });

  it('NAS title → server', () => {
    expect(classifyHttpFingerprint(null, 'Synology DiskStation DS220+')).toBe('server');
  });

  it('投屏/电视 title → iot', () => {
    expect(classifyHttpFingerprint(null, 'Chromecast Setup')).toBe('iot');
  });

  it('≥2 类同时命中 → null（不猜）', () => {
    // "printer" + "router" 两类关键词同现
    expect(classifyHttpFingerprint('print server', 'my router page')).toBeNull();
  });

  it('无命中 → null（kind 不动，osHint 由调用方用 title 兜底）', () => {
    expect(classifyHttpFingerprint('nginx', 'Welcome to nginx!')).toBeNull();
  });

  it('task-028 生态扩充：foscam/reolink → camera；linksys/asuswrt → router；tuya → iot', () => {
    expect(classifyHttpFingerprint(null, 'FOSCAM IP Camera Login')).toBe('camera');
    expect(classifyHttpFingerprint(null, 'Reolink Client')).toBe('camera');
    expect(classifyHttpFingerprint(null, 'Linksys Smart Wi-Fi')).toBe('router');
    expect(classifyHttpFingerprint(null, 'ASUSWRT-Lucid Router Management')).toBe('router');
    expect(classifyHttpFingerprint(null, 'GL.iNet Admin')).toBe('router');
    expect(classifyHttpFingerprint(null, 'Tuya Smart Device')).toBe('iot');
  });

  it('Server 头与 title 均为空 → null', () => {
    expect(classifyHttpFingerprint(null, null)).toBeNull();
  });
});

describe('http-fingerprint.discoverHttpFingerprints', () => {
  it('命中时返回 kind + 管理页自报 osHint', async () => {
    const out = await discoverHttpFingerprints(
      [{ ip: '192.168.2.1', port: 80 }],
      async () => resp('<title>TP-LINK 路由器</title>', 'Boa/0.94'),
    );
    expect(out).toEqual([{ ip: '192.168.2.1', kind: 'router', osHint: '管理页自报：TP-LINK 路由器' }]);
  });

  it('未命中类别时 title 原文兜底 osHint，kind=null', async () => {
    const out = await discoverHttpFingerprints(
      [{ ip: '192.168.2.9', port: 8080 }],
      async () => resp('<title>Device Console</title>'),
    );
    expect(out).toEqual([{ ip: '192.168.2.9', kind: null, osHint: 'Device Console' }]);
  });

  it('无 title 但 Server 头命中时用 Server 头作 osHint', async () => {
    const out = await discoverHttpFingerprints(
      [{ ip: '192.168.2.10', port: 80 }],
      async () => resp('<html><body>ok</body></html>', 'Hikvision-Webs'),
    );
    expect(out).toEqual([{ ip: '192.168.2.10', kind: 'camera', osHint: '管理页自报：Hikvision-Webs' }]);
  });

  it('无 title 无命中但 Server 头非空 → kind=null，Server 头兜底 osHint（真实自报）', async () => {
    const out = await discoverHttpFingerprints(
      [{ ip: '192.168.2.11', port: 80 }],
      async () => resp('<html></html>', 'Boa'),
    );
    expect(out).toEqual([{ ip: '192.168.2.11', kind: null, osHint: 'Boa' }]);
  });

  it('fetcher 抛异常 / 返回 null 的目标静默跳过', async () => {
    const out = await discoverHttpFingerprints(
      [
        { ip: '192.168.2.12', port: 80 },
        { ip: '192.168.2.13', port: 80 },
      ],
      async (ip) => {
        if (ip === '192.168.2.12') throw new Error('boom');
        return null;
      },
    );
    expect(out).toEqual([]);
  });

  it('单轮上限 6 台：8 个目标只探测前 6 个', async () => {
    const seen: string[] = [];
    await discoverHttpFingerprints(
      Array.from({ length: 8 }, (_, i) => ({ ip: `192.168.2.${i + 1}`, port: 80 as const })),
      async (ip) => {
        seen.push(ip);
        return resp('<title>printer</title>');
      },
    );
    expect(seen).toHaveLength(HTTP_PROBE_MAX_TARGETS);
    expect(seen).toHaveLength(6);
  });

  it('空目标列表直接返回空（不发请求）', async () => {
    let called = 0;
    const out = await discoverHttpFingerprints([], async () => {
      called += 1;
      return resp('<title>x</title>');
    });
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });
});
