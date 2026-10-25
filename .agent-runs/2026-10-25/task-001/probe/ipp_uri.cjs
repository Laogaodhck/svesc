const http=require('http');
function A(t,n,v){const nb=Buffer.from(n),vb=Buffer.from(v);return Buffer.concat([Buffer.from([t]),Buffer.from([0,nb.length]),nb,Buffer.from([vb.length>>8,vb.length&255]),vb]);}
function go(ip,path,uri){const body=Buffer.concat([Buffer.from([0x01,0x01,0x00,0x09,0,0,0,30,0x01]),A(0x47,'attributes-charset','utf-8'),A(0x48,'attributes-natural-language','en'),A(0x45,'printer-uri',uri),Buffer.from([0x03])]);
return new Promise(r=>{const rq=http.request({host:ip,port:631,path,method:'POST',headers:{'Content-Type':'application/ipp','Content-Length':body.length,Connection:'close'},timeout:2500},rs=>{let b=Buffer.alloc(0);rs.on('data',d=>b=Buffer.concat([b,d]));rs.on('end',()=>r({http:rs.statusCode,len:b.length,st:b.length>=8?b.readUInt16BE(2):null}));});rq.on('timeout',()=>{rq.destroy();r({http:'timeout'})});rq.on('error',e=>r({http:'err:'+e.code}));rq.end(body);});}
(async()=>{
 const cands=[['/ipp','ipp://192.168.2.170:631/ipp'],['/ipp','ipp://192.168.2.170/ipp'],['/ipp','ipp://192.168.2.170:631/'],['/ipp','ipp://192.168.2.170:631/printers/1'],['/ipp','ipp://192.168.2.170:631/ipp/port1'],['/ipp','ipp://192.168.2.170:631/ipp/print'],['/printers/1','ipp://192.168.2.170:631/printers/1'],['/ipp/port1','ipp://192.168.2.170:631/ipp/port1']];
 for(const [p,u] of cands){const r=await go('192.168.2.170',p,u);console.log(`SHARP path=${p} uri=${u} -> http=${r.http} ipp=${r.st!=null?'0x'+r.st.toString(16):'-'} len=${r.len}`);}
})();
