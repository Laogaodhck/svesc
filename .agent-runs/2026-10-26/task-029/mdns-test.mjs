import { build } from 'esbuild';
import os from 'node:os'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const bp = path.join(os.tmpdir(), 'mdns-test.cjs');
await build({
  entryPoints: ['src/main/engine/discovery/mdns-devices.ts'],
  bundle: true, platform: 'node', format: 'cjs', outfile: bp, logLevel: 'error',
});
const { discoverMdnsDevices } = await import(pathToFileURL(bp).href);
const t0 = Date.now();
const hits = await discoverMdnsDevices(3500);
console.log(`mDNS 3.5s 窗口: ${hits.length} 条命中, 耗时 ${Date.now() - t0}ms`);
for (const h of hits) console.log(`  ${h.ip.padEnd(16)} ${h.kind.padEnd(12)} ${h.service} ${h.name}`);
