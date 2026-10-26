import { build } from 'esbuild';
import os from 'node:os'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const bp = path.join(os.tmpdir(), 'oui-test.cjs');
await build({
  entryPoints: ['src/main/engine/discovery/oui.ts'],
  bundle: true, platform: 'node', format: 'cjs', outfile: bp, logLevel: 'error',
});
const { lookupVendor, isRandomizedMac } = await import(pathToFileURL(bp).href);
const macs = ['60-a3-e3-5e-2c-2c','ac-b7-22-70-d7-3c','b0-81-01-70-50-ae','54-ea-e1-37-c7-d4','d8-e2-3f-c9-60-e4','20-54-fa-2d-78-ce','78-a6-a0-a7-71-14','60-a3-e3-1d-1a-50'];
for (const m of macs) console.log(m.slice(0,8).padEnd(9), 'vendor=', JSON.stringify(lookupVendor(m)), 'random=', isRandomizedMac(m));
