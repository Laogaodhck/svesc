/** IPC 通道常量（plan.md 第 5 节冻结） */
export const CH = {
  // renderer → main (invoke)
  getSnapshot: 'lan:getSnapshot',
  refresh: 'lan:refresh',
  setAutoScan: 'lan:setAutoScan',
  getDeviceDetail: 'lan:getDeviceDetail',
  ackAlarm: 'lan:ackAlarm',
  /** 用户手动清除告警（task-021 语义 A）；payload = id 数组，单条也是数组 */
  alarmsClear: 'alarms:clear',
  exportReport: 'lan:exportReport',
  setDeviceAlias: 'lan:setDeviceAlias',

  // 路由器管理
  routerGetStatus: 'router:getStatus',
  routerRefresh: 'router:refresh',
  routerLogin: 'router:login',
  routerLogout: 'router:logout',
  routerReboot: 'router:reboot',
  routerOpenAdmin: 'router:openAdmin',

  // 打印管理
  printerGetManageConfig: 'printer:getManageConfig',
  printerAddManual: 'printer:addManual',
  printerRemoveManual: 'printer:removeManual',
  printerSetIgnored: 'printer:setIgnored',
  printerSetAlias: 'printer:setAlias',

  // 设置
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  /** 开机自启开关（task-021：OS 为唯一事实源，payload { on } → { ok, error }） */
  launchAtLoginSet: 'settings:launch-at-login',

  // 网络诊断 / 日志 / 远程操作 / 内置终端
  diagRun: 'diag:run',
  diagAdapters: 'diag:adapters',
  logsGetRecent: 'logs:getRecent',
  logsExport: 'logs:export',
  remoteOpen: 'remote:open',
  terminalRun: 'terminal:run',

  // main → renderer (push)
  snapshot: 'lan:snapshot',
  scanProgress: 'lan:scanProgress',
  alarm: 'lan:alarm',
  routerStatus: 'router:status',
} as const;

export type ChannelName = (typeof CH)[keyof typeof CH];
