import { build } from 'esbuild';
import os from 'node:os'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const bp = path.join(os.tmpdir(), 'fp-test.cjs');
await build({
  entryPoints: ['src/main/engine/discovery/fingerprint.ts'],
  bundle: true, platform: 'node', format: 'cjs', outfile: bp, logLevel: 'error',
});
const { inferFingerprint } = await import(pathToFileURL(bp).href);
const cases = [
  { name: '.50 TP-LINK+80口', openPorts: [80], hostname: null, vendor: 'TP-LINK TECHNOLOGIES' },
  { name: '.104 Haier 无口', openPorts: [], hostname: null, vendor: 'Qingdao Haier Technology' },
  { name: '.109 Honor 无口', openPorts: [], hostname: null, vendor: 'Honor Device' },
  { name: '.111 Haier 无口', openPorts: [], hostname: null, vendor: 'Qingdao Haier Technology' },
  { name: '.114 Huawei 无口', openPorts: [], hostname: null, vendor: 'HUAWEI TECHNOLOGIES' },
  { name: '.105 随机MAC', openPorts: [], hostname: null, vendor: '随机 MAC（厂商不可判）' },
];
for (const c of cases) {
  const r = inferFingerprint(c);
  console.log(c.name.padEnd(20), '→', r.kind.padEnd(12), r.osHint);
}
