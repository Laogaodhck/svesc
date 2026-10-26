/**
 * HTML 导出报告（task-025）：自包含单文件（内联 CSS、无外链、无 JS）。
 *
 * 安全约束：**所有**动态文本必须经 escapeHtml 转义——设备备注/别名里出现
 * `<script>` 不得变成可执行内容（报告会被人用浏览器打开）。
 * 纯函数可单测（断言关键 id 与转义行为）。
 *
 * 本文件不 import electron，可被 vitest 在纯 Node 下直接导入。
 */
import type { Snapshot } from '../../shared/types';

/** HTML 转义（& < > " '）。导出报告与将来任何 HTML 产物共用。 */
export function escapeHtml(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBps(v: number | null): string {
  if (v === null) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)} Mbps`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)} Kbps`;
  return `${Math.round(v)} Bps`;
}

const STATE_LABEL: Record<string, string> = {
  online: '在线',
  offline: '离线',
  degraded: '劣化',
  scanning: '扫描中',
  unknown: '未知',
};

/**
 * 生成自包含 HTML 报告。extras 合入头部附录（路由器状态等，由调用方提供）。
 * 空表显示"暂无数据"占位，绝不虚构行。
 */
export function buildHtmlReport(snapshot: Snapshot, extras?: Record<string, unknown>): string {
  const s = escapeHtml;
  const now = new Date(snapshot.ts);
  const devices = snapshot.devices ?? [];
  const printers = snapshot.printers ?? [];
  const warnings = snapshot.warnings ?? [];

  const deviceRows = devices
    .map(
      (d) => `<tr>
  <td><span class="dot ${s(d.state)}"></span>${s(STATE_LABEL[d.state] ?? d.state)}</td>
  <td>${s(d.displayName ?? d.hostname ?? '—')}</td>
  <td>${s(d.ip)}</td>
  <td>${s(d.mac ?? '未知')}</td>
  <td>${s(d.vendor ?? '未知')}</td>
  <td>${s(String(d.kind))}</td>
  <td>${d.quality.latencyMs !== null ? `${s(String(d.quality.latencyMs))} ms` : '—'}</td>
  <td>${d.quality.grade === 'unknown' ? '—' : `${s(String(d.quality.score))}`}</td>
  <td>${d.bandwidth.attributable ? `${s(formatBps(d.bandwidth.rxBps))} / ${s(formatBps(d.bandwidth.txBps))}` : '无归集'}</td>
  <td>${d.note ? s(d.note) : '—'}</td>
  <td>${d.tags && d.tags.length > 0 ? d.tags.map((t) => `<span class="tag">${s(t)}</span>`).join(' ') : '—'}</td>
</tr>`,
    )
    .join('\n');

  const printerRows = printers
    .map(
      (p) => `<tr>
  <td>${s(p.alias ?? p.name)}</td>
  <td>${s(p.connection)}</td>
  <td>${s(p.state)}</td>
  <td>${s(p.ip ?? '—')}</td>
  <td>${p.pageCount !== null ? s(String(p.pageCount)) : '—'}</td>
</tr>`,
    )
    .join('\n');

  const warningItems =
    warnings.length > 0
      ? warnings.map((w) => `<li>[${s(w.source)}] ${s(w.message)}</li>`).join('\n')
      : '<li>无降级信息</li>';

  const extrasBlock =
    extras && Object.keys(extras).length > 0
      ? `<h2 id="extras">附录（引擎附加数据）</h2><pre>${s(JSON.stringify(extras, null, 2))}</pre>`
      : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>SVESC 局域网巡检报告 ${s(now.toLocaleString('zh-CN'))}</title>
<style>
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; margin: 24px; color: #1f2937; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 12px; }
  th, td { border: 1px solid #d1d5db; padding: 4px 8px; text-align: left; }
  th { background: #f3f4f6; }
  .meta { color: #6b7280; font-size: 12px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; background: #9ca3af; }
  .dot.online { background: #16a34a; } .dot.offline { background: #dc2626; } .dot.degraded { background: #d97706; }
  .tag { display: inline-block; background: #e5e7eb; border-radius: 3px; padding: 0 4px; margin: 1px; }
  pre { background: #f9fafb; border: 1px solid #e5e7eb; padding: 8px; font-size: 11px; overflow-x: auto; }
  .empty { color: #6b7280; font-style: italic; padding: 8px; }
</style>
</head>
<body>
<h1>SVESC 局域网巡检报告</h1>
<p class="meta" id="meta">
  网段：${s(snapshot.subnet ?? '未知')} · 生成时间：${s(now.toLocaleString('zh-CN'))} ·
  数据源：${s(snapshot.dataSource)} · 设备 ${devices.length} 台（在线 ${s(String(devices.filter((d) => d.state === 'online').length))}）·
  打印机 ${printers.length} 台
</p>
<h2 id="devices">设备</h2>
${
  devices.length === 0
    ? '<p class="empty">暂无设备数据</p>'
    : `<table>
<thead><tr><th>状态</th><th>名称</th><th>IP</th><th>MAC</th><th>厂商</th><th>类型</th><th>延迟</th><th>评分</th><th>带宽 (↓/↑)</th><th>备注</th><th>标签</th></tr></thead>
<tbody>
${deviceRows}
</tbody></table>`
}
<h2 id="printers">打印机</h2>
${
  printers.length === 0
    ? '<p class="empty">暂无打印机数据</p>'
    : `<table>
<thead><tr><th>名称</th><th>连接</th><th>状态</th><th>IP</th><th>页数</th></tr></thead>
<tbody>
${printerRows}
</tbody></table>`
}
<h2 id="warnings">降级信息（数据可信度）</h2>
<ul>${warningItems}</ul>
${extrasBlock}
</body>
</html>`;
}
