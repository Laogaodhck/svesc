import { build } from 'esbuild';
import os from 'node:os'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const bp = path.join(os.tmpdir(), 'fp-test2.cjs');
await build({ entryPoints: ['src/main/engine/discovery/fingerprint.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bp, logLevel: 'error' });
const { inferFingerprint } = await import(pathToFileURL(bp).href);
const cases = [
  { name: '.119 华硕+445', openPorts: [445], hostname: null, vendor: 'ASUSTek COMPUTER' },
  { name: '.128 华硕+445', openPorts: [445], hostname: null, vendor: 'ASUSTek COMPUTER' },
  { name: 'Realtek 芯片无口', openPorts: [], hostname: null, vendor: 'Realtek Semiconductor Corp.' },
  { name: 'OpenWrt SSH-only', openPorts: [22], hostname: 'OpenWrt', vendor: null },
];
for (const c of cases) { const r = inferFingerprint(c); console.log(c.name.padEnd(18), '→', r.kind.padEnd(12), r.osHint); }
