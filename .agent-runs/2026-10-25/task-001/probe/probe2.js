const { spawn, execFile } = require('child_process');
const net = require('net');

const dec = (b) => new TextDecoder('gb18030').decode(b);
function sh(cmd, args, timeout = 8000) {
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { windowsHide: true });
    let b = Buffer.alloc(0); let e = Buffer.alloc(0);
    p.stdout.on('data', (d) => b = Buffer.concat([b, d]));
    p.stderr.on('data', (d) => e = Buffer.concat([e, d]));
    const timer = setTimeout(() => p.kill(), timeout);
    p.on('close', (c) => { clearTimeout(timer); res({ code: c, out: dec(b), err: dec(e), ms: Date.now() - t0 }); });
  });
}
function ping1(ip) {
  return new Promise((res) => {
    const p = spawn('ping', ['-n', '1', '-w', '600', ip], { windowsHide: true });
    let b = Buffer.alloc(0); p.stdout.on('data', (d) => b = Buffer.concat([b, d]));
    p.on('close', (c) => {
      const s = dec(b);
      const mRtt = /时间[=<]\s*(\d+)\s*ms/.exec(s);
      const mTtl = /TTL=(\d+)/i.exec(s);
      res({ ip, alive: c === 0, rtt: mRtt ? +mRtt[1] : null, ttl: mTtl ? +mTtl[1] : null });
    });
  });
}

(async () => {
  const mode = process.argv[2];

  if (mode === 'ttl') {
    const hosts = process.argv.slice(3);
    const out = [];
    for (const h of hosts) out.push(await ping1(h));
    for (const r of out) console.log(`TTL ${r.ip} alive=${r.alive} rtt=${r.rtt} ttl=${r.ttl}`);
    return;
  }

  if (mode === 'hostname') {
    // ping -a 反解
    for (const ip of process.argv.slice(3)) {
      const r = await sh('ping', ['-a', '-n', '1', '-w', '600', ip]);
      console.log(`--- ping -a ${ip} (code ${r.code}, ${r.ms}ms) ---`);
      console.log(JSON.stringify(r.out.split(/\r?\n/).filter(Boolean).slice(0, 3)));
    }
    const n = await sh('nslookup', ['192.168.2.170']);
    console.log('--- nslookup .170 ---', n.code, n.ms + 'ms');
    console.log(JSON.stringify(n.out.slice(0, 300)));
    const h = await sh('hostname', []);
    console.log('--- local hostname ---', JSON.stringify(h.out.trim()));
    return;
  }

  if (mode === 'net') {
    // netstat -e (字节) 连续两次差分
    const a = await sh('netstat', ['-e']);
    await new Promise((r) => setTimeout(r, 2000));
    const b = await sh('netstat', ['-e']);
    console.log('--- netstat -e ---', JSON.stringify(a.out));
    console.log('--- after 2s ---', JSON.stringify(b.out));
    // Get-NetAdapterStatistics 连续两次
    const q = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress';
    const s1 = await sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', q]);
    await new Promise((r) => setTimeout(r, 2000));
    const s2 = await sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', q]);
    console.log('--- stats t0 ---', s1.ms + 'ms', s1.out.trim());
    console.log('--- stats t2 ---', s2.ms + 'ms', s2.out.trim());
    console.log('--- raw counters (Get-NetAdapterStatistics detailed) ---');
    const d = await sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-NetAdapterStatistics | Get-Member -MemberType Property | Select-Object -ExpandProperty Name']);
    console.log(d.out.trim().replace(/\r?\n/g, ' | '));
    return;
  }

  if (mode === 'tcp') {
    const q = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-NetTCPConnection -State Established | Select-Object RemoteAddress,RemotePort,State,OwningProcess | ConvertTo-Json -Compress';
    const r = await sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', q]);
    console.log(`Get-NetTCPConnection elapsed=${r.ms}ms code=${r.code}`);
    let arr = [];
    try { const j = JSON.parse(r.out); arr = Array.isArray(j) ? j : [j]; } catch (e) { console.log('parse err', e.message, r.out.slice(0, 200)); }
    console.log('established count =', arr.length);
    const agg = {};
    for (const c of arr) {
      const k = c.RemoteAddress;
      agg[k] = (agg[k] || 0) + 1;
    }
    console.log('grouped sample:', JSON.stringify(Object.entries(agg).filter(([k]) => k && k.startsWith('192.168.2')).slice(0, 6)));
    // netstat -ano 对比耗时
    const n = await sh('netstat', ['-ano']);
    const lines = n.out.split(/\r?\n/).filter((l) => /ESTABLISHED/.test(l));
    console.log(`netstat -ano elapsed=${n.ms}ms established-text-lines=${lines.length}`);
    console.log('raw first line:', JSON.stringify(n.out.split(/\r?\n/).slice(0, 5)));
    return;
  }

  if (mode === 'printerdetail') {
    const ps = (code) => sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + code]);
    const name = process.argv[3];
    const q = `Get-Printer -Name '${name}' | Select-Object * -ExcludeProperty CimClass,CimInstanceProperties,CimSystemProperties | ConvertTo-Json -Compress`;
    const r = await ps(q);
    console.log(`--- Get-Printer '*' ${r.ms}ms code=${r.code} ---`);
    console.log(r.out.trim().slice(0, 1600));
    const r2 = await ps(`Get-PrinterProperty -PrinterName '${name}' | Select-Object PropertyName,Value | ConvertTo-Json -Compress`);
    console.log(`--- Get-PrinterProperty ${r2.ms}ms code=${r2.code} ---`);
    console.log(r2.out.trim().slice(0, 900));
    console.log('--- err ---', r2.err.trim().slice(0, 300));
    const r3 = await ps(`Get-PrintJob -PrinterName '${name}' | ConvertTo-Json -Compress`);
    console.log(`--- Get-PrintJob ${r3.ms}ms code=${r3.code} ---`, r3.out.trim().slice(0, 300), '| err:', r3.err.trim().slice(0, 200));
    const r4 = await ps(`Get-PrinterPort | Select-Object Name,PrinterName,Description,PortNumber | ConvertTo-Json -Compress`);
    console.log(`--- Get-PrinterPort ${r4.ms}ms ---`, r4.out.trim().slice(0, 900));
    const r5 = await ps(`Get-CimInstance Win32_Printer | Where-Object {$_.PortName -like '*192.168*'} | Select-Object Name,PortName,PrinterStatus,DetectedErrorState,ExtendedPrinterStatus,WorkOffline,Status,Comment,Location | ConvertTo-Json -Compress`);
    console.log(`--- Win32_Printer net ${r5.ms}ms ---`, r5.out.trim().slice(0, 900));
    return;
  }
})();
