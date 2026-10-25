/**
 * 预加载桥：只暴露 window.lanApi 这一层类型化 API。
 *
 * 安全约束：**绝不**把 ipcRenderer 本体或任何 Node 能力透传给渲染层。
 * contextIsolation:true + nodeIntegration:false 下，渲染层只能拿到这里显式列出的方法。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CH } from '../shared/channels';
import type {
  Alarm,
  DeviceDetail,
  DiagKind,
  DiagResult,
  LanApi,
  LogBundle,
  NetAdapter,
  RemoteOpKind,
  TerminalResult,
  RouterActionStatus,
  RouterStatus,
  ScanProgress,
  Snapshot,
} from '../shared/types';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: LanApi = {
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke(CH.getSnapshot),
  refresh: (): Promise<{ started: boolean }> => ipcRenderer.invoke(CH.refresh),
  setAutoScan: (enabled: boolean, intervalSec?: number): Promise<{ autoScan: boolean; intervalSec: number }> =>
    ipcRenderer.invoke(CH.setAutoScan, enabled, intervalSec),
  getDeviceDetail: (deviceId: string): Promise<DeviceDetail | null> =>
    ipcRenderer.invoke(CH.getDeviceDetail, deviceId),
  ackAlarm: (alarmId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(CH.ackAlarm, alarmId),
  alarmsClear: (ids: string[]): Promise<void> => ipcRenderer.invoke(CH.alarmsClear, ids),
  exportReport: (): Promise<{ ok: boolean; path: string | null; error?: string }> =>
    ipcRenderer.invoke(CH.exportReport),
  setDeviceAlias: (deviceId: string, alias: string | null): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(CH.setDeviceAlias, deviceId, alias),

  routerGetStatus: (): Promise<RouterStatus> => ipcRenderer.invoke(CH.routerGetStatus),
  routerRefresh: (): Promise<RouterStatus> => ipcRenderer.invoke(CH.routerRefresh),
  routerLogin: (
    user: string,
    password: string,
  ): Promise<{ ok: boolean; error: string | null; persisted: boolean; persistError: string | null }> =>
    ipcRenderer.invoke(CH.routerLogin, user, password),
  routerLogout: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(CH.routerLogout),
  routerReboot: (): Promise<{ status: RouterActionStatus; error: string | null }> =>
    ipcRenderer.invoke(CH.routerReboot),
  routerOpenAdmin: (): Promise<{ ok: boolean; error: string | null; url: string | null }> =>
    ipcRenderer.invoke(CH.routerOpenAdmin),

  printerGetManageConfig: () => ipcRenderer.invoke(CH.printerGetManageConfig),
  printerAddManual: (ip: string, note: string | null) => ipcRenderer.invoke(CH.printerAddManual, ip, note),
  printerRemoveManual: (ip: string) => ipcRenderer.invoke(CH.printerRemoveManual, ip),
  printerSetIgnored: (printerId: string, ignored: boolean) =>
    ipcRenderer.invoke(CH.printerSetIgnored, printerId, ignored),
  printerSetAlias: (printerId: string, alias: string | null) =>
    ipcRenderer.invoke(CH.printerSetAlias, printerId, alias),

  settingsGet: () => ipcRenderer.invoke(CH.settingsGet),
  settingsUpdate: (patch: Record<string, unknown>) => ipcRenderer.invoke(CH.settingsUpdate, patch),
  setLaunchAtLogin: (on: boolean): Promise<{ ok: boolean; error: string | null }> =>
    ipcRenderer.invoke(CH.launchAtLoginSet, on),

  diagRun: (kind: DiagKind, target: string): Promise<DiagResult> =>
    ipcRenderer.invoke(CH.diagRun, kind, target),
  diagAdapters: (): Promise<NetAdapter[]> => ipcRenderer.invoke(CH.diagAdapters),
  logsGetRecent: (limit?: number): Promise<LogBundle> => ipcRenderer.invoke(CH.logsGetRecent, limit),
  logsExport: (): Promise<{ ok: boolean; path: string | null; error?: string }> =>
    ipcRenderer.invoke(CH.logsExport),
  remoteOpen: (kind: RemoteOpKind, target: string, user?: string): Promise<{ ok: boolean; error: string | null }> =>
    ipcRenderer.invoke(CH.remoteOpen, kind, target, user),
  terminalRun: (command: string): Promise<TerminalResult> => ipcRenderer.invoke(CH.terminalRun, command),

  onSnapshot: (cb: (s: Snapshot) => void): (() => void) => subscribe<Snapshot>(CH.snapshot, cb),
  onScanProgress: (cb: (p: ScanProgress) => void): (() => void) => subscribe<ScanProgress>(CH.scanProgress, cb),
  onAlarm: (cb: (a: Alarm) => void): (() => void) => subscribe<Alarm>(CH.alarm, cb),
  onRouterStatus: (cb: (s: RouterStatus) => void): (() => void) => subscribe<RouterStatus>(CH.routerStatus, cb),
};

contextBridge.exposeInMainWorld('lanApi', api);
