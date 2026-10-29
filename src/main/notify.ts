/** 系统通知出口（仅主进程 import electron）；判定逻辑在引擎侧保持纯 Node。 */
import { Notification } from 'electron';
import type { PrinterAlert } from './engine/printers/alerts';

/** 返回是否已提交系统通知；平台不支持返回 false，操作系统最终展示与否不作保证。 */
export function showPrinterAlert(alert: PrinterAlert, onClick: () => void): boolean {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({
    title:
      alert.kind === 'fault'
        ? `打印机异常：${alert.printerName}`
        : `打印机已恢复：${alert.printerName}`,
    body: `${alert.reason}\n本次运行首次发现异常：${new Date(alert.firstObservedAt).toLocaleString('zh-CN', { hour12: false })}（非真实故障起点）`,
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
