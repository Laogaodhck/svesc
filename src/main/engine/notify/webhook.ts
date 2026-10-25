/**
 * 告警 Webhook 推送（task-025）。
 *
 * 诚实约束：HTTP POST 发送成功（2xx）≠ 对方处理成功；非 2xx 也如实返回 status。
 * 不重试、绝不抛——推送失败只写 netlog，不影响告警主链路。
 *
 * 本文件不 import electron，可被 vitest 在纯 Node 下直接导入。
 */
import http from 'node:http';
import https from 'node:https';

export interface WebhookResult {
  ok: boolean;
  /** HTTP 状态码（请求到达且收到响应时才有） */
  status: number | null;
  error: string | null;
}

/** URL 合法性：仅 http/https。 */
export function isValidWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 向 url POST 一段 JSON payload。5s 超时、不重试、绝不抛。
 * ok 判定：请求到达并收到 2xx 响应；其余（非 2xx / 超时 / 连接失败）ok:false。
 */
export function postWebhook(url: string, payload: unknown, timeoutMs = 5000): Promise<WebhookResult> {
  if (!isValidWebhookUrl(url)) {
    return Promise.resolve({ ok: false, status: null, error: `无效的 Webhook URL：${url}` });
  }
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const req = lib.request(
        parsed,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: timeoutMs,
        },
        (res) => {
          // 消费响应体防止 socket 挂起；状态码如实上报
          res.resume();
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          resolve({ ok, status, error: ok ? null : `远端返回 HTTP ${status}` });
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, status: null, error: `请求超时（${timeoutMs}ms）` });
      });
      req.on('error', (err) => {
        resolve({ ok: false, status: null, error: err.message });
      });
      req.end(body);
    } catch (err) {
      resolve({ ok: false, status: null, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
