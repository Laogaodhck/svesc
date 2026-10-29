// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceDetailDrawer } from '../src/renderer/views/DeviceDetailDrawer';
import { fmtDateTime, fmtMs, STATE_LABEL } from '../src/renderer/lib/format';
import type { Device, DeviceDetail, DeviceStatusEvent, LanApi } from '../src/shared/types';
import { device, T0 } from './fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const first = device({ id: 'device-a', ip: '192.0.2.10', hostname: '设备 A' });
const second = device({ id: 'device-b', ip: '192.0.2.20', hostname: '设备 B' });
const online: DeviceStatusEvent = { state: 'online', at: T0, latencyMs: 7 };
const offline: DeviceStatusEvent = { state: 'offline', at: T0 + 5000, latencyMs: null };

function detail(target: Device = first, statusHistory: DeviceStatusEvent[] = [online]): DeviceDetail {
  return { device: target, ports: [], connections: [], history: [], statusHistory };
}

function installApi() {
  const api = { getDeviceDetail: vi.fn<LanApi['getDeviceDetail']>().mockResolvedValue(detail()) } satisfies Partial<LanApi>;
  Object.defineProperty(window, 'lanApi', { configurable: true, value: api });
  return api;
}

function renderDrawer(target: Device | null = first) {
  const onClose = vi.fn();
  const view = render(<DeviceDetailDrawer deviceId={target?.id ?? null} device={target} now={T0 + 60000} onClose={onClose} />);
  return {
    ...view,
    onClose,
    select: (next: Device | null) => view.rerender(
      <DeviceDetailDrawer deviceId={next?.id ?? null} device={next} now={T0 + 60000} onClose={onClose} />,
    ),
  };
}

function historyRows() {
  return within(screen.getByRole('list', { name: '设备状态历史' })).getAllByRole('listitem');
}

async function flush() {
  await act(async () => {});
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => { vi.useFakeTimers(); });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'lanApi');
});

describe('DeviceDetailDrawer 在线历史', () => {
  it('按接口的新到旧顺序展示最近 12 条，保留状态、时间和未知延迟', async () => {
    const api = installApi();
    const events: DeviceStatusEvent[] = Array.from({ length: 14 }, (_, index) => ({
      state: index % 3 === 0 ? 'offline' : index % 3 === 1 ? 'degraded' : 'online',
      at: T0 - index * 60000,
      latencyMs: index % 3 === 0 ? null : 200 - index,
    }));
    api.getDeviceDetail.mockResolvedValue(detail(first, events));
    renderDrawer();
    await flush();

    const rows = historyRows();
    expect(rows).toHaveLength(12);
    rows.forEach((row, index) => {
      const event = events[index];
      expect(within(row).getByText(STATE_LABEL[event.state])).toBeTruthy();
      expect(within(row).getByText(fmtDateTime(event.at))).toBeTruthy();
      expect(within(row).getByText(fmtMs(event.latencyMs))).toBeTruthy();
    });
    expect(screen.getByText('仅显示最近 12 条，共 14 条。')).toBeTruthy();
    expect(screen.queryByText(fmtDateTime(events[12].at))).toBeNull();
  });

  it('首次读取期间显示 loading，空数组显示无持久化历史而不是虚构记录', async () => {
    const api = installApi();
    const pending = deferred<DeviceDetail | null>();
    api.getDeviceDetail.mockReturnValue(pending.promise);
    renderDrawer();
    expect(screen.getByText('正在读取状态历史…')).toBeTruthy();
    expect(screen.queryByText(/暂无跨重启的状态记录/)).toBeNull();

    await act(async () => { pending.resolve(detail(first, [])); });
    expect(screen.getByText(/暂无跨重启的状态记录/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: '设备状态历史' })).toBeNull();
    expect(screen.queryByText('正在读取状态历史…')).toBeNull();
  });

  it('设备离开快照且详情返回 null 时显示消失空态', async () => {
    const api = installApi();
    api.getDeviceDetail.mockResolvedValue(null);
    render(<DeviceDetailDrawer deviceId={first.id} device={null} now={T0} onClose={vi.fn()} />);
    await flush();
    expect(screen.getByText('该设备已从网络中消失')).toBeTruthy();
    expect(screen.queryByRole('list', { name: '设备状态历史' })).toBeNull();
  });

  it('首次读取失败显示错误，下一次轮询成功后清除错误并显示历史', async () => {
    const api = installApi();
    api.getDeviceDetail.mockRejectedValueOnce(new Error('历史读取失败'));
    renderDrawer();
    await flush();
    expect(screen.getByText('历史读取失败')).toBeTruthy();
    expect(screen.queryByText('正在读取状态历史…')).toBeNull();

    await advance(5000);
    expect(screen.queryByText('历史读取失败')).toBeNull();
    expect(historyRows()).toHaveLength(1);
  });

  it('后台刷新失败保留历史，后续成功更新而不陷入 loading', async () => {
    const api = installApi();
    api.getDeviceDetail.mockResolvedValueOnce(detail()).mockRejectedValueOnce(new Error('暂时不可用'))
      .mockResolvedValue(detail(first, [offline, online]));
    renderDrawer();
    await flush();
    const previous = historyRows().map((row) => row.textContent);

    await advance(5000);
    expect(historyRows().map((row) => row.textContent)).toEqual(previous);
    expect(screen.queryByText('正在读取状态历史…')).toBeNull();
    expect(screen.queryByText('暂时不可用')).toBeNull();

    await advance(5000);
    expect(historyRows()).toHaveLength(2);
    expect(within(historyRows()[0]).getByText('离线')).toBeTruthy();
  });

  it('只在打开时立即请求，此后每 5 秒刷新；快照重渲染不重建轮询', async () => {
    const api = installApi();
    const view = renderDrawer();
    await flush();
    expect(api.getDeviceDetail).toHaveBeenCalledExactlyOnceWith(first.id);
    await advance(4999);
    view.select({ ...first, lastSeen: T0 + 1000 });
    expect(api.getDeviceDetail).toHaveBeenCalledTimes(1);
    api.getDeviceDetail.mockResolvedValue(detail(first, [offline, online]));
    await advance(1);
    expect(api.getDeviceDetail).toHaveBeenCalledTimes(2);
    expect(historyRows()).toHaveLength(2);
    await advance(5000);
    expect(api.getDeviceDetail).toHaveBeenCalledTimes(3);
  });

  it.each(['resolve', 'reject'] as const)('换设备后忽略旧请求的迟到 %s，且不再请求旧设备', async (outcome) => {
    const api = installApi();
    const oldRequest = deferred<DeviceDetail | null>();
    const newRequest = deferred<DeviceDetail | null>();
    api.getDeviceDetail.mockImplementation((id) => id === first.id ? oldRequest.promise : newRequest.promise);
    const view = renderDrawer();
    view.select(second);
    await act(async () => { newRequest.resolve(detail(second, [offline])); });
    await act(async () => {
      if (outcome === 'resolve') oldRequest.resolve(detail(first, [online]));
      else oldRequest.reject(new Error('旧设备错误'));
    });
    expect(screen.getByRole('dialog').textContent).toContain('设备 B');
    expect(historyRows()).toHaveLength(1);
    expect(within(historyRows()[0]).getByText('离线')).toBeTruthy();
    expect(screen.queryByText('旧设备错误')).toBeNull();
    expect(api.getDeviceDetail.mock.calls).toEqual([[first.id], [second.id]]);
    await advance(5000);
    expect(api.getDeviceDetail.mock.calls).toEqual([[first.id], [second.id], [second.id]]);
  });

  it('同一设备的重叠轮询迟到响应不能覆盖更新的历史', async () => {
    const api = installApi();
    const oldRequest = deferred<DeviceDetail | null>();
    api.getDeviceDetail.mockReturnValueOnce(oldRequest.promise).mockResolvedValue(detail(first, [offline, online]));
    renderDrawer();
    await advance(5000);
    expect(historyRows()).toHaveLength(2);
    await act(async () => { oldRequest.resolve(detail()); });
    expect(historyRows()).toHaveLength(2);
    expect(within(historyRows()[0]).getByText('离线')).toBeTruthy();
  });

  it('关闭后停止轮询与 Esc 监听，重新打开读取新历史', async () => {
    const api = installApi();
    const pending = deferred<DeviceDetail | null>();
    api.getDeviceDetail.mockReturnValueOnce(pending.promise);
    const view = renderDrawer();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(view.onClose).toHaveBeenCalledTimes(1);
    view.select(null);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => { pending.resolve(detail(first, [offline])); });
    await advance(10000);
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(api.getDeviceDetail).toHaveBeenCalledTimes(1);
    view.select(first);
    await flush();
    expect(historyRows()).toHaveLength(1);
    expect(within(historyRows()[0]).getByText('在线')).toBeTruthy();
    expect(api.getDeviceDetail).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'] as const)('卸载清理轮询、焦点定时器与 Esc 监听，允许请求迟到 %s', async (outcome) => {
    const api = installApi();
    const pending = deferred<DeviceDetail | null>();
    api.getDeviceDetail.mockReturnValue(pending.promise);
    const view = renderDrawer();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      if (outcome === 'resolve') pending.resolve(detail());
      else pending.reject(new Error('卸载后的错误'));
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    await advance(10000);
    expect(view.onClose).not.toHaveBeenCalled();
    expect(api.getDeviceDetail).toHaveBeenCalledTimes(1);
    expect(view.container.childElementCount).toBe(0);
  });
});
