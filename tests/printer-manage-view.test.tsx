// @vitest-environment jsdom
/**
 * 打印管理页组件测试（此前只有引擎层/人工 fixture 验证）：
 *  1) 本机队列门控：未安装队列与演示数据的操作按钮必须禁用并解释原因；
 *  2) 测试页双步确认：第一次点击只弹确认，不产生实际打印任务；
 *  3) 别名草稿保留：快照刷新/保存期间用户输入不被 5s 推送冲掉。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PrinterManageView } from '../src/renderer/views/PrinterManageView';
import type { LanApi, Printer, PrinterManageConfig } from '../src/shared/types';
import { printer } from './fixtures';

type ApiMock = {
  config: PrinterManageConfig;
  printerGetManageConfig: ReturnType<typeof vi.fn>;
  printerAddManual: ReturnType<typeof vi.fn>;
  printerSetAlias: ReturnType<typeof vi.fn>;
  printerPrintTestPage: ReturnType<typeof vi.fn>;
  printerSetDefault: ReturnType<typeof vi.fn>;
  printerOpenAdmin: ReturnType<typeof vi.fn>;
  printerSetIgnored: ReturnType<typeof vi.fn>;
  printerRemoveManual: ReturnType<typeof vi.fn>;
};

function installApi(): ApiMock {
  const mock: ApiMock = {
    config: { manual: [], ignored: [] },
    printerGetManageConfig: vi.fn(async () => mock.config),
    printerAddManual: vi.fn(async () => ({ ok: true, error: null })),
    printerSetAlias: vi.fn(async () => ({ ok: true })),
    printerPrintTestPage: vi.fn(async () => ({ ok: true, error: null })),
    printerSetDefault: vi.fn(async () => ({ ok: true, error: null })),
    printerOpenAdmin: vi.fn(async () => ({ ok: true, error: null, url: 'http://192.168.2.10' })),
    printerSetIgnored: vi.fn(async () => ({ ok: true })),
    printerRemoveManual: vi.fn(async () => ({ ok: true })),
  };
  (window as unknown as { lanApi: unknown }).lanApi = mock as unknown as LanApi;
  return mock;
}

function renderView(printers: Printer[], api: ApiMock) {
  const props = { printers, refreshing: false, refreshError: null, onRefresh: vi.fn() };
  const view = render(<PrinterManageView {...props} />);
  return {
    ...view,
    rerenderPrinters: (next: Printer[]) => view.rerender(<PrinterManageView {...props} printers={next} />),
    api,
  };
}

/** 等到配置加载完成（否则表格还没渲染出来） */
async function waitForTable(): Promise<void> {
  await screen.findByText('监控中的打印机');
  await waitFor(() => expect(screen.queryByText('正在读取打印管理配置…')).toBeNull());
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, 'lanApi');
});

describe('PrinterManageView 本机队列门控', () => {
  it('未安装队列：测试页/设默认禁用，队列列如实说明', async () => {
    const api = installApi();
    const noQueue = printer({ id: 'p1', name: 'HP-NoQueue', ip: '192.168.2.10', queueName: null });
    renderView([noQueue], api);
    await waitForTable();

    const row = screen.getByText('HP-NoQueue').closest('tr');
    expect(row).not.toBeNull();
    const rowQueries = within(row as HTMLElement);
    expect(rowQueries.getByText('未安装本机队列')).toBeTruthy();
    expect((rowQueries.getByRole('button', { name: '测试页' }) as HTMLButtonElement).disabled).toBe(true);
    expect((rowQueries.getByRole('button', { name: '设默认' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('演示数据：即便有队列名也禁用，并给出演示原因', async () => {
    const api = installApi();
    const demo = printer({
      id: 'sim-1',
      name: 'Demo Printer',
      queueName: 'Demo Queue',
      source: 'simulated',
      ip: '192.168.2.99',
    });
    renderView([demo], api);
    await waitForTable();

    const row = screen.getByText('Demo Printer').closest('tr') as HTMLElement;
    const testBtn = within(row).getByRole('button', { name: '测试页' });
    expect((testBtn as HTMLButtonElement).disabled).toBe(true);
    expect(testBtn.getAttribute('title')).toBe('演示数据不可执行实际操作');
  });
});

describe('PrinterManageView 测试页双步确认', () => {
  it('第一次点击只弹确认，不发起打印；确认后才调用主进程', async () => {
    const api = installApi();
    const real = printer({
      id: 'p2',
      name: 'HP-LaserJet',
      ip: '192.168.2.20',
      queueName: 'HP LaserJet M404',
      source: 'spooler',
    });
    renderView([real], api);
    await waitForTable();

    fireEvent.click(screen.getByRole('button', { name: '测试页' }));

    const confirm = await screen.findByRole('alert');
    expect(confirm.textContent).toContain('会产生实际打印任务');
    expect(confirm.textContent).toContain('HP LaserJet M404');
    expect(api.printerPrintTestPage).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: '确认打印一张测试页' }));

    await waitFor(() => expect(api.printerPrintTestPage).toHaveBeenCalledWith('HP LaserJet M404'));
    expect(await screen.findByText(/已向 HP-LaserJet 发送测试页/)).toBeTruthy();
  });

  it('取消后不发起打印', async () => {
    const api = installApi();
    const real = printer({ id: 'p3', name: 'Canon', queueName: 'Canon Queue', source: 'spooler' });
    renderView([real], api);
    await waitForTable();

    fireEvent.click(screen.getByRole('button', { name: '测试页' }));
    const confirm = await screen.findByRole('alert');
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.printerPrintTestPage).not.toHaveBeenCalled();
  });
});

describe('PrinterManageView 别名草稿', () => {
  it('快照刷新不会冲掉未保存的别名输入', async () => {
    const api = installApi();
    const first = printer({ id: 'p4', name: 'Brother', ip: '192.168.2.30' });
    const view = renderView([first], api);
    await waitForTable();

    const input = screen.getByLabelText('Brother 的别名') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '财务部打印机' } });
    expect(input.value).toBe('财务部打印机');

    // 模拟下一次 5s 快照：服务端别名仍为空，对象引用变化
    view.rerenderPrinters([{ ...first, lastSeen: first.lastSeen + 5000, alias: '服务端别名' }]);
    const after = screen.getByLabelText('Brother 的别名') as HTMLInputElement;
    expect(after.value, '用户草稿优先于快照投影').toBe('财务部打印机');
  });

  it('保存别名调用主进程并保留草稿', async () => {
    const api = installApi();
    const target = printer({ id: 'p5', name: 'Epson', ip: '192.168.2.40' });
    renderView([target], api);
    await waitForTable();

    const row = screen.getByText('Epson').closest('tr') as HTMLElement;
    const input = within(row).getByLabelText('Epson 的别名') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '前台彩色机' } });
    fireEvent.click(within(row).getByRole('button', { name: '保存别名' }));

    await waitFor(() => expect(api.printerSetAlias).toHaveBeenCalledWith('p5', '前台彩色机'));
    expect(await screen.findByText('别名已保存：前台彩色机')).toBeTruthy();
    expect((screen.getByLabelText('Epson 的别名') as HTMLInputElement).value).toBe('前台彩色机');
  });
});
