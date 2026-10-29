/** 系统通知出口（仅主进程 import electron）；判定逻辑在引擎侧保持纯 Node。 */
import { Notification } from 'electron';
import type { PrinterAlert } from './engine/printers/alerts';

/**
 * 弹一条打印机通知；返回是否真的展示（平台不支持时返回 false，调用方不假装成功）。
 * Windows 上通知归属由 app.setAppUserModelId 决定（见 index.ts）。
 */
export function showPrinterAlert(alert: PrinterAlert, onClick: () => void): boolean {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({
    title:
      alert.kind === 'fault'
        ? `打印机异常：${alert.printerName}`
        : `打印机已恢复：${alert.printerName}`,
    body: alert.reason,
    silent: alert.kind === 'recovered',
  });
  notification.on('click', onClick);
  notification.show();
  return true;
}

/** 更新下载完成：提示用户手动重启安装（不自作主张在退出时静默安装）。 */
export function showUpdateReady(version: string, onClick: () => void): boolean {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({
    title: `更新已就绪：v${version}`,
    body: '点击打开主窗口，在设置页选择“重启并安装”。安装包未签名，Windows 可能提示未知发布者。',
  });
  notification.on('click', onClick);
  notification.show();
  return true;
}
