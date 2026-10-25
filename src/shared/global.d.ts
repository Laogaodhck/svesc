/**
 * 渲染层全局类型声明（契约冻结区，由 Max-1 提供，Max-2 只读）。
 * 与 plan.md §5.3 的冒烟钩子一一对应。
 */
import type { LanApi } from './types';

declare global {
  interface Window {
    lanApi: LanApi;
    /** 首个快照渲染完成时置 true（smoke 脚本据此等待） */
    __ready: boolean;
    /**
     * 切换视图 / 打开详情抽屉（smoke 脚本据此截图）。
     * 第二参 deviceId 仅对 devices 视图有意义（打开设备抽屉）；其他视图传值会被忽略。
     */
    __setView?: (
      view:
        | 'overview'
        | 'devices'
        | 'printers'
        | 'printermanage'
        | 'settings'
        | 'alarms'
        | 'router'
        | 'diagnostics'
        | 'terminal',
      deviceId?: string,
    ) => void;
  }
}

export {};
