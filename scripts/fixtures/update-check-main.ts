/** Isolated packaged test host. Never imports main/index or starts collection. */
import { app, Notification, session } from 'electron';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { UpdateService } from '../../src/main/updater';

interface FixtureConfig {
  root: string;
  appId: string;
  productName: string;
  controlUrl: string;
  token: string;
  deadline: number;
  installDir: string;
}

const config: FixtureConfig = JSON.parse(readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const bootId = randomUUID();
const userData = path.join(config.root, 'user-data');
const localCache = path.join(config.root, 'local-cache');
for (const dir of [userData, localCache, path.join(config.root, 'session-data'), path.join(config.root, 'app-logs')]) mkdirSync(dir, { recursive: true });
app.setPath('userData', userData);
app.setPath('sessionData', path.join(config.root, 'session-data'));
app.setPath('logs', path.join(config.root, 'app-logs'));
app.setAppUserModelId(config.appId);
// ElectronAppAdapter.getAppCacheDir() reads LOCALAPPDATA. Only this fixture process changes it.
process.env.LOCALAPPDATA = localCache;
const origin = new URL(config.controlUrl).origin;
if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Fixture requires loopback');

let service: UpdateService | undefined;
let stopping = false;
let sequence = 0;
let lastContact = Date.now();
const evidenceFile = path.join(config.root, 'fixture-events.jsonl');

function localEvent(kind: string, data: unknown = {}): Record<string, unknown> {
  const event = { kind, data, bootId, pid: process.pid, version: app.getVersion(), sequence: ++sequence, at: new Date().toISOString() };
  appendFileSync(evidenceFile, `${JSON.stringify(event)}\n`);
  return event;
}

function call(route: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(new URL(route, origin), {
      method: payload ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Control HTTP ${res.statusCode}`));
        try { lastContact = Date.now(); resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.setTimeout(3_000, () => req.destroy(new Error('Control timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function report(kind: string, data: unknown = {}): Promise<void> {
  const event = localEvent(kind, data);
  try { await call('/report', event); } catch { /* Synchronous JSONL survives quit/network loss. */ }
}

function quit(): void {
  stopping = true;
  service?.dispose();
  app.quit();
}

process.on('uncaughtException', (error) => { localEvent('fatal', { message: error.message, stack: error.stack }); app.exit(1); });
process.on('unhandledRejection', (error) => { localEvent('fatal', { message: String(error) }); app.exit(1); });
app.on('before-quit', () => { stopping = true; service?.dispose(); localEvent('before-quit'); });
app.on('quit', (_, code) => { localEvent('quit', { code }); });

// 仅关闭测试通知；更新器、传输、缓存校验和安装器均使用真实实现。
Notification.isSupported = () => false;

async function main(): Promise<void> {
  if (Date.now() >= config.deadline) throw new Error('Expired fixture; run the harness again');
  if (!app.isPackaged) throw new Error('Only a real packaged host may run');
  if (path.resolve(path.dirname(process.execPath)).toLowerCase() !== path.resolve(config.installDir).toLowerCase()) {
    throw new Error('Fixture must run from its isolated NSIS installation');
  }
  await app.whenReady();
  // Load the real default singleton AFTER userData/cache isolation, no injected updater.
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
  const restrict = (target: Electron.Session): void => {
    target.webRequest.onBeforeRequest((details, callback) => {
      const allowed = new URL(details.url).origin === origin;
      if (!allowed) localEvent('blocked-network', { url: details.url });
      callback({ cancel: !allowed });
    });
  };
  restrict(session.defaultSession);
  restrict(autoUpdater.netSession);
  // Lazy require is intentional: the production service must see the isolated real Electron app.
  const { createUpdateService } = require('../../src/main/updater') as typeof import('../../src/main/updater');
  service = createUpdateService({
    currentVersion: app.getVersion(), isPackaged: app.isPackaged, isSmoke: false, env: process.env,
    getAutoUpdate: () => false,
    showWindow: () => { void report('show-window'); },
    onStatus: (status) => { void report('status', status); },
    onLog: (level, message) => { void report('log', { level, message }); },
  });
  service.start();
  const updateConfig = readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
  await report('boot', {
    appId: config.appId, name: app.getName(), productName: config.productName,
    exe: process.execPath, appPath: app.getAppPath(), userData: app.getPath('userData'), localCache,
    isPackaged: app.isPackaged, updater: autoUpdater.constructor.name,
    autoDownload: autoUpdater.autoDownload, autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit,
    allowPrerelease: autoUpdater.allowPrerelease, allowDowngrade: autoUpdater.allowDowngrade,
    updateConfig, updateConfigSha512: createHash('sha512').update(updateConfig).digest('base64'),
    status: service.status(), notifications: 'availability stub only',
  });
  const watchdog = setInterval(() => {
    if (Date.now() >= config.deadline || Date.now() - lastContact > 15_000) {
      localEvent('watchdog-expired');
      quit();
    }
  }, 1_000);
  watchdog.unref();

  const poll = async (): Promise<void> => {
    if (stopping) return;
    try {
      const command = await call(`/command?bootId=${bootId}`);
      const action = command !== null && typeof command === 'object' && 'action' in command ? command.action : undefined;
      if (action === 'check') {
        await report('command', command);
        service!.check();
      } else if (action === 'install') {
        await report('command', command);
        const result = service!.install();
        await report('install-result', result);
      } else if (action === 'quit') {
        await report('normal-quit', { status: service!.status(), autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit });
        quit();
      }
    } catch (error) {
      localEvent('control-error', { message: String(error) });
    }
    if (!stopping) setTimeout(() => { void poll(); }, 150);
  };
  void poll();
}

void main().catch(async (error: Error) => {
  await report('fatal', { message: error.message, stack: error.stack });
  app.exit(1);
});
