const {execFile}=require('child_process');
const t=(cmd,args)=>new Promise(r=>{const s=Date.now();execFile(cmd,args,{encoding:'buffer',maxBuffer:1e7},(e,so)=>r({cmd:cmd+' '+args.join(' '),ms:Date.now()-s,bytes:so?so.length:0}));});
(async()=>{for(const [c,a] of [['arp',['-a']],['arp',['-a']],['netstat',['-e']],['netstat',['-e']],['netstat',['-ano']],['ping',['-n','1','-w','800','192.168.2.1']]]) console.log(JSON.stringify(await t(c,a)));})();
