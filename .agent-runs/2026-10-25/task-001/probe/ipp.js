// IPP Get-Printer-Attributes 只读探测
// 用法: node ipp.js <ip>[,<ip>...]
const http = require('http');
const https = require('https');

// ---------- 编码 ----------
function attr(tag, name, value) {
  const n = Buffer.from(name, 'ascii');
  const parts = [Buffer.from([tag]), Buffer.from([n.length >> 8, n.length & 0xff]), n];
  if (value && value.length) {
    parts.push(Buffer.from([value.length >> 8, value.length & 0xff]), value);
  } else {
    parts.push(Buffer.from([0, 0]));
  }
  return Buffer.concat(parts);
}

function buildRequest(version, printerUri, requestId) {
  const b = [
    Buffer.from(version),                 // 0x02 0x00 或 0x01 0x01
    Buffer.from([0x00, 0x09]),            // Get-Printer-Attributes
    Buffer.from([(requestId >> 24) & 0xff, (requestId >> 16) & 0xff, (requestId >> 8) & 0xff, requestId & 0xff]),
    Buffer.from([0x01]),                  // operation-attributes-tag
    attr(0x47, 'attributes-charset', Buffer.from('utf-8', 'ascii')),
    attr(0x48, 'attributes-natural-language', Buffer.from('en', 'ascii')),
    attr(0x45, 'printer-uri', Buffer.from(printerUri, 'utf8')),
    attr(0x44, 'requested-attributes', Buffer.from('all', 'ascii')),
    Buffer.from([0x03]),                  // end-of-attributes-tag
  ];
  return Buffer.concat(b);
}

function post(ip, port, path, body, opts = {}) {
  const lib = opts.tls ? https : http;
  const start = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const fin = (r) => { if (!done) { done = true; resolve({ ...r, ms: Date.now() - start }); } };
    const req = lib.request({
      host: ip, port, path, method: 'POST',
      headers: {
        'Content-Type': 'application/ipp',
        'Content-Length': body.length,
        'Connection': 'close',
        'User-Agent': 'ipp-probe',
      },
      timeout: 2500,
      rejectUnauthorized: false,
      servername: ip,
    }, (res) => {
      let buf = Buffer.alloc(0);
      res.on('data', (d) => buf = Buffer.concat([buf, d]));
      res.on('end', () => fin({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('timeout', () => { req.destroy(); fin({ status: 'timeout', err: 'socket timeout' }); });
    req.on('error', (e) => fin({ status: 'error', err: e.code || e.message }));
    req.end(body);
  });
}

// ---------- 解析 ----------
const TAG = {
  0x10: 'unsupported', 0x12: 'unknown', 0x13: 'no-value',
  0x21: 'integer', 0x22: 'boolean', 0x23: 'enum',
  0x30: 'octetString', 0x31: 'dateTime', 0x32: 'resolution', 0x33: 'rangeOfInteger',
  0x34: 'begCollection', 0x35: 'textWithLanguage', 0x36: 'nameWithLanguage', 0x37: 'endCollection',
  0x41: 'text', 0x42: 'name', 0x44: 'keyword', 0x45: 'uri', 0x46: 'uriScheme',
  0x47: 'charset', 0x48: 'naturalLanguage', 0x49: 'mimeMediaType', 0x4a: 'memberAttrName',
};

function parseIpp(buf) {
  const out = { version: null, statusCode: null, requestId: null, attrs: [], groups: [], errors: [] };
  if (buf.length < 8) { out.errors.push('short body'); return out; }
  out.version = `${buf[0]}.${buf[1]}`;
  out.statusCode = buf.readUInt16BE(2);
  out.requestId = buf.readUInt32BE(4);
  let i = 8;
  let lastName = '';
  let group = null;
  while (i < buf.length) {
    const t = buf[i];
    if (t === 0x03) break;            // end-of-attributes
    if (t >= 0x01 && t <= 0x05) {      // delimiter tags
      group = t;
      out.groups.push(t);
      i += 1;
      continue;
    }
    if (i + 2 > buf.length) { out.errors.push(`truncated name-len at ${i}`); break; }
    const nameLen = buf.readInt16BE(i + 1);
    i += 3;
    let name = lastName;
    if (nameLen > 0) {
      if (i + nameLen > buf.length) { out.errors.push(`truncated name at ${i}`); break; }
      name = buf.subarray(i, i + nameLen).toString('utf8');
      lastName = name;
      i += nameLen;
    }
    if (i + 2 > buf.length) { out.errors.push(`truncated val-len at ${i}`); break; }
    const valLen = buf.readInt16BE(i);
    i += 2;
    if (i + valLen > buf.length) { out.errors.push(`truncated value ${name} at ${i} (len=${valLen}, remain=${buf.length - i})`); break; }
    const raw = buf.subarray(i, i + valLen);
    i += valLen;
    let value;
    switch (t) {
      case 0x21: case 0x23: value = raw.length === 4 ? raw.readInt32BE(0) : raw.toString('hex'); break;
      case 0x22: value = raw.length === 1 ? raw[0] !== 0 : raw.toString('hex'); break;
      case 0x33: value = `${raw.readInt32BE(0)}..${raw.readInt32BE(4)}`; break;
      case 0x31: value = raw.toString('hex'); break;
      default: value = raw.toString('utf8');
    }
    out.attrs.push({ group, tag: t, tagName: TAG[t] || `0x${t.toString(16)}`, name, value });
  }
  return out;
}

function summarize(ip, r) {
  const lines = [];
  lines.push(`status=${r.status} ms=${r.ms} contentType=${r.headers && r.headers['content-type']} bytes=${r.body ? r.body.length : 0}`);
  if (r.err) lines.push(`err=${r.err}`);
  if (r.headers) {
    const h = r.headers;
    ["www-authenticate", "set-cookie", "server", "location"].forEach((k) => { if (h[k]) lines.push(`${k}: ${h[k]}`); });
  }
  return lines.join(' | ');
}

const PATHS = ['/ipp/print', '/ipp', '/ipp/port1', '/printers', '/'];
const VERSIONS = [[0x02, 0x00], [0x01, 0x01]];

(async () => {
  const ips = (process.argv[2] || '192.168.2.170,192.168.2.235,192.168.2.213').split(',');
  const results = [];

  for (const ip of ips) {
    console.log(`\n================ ${ip} ================`);
    let best = null;
    for (const ver of VERSIONS) {
      for (const path of PATHS) {
        const uri = `ipp://${ip}:631${path}`;
        const body = buildRequest(ver, uri, 0x00000001);
        const r = await post(ip, 631, path, body);
        const ok = typeof r.status === 'number' && r.status >= 200 && r.status < 300 && r.body && r.body.length > 8;
        console.log(`  v${ver[0]}.${ver[1]} ${path.padEnd(12)} -> ${summarize(ip, r)}`);
        if (ok && !best) best = { ver, path, r };
        if (ok) { results.push({ ip, ver: `v${ver[0]}.${ver[1]}`, path, r }); }
        // 一旦 v2.0 + /ipp/print 成功就不再穷举
        if (ok && ver[0] === 2 && path === '/ipp/print') break;
      }
      if (best) break;
    }

    // 80 端口 / 443 兜底
    if (!best) {
      for (const [port, tls, p] of [[80, false, '/ipp/print'], [443, true, '/ipp/print'], [443, true, '/ipp']]) {
        const uri = `ipp://${ip}:${port}${p}`;
        const body = buildRequest([0x02, 0x00], uri, 3);
        const r = await post(ip, port, p, body, { tls });
        console.log(`  fallback ${tls ? 'https' : 'http'} :${port}${p} -> ${summarize(ip, r)}`);
        if (typeof r.status === 'number' && r.body && r.body.length > 8) results.push({ ip, ver: 'v2.0', path: `${tls ? 'https' : 'http'}:${port}${p}`, r });
      }
      // 纯 HTTP GET 看是否 301/404/200
      for (const [port, tls] of [[80, false], [443, true]]) {
        const g = await new Promise((res) => {
          const lib = tls ? https : http;
          const rq = lib.request({ host: ip, port, path: '/', method: 'GET', timeout: 2000, rejectUnauthorized: false, servername: ip }, (rs) => {
            let b = Buffer.alloc(0); rs.on('data', (d) => b = Buffer.concat([b, d]));
            rs.on('end', () => res({ status: rs.statusCode, len: b.length, headers: rs.headers }));
          });
          rq.on('timeout', () => { rq.destroy(); res({ status: 'timeout' }); });
          rq.on('error', (e) => res({ status: 'error', err: e.code }));
          rq.end();
        });
        console.log(`  GET ${tls ? 'https' : 'http'} :${port}/ -> status=${g.status} len=${g.len} server=${g.headers && g.headers.server}`);
      }
    }

    if (best) {
      const parsed = parseIpp(best.r.body);
      console.log(`  ---- PARSED (v${best.ver.join('.')} ${best.path}) ----`);
      console.log(`  version=${parsed.version} statusCode=0x${parsed.statusCode.toString(16)} requestId=${parsed.requestId} attrs=${parsed.attrs.length} errors=${JSON.stringify(parsed.errors)}`);
      const show = parsed.attrs.filter((a) => /marker|printer-state|queued-job|printer-name|printer-make|printer-info|printer-is-accepting|printer-up-time|document-format-supported|operations-supported|charset|natural-language|printer-device-id|printer-alert/.test(a.name));
      for (const a of show) console.log(`   ${a.name} = ${JSON.stringify(a.value)}  (tag=${a.tagName})`);
      const names = parsed.attrs.map((a) => a.name);
      const dup = names.filter((n, idx) => names.indexOf(n) !== idx);
      console.log(`  duplicate-attr-names = ${JSON.stringify([...new Set(dup)].slice(0, 12))} (count=${dup.length})`);
      console.log(`  first-25-attr-names = ${JSON.stringify([...new Set(names)].slice(0, 25))}`);
    }
  }
})().catch((e) => console.log('FATAL', e));
