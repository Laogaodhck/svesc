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

// save 开始即抢占旧操作；clear 在删除前同步使所有在飞操作失效。
let operationRevision = 0;

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

/** isCurrent 由调用方校验会话/记住密码设置，在异步步骤后、写盘前复核。 */
export async function saveCredentials(
  user: string,
  password: string,
  isCurrent: () => boolean = () => true,
): Promise<{ ok: boolean; error: string | null }> {
  const revision = ++operationRevision;
  return persistCredentials(user, password, revision, 'save', isCurrent);
}

/** 轮换沿用 load 的修订，不能作为新 save 抢占更新的凭据操作。 */
async function persistCredentials(
  user: string,
  password: string,
  revision: number,
  source: 'save' | 'rotation',
  isCurrent: () => boolean = () => true,
): Promise<{ ok: boolean; error: string | null }> {
  const canWrite = () => revision === operationRevision && isCurrent();
  try {
    const available = await canPersistCredentials();
    if (!canWrite()) return { ok: false, error: '凭据保存已取消' };
    if (!available) {
      return { ok: false, error: '系统密钥环不可用，凭据不会被保存（每次启动需重新登录）' };
    }
    // 返回值仍是 Buffer，落盘格式与同步版完全一致
    const enc = await safeStorage.encryptStringAsync(password);
    if (!canWrite()) return { ok: false, error: '凭据保存已取消' };
    const data: StoredCredentials = { user, passwordEnc: enc.toString('base64') };
    // 检查到同步写盘之间没有 await，clear / 新 save 无法插入。
    fs.writeFileSync(storePath(), JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    // save 挂起期间新发起的 load 仍可能读到旧文件；写入后也要使其失效。
    // 轮换不推进修订，以免使自身 load 或正在保存的新凭据失效。
    if (source === 'save') ++operationRevision;
    return { ok: true, error: null };
  } catch {
    // 包括 guard 抛错在内均 fail closed，不能将底层异常中的凭据回传。
    return { ok: false, error: '凭据保存失败' };
  }
}

export async function loadCredentials(): Promise<{ user: string; password: string } | null> {
  const revision = operationRevision;
  const available = await canPersistCredentials();
  if (revision !== operationRevision || !available) return null;
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const data = JSON.parse(raw) as StoredCredentials;
    if (typeof data.user !== 'string' || typeof data.passwordEnc !== 'string') return null;
    // 异步解密返回 { shouldReEncrypt, result } 对象，取 .result
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(data.passwordEnc, 'base64'));
    if (revision !== operationRevision) return null;
    if (decrypted.shouldReEncrypt) {
      // 平台密钥已轮换：尽力重存，但仍属于同一次 load。
      await persistCredentials(data.user, decrypted.result, revision, 'rotation');
    }
    if (revision !== operationRevision) return null;
    return { user: data.user, password: decrypted.result };
  } catch {
    return null; // 文件不存在/损坏按"无凭据"处理
  }
}

export function clearCredentials(): void {
  ++operationRevision;
  try {
    fs.rmSync(storePath(), { force: true });
  } catch {
    /* 文件本就不存在 */
  }
}
