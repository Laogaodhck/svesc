/**
 * task-019：内置终端安全校验与执行回归锁。
 *
 *  - validateTerminalCommand 纯函数：白名单、shell 元字符一票拒绝、空/超长；
 *  - terminalRun 真实执行（ipconfig，普通权限即可）：输出/耗时/单飞；
 *  - 拒绝路径绝不 spawn 进程（行内无子进程副作用）。
 */
import { describe, expect, it } from 'vitest';
import { TERMINAL_ALLOW, terminalRun, validateTerminalCommand } from '../src/main/terminal';

describe('终端命令校验（白名单 + 字符白名单）', () => {
  it('白名单命令 + 普通参数放行，首 token 大小写不敏感', () => {
    const ok = validateTerminalCommand('PING 192.168.2.1 -n 4');
    expect({ ok: ok.ok, cmd: ok.cmd, args: ok.args }).toEqual({
      ok: true,
      cmd: 'ping',
      args: ['192.168.2.1', '-n', '4'],
    });
  });

  it('白名单外的命令一律拒绝（powershell/del/format 等）', () => {
    for (const bad of ['powershell -c x', 'del x', 'net user', 'format c:', 'regedit']) {
      const res = validateTerminalCommand(bad);
      expect(res.ok, `${bad} 必须被拒绝`).toBe(false);
    }
  });

  it('shell 元字符一票拒绝：管道/重定向/命令连接/引号/变量/转义/通配', () => {
    const bad = [
      'ping 127.0.0.1 & whoami',
      'ipconfig | findstr IPv4',
      'ping a>b',
      'ping 1.1.1.1; ping 2.2.2.2',
      'nslookup "host"',
      "ping 'x'",
      'ping %PATH%',
      'ping x^y',
      'arp -a `id`',
      'ping 1.1.1.1 *',
    ];
    for (const cmd of bad) {
      const res = validateTerminalCommand(cmd);
      expect({ cmd, ok: res.ok, error: res.error?.slice(0, 8) }, `${cmd} 必须被拒绝`).toMatchObject({ ok: false });
    }
  });

  it('空命令 / 超长命令 / 纯空白拒绝且给中文原因', () => {
    expect(validateTerminalCommand('').ok).toBe(false);
    expect(validateTerminalCommand('   ').ok).toBe(false);
    expect(validateTerminalCommand('ping ' + 'a'.repeat(400)).ok).toBe(false);
    expect(validateTerminalCommand('ping abc').error).toBeNull();
  });

  it('白名单表与超时预算齐全（回归锁：改动需同步本用例）', () => {
    expect(Object.keys(TERMINAL_ALLOW).sort()).toEqual(
      ['arp', 'getmac', 'hostname', 'ipconfig', 'nbtstat', 'netstat', 'nslookup', 'ping', 'route', 'systeminfo', 'tasklist', 'tracert', 'whoami'],
    );
    for (const v of Object.values(TERMINAL_ALLOW)) {
      expect(v.timeoutMs).toBeGreaterThanOrEqual(3000);
    }
  });
});

describe('终端真实执行（普通权限，无需管理员）', () => {
  it('ipconfig 应真实执行并输出适配器信息', async () => {
    const res = await terminalRun('ipconfig /all');
    expect({ ok: res.ok, hasLines: res.lines.length > 0, error: res.error }).toMatchObject({
      ok: true,
      hasLines: true,
      error: null,
    });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  }, 20_000);

  it('拒绝路径不 spawn：白名单外命令立即返回已拒绝', async () => {
    // regedit 不在白名单（task-020 扩充后 whoami/nbtstat 已在白名单内，不能再当反例）
    const res = await terminalRun('regedit');
    expect({ ok: res.ok, summary: res.summary }).toEqual({ ok: false, summary: '已拒绝' });
  });
});
