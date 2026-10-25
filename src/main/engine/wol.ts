/**
 * WOL 网络唤醒（task-025）。
 *
 * 数据诚实铁律：UDP 广播无确认 —— **发送成功 ≠ 设备一定唤醒**。
 * 本模块只承诺"magic packet 已按标准构造并发出"，错误仅限 MAC 非法 / socket 创建失败。
 * 为提高兼容性向端口 7 / 9 各发一次尽力而为（目标主机监听哪个由它自己决定）。
 *
 * 本文件不 import electron，可被 vitest 在纯 Node 下直接导入。
 */
import dgram from 'node:dgram';

export interface WolResult {
  ok: boolean;
  error: string | null;
}

/** MAC 地址：支持 `-` / `:` 分隔，大小写不敏感。 */
export const RE_MAC = /^[0-9a-fA-F]{2}(?:(?::|-)[0-9a-fA-F]{2}){5}$/;

/** 归一化 MAC：去分隔符转小写（如 aa:bb:cc:dd:ee:ff → aabbccddeeff）。 */
export function normalizeMac(mac: string): string {
  return mac.replace(/[:\-]/g, '').toLowerCase();
}

/**
 * 纯函数：构造 magic packet = 6×0xFF + 16×目标 MAC。
 * 单测覆盖字节级断言。
 */
export function buildMagicPacket(mac: string): Buffer | null {
  if (!RE_MAC.test(mac)) return null;
  const macBytes = Buffer.from(normalizeMac(mac), 'hex');
  if (macBytes.length !== 6) return null;
  return Buffer.concat([Buffer.alloc(6, 0xff), Buffer.concat(Array.from({ length: 16 }, () => macBytes))]);
}

/**
 * 发送 WOL magic packet（UDP 广播 255.255.255.255，端口 9 与 7 各一次尽力而为）。
 * 任一端口发送成功即 ok:true；全部失败返回最后一次错误。
 * 不重试、绝不抛（socket 层异常收敛为 { ok:false }）。
 */
export function sendMagicPacket(mac: string, opts: { timeoutMs?: number } = {}): Promise<WolResult> {
  const packet = buildMagicPacket(mac);
  if (!packet) return Promise.resolve({ ok: false, error: `无效的 MAC 地址：${mac}` });
  const timeoutMs = opts.timeoutMs ?? 2000;
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;
    const finish = (result: WolResult): void => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* 已关闭 */
      }
      resolve(result);
    };
    // 广播地址目标端口（9 优先，7 兜底；两者都发，任一成功即视为已发出）
    const targets: { host: string; port: number }[] = [
      { host: '255.255.255.255', port: 9 },
      { host: '255.255.255.255', port: 7 },
    ];
    let sentOk = false;
    let lastError = '';
    let pending = targets.length;
    sock.on('error', (err) => {
      lastError = err.message;
      pending -= 1;
      if (pending <= 0) finish({ ok: sentOk, error: sentOk ? null : lastError || 'socket 发送失败' });
    });
    // bind 成功后才开广播（Windows 下部分系统要求 bind 后再 setBroadcast）
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch (err) {
        finish({ ok: false, error: `无法开启广播：${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      // 超时保护：send 回调长期不触发也不悬挂
      const guard = setTimeout(() => finish({ ok: sentOk, error: sentOk ? null : lastError || '发送超时' }), timeoutMs);
      guard.unref?.();
      for (const t of targets) {
        sock.send(packet, t.port, t.host, (err) => {
          if (err) lastError = err.message;
          else sentOk = true;
          pending -= 1;
          if (pending <= 0) {
            clearTimeout(guard);
            finish({ ok: sentOk, error: sentOk ? null : lastError || 'socket 发送失败' });
          }
        });
      }
    });
  });
}
