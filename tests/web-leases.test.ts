/**
 * task-030：管理页租约实验通道（`src/main/engine/router/web-leases.ts`）。
 *
 * 诚实边界：候选页路径未经真机登录验证（实验性），但解析器与抓取循环是纯函数，
 * 用合成页面全面覆盖。品牌识别部分（TP-LINK dynaform 自报）有真机 TL-7DR7290 实测佐证。
 */
import { describe, expect, it } from 'vitest';
import {
  fetchWebLeases,
  parseLeasesFromHtml,
  WEB_LEASE_CANDIDATES,
  WEB_LEASE_MAX_CANDIDATES,
} from '../src/main/engine/router/web-leases';
import { matchFingerprint } from '../src/main/engine/router/detect';

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
    expect(leases[0]?.ip).toBe('192.168.0.105');
    expect(leases[0]?.hostname).toBe('android-客厅');
    expect(leases[1]?.mac).toBe('00-11-5b-97-5a-1c');
    expect(leases[1]?.ip).toBe('192.168.0.100');
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
    // task-032 候选扩充后：小米专属 1 条 + 通用 3 条 = 4 候选，每条失败含一次 Host 覆写重试
    expect(tried).toHaveLength(8);
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
