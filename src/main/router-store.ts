/**
 * 路由器凭据持久化（Electron safeStorage）。
 *
 * 安全约束：
 *  - 明文密码只存在于内存；落盘前必须经 safeStorage 加密（Windows DPAPI）。
 *  - safeStorage 不可用（Linux 无 keyring 等）时拒绝持久化并如实上报，
 *    绝不降级为明文落盘。
 *
 * API 说明：`isEncryptionAvailable` / `encryptString` / `decryptString` 三个同步 API
 * 自 Electron 45 起弃用、46 移除，故本文件只使用异步 API
 * （`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`）。
 * 异步版使用同一套平台密钥库：既有同步 API 产出的 DPAPI 密文可被
 * `decryptStringAsync` 解密，base64 落盘格式不变，用户无需重新登录。
 */
import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StoredCredentials {
  user: string;
  /** base64(DPAPI 密文) */
  passwordEnc: string;
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'router-credentials.json');
}

/** 是否具备安全持久化条件（不可用时调用方须提示用户每次手动登录）。 */
export async function canPersistCredentials(): Promise<boolean> {
  try {
    return await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    return false;
  }
}

export async function saveCredentials(
  user: string,
  password: string,
): Promise<{ ok: boolean; error: string | null }> {
  if (!(await canPersistCredentials())) {
    return { ok: false, error: '系统密钥环不可用，凭据不会被保存（每次启动需重新登录）' };
  }
  try {
    // 返回值仍是 Buffer，落盘格式与同步版完全一致
    const enc = (await safeStorage.encryptStringAsync(password)).toString('base64');
    const data: StoredCredentials = { user, passwordEnc: enc };
    fs.writeFileSync(storePath(), JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function loadCredentials(): Promise<{ user: string; password: string } | null> {
  if (!(await canPersistCredentials())) return null;
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const data = JSON.parse(raw) as StoredCredentials;
    if (typeof data.user !== 'string' || typeof data.passwordEnc !== 'string') return null;
    // 异步解密返回 { shouldReEncrypt, result } 对象，取 .result
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(data.passwordEnc, 'base64'));
    if (decrypted.shouldReEncrypt) {
      // 平台密钥已轮换：用新密钥重存，避免下次启动再走一次兼容解密
      await saveCredentials(data.user, decrypted.result);
    }
    return { user: data.user, password: decrypted.result };
  } catch {
    return null; // 文件不存在/损坏按"无凭据"处理
  }
}

export function clearCredentials(): void {
  try {
    fs.rmSync(storePath(), { force: true });
  } catch {
    /* 文件本就不存在 */
  }
}
