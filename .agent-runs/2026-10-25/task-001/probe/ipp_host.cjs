const http=require('http');
function A(t,n,v){const nb=Buffer.from(n),vb=Buffer.from(v);return Buffer.concat([Buffer.from([t]),Buffer.from([0,nb.length]),nb,Buffer.from([vb.length>>8,vb.length&255]),vb]);}
function go(ip,port,path,host,ver,extraUri){
  const uri=extraUri||`ipp://${ip}:631${path}`;
  const body=Buffer.concat([Buffer.from([ver[0],ver[1],0x00,0x09,0,0,0,11,0x01]),A(0x47,'attributes-charset','utf-8'),A(0x48,'attributes-natural-language','en'),A(0x45,'printer-uri',uri),Buffer.from([0x03])]);
  return new Promise(r=>{const rq=http.request({host:ip,port,path,method:'POST',headers:{'Content-Type':'application/ipp','Content-Length':body.length,Connection:'close',Host:host},timeout:2500},rs=>{let b=Buffer.alloc(0);rs.on('data',d=>b=Buffer.concat([b,d]));rs.on('end',()=>r({http:rs.statusCode,len:b.length,st:b.length>=8?b.readUInt16BE(2):null}));});
  rq.on('timeout',()=>{rq.destroy();r({http:'timeout'})});rq.on('error',e=>r({http:'err:'+e.code}));rq.end(body);});
}
(async()=>{
  const cases=[['192.168.2.235',631,'/ipp/print','192.168.2.235'],['192.168.2.235',631,'/ipp/print','XRX9C934E9C6A76.lan'],['192.168.2.235',631,'/ipp/print','localhost'],['192.168.2.235',631,'/ipp/print/','192.168.2.235'],['192.168.2.235',631,'/ipp/print','192.168.2.235:631'],['192.168.2.170',631,'/ipp','192.168.2.170'],['192.168.2.170',631,'/ipp','192.168.2.170:631'],['192.168.2.170',631,'/ipp/','192.168.2.170'],['192.168.2.170',631,'/ipp/print','192.168.2.170']];
  for(const [ip,port,path,host] of cases){
    for(const ver of [[0x01,0x01]]){
      const r=await go(ip,port,path,host,ver);
      console.log(`${ip} :${port}${path} Host=${host} v${ver[0]}.${ver[1]} -> http=${r.http} ipp=${r.st!=null?'0x'+r.st.toString(16):'-'} len=${r.len}`);
    }
  }
})();
