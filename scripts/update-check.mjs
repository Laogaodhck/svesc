#!/usr/bin/env node
// --install 仅安装/清理独立测试应用；--build-only 只打包，不验证生产向导或 SmartScreen。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const install = args.includes('--install');
const buildOnly = args.includes('--build-only');
const timeoutIndex = args.indexOf('--timeout-ms');
const stageTimeout = timeoutIndex < 0 ? 120_000 : Number(args[timeoutIndex + 1]);
const known = args.filter((_, index) => index !== timeoutIndex + 1 || timeoutIndex < 0);
assert(known.every((arg) => ['--install', '--build-only', '--timeout-ms', '--help'].includes(arg)), 'Unknown argument');
assert(!(install && buildOnly), 'Choose --install OR --build-only');
assert(Number.isFinite(stageTimeout) && stageTimeout >= 10_000 && stageTimeout <= 300_000, 'Timeout must be 10000..300000 ms');
if ((!install && !buildOnly) || args.includes('--help')) {
  console.log('Usage: node scripts/update-check.mjs --install | --build-only [--timeout-ms 120000]\nCreates unique temp packages; --install authorizes only their per-user NSIS installation and cleanup.');
  process.exit(0);
}
assert.equal(process.platform, 'win32', 'Real NSIS validation requires Windows');
assert.equal(process.arch, 'x64', 'This fixture currently builds Windows x64');

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svesc-update-check-'));
const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const productName = `SVESC Update Fixture ${id}`;
const packageName = `svesc-update-fixture-${id}`;
const appId = `test.svesc.update.${id}`;
const guid = randomUUID();
const installDir = path.join(runRoot, 'installed');
const exeName = `${packageName}.exe`;
const installedExe = path.join(installDir, exeName);
// NSIS itself uses the Windows known-folder path; its own installer cache is still uniquely named.
const nsisCacheDir = path.join(cleanEnv().LOCALAPPDATA, `${packageName}-updater`);
const token = randomUUID();
const deadline = Date.now() + 20 * 60_000;
const feedFiles = new Map();
const events = [];
const signals = new EventEmitter();
const commands = new Map();
const children = new Set();
let feedMode = 'offline';
let exeRequests = 0;
let exeBytes = 0;
let installed = false;
let activeBoot;
let server;
let stopping = false;
const result = {
  runRoot, appId, productName, packageName, guid, installDir,
  status: 'RUNNING', realNsisUpgradeSucceeded: false,
  limitations: ['oneClick fixture, not production assisted wizard/SmartScreen validation', 'Notification.isSupported stubbed; updater/cache/NSIS are real', 'Loopback fault injection does not disconnect the host network'],
  builds: [], checks: [], cleanup: {},
};
const writeResult = () => fs.writeFileSync(path.join(runRoot, 'result.json'), JSON.stringify(result, null, 2));
const journal = (kind, data) => fs.appendFileSync(path.join(runRoot, 'harness-events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), kind, data })}\n`);
function pass(name, data = {}) {
  result.checks.push({ name, ...data });
  journal('check', { name, ...data });
  console.log(`[update-check] ${name}`);
  writeResult();
}
function accept(event) {
  events.push(event);
  signals.emit('event', event);
  if (event.kind === 'status') console.log(`[update-check] ${event.version} ${event.data.phase}`);
}
function waitEvent(predicate, label, since = 0, timeout = stageTimeout) {
  const found = events.slice(since).find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out: ${label}`)), Math.min(timeout, Math.max(1, deadline - Date.now())));
    const listener = (event) => {
      if (event.kind === 'fatal') finish(new Error(`Fixture fatal: ${event.data.message}`));
      else if (predicate(event)) finish(null, event);
    };
    function finish(error, event) {
      clearTimeout(timer);
      signals.off('event', listener);
      if (error) reject(error); else resolve(event);
    }
    signals.on('event', listener);
  });
}
async function hashFile(file) {
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}
function cleanEnv() {
  const env = {};
  for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
    const found = Object.keys(process.env).find((name) => name.toLowerCase() === key.toLowerCase());
    if (found) env[key] = process.env[found];
  }
  return env;
}
function start(file, argv, options = {}) {
  const child = spawn(file, argv, { cwd: runRoot, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
  children.add(child);
  const label = options.label || path.basename(file);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk) => {
    output += chunk.toString();
    fs.appendFileSync(path.join(runRoot, `${label}.log`), chunk);
  });
  child.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal, output }); });
  });
  // Some children remain alive while the harness waits on callback reports.
  child.done.catch(() => {});
  return child;
}
async function finishChild(child, timeout = stageTimeout) {
  let timer;
  try {
    return await Promise.race([child.done, new Promise((_, reject) => {
      timer = setTimeout(() => { child.kill(); reject(new Error(`Child timeout (pid ${child.pid})`)); }, timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function run(file, argv, options = {}, timeout = stageTimeout) {
  const value = await finishChild(start(file, argv, options), timeout);
  assert.equal(value.code, 0, `${path.basename(file)} failed (${value.code}); see ${runRoot}`);
  return value.output.trim();
}
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
async function powershell(script, label) {
  const file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return run(file, ['-NoProfile', '-NonInteractive', '-Command', script], { label }, 30_000);
}
async function registry() {
  const base = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`;
  const installKey = `Software\\${guid}`;
  const text = await powershell(`$ErrorActionPreference='Stop'; $r=@(); foreach($h in @('HKCU:','HKLM:')) { $p=$h+'\\'+${psQuote(base)}; $i=$h+'\\'+${psQuote(installKey)}; if(Test-Path -LiteralPath $p) { $v=Get-ItemProperty -LiteralPath $p; $location=$null; if(Test-Path -LiteralPath $i) { $location=(Get-ItemProperty -LiteralPath $i).InstallLocation }; $r+=@{key=$p;installKey=$i;name=$v.DisplayName;version=$v.DisplayVersion;location=$location;uninstaller=$v.UninstallString} } elseif(Test-Path -LiteralPath $i) { $r+=@{key=$i;orphan=$true} } }; ConvertTo-Json -InputObject @($r) -Compress`, 'registry');
  return JSON.parse(text);
}
async function versionEvidence(version) {
  const productVersion = await powershell(`(Get-Item -LiteralPath ${psQuote(installedExe)}).VersionInfo.ProductVersion`, 'exe-version');
  assert(productVersion.startsWith(version), `PE version ${productVersion} != ${version}`);
  const asarSha512 = await hashFile(path.join(installDir, 'resources', 'app.asar'));
  assert.equal(asarSha512, result.builds.find((build) => build.version === version).asarSha512);
  const entries = await registry();
  assert.equal(entries.length, 1, 'Exactly one fixture uninstall entry');
  assert(entries[0].key.startsWith('HKCU:'), 'Fixture must be per-user, not HKLM');
  assert.equal(entries[0].name, `${productName} ${version}`);
  assert.equal(entries[0].version, version);
  assert.equal(path.resolve(entries[0].location).toLowerCase(), installDir.toLowerCase());
  return { productVersion, asarSha512, registry: entries };
}
function command(boot, action) {
  const index = events.length;
  const queue = commands.get(boot.bootId) || [];
  queue.push({ id: randomUUID(), action });
  commands.set(boot.bootId, queue);
  journal('command', { bootId: boot.bootId, action });
  return index;
}
function state(boot, phase, since) {
  return waitEvent((event) => event.bootId === boot.bootId && event.kind === 'status' && event.data.phase === phase, `${boot.version} ${phase}`, since);
}
async function bootAfter(since) {
  const boot = await waitEvent((event) => event.kind === 'boot', 'installed fixture boot', since);
  activeBoot = boot;
  const data = boot.data;
  assert.equal(data.appId, appId);
  assert.equal(data.name, productName);
  assert.equal(data.isPackaged, true);
  assert.equal(data.updater, 'NsisUpdater');
  assert.equal(path.resolve(data.exe).toLowerCase(), installedExe.toLowerCase());
  assert.equal(data.userData, path.join(runRoot, 'user-data'));
  assert.equal(data.localCache, path.join(runRoot, 'local-cache'));
  assert.equal(data.autoDownload, true);
  assert.equal(data.autoInstallOnAppQuit, false, 'Service must configure REAL updater.autoInstallOnAppQuit');
  assert.equal(data.allowPrerelease, false);
  assert.equal(data.allowDowngrade, false);
  return boot;
}
async function launch() {
  const since = events.length;
  const child = start(installedExe, [], { label: 'fixture' });
  return { child, boot: await bootAfter(since) };
}
async function quit(boot, child) {
  const since = command(boot, 'quit');
  await waitEvent((event) => event.bootId === boot.bootId && event.kind === 'normal-quit', 'normal app.quit', since);
  if (child) assert.equal((await finishChild(child, 20_000)).code, 0);
  else await waitUntil(() => {
    const all = readFixtureEvents();
    return all.some((event) => event.bootId === boot.bootId && event.kind === 'quit');
  }, 'detached fixture quit', 20_000);
  activeBoot = undefined;
}
function readFixtureEvents() {
  const file = path.join(runRoot, 'fixture-events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
async function waitUntil(predicate, label, timeout) {
  const until = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= until) throw new Error(`Timed out: ${label}`);
    // Bounded polling is only for externally owned NSIS/process/file completion.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
function json(res, data) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }
async function serve(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/feed/')) {
    const name = decodeURIComponent(url.pathname.slice('/feed/'.length));
    journal('feed-request', { name, mode: feedMode, range: req.headers.range || null });
    if (feedMode === 'offline') { req.socket.destroy(); return; }
    if (feedMode === 'metadata-missing' || !feedFiles.has(name)) { res.writeHead(404); res.end('Fixture metadata unavailable'); return; }
    const file = feedFiles.get(name);
    const size = fs.statSync(file).size;
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    let start = 0; let end = size - 1;
    if (req.headers.range && !range) { res.writeHead(416); res.end(); return; }
    if (range) { start = Number(range[1]); end = range[2] ? Number(range[2]) : end; }
    if (start > end || end >= size) { res.writeHead(416); res.end(); return; }
    const headers = { 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'content-type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    if (name.endsWith('.exe')) exeRequests++;
    res.writeHead(range ? 206 : 200, headers);
    const stream = fs.createReadStream(file, { start, end });
    if (name.endsWith('.exe')) stream.on('data', (chunk) => { exeBytes += chunk.length; });
    await pipeline(stream, res);
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end(); return; }
  if (url.pathname === '/command') { json(res, commands.get(url.searchParams.get('bootId'))?.shift() || {}); return; }
  if (url.pathname === '/report' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 128 * 1024) throw new Error('Report too large'); }
    const event = JSON.parse(body);
    accept(event);
    json(res, { ok: true });
    return;
  }
  res.writeHead(404); res.end();
}
function findFile(dir, basename) {
  if (!fs.existsSync(dir)) return undefined;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === basename) return file;
    if (entry.isDirectory()) { const found = findFile(file, basename); if (found) return found; }
  }
}
async function buildPackages(origin) {
  const esbuild = require('esbuild');
  const yaml = require('js-yaml');
  const local = cleanEnv().LOCALAPPDATA;
  const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(local, 'electron-builder', 'Cache');
  const nsis = [path.join(cache, 'nsis', 'nsis-3.0.4.1'), path.join(cache, 'nsis-3.0.4.1')].find((dir) => fs.existsSync(path.join(dir, 'Bin', 'makensis.exe')));
  const resources = [path.join(cache, 'nsis', 'nsis-resources-3.4.1'), path.join(cache, 'nsis-resources-3.4.1')].find((dir) => fs.existsSync(path.join(dir, 'plugins')));
  const sevenZip = findFile(path.join(cache, '7zip@1.0.0'), '7za.exe');
  assert(nsis && resources && sevenZip, 'Pre-cached NSIS/resources/7zip required; harness will not download tools');
  const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
  assert(fs.existsSync(path.join(electronDist, 'electron.exe')), 'Local electronDist missing');
  const electronVersion = fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim();
  result.tools = { node: process.version, electron: electronVersion, builder: require('electron-builder/package.json').version, updater: require('electron-updater/package.json').version };
  const sourceFiles = ['scripts/update-check.mjs', 'scripts/fixtures/update-check-main.ts', 'src/main/updater.ts', 'src/main/engine/update-controller.ts', 'src/main/engine/update-policy.ts', 'src/main/notify.ts'];
  result.sourceSha512 = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, await hashFile(path.join(root, file))])));
  const bundle = await esbuild.build({
    absWorkingDir: root, entryPoints: [path.join(root, 'scripts', 'fixtures', 'update-check-main.ts')],
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false, metafile: true,
  });
  const bundledInputs = Object.keys(bundle.metafile.inputs).map((file) => file.replaceAll('\\', '/'));
  assert(!bundledInputs.some((file) => file.endsWith('src/main/index.ts')), 'Must not import production entry');
  result.bundledInputs = bundledInputs;
  result.bundleSha512 = createHash('sha512').update(bundle.outputFiles[0].contents).digest('base64');
  for (const file of sourceFiles) assert.equal(await hashFile(path.join(root, file)), result.sourceSha512[file], `Source changed during bundle: ${file}; rerun`);
  const env = {
    ...cleanEnv(), CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    ELECTRON_BUILDER_NSIS_DIR: nsis, ELECTRON_BUILDER_NSIS_RESOURCES_DIR: resources,
    ELECTRON_BUILDER_7ZIP_PATH: sevenZip,
    // Unexpected downloads fail locally rather than reach an external service.
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://127.0.0.1:1/', ELECTRON_MIRROR: 'https://127.0.0.1:1/',
    npm_config_registry: 'http://127.0.0.1:1/', npm_config_offline: 'true',
  };
  for (const version of ['0.4.0', '0.4.1']) {
    const project = path.join(runRoot, `project-${version}`);
    const output = path.join(runRoot, `output-${version}`);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'main.cjs'), bundle.outputFiles[0].contents);
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: packageName, productName, version, main: 'main.cjs', description: 'Isolated NSIS updater regression fixture', author: 'SVESC tests', private: true }));
    fs.writeFileSync(path.join(project, 'fixture.json'), JSON.stringify({ root: runRoot, appId, productName, controlUrl: origin, token, deadline, installDir }));
    const config = {
      appId, productName, executableName: packageName, electronVersion, electronDist,
      directories: { output, buildResources: path.join(project, 'build-resources') },
      files: ['main.cjs', 'fixture.json', 'package.json'], asar: true,
      npmRebuild: false, nodeGypRebuild: false, compression: 'normal',
      publish: { provider: 'generic', url: `${origin}/feed/`, useMultipleRangeRequest: false },
      win: { target: ['nsis'], requestedExecutionLevel: 'asInvoker', signExecutable: false },
      nsis: {
        guid, oneClick: true, perMachine: false, allowElevation: false, packElevateHelper: false,
        createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: true,
        deleteAppDataOnUninstall: false, artifactName: `${packageName}-\${version}-setup.\${ext}`,
      },
    };
    const configFile = path.join(runRoot, `builder-${version}.json`);
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    console.log(`[update-check] building ${version} -> ${output}`);
    await run(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--projectDir', project, '--config', configFile, '--win', 'nsis', '--x64', '--publish', 'never'], { env, label: `builder-${version}` }, 360_000);
    const resourcesDir = path.join(output, 'win-unpacked', 'resources');
    const updateConfig = yaml.load(fs.readFileSync(path.join(resourcesDir, 'app-update.yml'), 'utf8'));
    assert.equal(updateConfig.provider, 'generic');
    assert.equal(updateConfig.url, `${origin}/feed/`);
    assert.equal(updateConfig.updaterCacheDirName, `${packageName}-updater`);
    assert(!fs.existsSync(path.join(resourcesDir, 'elevate.exe')), 'Fixture must not bundle elevation helper');
    const metadataPath = path.join(output, 'latest.yml');
    const metadata = yaml.load(fs.readFileSync(metadataPath, 'utf8'));
    assert.equal(metadata.version, version);
    const artifact = path.join(output, `${packageName}-${version}-setup.exe`);
    const sha512 = await hashFile(artifact);
    assert.equal(metadata.sha512, sha512);
    assert.equal(metadata.files[0].sha512, sha512);
    assert.equal(metadata.files[0].size, fs.statSync(artifact).size);
    const asarSha512 = await hashFile(path.join(resourcesDir, 'app.asar'));
    result.builds.push({ version, artifact, sha512, asarSha512, updateConfig, metadata });
    for (const name of fs.readdirSync(output).filter((name) => /\.(exe|blockmap)$/.test(name))) feedFiles.set(name, path.join(output, name));
    if (version === '0.4.1') feedFiles.set('latest.yml', metadataPath);
    pass(`built-${version}-sha512-verified`, { sha512 });
  }
  assert.notEqual(result.builds[0].asarSha512, result.builds[1].asarSha512);
}
async function scenario() {
  assert.deepEqual(await registry(), [], 'Fresh identity already has a registry entry');
  assert(!fs.existsSync(nsisCacheDir), 'Fresh identity already has an installer cache');
  result.nsisCacheDir = nsisCacheDir;
  const initial = result.builds[0].artifact;
  installed = true; // Even a partial installation needs cleanup.
  // NSIS /D must be the final, unquoted argument, including when TEMP contains spaces.
  await run(initial, ['/S', `/D=${installDir}`], { argv0: `"${initial}"`, windowsVerbatimArguments: true, label: 'initial-install' });
  assert(fs.existsSync(installedExe), 'Initial NSIS install did not create isolated executable');
  pass('initial-nsis-0.4.0', await versionEvidence('0.4.0'));
  const first = await launch();
  assert.equal(first.boot.version, '0.4.0');
  feedMode = 'offline';
  await state(first.boot, 'error', command(first.boot, 'check'));
  assert.equal(exeRequests, 0);
  pass('loopback-disconnect-error');
  feedMode = 'metadata-missing';
  await state(first.boot, 'error', command(first.boot, 'check'));
  assert.equal(exeRequests, 0);
  pass('metadata-404-error');
  feedMode = 'online';
  const downloaded = await state(first.boot, 'downloaded', command(first.boot, 'check'));
  assert.equal(downloaded.data.availableVersion, '0.4.1');
  assert(exeRequests > 0 && exeBytes > 0, 'Must really transfer installer bytes');
  const cacheDir = path.join(runRoot, 'local-cache', `${packageName}-updater`, 'pending');
  const cacheInfo = JSON.parse(fs.readFileSync(path.join(cacheDir, 'update-info.json'), 'utf8'));
  assert.equal(path.basename(cacheInfo.fileName), cacheInfo.fileName);
  assert.notEqual(cacheInfo.isAdminRightsRequired, true);
  const cachedSha512 = await hashFile(path.join(cacheDir, cacheInfo.fileName));
  assert.equal(cachedSha512, result.builds[1].sha512);
  pass('manual-retry-real-download', { exeRequests, exeBytes, cacheDir, cachedSha512 });
  await quit(first.boot, first.child);
  pass('downloaded-normal-quit-still-0.4.0', await versionEvidence('0.4.0'));
  const beforeRequests = exeRequests;
  const beforeBytes = exeBytes;
  const second = await launch();
  assert.equal(second.boot.version, '0.4.0');
  const since = command(second.boot, 'check');
  await state(second.boot, 'downloaded', since);
  assert.equal(exeRequests, beforeRequests, 'Restart must not request the EXE again');
  assert.equal(exeBytes, beforeBytes, 'Restart must not re-transfer installer bytes');
  assert(readFixtureEvents().some((event) => event.bootId === second.boot.bootId && event.kind === 'log' && /already been downloaded/.test(event.data.message)), 'Require real updater cache-validation log');
  pass('restart-cache-sha512-restored-no-exe-transfer', { exeRequests, exeBytes, version: second.boot.version });
  const installingSince = command(second.boot, 'install');
  await state(second.boot, 'installing', installingSince);
  assert.equal((await finishChild(second.child, 30_000)).code, 0);
  // No manual launch/copy here: only quitAndInstall(false,true) + NSIS runAfterFinish can produce this boot.
  const upgraded = await bootAfter(installingSince);
  assert.equal(upgraded.version, '0.4.1');
  assert.notEqual(upgraded.bootId, second.boot.bootId);
  const evidence = await versionEvidence('0.4.1');
  const all = readFixtureEvents();
  assert(all.some((event) => event.bootId === second.boot.bootId && event.kind === 'install-result' && event.data.ok === true));
  assert(all.some((event) => event.bootId === second.boot.bootId && event.kind === 'log' && /Install: isSilent: false, isForceRunAfter: true/.test(event.data.message)), 'Require production quitAndInstall(false,true) evidence');
  assert(!all.some((event) => ['fatal', 'blocked-network', 'watchdog-expired'].includes(event.kind)));
  result.realNsisUpgradeSucceeded = true;
  pass('real-nsis-upgrade-0.4.1-auto-start', { bootId: upgraded.bootId, ...evidence });
  await quit(upgraded);
}
async function cleanup() {
  if (activeBoot) {
    try { await quit(activeBoot); } catch (error) { result.cleanup.quitError = error.message; }
  }
  for (const child of children) { try { child.kill(); } catch { /* Only directly owned child handles. */ } }
  if (!installed) return;
  // No taskkill /IM. Stop only executables whose verified absolute path is below this unique run directory.
  try {
    const prefix = `${runRoot}${path.sep}`;
    await powershell(`$ErrorActionPreference='Stop'; Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith(${psQuote(prefix)}, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.Id -ErrorAction Stop }`, 'fixture-process-cleanup');
    const uninstaller = path.join(installDir, `Uninstall ${packageName}.exe`);
    if (fs.existsSync(uninstaller)) {
      result.cleanup.uninstaller = uninstaller;
      await run(uninstaller, ['/S'], { label: 'uninstall' }, 60_000);
      await waitUntil(() => !fs.existsSync(installedExe), 'fixture uninstall', 30_000);
    }
    result.cleanup.registryRemaining = await registry();
    result.cleanup.installedExeRemaining = fs.existsSync(installedExe);
    assert.equal(result.cleanup.registryRemaining.length, 0, 'Fixture uninstall registry entry remains');
    assert.equal(result.cleanup.installedExeRemaining, false, 'Fixture installation remains');
    result.cleanup.uninstalled = true;
    fs.rmSync(nsisCacheDir, { recursive: true, force: true });
    result.cleanup.nativeInstallerCacheRemoved = nsisCacheDir;
  } catch (error) {
    result.cleanup.error = error.message;
    result.cleanup.retainedInstallDir = installDir;
  }
  // Keep isolated caches and build outputs as inspectable evidence; never remove unrelated paths.
  result.cleanup.retainedArtifacts = runRoot;
}
const interrupt = () => {
  if (stopping) return;
  stopping = true;
  feedMode = 'offline';
  for (const boot of events.filter((event) => event.kind === 'boot')) command(boot, 'quit');
  for (const child of children) { try { child.kill(); } catch { /* own child only */ } }
  result.status = 'FAIL';
  result.error = 'Interrupted or global deadline reached';
  writeResult();
  server?.closeAllConnections();
  server?.close();
  // Detached fixtures self-expire after losing loopback control; preserve paths for uninstall.
  console.error(`[update-check] interrupted; retained fixture: ${installDir}`);
  process.exit(1);
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const globalTimer = setTimeout(interrupt, deadline - Date.now());
try {
  console.log(`[update-check] isolated output: ${runRoot}`);
  writeResult();
  server = http.createServer((req, res) => { void serve(req, res).catch((error) => { journal('server-error', { message: error.message }); res.destroy(); }); });
  server.requestTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  result.feedUrl = `${origin}/feed/`;
  await buildPackages(origin);
  if (install) { await scenario(); result.status = 'PASS'; }
  else result.status = 'BUILT_NOT_INSTALLED';
} catch (error) {
  result.status = 'FAIL';
  result.error = error.stack || error.message;
  console.error(`[update-check] FAIL: ${error.message}`);
} finally {
  await cleanup();
  if (result.cleanup.error && result.status === 'PASS') result.status = 'FAIL';
  clearTimeout(globalTimer);
  server?.closeAllConnections();
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
  result.finishedAt = new Date().toISOString();
  writeResult();
  console.log(`[update-check] ${result.status}; real NSIS upgrade=${result.realNsisUpgradeSucceeded}; evidence=${path.join(runRoot, 'result.json')}`);
  process.exitCode = result.status === 'FAIL' ? 1 : 0;
}
