/**
 * 冒烟截图例程（只在 SMOKE=1 时被 index.ts 调用）。
 *
 * 刻意与生产路径分离：生产启动流程里只有一行 `if (process.env.SMOKE) void runSmoke(...)`。
 * 依赖渲染层按 plan.md §5.3 暴露的两个测试钩子：
 *   window.__ready: boolean
 *   window.__setView(view, deviceId?)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Engine } from './engine';
import type { RouterManager } from './engine/router';

export interface SmokeResult {
  ok: boolean;
  outDir: string;
  files: { name: string; bytes: number }[];
  errors: string[];
  devices: number;
  printers: number;
}

type SmokeView = 'overview' | 'devices' | 'printers' | 'printermanage' | 'settings' | 'router' | 'diagnostics';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForReady(win: BrowserWindow, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await win.webContents.executeJavaScript('Boolean(window.__ready === true)', true);
      if (ready === true) return true;
    } catch {
      /* 渲染层还没挂载，继续等 */
    }
    await sleep(250);
  }
  return false;
}

export async function runSmoke(win: BrowserWindow, engine: Engine, router?: RouterManager): Promise<SmokeResult> {
  const outDir = path.resolve(process.env.SMOKE_OUT ?? '.agent-runs/2026-10-25/task-001/artifacts');
  fs.mkdirSync(outDir, { recursive: true });

  // 截图必须在"可见且未被节流"的窗口上做：隐藏窗口里 React 的重绘可能被推迟，
  // 会导致连续两次 __setView 拍到同一帧。
  win.showInactive();
  win.focus();

  const errors: string[] = [];
  const files: { name: string; bytes: number }[] = [];

  const ready = await waitForReady(win);
  if (!ready) errors.push('window.__ready 超时（渲染层未完成首帧）');

  // 等首轮真实数据落地（子网扫描 ≈6-10s，打印机采集在其后）：只等有界时间，超时也照常截图
  const dataDeadline = Date.now() + 35000;
  let waited = 0;
  while (Date.now() < dataDeadline) {
    const snap = engine.getSnapshot();
    const realDevices = snap.devices.filter((d) => !d.id.startsWith('sim-')).length;
    const realPrinters = snap.printers.filter((p) => !p.id.startsWith('sim-')).length;
    if (realDevices > 0 && realPrinters > 0) break;
    if (waited % 4000 === 0) {
      const timings = engine.scheduler.lastTimings;
      process.stdout.write(
        `[smoke] 等待真实数据 ${waited}ms realDevices=${realDevices} realPrinters=${realPrinters} scan=${timings ? `${timings.total}ms` : 'running'}\n`,
      );
    }
    await sleep(500);
    waited += 500;
  }
  // 再等一个推送周期（带宽 2s tick），确保渲染层拿到的是含 printer 的那份快照
  await sleep(2200);

  const capture = async (name: string): Promise<void> => {
    try {
      await sleep(700);
      const image = await win.webContents.capturePage();
      const buffer = image.toPNG();
      const target = path.join(outDir, `${name}.png`);
      fs.writeFileSync(target, buffer);
      files.push({ name: `${name}.png`, bytes: buffer.length });
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const setView = async (view: SmokeView, deviceId?: string): Promise<void> => {
    const call =
      deviceId === undefined
        ? `window.__setView && window.__setView('${view}')`
        : `window.__setView && window.__setView('${view}', ${JSON.stringify(deviceId)})`;
    try {
      await win.webContents.executeJavaScript(call, true);
    } catch (err) {
      errors.push(`__setView(${view}): ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const snapshot = engine.getSnapshot();
  const detailDeviceId =
    snapshot.devices.find((d) => d.kind === 'printer')?.id ??
    snapshot.devices.find((d) => !d.isSelf)?.id ??
    null;

  await setView('overview');
  await capture('overview');
  await setView('devices');
  await capture('devices');
  if (detailDeviceId) {
    await setView('devices', detailDeviceId);
    await capture('detail');
  }
  await setView('printers');
  await capture('printers');
  await setView('printermanage');
  await capture('printermanage');
  await setView('settings');
  await capture('settings');
  // 诊断中心：验证新页面渲染 + 本机网卡 IPC 通道真实可达（读失败会如实显示空态，不阻断）
  await setView('diagnostics');
  await capture('diagnostics');
  try {
    const adapters = await win.webContents.executeJavaScript(
      'window.lanApi ? window.lanApi.diagAdapters() : Promise.resolve([])',
      true,
    );
    const target = path.join(outDir, 'diag-adapters.json');
    fs.writeFileSync(target, JSON.stringify(adapters, null, 2), 'utf8');
    files.push({ name: 'diag-adapters.json', bytes: fs.statSync(target).size });
  } catch (err) {
    errors.push(`diag-adapters.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  // —— 路由器视图：等能力探测出阶段结论（有界 20s），截图 + 状态落盘 ——
  if (router) {
    const probeDeadline = Date.now() + 20000;
    while (Date.now() < probeDeadline) {
      if (router.getStatus().phase !== 'probing') break;
      await sleep(500);
    }
    await setView('router');
    await capture('router');
    try {
      const status = router.getStatus();
      const target = path.join(outDir, 'router-status.json');
      fs.writeFileSync(target, JSON.stringify(status, null, 2), 'utf8');
      files.push({ name: 'router-status.json', bytes: fs.statSync(target).size });
    } catch (err) {
      errors.push(`router-status.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const finalSnapshot = engine.getSnapshot();
  try {
    fs.writeFileSync(path.join(outDir, 'snapshot.json'), JSON.stringify(finalSnapshot, null, 2), 'utf8');
    files.push({ name: 'snapshot.json', bytes: fs.statSync(path.join(outDir, 'snapshot.json')).size });
  } catch (err) {
    errors.push(`snapshot.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pngs = files.filter((f) => f.name.endsWith('.png'));
  const ok = pngs.length >= 4 && pngs.every((f) => f.bytes > 10 * 1024) && errors.length === 0;

  const result: SmokeResult = {
    ok,
    outDir,
    files,
    errors,
    devices: finalSnapshot.devices.length,
    printers: finalSnapshot.printers.length,
  };

  process.stdout.write(`${JSON.stringify({ smoke: result })}\n`);
  return result;
}
