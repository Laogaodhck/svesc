/**
 * 更新能力判定与错误文案回归锁（纯 Node）。
 * 重点：便携版/开发态/冒烟绝不能被误判为可更新；底层错误必须翻译成可执行提示。
 */
import { describe, expect, it } from 'vitest';
import {
  clampPercent,
  isPortableBuild,
  normalizeUpdateError,
  resolveUpdateSupport,
} from '../src/main/engine/update-policy';

describe('resolveUpdateSupport', () => {
  it('冒烟模式优先拒绝，即使已打包且非便携', () => {
    expect(
      resolveUpdateSupport({ isPackaged: true, isSmoke: true, env: {} }),
    ).toEqual({ supported: false, reason: '冒烟检查模式不执行更新' });
  });

  it('开发态拒绝：未打包的 electron.exe 没有 app-update.yml', () => {
    const res = resolveUpdateSupport({ isPackaged: false, isSmoke: false, env: {} });
    expect(res.supported).toBe(false);
    expect(res.reason).toContain('开发模式');
  });

  it('便携版拒绝：自解压目录无法就地替换', () => {
    const res = resolveUpdateSupport({
      isPackaged: true,
      isSmoke: false,
      env: { PORTABLE_EXECUTABLE_FILE: 'E:\\SVESC-Portable-0.4.0.exe' },
    });
    expect(res.supported).toBe(false);
    expect(res.reason).toContain('便携版');
  });

  it('安装版放行', () => {
    expect(resolveUpdateSupport({ isPackaged: true, isSmoke: false, env: {} })).toEqual({
      supported: true,
      reason: null,
    });
  });
});

describe('isPortableBuild', () => {
  it('三个 electron-builder portable 环境变量任一命中即视为便携版', () => {
    expect(isPortableBuild({})).toBe(false);
    expect(isPortableBuild({ PORTABLE_EXECUTABLE_FILE: 'x.exe' })).toBe(true);
    expect(isPortableBuild({ PORTABLE_EXECUTABLE_DIR: 'C:\\Temp' })).toBe(true);
    expect(isPortableBuild({ PORTABLE_EXECUTABLE_APP_FILENAME: 'SVESC-LAN-Monitor.exe' })).toBe(true);
  });
});

describe('normalizeUpdateError', () => {
  it('缺少 latest.yml / 404 → 提示发布侧缺文件', () => {
    expect(normalizeUpdateError(new Error('HttpError: 404 Not Found'))).toContain('latest.yml');
    expect(normalizeUpdateError('Cannot find latest.yml in the latest release')).toContain('latest.yml');
  });

  it('缺少 app-update.yml → 提示改用安装版', () => {
    expect(normalizeUpdateError(new Error('ENOENT: app-update.yml'))).toContain('app-update.yml');
  });

  it('校验失败 → 建议重试或手动核对', () => {
    expect(normalizeUpdateError(new Error('sha512 checksum mismatch'))).toContain('校验失败');
  });

  it('磁盘/权限/网络分别给出可执行提示', () => {
    expect(normalizeUpdateError(new Error('ENOSPC: no space left'))).toContain('磁盘空间不足');
    expect(normalizeUpdateError(new Error('EACCES: permission denied'))).toContain('权限');
    expect(normalizeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toContain('网络连接失败');
    expect(normalizeUpdateError(new Error('getaddrinfo ENOTFOUND api.github.com'))).toContain('网络连接失败');
  });

  it('未知错误保留原始信息（截断），空错误不空白', () => {
    expect(normalizeUpdateError(new Error('boom'))).toBe('更新失败：boom');
    expect(normalizeUpdateError('')).toBe('更新失败（没有返回错误信息）');
    const long = normalizeUpdateError(new Error('x'.repeat(400)));
    expect(long.length).toBeLessThan(200);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('clampPercent', () => {
  it('非法值归零，范围夹紧并保留一位小数', () => {
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(42.34)).toBe(42.3);
    expect(clampPercent(100.04)).toBe(100);
    expect(clampPercent(140)).toBe(100);
  });
});
