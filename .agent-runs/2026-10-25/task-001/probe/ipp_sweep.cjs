// IPP 路径/端口/版本/URI 组合扫描
const http = require('http'), https = require('https');
function A(t, n, v) {
  const nb = Buffer.from(n), vb = Buffer.from(v);
  return Buffer.concat([Buffer.from([t]), Buffer.from([0, nb.length]), nb, Buffer.from([vb.length >> 8, vb.length & 255]), vb]);
}
function req(ip, port, path, { ver = [0x02, 0x00], uri, host, extra = [] } = {}) {
  const body = Buffer.concat([
    Buffer.from([ver[0], ver[1], 0x00, 0x09, 0, 0, 0, 9, 0x01]),
    A(0x47, 'attributes-charset', 'utf-8'),
    A(0x48, 'attributes-natural-language', 'en'),
    A(0x45, 'printer-uri', uri || `ipp://${ip}:${port}${path}`),
    ...extra,
    Buffer.from([0x03]),
  ]);
  const lib = port === 443 ? https : http;
  return new Promise((res) => {
    const t0 = Date.now();
    const rq = lib.request({ host: ip, port, path, method: 'POST', rejectUnauthorized: false, servername: ip,
      headers: { 'Content-Type': 'application/ipp', 'Content-Length': body.length, Connection: 'close', ...(host ? { Host: host } : {}) },
      timeout: 2500 }, (rs) => {
      let b = Buffer.alloc(0); rs.on('data', (d) => b = Buffer.concat([b, d]));
      rs.on('end', () => res({ http: rs.statusCode, len: b.length, ct: rs.headers['content-type'], server: rs.headers.server, body: b, ms: Date.now() - t0 }));
    });
    rq.on('timeout', () => { rq.destroy(); res({ http: 'timeout' }); });
    rq.on('error', (e) => res({ http: 'err:' + (e.code || e.message) }));
    rq.end(body);
  });
}
function parse(buf) {
  const st = buf.length >= 8 ? buf.readUInt16BE(2) : null;
  const ver = buf.length >= 2 ? `${buf[0]}.${buf[1]}` : null;
  const attrs = [];
  let i = 8, last = '';
  while (i < buf.length) {
    const t = buf[i];
    if (t === 0x03) break;
    if (t >= 0x01 && t <= 0x05) { i++; continue; }
    if (i + 3 > buf.length) break;
    const nl = buf.readInt16BE(i + 1); i += 3;
    let name = last;
    if (nl > 0) { name = buf.subarray(i, i + nl).toString('utf8'); last = name; i += nl; }
    if (i + 2 > buf.length) break;
    const vl = buf.readInt16BE(i); i += 2;
    const raw = buf.subarray(i, i + vl); i += vl;
    let v;
    if (t === 0x21 || t === 0x23) v = raw.length === 4 ? raw.readInt32BE(0) : raw.toString('hex');
    else if (t === 0x22) v = raw[0] !== 0;
    else if (t === 0x33) v = `${raw.readInt32BE(0)}..${raw.readInt32BE(4)}`;
    else v = raw.toString('utf8');
    attrs.push({ name, tag: t, v });
  }
  return { ver, st, attrs };
}

(async () => {
  const ips = (process.argv[2] || '192.168.2.170,192.168.2.235').split(',');
  const combos = [];
  for (const port of [631, 80, 443]) {
    for (const path of ['/ipp/print', '/ipp', '/printers', '/ipp/port1']) combos.push({ port, path });
  }
  for (const ip of ips) {
    console.log(`\n===== ${ip} =====`);
    for (const c of combos) {
      const r = await req(ip, c.port, c.path);
      if (r.http === 'timeout' || r.http === 'err:ECONNREFUSED' || r.http === 'err:ECONNRESET') {
        console.log(`  :${c.port}${c.path.padEnd(11)} ${r.http}`);
        continue;
      }
      const p = r.body && r.body.length >= 8 ? parse(r.body) : null;
      const names = p ? [...new Set(p.attrs.map((a) => a.name))] : [];
      console.log(`  :${c.port}${c.path.padEnd(11)} http=${r.http} ipp=0x${p ? p.st.toString(16) : '----'} ver=${p ? p.ver : '-'} len=${r.len} ct=${r.ct} srv=${r.server} attrs=${p ? p.attrs.length : 0}`);
      if (p && p.attrs.length > 2) {
        for (const a of p.attrs.filter((x) => /marker|state|queued|printer-name|make|device-id|alert/.test(x.name)).slice(0, 40)) {
          console.log(`      ${a.name} = ${JSON.stringify(a.v)} (0x${a.tag.toString(16)})`);
        }
      }
      if (names.length) console.log(`      names[${names.length}]: ${JSON.stringify(names.slice(0, 12))}`);
    }
  }
})();
