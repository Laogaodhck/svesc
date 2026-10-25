// 只读探测脚本 — 编码 / ping 并发 / 端口 / SNMP
const { spawn, execFile } = require('child_process');
const net = require('net');
const dgram = require('dgram');

const NODE = process.execPath;
const t0 = Date.now();
const log = (...a) => console.log(...a);

function runPing(ip, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const args = ['-n', '1', '-w', '800', ip];
    const start = Date.now();
    const p = spawn('ping', args, { windowsHide: true });
    let buf = Buffer.alloc(0);
    p.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); });
    p.stderr.on('data', (d) => { buf = Buffer.concat([buf, d]); });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ip, code, ms: Date.now() - start, raw: buf });
    });
  });
}

async function pingBatch(ips, concurrency) {
  const results = [];
  let i = 0;
  const start = Date.now();
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= ips.length) return;
      results[idx] = await runPing(ips[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, worker));
  return { totalMs: Date.now() - start, results };
}

// ---------------- SNMP v2c 最简 GET (手写 BER) ----------------
function encLen(n) {
  if (n < 128) return Buffer.from([n]);
  const b = [];
  let v = n;
  while (v > 0) { b.unshift(v & 0xff); v >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
function tlv(tag, content) { return Buffer.concat([Buffer.from([tag]), encLen(content.length), content]); }
const INT = (v) => {
  const b = [];
  let x = v;
  do { b.unshift(x & 0xff); x >>= 8; } while (x > 0);
  if (b[0] & 0x80) b.unshift(0);
  return tlv(0x02, Buffer.from(b));
};
const OCT = (s) => tlv(0x04, Buffer.from(s, 'ascii'));
const OID = (s) => {
  const parts = s.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    if (p < 128) { bytes.push(p); continue; }
    const st = [];
    let x = p;
    do { st.unshift(x & 0x7f); x >>= 7; } while (x > 0);
    for (let k = 0; k < st.length - 1; k++) st[k] |= 0x80;
    bytes.push(...st);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const NULL = tlv(0x05, Buffer.alloc(0));
const SEQ = (...kids) => tlv(0x30, Buffer.concat(kids));

function buildGet(community, oid, reqId) {
  const pdu = tlv(0xa0, Buffer.concat([INT(reqId), INT(0), INT(0), SEQ(OID(oid), NULL)]));
  return SEQ(INT(1), OCT(community), pdu);
}

function snmpGet(host, community, oid = '1.3.6.1.2.1.1.1.0', timeout = 900) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const reqId = Math.floor(Math.random() * 100000) + 1;
    const pkt = buildGet(community, oid, reqId);
    const start = Date.now();
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.close(); } catch {} resolve({ host, community, ...r, ms: Date.now() - start }); };
    sock.on('message', (msg) => {
      // 粗解析：找 sysDescr 的 OCTET STRING（跳过 OID 后的 0x04）
      finish({ ok: true, len: msg.length, hexHead: msg.subarray(0, 24).toString('hex'), text: extractOctets(msg) });
    });
    sock.on('error', (e) => finish({ ok: false, err: e.message }));
    sock.send(pkt, 161, host, (err) => { if (err) finish({ ok: false, err: err.message }); });
    setTimeout(() => finish({ ok: false, err: 'timeout' }), timeout);
  });
}
function extractOctets(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    if (tag === 0x04) {
      let j = i + 1; let len = buf[j];
      if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) { j++; len = (len << 8) | buf[j]; } }
      j++;
      if (len > 2 && len < 512 && j + len <= buf.length) out.push(buf.subarray(j, j + len).toString('utf8'));
      i = j + len; continue;
    }
    i++;
  }
  return out;
}

function portProbe(ip, port, timeout = 700) {
  return new Promise((resolve) => {
    const start = Date.now();
    const s = new net.Socket();
    let done = false;
    const fin = (open, err) => { if (done) return; done = true; s.destroy(); resolve({ ip, port, open, ms: Date.now() - start, err }); };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false, 'timeout'));
    s.once('error', (e) => fin(false, e.code));
    s.connect(port, ip);
  });
}

(async () => {
  const mode = process.argv[2];

  if (mode === 'enc') {
    // A: 直接 spawn arp.exe，读 Buffer 用 GBK 解码
    const arpRaw = await new Promise((res) => {
      execFile('arp', ['-a'], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }, (e, so) => res(so));
    });
    log('[A] arp.exe Buffer -> utf8 :', JSON.stringify(arpRaw.toString('utf8').split('\n').slice(1, 3)));
    log('[A] arp.exe Buffer -> gbk  :', JSON.stringify(arpRaw.toString('latin1').slice(0, 80)));
    try {
      log('[A] arp.exe Buffer -> gb18030:', JSON.stringify(new TextDecoder('gb18030').decode(arpRaw).split(/\r?\n/).slice(1, 3)));
    } catch (e) { log('[A] gb18030 decoder ERR', e.message); }

    // B: spawn powershell 默认编码
    const psDefault = await new Promise((res) => {
      const p = spawn('powershell', ['-NoProfile', '-Command', 'arp -a'], { windowsHide: true });
      let b = Buffer.alloc(0); p.stdout.on('data', (d) => b = Buffer.concat([b, d]));
      p.on('close', () => res(b));
    });
    log('[B] ps default -> utf8:', JSON.stringify(psDefault.toString('utf8').split(/\r?\n/).filter(Boolean)[1] || ''));
    log('[B] ps default hexhead:', psDefault.subarray(0, 40).toString('hex'));

    // C: powershell + OutputEncoding UTF8
    const psUtf8 = await new Promise((res) => {
      const p = spawn('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; arp -a'], { windowsHide: true });
      let b = Buffer.alloc(0); p.stdout.on('data', (d) => b = Buffer.concat([b, d]));
      p.on('close', () => res(b));
    });
    log('[C] ps UTF8 -> utf8   :', JSON.stringify(psUtf8.toString('utf8').split(/\r?\n/).filter(Boolean)[1] || ''));
    log('[C] has replacement char:', psUtf8.toString('utf8').includes('\uFFFD'));

    // D: chcp 65001
    const psChcp = await new Promise((res) => {
      const p = spawn('cmd', ['/c', 'chcp 65001 >nul & arp -a'], { windowsHide: true });
      let b = Buffer.alloc(0); p.stdout.on('data', (d) => b = Buffer.concat([b, d]));
      p.on('close', () => res(b));
    });
    log('[D] chcp65001 -> utf8 :', JSON.stringify(psChcp.toString('utf8').split(/\r?\n/).filter(Boolean)[1] || ''));
    log('[D] has replacement char:', psChcp.toString('utf8').includes('\uFFFD'));

    // E: powershell Get-Printer JSON
    const psJson = await new Promise((res) => {
      const p = spawn('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,Shared,Type | ConvertTo-Json -Compress'], { windowsHide: true });
      let b = Buffer.alloc(0); p.stdout.on('data', (d) => b = Buffer.concat([b, d]));
      p.on('close', () => res(b.toString('utf8')));
    });
    log('[E] Get-Printer JSON head:', psJson.slice(0, 220));
    log('[E] JSON parse ok:', (() => { try { JSON.parse(psJson); return true; } catch (e) { return e.message; } })());
    log('[E] elapsed', Date.now() - t0, 'ms');
    return;
  }

  if (mode === 'conc') {
    const base = '192.168.2.';
    const ips16 = Array.from({ length: 16 }, (_, i) => base + (i + 1));
    const r16 = await pingBatch(ips16, 16);
    log(`concurrency 16 x16 -> total ${r16.totalMs}ms; alive=${r16.results.filter(r => r.code === 0).length}`);
    log('sample raw (192.168.2.1):', JSON.stringify(r16.results[0]?.raw.toString('latin1') ?? ''));
    const r8 = await pingBatch(ips16, 8);
    log(`concurrency 8 x16 -> total ${r8.totalMs}ms`);
    // 死地址耗时（决定性数据）
    const dead = ['192.168.2.249', '192.168.2.250', '192.168.2.251', '192.168.2.252'];
    const rDead = await pingBatch(dead, 4);
    log(`dead x4 concurrency4 -> total ${rDead.totalMs}ms; per-ip ms=${rDead.results.map(r => r.ms).join(',')}`);
    log('dead raw sample:', JSON.stringify(rDead.results[0]?.raw.toString('latin1') ?? ''));
    // 64 并发死地址压测
    const dead64 = Array.from({ length: 64 }, (_, i) => base + (i + 100));
    const r64 = await pingBatch(dead64, 64);
    log(`64 addr concurrency64 -> total ${r64.totalMs}ms`);
    return;
  }

  if (mode === 'ports') {
    const targets = (process.argv[3] || '').split(',').filter(Boolean);
    const ports = [22, 80, 443, 445, 515, 631, 9100, 3389, 554, 62078];
    const start = Date.now();
    const all = [];
    for (const ip of targets) {
      const rs = await Promise.all(ports.map((p) => portProbe(ip, p)));
      const open = rs.filter((r) => r.open).map((r) => r.port);
      all.push({ ip, open });
      log(`${ip} open=[${open.join(',')}]`);
    }
    log('ports elapsed', Date.now() - start, 'ms for', targets.length * ports.length, 'probes');
    return;
  }

  if (mode === 'snmp') {
    const targets = (process.argv[3] || '').split(',').filter(Boolean);
    for (const ip of targets) {
      for (const c of ['public', 'private']) {
        const r = await snmpGet(ip, c, '1.3.6.1.2.1.1.1.0');
        log(`SNMP ${ip} c=${c} ->`, JSON.stringify(r));
      }
    }
    return;
  }

  if (mode === 'snmpbulk') {
    // 打印机 MIB 关键 OID: hrDeviceDescr(1.3.6.1.2.1.25.3.2.1.3.1), prtMarkerLifeCount
    const ip = process.argv[3];
    const c = process.argv[4] || 'public';
    const oids = {
      sysDescr: '1.3.6.1.2.1.1.1.0',
      sysName: '1.3.6.1.2.1.1.5.0',
      sysUpTime: '1.3.6.1.2.1.1.3.0',
      prtGeneralStatus: '1.3.6.1.2.1.43.5.1.1.2.1',
      prtMarkerLifeCount: '1.3.6.1.2.1.43.10.2.1.4.1.1',
      prtMarkerSuppliesLevel: '1.3.6.1.2.1.43.11.1.1.9.1.1',
      prtMarkerSuppliesMax: '1.3.6.1.2.1.43.11.1.1.8.1.1',
      hrDeviceDescr: '1.3.6.1.2.1.25.3.2.1.3.1',
    };
    for (const [k, oid] of Object.entries(oids)) {
      const r = await snmpGet(ip, c, oid, 1000);
      log(`${k} (${oid}) ->`, r.ok ? `len=${r.len} text=${JSON.stringify(r.text)}` : `FAIL ${r.err} ${r.ms}ms`);
    }
    return;
  }
})();
