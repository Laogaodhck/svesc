/**
 * 远程操作（设备抽屉的 RDP、共享文件夹一键打开；task-019 移除 SSH 入口）。
 *
 * 安全约束（与 netdiag 同一铁律）：
 *  - 目标先过 validateDiagTarget 字符白名单，注入字符直接拒绝，绝不拼 shell 字符串；
 *  - cmd 与 args 永远分离传入 spawn；
 *  - spawn 失败（找不到程序 / 权限不足）必须返回 { ok:false, error }，绝不抛、
 *    绝不静默——数据诚实：用户点了按钮就必须知道结果。
 *
 * 平台说明：本应用当前只支持 Windows 打包分发（electron-builder win），
 * 因此 rdp/share 按 Windows 程序处理；非 Windows 下如实返回不支持。
 */
import { spawn } from 'node:child_process';
import type { RemoteOpKind } from '../shared/types';
import { validateDiagTarget } from './engine/diag/netdiag';

/** 单个远程操作执行：成功即返回 ok:true（进程已拉起），失败带中文原因。 */
export async function remoteOpen(
  kind: RemoteOpKind,
  target: string,
  user?: string,
): Promise<{ ok: boolean; error: string | null }> {
  if (process.platform !== 'win32') {
    return { ok: false, error: `远程操作当前仅支持 Windows（当前 ${process.platform}）` };
  }
  const t = String(target ?? '').trim();
  const check = validateDiagTarget('ping', t); // 共用同一字符白名单（IP/主机名）
  if (!check.ok) {
    return { ok: false, error: `目标不合法：${check.error}` };
  }
  const u = user == null ? '' : String(user).trim();
  if (u && !/^[A-Za-z0-9._\\-]+$/.test(u)) {
    // 域账号形如 DOMAIN\user，放行反斜杠；其余可疑字符拒绝
    return { ok: false, error: '用户名包含非法字符' };
  }

  const detachedSpawn = (cmd: string, args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        // detached + unref：子进程独立于主进程存活（关掉监控台不断 RDP 会话）
        child.unref();
        child.on('error', (err) => reject(err));
        // spawn 成功即认为已拉起；GUI 程序的后续失败（如 mstsc 连不上）由其自身窗口呈现
        setImmediate(() => resolve());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

  try {
    switch (kind) {
      case 'rdp':
        // mstsc /v:ip —— 远程桌面（Windows 自带，无需安装）
        await detachedSpawn('mstsc.exe', ['/v:' + t]);
        return { ok: true, error: null };
      case 'share':
        // explorer \\ip\ —— 打开 SMB 共享根（需要目标开了文件共享；打不开时 explorer 自身提示）
        await detachedSpawn('explorer.exe', ['\\\\' + t + '\\']);
        return { ok: true, error: null };
      default:
        // task-019 兼容处理：老版本渲染层仍可能发 'ssh'（类型上已不可达，双保险）
        return { ok: false, error: `远程操作类型已停用或未知：${String(kind)}（SSH 入口已在 v0.2.0 移除，可改用「诊断」页的端口探测确认 22 端口开放）` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const label = kind === 'rdp' ? '远程桌面' : '共享文件夹';
    return { ok: false, error: `无法启动${label}（${msg}）` };
  }
}
