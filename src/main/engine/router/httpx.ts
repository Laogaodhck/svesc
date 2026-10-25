/**
 * 路由器通道的最小 HTTP 传输层（node:http，零第三方依赖）。
 *
 * 与 exec.ts 同一铁律：不 import electron，可被 vitest 在纯 Node 下直接导入。
 * 超时到点立即销毁请求并返回 error，绝不悬挂（R-05 同源教训）。
 */
import * as http from 'node:http';
import * as https from 'node:https';

export interface HttpResult {
  status: number | null;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  ms: number;
  /** 请求失败说明；null = 成功拿到响应 */
  error: string | null;
}

export interface HttpOptions {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** https 管理页自签证书直接放过（局域网设备无 CA，只做指纹探测） */
  rejectUnauthorized?: boolean;
}

/** 发起一次 HTTP(S) 请求；任何失败都以 error 文本返回，绝不抛异常拖垮调用方。 */
export function httpRequest(url: URL | string, opts: HttpOptions): Promise<HttpResult> {
  const started = Date.now();
  return new Promise<HttpResult>((resolve) => {
    let settled = false;
    const finish = (result: Omit<HttpResult, 'ms'>): void => {
      if (settled) return;
      settled = true;
      resolve({ ...result, ms: Date.now() - started });
    };

    const u = typeof url === 'string' ? new URL(url) : url;
    const transport = u.protocol === 'https:' ? https : http;
    let req: http.ClientRequest;
    try {
      req = transport.request(
        {
          hostname: u.hostname,
          port: opts.port,
          path: u.pathname + u.search,
          method: opts.method ?? 'GET',
          headers: opts.headers,
          timeout: opts.timeoutMs,
          rejectUnauthorized: opts.rejectUnauthorized ?? false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            finish({
              status: res.statusCode ?? null,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
              error: null,
            });
          });
          res.on('error', (err: Error) => finish({ status: null, headers: {}, body: '', error: err.message }));
        },
      );
    } catch (err) {
      finish({ status: null, headers: {}, body: '', error: err instanceof Error ? err.message : String(err) });
      return;
    }

    // node 的 request timeout 只作用于 socket 空闲，销毁动作必须自己收口
    req.on('timeout', () => {
      req.destroy();
      finish({ status: null, headers: {}, body: '', error: `timeout after ${opts.timeoutMs}ms` });
    });
    req.on('error', (err: Error) => finish({ status: null, headers: {}, body: '', error: err.message }));

    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
