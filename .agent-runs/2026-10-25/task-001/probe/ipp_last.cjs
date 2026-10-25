const http=require('http');
function A(t,n,v){const nb=Buffer.from(n),vb=Buffer.from(v);return Buffer.concat([Buffer.from([t]),Buffer.from([0,nb.length]),nb,Buffer.from([vb.length>>8,vb.length&255]),vb]);}
function go(ip,port,path,ver,uri,extra){
  const body=Buffer.concat([Buffer.from([ver[0],ver[1],0x00,0x09,0,0,0,21,0x01]),A(0x47,'attributes-charset','utf-8'),A(0x48,'attributes-natural-language','en'),A(0x45,'printer-uri',uri),...extra,Buffer.from([0x03])]);
  return new Promise(r=>{const rq=http.request({host:ip,port,path,method:'POST',headers:{'Content-Type':'application/ipp','Content-Length':body.length,Connection:'close'},timeout:2500},rs=>{let b=Buffer.alloc(0);rs.on('data',d=>b=Buffer.concat([b,d]));rs.on('end',()=>r({http:rs.statusCode,len:b.length,st:b.length>=8?b.readUInt16BE(2):null,b}));});
  rq.on('timeout',()=>{rq.destroy();r({http:'timeout'})});rq.on('error',e=>r({http:'err:'+e.code}));rq.end(body);});
}
(async()=>{
  const req1=A(0x44,'requested-attributes','printer-state');
  const reqAll=A(0x44,'requested-attributes','all');
  const cases=[
    ['192.168.2.170','/ipp',[0x01,0x00],'ipp://192.168.2.170:631/ipp',[]],
    ['192.168.2.170','/ipp',[0x01,0x01],'ipp://192.168.2.170:631/ipp',[reqAll]],
    ['192.168.2.170','/ipp',[0x02,0x00],'ipp://192.168.2.170/ipp',[]],
    ['192.168.2.170','/ipp',[0x01,0x01],'ipp://192.168.2.170/ipp/print',[]],
    ['192.168.2.235','/ipp/print',[0x01,0x01],'ipp://192.168.2.235:631/ipp/print',[req1]],
    ['192.168.2.235','/ipp/print',[0x01,0x00],'ipp://192.168.2.235:631/ipp/print',[]],
    ['192.168.2.235','/ipp/print',[0x02,0x00],'http://192.168.2.235:631/ipp/print',[]],
  ];
  for(const [ip,path,ver,uri,extra] of cases){
    const r=await go(ip,631,path,ver,uri,extra);
    console.log(`${ip} ${path} v${ver[0]}.${ver[1]} uri=${uri} -> http=${r.http} ipp=${r.st!=null?'0x'+r.st.toString(16):'-'} len=${r.len}`);
  }
})();
