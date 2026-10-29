import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as path from 'node:path';

// 完整替换 Electron/文件系统：测试只操作内存，绝不读取真实 userData。
const h = vi.hoisted(() => ({
  file: null as string | null,
  getPath: vi.fn<(name: string) => string>(),
  available: vi.fn<() => Promise<boolean>>(),
  encrypt: vi.fn<(value: string) => Promise<Buffer>>(),
  decrypt: vi.fn<(value: Buffer) => Promise<{ shouldReEncrypt: boolean; result: string }>>(),
  read: vi.fn<(file: unknown, encoding: unknown) => string>(),
  write: vi.fn<(file: unknown, data: string, options: unknown) => void>(),
  remove: vi.fn<(file: unknown, options: unknown) => void>(),
}));

vi.mock('electron', () => ({
  app: { getPath: h.getPath },
  safeStorage: {
    isAsyncEncryptionAvailable: h.available,
    encryptStringAsync: h.encrypt,
    decryptStringAsync: h.decrypt,
  },
}));
vi.mock('node:fs', () => ({
  readFileSync: h.read,
  writeFileSync: h.write,
  rmSync: h.remove,
}));

import { canPersistCredentials, clearCredentials, loadCredentials, saveCredentials } from '../src/main/router-store';

const USER = 'fixture-user';
const PASSWORD = 'fixture-only-password';
const ENCRYPTED = Buffer.from('fixture-only-encrypted');
const CANCELLED = { ok: false, error: '凭据保存已取消' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function pauseNext<Args extends unknown[], Result>(mock: Mock<(...args: Args) => Promise<Result>>) {
  const entered = deferred<void>();
  const result = deferred<Result>();
  mock.mockImplementationOnce(() => {
    entered.resolve(undefined);
    return result.promise;
  });
  return { ...result, entered: entered.promise };
}

function seed() {
  h.file = JSON.stringify({ user: USER, passwordEnc: ENCRYPTED.toString('base64') });
}

function expectNoWrites() {
  // 只断言计数/布尔值，失败报告也不输出凭据或密文。
  expect(h.write.mock.calls.length).toBe(0);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.getPath.mockReturnValue('mock-user-data');
  h.available.mockResolvedValue(true);
  h.encrypt.mockResolvedValue(ENCRYPTED);
  h.decrypt.mockResolvedValue({ shouldReEncrypt: false, result: PASSWORD });
  h.read.mockImplementation(() => {
    if (h.file === null) throw new Error('fixture file missing');
    return h.file;
  });
  h.write.mockImplementation((_file, data) => { h.file = data; });
  h.remove.mockImplementation(() => { h.file = null; });
  clearCredentials();
  h.remove.mockClear();
  h.getPath.mockClear();
});

describe('router credential store normal flow', () => {
  it('checks availability without filesystem access', async () => {
    expect(await canPersistCredentials()).toBe(true);
    h.available.mockResolvedValueOnce(false);
    expect(await canPersistCredentials()).toBe(false);
    h.available.mockRejectedValueOnce(new Error('fixture unavailable'));
    expect(await canPersistCredentials()).toBe(false);
    expect(h.getPath.mock.calls.length).toBe(0);
  });

  it('preserves the two-argument API, encrypted format, file mode and round trip', async () => {
    expect(await saveCredentials(USER, PASSWORD)).toEqual({ ok: true, error: null });
    const stored = JSON.parse(h.file!);
    expect(stored.user === USER).toBe(true);
    expect(stored.passwordEnc === ENCRYPTED.toString('base64')).toBe(true);
    expect(h.file!.includes(PASSWORD)).toBe(false);
    expect(h.encrypt.mock.calls[0]?.[0] === PASSWORD).toBe(true);
    expect(h.write.mock.calls[0]?.[0] === path.join('mock-user-data', 'router-credentials.json')).toBe(true);
    expect(h.write.mock.calls[0]?.[2]).toEqual({ encoding: 'utf8', mode: 0o600 });
    const loaded = await loadCredentials();
    expect(loaded?.user === USER && loaded.password === PASSWORD).toBe(true);
    expect(h.decrypt.mock.calls[0]?.[0].equals(ENCRYPTED)).toBe(true);
    expect(h.read.mock.calls[0]?.[1]).toBe('utf8');
    expect(h.getPath.mock.calls.every(([name]) => name === 'userData')).toBe(true);
    clearCredentials();
    expect(h.file === null).toBe(true);
    expect(h.remove.mock.calls[0]?.[1]).toEqual({ force: true });
  });

  it('does not persist or load when the keyring is unavailable', async () => {
    seed();
    h.available.mockResolvedValue(false);
    const saved = await saveCredentials(USER, PASSWORD);
    expect(saved.ok).toBe(false);
    expect(saved.error).toBe('系统密钥环不可用，凭据不会被保存（每次启动需重新登录）');
    expect(await loadCredentials() === null).toBe(true);
    expect(h.encrypt.mock.calls.length).toBe(0);
    expect(h.read.mock.calls.length).toBe(0);
    expectNoWrites();
  });

  it.each([null, '{', '{}', '{"user":1,"passwordEnc":""}', '{"user":"fixture","passwordEnc":1}'])('treats missing or malformed file #%# as absent', async (file) => {
    h.file = file;
    expect(await loadCredentials() === null).toBe(true);
    expect(h.decrypt.mock.calls.length).toBe(0);
    expectNoWrites();
  });

  it('treats decryption failure as absent', async () => {
    seed();
    h.decrypt.mockRejectedValueOnce(new Error('fixture decrypt failure'));
    expect(await loadCredentials() === null).toBe(true);
    expectNoWrites();
  });

  it('rotates the key without invalidating its own load', async () => {
    seed();
    h.decrypt.mockResolvedValueOnce({ shouldReEncrypt: true, result: PASSWORD });
    const loaded = await loadCredentials();
    expect(loaded?.user === USER && loaded.password === PASSWORD).toBe(true);
    expect(h.write.mock.calls.length).toBe(1);
    expect(h.encrypt.mock.calls[0]?.[0] === PASSWORD).toBe(true);
  });

  it('keeps rotation best-effort when encryption fails without invalidation', async () => {
    seed();
    h.decrypt.mockResolvedValueOnce({ shouldReEncrypt: true, result: PASSWORD });
    h.encrypt.mockRejectedValueOnce(new Error('fixture rotation failure'));
    const loaded = await loadCredentials();
    expect(loaded?.user === USER && loaded.password === PASSWORD).toBe(true);
    expectNoWrites();
  });

  it.each(['encrypt', 'write'] as const)('returns a generic error on %s failure', async (stage) => {
    const failure = new Error(PASSWORD);
    if (stage === 'encrypt') h.encrypt.mockRejectedValueOnce(failure);
    else h.write.mockImplementationOnce(() => { throw failure; });
    expect(await saveCredentials(USER, PASSWORD)).toEqual({ ok: false, error: '凭据保存失败' });
  });
});

describe('logout invalidates in-flight operations', () => {
  it.each([true, false])('logout during save availability check (available=%s)', async (available) => {
    const gate = pauseNext(h.available);
    const pending = saveCredentials(USER, PASSWORD);
    await gate.entered;
    clearCredentials();
    gate.resolve(available);
    expect(await pending).toEqual(CANCELLED);
    expect(h.encrypt.mock.calls.length).toBe(0);
    expectNoWrites();
    expect(h.file === null).toBe(true);
  });

  it('logout during encryption prevents resurrection', async () => {
    const gate = pauseNext(h.encrypt);
    const pending = saveCredentials(USER, PASSWORD);
    await gate.entered;
    clearCredentials();
    gate.resolve(ENCRYPTED);
    expect(await pending).toEqual(CANCELLED);
    expectNoWrites();
    expect(h.file === null).toBe(true);
  });

  it('logout during load availability check prevents even reading a later save', async () => {
    seed();
    const gate = pauseNext(h.available);
    const pending = loadCredentials();
    await gate.entered;
    clearCredentials();
    await saveCredentials('new-fixture-user', PASSWORD);
    gate.resolve(true);
    expect(await pending === null).toBe(true);
    expect(h.read.mock.calls.length).toBe(0);
    expect(h.decrypt.mock.calls.length).toBe(0);
    expect(h.write.mock.calls.length).toBe(1);
  });

  it.each([false, true])('logout during decryption (rotation=%s) suppresses return and rotation', async (shouldReEncrypt) => {
    seed();
    const gate = pauseNext(h.decrypt);
    const pending = loadCredentials();
    await gate.entered;
    clearCredentials();
    gate.resolve({ shouldReEncrypt, result: PASSWORD });
    expect(await pending === null).toBe(true);
    expect(h.encrypt.mock.calls.length).toBe(0);
    expectNoWrites();
    expect(h.file === null).toBe(true);
  });

  it.each(['availability', 'encryption'] as const)('logout during rotation %s suppresses return and write', async (stage) => {
    seed();
    h.decrypt.mockResolvedValueOnce({ shouldReEncrypt: true, result: PASSWORD });
    if (stage === 'availability') h.available.mockResolvedValueOnce(true);
    const availability = stage === 'availability' ? pauseNext(h.available) : null;
    const encryption = stage === 'encryption' ? pauseNext(h.encrypt) : null;
    const pending = loadCredentials();
    await (availability ?? encryption)!.entered;
    clearCredentials();
    availability?.resolve(true);
    encryption?.resolve(ENCRYPTED);
    expect(await pending === null).toBe(true);
    expectNoWrites();
    expect(h.file === null).toBe(true);
  });

  it('rechecks after awaited rotation completes and before returning', async () => {
    seed();
    h.decrypt.mockResolvedValueOnce({ shouldReEncrypt: true, result: PASSWORD });
    h.write.mockImplementationOnce((_file, data) => {
      h.file = data;
      queueMicrotask(clearCredentials);
    });
    expect(await loadCredentials() === null).toBe(true);
    expect(h.write.mock.calls.length).toBe(1);
    expect(h.file === null).toBe(true);
  });

  it('invalidates synchronously even when removal fails', async () => {
    const gate = pauseNext(h.encrypt);
    const pending = saveCredentials(USER, PASSWORD);
    await gate.entered;
    h.remove.mockImplementationOnce(() => { throw new Error('fixture removal failure'); });
    expect(() => clearCredentials()).not.toThrow();
    gate.resolve(ENCRYPTED);
    expect(await pending).toEqual(CANCELLED);
    expectNoWrites();
  });

  it('does not expose a rejected encryption error after logout', async () => {
    const gate = pauseNext(h.encrypt);
    const pending = saveCredentials(USER, PASSWORD);
    await gate.entered;
    clearCredentials();
    gate.reject(new Error(PASSWORD));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error?.includes(PASSWORD)).toBe(false);
    expectNoWrites();
  });
});

describe('save ordering and caller guard', () => {
  it.each(['availability', 'encryption'] as const)('later save wins over an earlier save in %s', async (stage) => {
    const availability = stage === 'availability' ? pauseNext(h.available) : null;
    const encryption = stage === 'encryption' ? pauseNext(h.encrypt) : null;
    const older = saveCredentials(USER, PASSWORD);
    await (availability ?? encryption)!.entered;
    expect(await saveCredentials('new-fixture-user', PASSWORD)).toEqual({ ok: true, error: null });
    availability?.resolve(true);
    encryption?.resolve(ENCRYPTED);
    expect(await older).toEqual(CANCELLED);
    expect(h.write.mock.calls.length).toBe(1);
    expect(JSON.parse(h.file!).user === 'new-fixture-user').toBe(true);
  });

  it('a later cancelled save still invalidates an earlier save', async () => {
    const gate = pauseNext(h.encrypt);
    const older = saveCredentials(USER, PASSWORD);
    await gate.entered;
    expect(await saveCredentials('new-fixture-user', PASSWORD, () => false)).toEqual(CANCELLED);
    gate.resolve(ENCRYPTED);
    expect(await older).toEqual(CANCELLED);
    expectNoWrites();
  });

  it.each([false, true])('new save during decryption prevents stale load (rotation=%s)', async (shouldReEncrypt) => {
    seed();
    const gate = pauseNext(h.decrypt);
    const pending = loadCredentials();
    await gate.entered;
    await saveCredentials('new-fixture-user', PASSWORD);
    gate.resolve({ shouldReEncrypt, result: PASSWORD });
    expect(await pending === null).toBe(true);
    expect(h.write.mock.calls.length).toBe(1);
    expect(JSON.parse(h.file!).user === 'new-fixture-user').toBe(true);
  });

  it.each([false, true])('a load started during a pending save is invalidated when it writes (rotation=%s)', async (shouldReEncrypt) => {
    seed();
    const encryption = pauseNext(h.encrypt);
    const saving = saveCredentials('new-fixture-user', PASSWORD);
    await encryption.entered;
    const decryption = pauseNext(h.decrypt);
    const loading = loadCredentials();
    await decryption.entered;
    encryption.resolve(ENCRYPTED);
    expect(await saving).toEqual({ ok: true, error: null });
    decryption.resolve({ shouldReEncrypt, result: PASSWORD });
    expect(await loading === null).toBe(true);
    expect(h.write.mock.calls.length).toBe(1);
    expect(JSON.parse(h.file!).user === 'new-fixture-user').toBe(true);
  });

  it('rotation finishing before a pending save does not cancel that save', async () => {
    seed();
    const encryption = pauseNext(h.encrypt);
    const saving = saveCredentials('new-fixture-user', PASSWORD);
    await encryption.entered;
    h.decrypt.mockResolvedValueOnce({ shouldReEncrypt: true, result: PASSWORD });
    expect(await loadCredentials() !== null).toBe(true);
    expect(h.write.mock.calls.length).toBe(1);
    encryption.resolve(ENCRYPTED);
    expect(await saving).toEqual({ ok: true, error: null });
    expect(h.write.mock.calls.length).toBe(2);
    expect(JSON.parse(h.file!).user === 'new-fixture-user').toBe(true);
  });

  it.each(['availability', 'encryption'] as const)('new save during rotation %s cannot be overwritten', async (stage) => {
    seed();
    h.decrypt.mockResolvedValueOnce({ shouldReEncrypt: true, result: PASSWORD });
    if (stage === 'availability') h.available.mockResolvedValueOnce(true);
    const availability = stage === 'availability' ? pauseNext(h.available) : null;
    const encryption = stage === 'encryption' ? pauseNext(h.encrypt) : null;
    const pending = loadCredentials();
    await (availability ?? encryption)!.entered;
    await saveCredentials('new-fixture-user', PASSWORD);
    availability?.resolve(true);
    encryption?.resolve(ENCRYPTED);
    expect(await pending === null).toBe(true);
    expect(h.write.mock.calls.length).toBe(1);
    expect(JSON.parse(h.file!).user === 'new-fixture-user').toBe(true);
  });

  it.each(['availability', 'encryption'] as const)('caller guard cancels during %s', async (stage) => {
    let current = true;
    const availability = stage === 'availability' ? pauseNext(h.available) : null;
    const encryption = stage === 'encryption' ? pauseNext(h.encrypt) : null;
    const pending = saveCredentials(USER, PASSWORD, () => current);
    await (availability ?? encryption)!.entered;
    current = false;
    availability?.resolve(true);
    encryption?.resolve(ENCRYPTED);
    expect(await pending).toEqual(CANCELLED);
    expectNoWrites();
    if (stage === 'availability') expect(h.encrypt.mock.calls.length).toBe(0);
  });

  it('accepts a current guard and fails closed when the guard throws', async () => {
    expect(await saveCredentials(USER, PASSWORD, () => true)).toEqual({ ok: true, error: null });
    h.write.mockClear();
    const result = await saveCredentials(USER, PASSWORD, () => { throw new Error(PASSWORD); });
    expect(result.ok).toBe(false);
    expect(result.error?.includes(PASSWORD)).toBe(false);
    expectNoWrites();
  });
});
