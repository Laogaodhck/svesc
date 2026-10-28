/**
 * task-030：管理页租约实验通道（`src/main/engine/router/web-leases.ts`）。
 *
 * 诚实边界：候选页路径未经真机登录验证（实验性），但解析器与抓取循环是纯函数，
 * 用合成页面全面覆盖。品牌识别部分（TP-LINK dynaform 自报）有真机 TL-7DR7290 实测佐证。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWebLeases,
  parseLeasesFromHtml,
  WEB_LEASE_CANDIDATES,
  WEB_LEASE_MAX_CANDIDATES,
  WEB_LEASE_TOTAL_BUDGET_MS,
  WEB_LEASE_TIMEOUT_MS,
} from '../src/main/engine/router/web-leases';
import { matchFingerprint } from '../src/main/engine/router/detect';
import * as httpx from '../src/main/engine/router/httpx';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('parseLeasesFromHtml（品牌无关 MAC 锚定解析）', () => {
  it('HTML 表格行：主机名/MAC/IP 同行 → 提取租约，租期列不混入主机名', () => {
    const html = `<table>
      <tr><th>客户端名</th><th>MAC 地址</th><th>IP 地址</th><th>租约</th></tr>
      <tr><td>android-客厅</td><td>A2-3E-31-1D-1A-50</td><td>192.168.0.105</td><td>01:53:37</td></tr>
      <tr><td>deskpc</td><td>54-ea-e1-37-c7-d4</td><td>192.168.0.109</td><td>永久</td></tr>
    </table>`;
    const leases = parseLeasesFromHtml(html);
    expect(leases).toHaveLength(2);
    expect(leases[0]).toEqual({
      ip: '192.168.0.105',
      mac: 'a2-3e-31-1d-1a-50',
      hostname: 'android-客厅',
      expiresAt: null,
    });
    expect(leases[1]?.hostname).toBe('deskpc');
  });

  it('TP-LINK dynaform JS 数组形态：引号序列滑窗（主机名在前、IP 在后）', () => {
    const html = `<script>var DHCPHostList = new Array(
      "android-客厅", "A2:3E:31:1D:1A:50", "192.168.0.105", "01:53:37",
      "bin", "00-11-5B-97-5A-1C", "192.168.0.100", "永久");</script>`;
    const leases = parseLeasesFromHtml(html);
    expect(leases).toHaveLength(2);
    expect(leases.find((lease) => lease.ip === '192.168.0.105')?.hostname).toBe('android-客厅');
    expect(leases.find((lease) => lease.ip === '192.168.0.100')?.mac).toBe('00-11-5b-97-5a-1c');
  });

  it('MAC 在首位（无前序主机名）→ hostname 为 null 而非错位取值', () => {
    const html = `<script>new Array("54-ea-e1-37-c7-d4","192.168.0.109","永久");</script>`;
    const leases = parseLeasesFromHtml(html);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.hostname).toBeNull();
    expect(leases[0]?.ip).toBe('192.168.0.109');
  });

  it('同 MAC 重复条目去重', () => {
    const html = `<tr><td>a</td><td>54-EA-E1-37-C7-D4</td><td>192.168.0.109</td></tr>
      <tr><td>a</td><td>54-ea-e1-37-c7-d4</td><td>192.168.0.109</td></tr>`;
    expect(parseLeasesFromHtml(html)).toHaveLength(1);
  });

  it('无 MAC / 无 IP 的行丢弃；空页面与垃圾输入返回 []', () => {
    expect(parseLeasesFromHtml('<tr><td>只有文字</td></tr>')).toEqual([]);
    expect(parseLeasesFromHtml('')).toEqual([]);
    expect(parseLeasesFromHtml('<html><body>登录页</body></html>')).toEqual([]);
  });

  const mac = 'AA:BB:CC:DD:EE:01';
  const row = (fields: string[]) => `<tr>${fields.map((field) => `<td>${field}</td>`).join('')}</tr>`;

  it.each(['Host Name', 'Client Name', 'Device Name', '主机名', '客户端名称'])('表头 %s 支持后置名称，不把序号或状态当主机名', (label) => {
    const html = `<table><tr><th>ID</th><th>MAC Address</th><th>IP Address</th><th>${label}</th></tr>${row(['1', mac, '192.168.0.2', ' living-room '])}</table>`;
    expect(parseLeasesFromHtml(html)[0].hostname).toBe('living-room');
  });

  it('td 表头也有效；空名称/占位名不回退到序号或状态', () => {
    for (const name of ['', '-', 'unknown']) {
      const html = `<table>${row(['ID', 'Host Name', 'MAC Address', 'IP Address'])}${row(['online', name, mac, '192.168.0.2'])}</table>`;
      expect(parseLeasesFromHtml(html)[0].hostname).toBeNull();
    }
  });

  it('无表头保守筛掉序号、时长和永久，只选前置候选；表头不能跨表', () => {
    expect(parseLeasesFromHtml(row(['1', 'deskpc', mac, '192.168.0.2']))[0].hostname).toBe('deskpc');
    for (const field of ['1', '01:53:37', '1 day 2 hours', '3600s', '永久', 'infinite', 'permanent']) {
      expect(parseLeasesFromHtml(row([field, mac, '192.168.0.2']))[0].hostname).toBeNull();
    }
    expect(parseLeasesFromHtml(row(['status', 'deskpc', mac, '192.168.0.2']))[0].hostname).toBeNull();
    expect(parseLeasesFromHtml(row([mac, '192.168.0.2', 'trailer']))[0].hostname).toBeNull();
    const html = `<table><tr><th>MAC</th><th>IP</th><th>Host Name</th></tr></table><table>${row([mac, '192.168.0.2', 'trailer'])}</table>`;
    expect(parseLeasesFromHtml(html)[0].hostname).toBeNull();
  });

  it('安全解码命名/数值实体，不递归解释 HTML；非法码点与控制字符不作为主机名', () => {
    expect(parseLeasesFromHtml(row(['desk&amp;pc&lt;1&gt;&quot;&#x4E2D;&#39;', 'AABB.CCDD.EE01', '192.168.0.2']))[0].hostname).toBe('desk&pc<1>"中\'');
    expect(parseLeasesFromHtml(row(['&amp;lt;desk&amp;gt;', mac, '192.168.0.2']))[0].hostname).toBe('&lt;desk&gt;');
    for (const name of ['x&#0;y', 'x&#xD800;y', 'x&#999999999;y', 'x&#10;y']) {
      expect(parseLeasesFromHtml(row([name, mac, '192.168.0.2']))[0].hostname).toBeNull();
    }
  });

  it('JS 字面量支持单/双引号与转义；空主机名必须保留位置', () => {
    const html = `<script>const rows = ['first', '${mac}', '192.168.0.2', '3600', '', 'AA-BB-CC-DD-EE-02', '192.168.0.3', '永久'];
      var other = new Array('desk\\x2dpc\\u0021', 'AABBCCDDEE03', '192.168.0.4');</script>`;
    expect(parseLeasesFromHtml(html).map((lease) => lease.hostname)).toEqual(['first', null, 'desk-pc!']);
  });

  it('JS 数组间及记录间不串名；无名记录不继承上一条租期', () => {
    const html = `<div title="stranger">"fake" "${mac}" "192.168.0.9"</div>
      <script>var title = 'stranger'; var a = ['other']; var b = ['${mac}', '192.168.0.2', 'arbitrary lease text', 'AA-BB-CC-DD-EE-02', '192.168.0.3', 'arbitrary lease text'];</script>`;
    expect(parseLeasesFromHtml(html).map((lease) => lease.hostname)).toEqual([null, null]);
    const uneven = `<script>new Array('first', '${mac}', '192.168.0.2', 'lease', 'AA-BB-CC-DD-EE-02', '192.168.0.3', 'lease')</script>`;
    expect(parseLeasesFromHtml(uneven).map((lease) => lease.hostname)).toEqual([null, null]);
    expect(parseLeasesFromHtml(`<script>['ghost']; ['${mac}']; ['192.168.0.2'];</script>`)).toEqual([]);
  });

  it.each([
    `['host', '${mac}', '192.168.0.2', 1]`,
    `['host' + 'suffix', '${mac}', '192.168.0.2']`,
    `['host', '${mac}', '192.168.0.2', alert('not executed')]`,
    `['host', '${mac}', '192.168.0.2', ,]`,
    `['host', '${mac}', '192.168.0.2', ...more]`,
    `['host', '${mac}', '192.168.0.2', ['nested']]`,
    '`["host", "AA:BB:CC:DD:EE:01", "192.168.0.2"]`',
    `/* ['host', '${mac}', '192.168.0.2'] */`,
    `// ['host', '${mac}', '192.168.0.2']`,
    `"host"; "${mac}"; "192.168.0.2";`,
    `object['host', '${mac}', '192.168.0.2']`,
    `['host', '${mac}', '192.168.0.2',)`,
    `new Array('host', '${mac}', '192.168.0.2',]`,
    `['host', '${mac}', '192.168.0.2'`,
  ])('不执行也不抽取非纯字符串数组/其它 JS：%s', (script) => {
    expect(parseLeasesFromHtml(`<script>${script}</script>`)).toEqual([]);
  });

  it('冲突名合并为 null，空名不覆盖真名，同 MAC 不同 IP 不丢失', () => {
    const rows = [row(['', mac, '192.168.0.2']), row(['a', mac, '192.168.0.2']), row(['b', mac, '192.168.0.2']), row(['a', mac, '192.168.0.2']), row(['other', mac, '192.168.0.3'])];
    const leases = parseLeasesFromHtml(rows.join(''));
    expect(leases.map((lease) => lease.hostname)).toEqual([null, 'other']);
    expect(parseLeasesFromHtml(rows.reverse().join(''))).toEqual(leases);
  });
});

describe('fetchWebLeases（抓取循环，注入式传输）', () => {
  const page = `<script>new Array("android","A2-3E-31-1D-1A-50","192.168.0.105");</script>`;

  it('首个候选命中 → 返回租约 + 诚实 note（含候选标签与条数）', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const res = await fetchWebLeases({
      gateway: '192.168.0.1',
      cookie: 'sessionId=abc',
      brand: 'tplink',
      transport: async (url, headers) => {
        calls.push({ url, headers });
        return page;
      },
    });
    expect(res.ok).toBe(true);
    expect(res.leases).toHaveLength(1);
    expect(res.note).toContain('1 条');
    expect(calls[0]?.headers.Cookie).toBe('sessionId=abc');
    expect(calls[0]?.headers.Referer).toBe('http://192.168.0.1/');
    expect(calls[0]?.url).toBe('http://192.168.0.1/userRpm/DhcpSeartListRpm.htm');
  });

  it('候选按品牌过滤：brand=xiaomi 时只试小米专属页 + 通用候选（不试 tplink）', async () => {
    const tried: string[] = [];
    const res = await fetchWebLeases({
      gateway: '192.168.0.1',
      cookie: 'c=1',
      brand: 'xiaomi',
      transport: async (url) => {
        tried.push(url);
        return null;
      },
    });
    expect(res.ok).toBe(false);
    // 小米专属 1 条 + 通用 3 条，不得尝试 TP-LINK Host。
    expect(tried).toHaveLength(4);
    expect(tried[0]).toBe('http://192.168.0.1/cgi-bin/luci/admin/status/overview');
    expect(tried).toContain('http://192.168.0.1/dhcp.htm');
    expect(tried.every((u) => !u.includes('userRpm'))).toBe(true);
    // note 截断：只列前 3 条 + 总数
    expect((res.note ?? '').match(/等 4 个候选页/)).toBeTruthy();
  });

  it('前序候选失败 → 逐个尝试；Host 覆写重试用于防重绑定 302', async () => {
    const calls: { url: string; host: string | undefined }[] = [];
    const res = await fetchWebLeases({
      gateway: '192.168.0.1',
      cookie: 'c=1',
      brand: 'tplink',
      transport: async (url, headers) => {
        calls.push({ url, host: headers.Host });
        // 第一候选：直访 302（null），Host 覆写重试拿到 200 数据页
        return url.endsWith('DhcpSeartListRpm.htm') && headers.Host === undefined ? null : page;
      },
    });
    expect(res.ok).toBe(true);
    expect(calls[0]?.host).toBeUndefined();
    expect(calls[1]?.host).toBe('tplogin.cn');
  });

  it('全部候选失败 → ok:false，note 列出尝试过程（不静默）', async () => {
    const res = await fetchWebLeases({
      gateway: '192.168.0.1',
      cookie: 'c=1',
      brand: 'tplink',
      transport: async () => null,
    });
    expect(res.ok).toBe(false);
    expect(res.leases).toEqual([]);
    expect(res.note).toContain('未获取');
    expect(res.note).toContain('TP-LINK DHCP 客户端列表');
  });

  it('200 但页面无可解析租约 → 继续下一候选，note 如实标注', async () => {
    const res = await fetchWebLeases({
      gateway: '192.168.0.1',
      cookie: 'c=1',
      brand: 'tplink',
      transport: async (url) => (url.endsWith('DhcpSeartListRpm.htm') ? '<html>登录页</html>' : page),
    });
    expect(res.ok).toBe(true);
    expect(res.note).toContain('客户端列表(新)');
  });

  it('所有空页面仍失败，不能伪造成功的空表', async () => {
    const result = await fetchWebLeases({ gateway: '192.168.0.1', transport: async () => '<table></table>' });
    expect(result).toMatchObject({ ok: false, leases: [] });
    expect(result.note).toContain('200 但无可解析租约');
  });

  it.each(['netgear', 'dlink', 'xiaomi', null] as const)('品牌 %s 去重候选 path 且不重试 TP-LINK Host', async (brand) => {
    const transport = vi.fn(async () => null);
    await fetchWebLeases({ gateway: '192.168.0.1', brand, transport });
    const calls = transport.mock.calls as unknown as [string, Record<string, string>][];
    expect(new Set(calls.map(([url]) => url)).size).toBe(calls.length);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([, headers]) => headers.Host === undefined)).toBe(true);
  });

  it.each(['http:', 'https:'])('provider 按具体 URL/path 现取 Cookie，%s TP-LINK 重试严格隔离域', async (protocol) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const cookieProvider = vi.fn(async (url: string) => new URL(url).hostname === 'tplogin.cn' ? 'domain=tplink' : 'gateway=session');
    const result = await fetchWebLeases({
      gateway: '192.168.0.1', brand: 'tplink', cookie: 'legacy=must-not-leak',
      adminUrl: `${protocol}//192.168.0.1:8443/login?not=a-candidate`, cookieProvider,
      transport: async (url, headers) => {
        calls.push({ url, headers });
        return calls.length === 3 ? page : null;
      },
    });
    expect(result.ok).toBe(true);
    expect(cookieProvider.mock.calls.map(([url]) => url)).toEqual([
      `${protocol}//192.168.0.1:8443/userRpm/DhcpSeartListRpm.htm`,
      `${protocol}//tplogin.cn:8443/userRpm/DhcpSeartListRpm.htm`,
      `${protocol}//192.168.0.1:8443/userRpm/DhcpClientsListRpm.htm`,
    ]);
    expect(calls.map((call) => call.headers.Cookie)).toEqual(['gateway=session', 'domain=tplink', 'gateway=session']);
    expect(calls[1].headers).toMatchObject({ Host: 'tplogin.cn:8443', Referer: `${protocol}//tplogin.cn:8443/` });
    expect(calls.every((call) => new URL(call.url).hostname === '192.168.0.1')).toBe(true);
  });

  it.each([null, 'throw'] as const)('provider 返回 %s 不得回退到其它域/兼容 Cookie', async (mode) => {
    const calls: Record<string, string>[] = [];
    let lookups = 0;
    const result = await fetchWebLeases({
      gateway: '192.168.0.1', brand: 'tplink', cookie: 'legacy=secret',
      cookieProvider: async () => {
        lookups += 1;
        if (lookups === 1) return 'gateway=secret';
        if (mode === 'throw') throw new Error('no cookie');
        return null;
      },
      transport: async (_url, headers) => { calls.push(headers); return calls.length === 1 ? null : page; },
    });
    expect(result.ok).toBe(true);
    expect(calls[0].Cookie).toBe('gateway=secret');
    expect(calls[1].Host).toBe('tplogin.cn');
    expect(calls[1]).not.toHaveProperty('Cookie');
  });

  it.each(['https://external.example:8443/', 'http://192.168.0.1.evil/', 'http://192.168.0.1@evil/', 'file://192.168.0.1/', 'not-a-url'])('拒绝外部/非法 adminUrl：%s', async (adminUrl) => {
    const transport = vi.fn(async (_url: string, _headers: Record<string, string>) => page);
    const cookieProvider = vi.fn(async (_url: string) => 'session=local');
    await fetchWebLeases({ gateway: '192.168.0.1', adminUrl, cookieProvider, transport });
    expect(transport.mock.calls[0][0]).toBe('http://192.168.0.1/dhcp.htm');
    expect(cookieProvider.mock.calls[0][0]).toBe('http://192.168.0.1/dhcp.htm');
  });

  it.each([
    ['https://192.168.0.1/', 443],
    ['https://192.168.0.1:8443/login', 8443],
    ['http://192.168.0.1:8080/', 8080],
  ] as const)('默认传输遵循管理 origin %s 的端口，不改 TLS 配置', async (adminUrl, port) => {
    const request = vi.spyOn(httpx, 'httpRequest').mockResolvedValue({ status: 200, headers: {}, body: page, error: null, ms: 1 });
    const result = await fetchWebLeases({ gateway: '192.168.0.1', adminUrl, cookie: 'session=legacy' });
    expect(result.ok).toBe(true);
    expect(request.mock.calls[0][0]).toBe(`${new URL(adminUrl).origin}/dhcp.htm`);
    expect(request.mock.calls[0][1]).toMatchObject({ port, path: '/dhcp.htm' });
    expect(request.mock.calls[0][1]).not.toHaveProperty('rejectUnauthorized');
  });

  it('挂起 transport 受单次超时与总预算约束；完成后不后台继续候选', async () => {
    vi.useFakeTimers();
    const late: ((body: string | null) => void)[] = [];
    const transport = vi.fn(() => new Promise<string | null>((resolve) => late.push(resolve)));
    const started = Date.now();
    const pending = fetchWebLeases({ gateway: '192.168.0.1', brand: 'tplink', transport });
    await vi.advanceTimersByTimeAsync(WEB_LEASE_TOTAL_BUDGET_MS);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, leases: [] });
    expect(result.note).toContain('截止');
    expect(Date.now() - started).toBe(WEB_LEASE_TOTAL_BUDGET_MS);
    expect(transport).toHaveBeenCalledTimes(WEB_LEASE_TOTAL_BUDGET_MS / WEB_LEASE_TIMEOUT_MS);
    const count = transport.mock.calls.length;
    late.forEach((resolve) => resolve(page));
    await vi.advanceTimersByTimeAsync(WEB_LEASE_TOTAL_BUDGET_MS);
    expect(transport).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('挂起 provider 会收敛，迟到结果不能启动 transport 或后续候选', async () => {
    vi.useFakeTimers();
    let release!: (cookie: string | null) => void;
    const cookieProvider = vi.fn(() => new Promise<string | null>((resolve) => { release = resolve; }));
    const transport = vi.fn(async () => page);
    const pending = fetchWebLeases({ gateway: '192.168.0.1', brand: 'tplink', cookie: 'fallback=secret', cookieProvider, transport });
    await vi.advanceTimersByTimeAsync(WEB_LEASE_TOTAL_BUDGET_MS);
    expect(await pending).toMatchObject({ ok: false, leases: [] });
    release('late=secret');
    await vi.advanceTimersByTimeAsync(WEB_LEASE_TOTAL_BUDGET_MS);
    expect(cookieProvider).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('会话取消后迟到 Cookie 不启动传输，取消的传输不继续候选', async () => {
    let current = true;
    const gate = Promise.withResolvers<string | null>();
    const entered = Promise.withResolvers<void>();
    const transport = vi.fn(async () => page);
    const pending = fetchWebLeases({
      gateway: '192.168.0.1', brand: 'tplink', isCurrent: () => current,
      cookieProvider: () => { entered.resolve(); return gate.promise; }, transport,
    });
    await entered.promise;
    current = false;
    gate.resolve('session=late');
    expect(await pending).toMatchObject({ ok: false, leases: [] });
    expect(transport).not.toHaveBeenCalled();
    current = true;
    const cancelTransport = vi.fn(async () => { current = false; return page; });
    expect(await fetchWebLeases({
      gateway: '192.168.0.1', brand: 'tplink', isCurrent: () => current, transport: cancelTransport,
    })).toMatchObject({ ok: false, leases: [] });
    expect(cancelTransport).toHaveBeenCalledTimes(1);
  });

  it('传输排入微任务后会话取消，仍不得发出请求', async () => {
    let current = true;
    const transport = vi.fn(async () => page);
    const pending = fetchWebLeases({ gateway: '192.168.0.1', isCurrent: () => current, transport });
    current = false;
    expect(await pending).toMatchObject({ ok: false, leases: [] });
    expect(transport).not.toHaveBeenCalled();
  });

  it('provider 与传输累积耗时共用预算，不给每次 Host 重试重置预算', async () => {
    vi.useFakeTimers();
    const delay = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 900));
    const cookieProvider = vi.fn(() => delay('session=current'));
    const transport = vi.fn(() => delay<string | null>(null));
    const pending = fetchWebLeases({ gateway: '192.168.0.1', brand: 'tplink', cookieProvider, transport });
    await vi.advanceTimersByTimeAsync(WEB_LEASE_TOTAL_BUDGET_MS);
    expect(await pending).toMatchObject({ ok: false });
    expect(cookieProvider).toHaveBeenCalledTimes(4);
    expect(transport).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10000);
    expect(cookieProvider).toHaveBeenCalledTimes(4);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('候选清单与品牌识别', () => {
  it('候选清单总量受控且单次抓取有上限（轮询预算约束）、path 均以 / 开头', () => {
    expect(WEB_LEASE_CANDIDATES.length).toBeLessThanOrEqual(20);
    expect(WEB_LEASE_MAX_CANDIDATES).toBeLessThanOrEqual(6);
    for (const c of WEB_LEASE_CANDIDATES) expect(c.path.startsWith('/')).toBe(true);
  });

  it('TP-LINK dynaform 自报（真机 TL-7DR7290 页面形态）→ tplink + 型号 hint', () => {
    const body = `<title>TL-7DR7290</title>
      <link rel="stylesheet" href="../web-static/dynaform/class.css">
      <script>var proName="TL-7DR7290"; pageOnload();</script>`;
    const { brand, hint } = matchFingerprint(null, body);
    expect(brand).toBe('tplink');
    expect(hint).toBe('TL-7DR7290');
  });
});
