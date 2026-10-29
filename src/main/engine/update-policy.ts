/**
 * 更新能力判定与错误归一化（纯 Node，无 electron 依赖，可在 Vitest 中直接测试）。
 *
 * 只决定"能不能自动更新"和"失败该怎么说"，不接触网络或文件。
 */

export interface UpdateSupport {
  supported: boolean;
  /** supported=false 时的诚实原因，直接展示给用户；supported=true 时为 null */
  reason: string | null;
}

/**
 * electron-builder 的 portable 目标会注入 PORTABLE_EXECUTABLE_FILE / _DIR / _APP_FILENAME。
 * 便携版是自解压单文件，进程目录是临时目录，NSIS 差分安装无法落到原文件，因此不支持就地更新。
 */
export function isPortableBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR || env.PORTABLE_EXECUTABLE_APP_FILENAME,
  );
}

export function resolveUpdateSupport(input: {
  isPackaged: boolean;
  isSmoke: boolean;
  env: NodeJS.ProcessEnv;
}): UpdateSupport {
  if (input.isSmoke) return { supported: false, reason: '冒烟检查模式不执行更新' };
  if (!input.isPackaged) return { supported: false, reason: '开发模式不执行更新检查；请使用安装版' };
  if (isPortableBuild(input.env)) {
    return { supported: false, reason: '便携版不支持就地更新，请从 Releases 手动下载新版本' };
  }
  return { supported: true, reason: null };
}

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

function truncate(text: string, max = 180): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把 electron-updater 的底层错误翻译成可执行的提示。
 * 未识别的错误保留原始信息（截断），不吞掉排查线索。
 */
export function normalizeUpdateError(err: unknown): string {
  const raw = rawMessage(err).trim();
  if (/latest\.ya?ml|404|not found/i.test(raw)) {
    return '未找到更新元数据（latest.yml）；请确认 Release 已上传该文件';
  }
  if (/app-update\.ya?ml/i.test(raw)) {
    return '安装包缺少更新配置（app-update.yml），无法自动更新；请手动下载安装版';
  }
  if (/sha512|checksum|integrity|signature/i.test(raw)) {
    return '更新包校验失败，已取消安装；请重试或手动下载并核对 SHA256';
  }
  if (/ENOSPC|no space/i.test(raw)) return '磁盘空间不足，无法下载更新';
  if (/EACCES|EPERM|permission/i.test(raw)) return '没有写入更新缓存的权限；请检查用户目录权限';
  if (/net::|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network|getaddrinfo/i.test(raw)) {
    return '网络连接失败，无法检查更新；请稍后重试';
  }
  if (raw === '') return '更新失败（没有返回错误信息）';
  return `更新失败：${truncate(raw)}`;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}
