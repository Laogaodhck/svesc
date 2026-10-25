/**
 * R-05 exec 兜底 settle（`src/main/engine/exec.ts`）
 *
 * 现状缺陷：超时定时器只 `child.kill()`，**不 settle Promise**。若子进程被 kill 后
 * 仍不派发 `close`（Windows 上被强杀的子进程、被 shim 转手的 exe、句柄卡住的 powershell
 * 都可能这样），Promise 会永久 pending → `childGate.release()` 永不执行 → **闸门永久占用**，
 * 之后所有 arp/ping/netstat 调用排在队列里静默卡死，引擎表现为"界面不动、什么也不报"。
 *
 * 注入方式：`vi.mock('node:child_process')` 换掉 spawn + fake timers，不真起进程、不真等超时。
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// 必须在 vi.mock 之后导入（模块图里 exec 拿到的才是替身 spawn）
import { runNative, runPowerShell } from '../src/main/engine/exec';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killCalls = 0;

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }
}

function useChild(child: FakeChild): FakeChild {
  spawnMock.mockReturnValueOnce(child);
  return child;
}

beforeEach(() => {
  vi.useFakeTimers();
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('R-05. 子进程永不派发 close 时必须兜底 settle', () => {
  it('超时后 Promise 必须在 ~500ms 内 settle（不得永久 pending）', async () => {
    const child = useChild(new FakeChild());
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    const promise = runNative('ping', ['-n', '1', '192.168.2.9'], 'gbk', 500);
    void promise.then(
      () => {
        outcome = 'resolved';
      },
      () => {
        outcome = 'rejected';
      },
    );

    await vi.advanceTimersByTimeAsync(600);

    expect(
      outcome,
      '只 kill 不 settle 会让 Promise 永久 pending，childGate 永不 release（后续所有 arp/ping 静默卡死）',
    ).not.toBe('pending');
    expect(child.killCalls, '超时必须 kill 子进程').toBe(1);
  });

  it('兜底 settle 后 PowerShell 闸门必须释放：紧接着的下一个任务要能被调度执行', async () => {
    // powershellGate 上限是 1：第一个任务若泄漏闸门，第二个永远拿不到令牌
    useChild(new FakeChild());
    const first = runPowerShell('Get-Date', 500);
    void first.catch(() => {
      /* 兜底可能 reject，这里吞掉避免 unhandled */
    });

    await vi.advanceTimersByTimeAsync(600);

    const secondChild = useChild(new FakeChild());
    let secondDone = false;
    const second = runPowerShell('Get-Date', 500).then((result) => {
      secondDone = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1);

    // 闸门已释放的直接证据：第二个任务真的被调度、真的 spawn 出来了
    // （若第一个任务泄漏 powershellGate，这里连第二次 spawn 都不会发生）
    expect(
      spawnMock,
      '第二次调用必须真的启动子进程（第一个任务泄漏了 powershellGate 时，第二个任务连 spawn 都轮不到、排队静默卡死）',
    ).toHaveBeenCalledTimes(2);

    // secondDone 依赖第二个子进程的正常收尾：close 派发后 Promise 才可能 fulfill。
    // （原断言位于 close 派发之前，等价于要求"无任何完成事件时任务已完成"，逻辑上不可能满足）
    secondChild.emit('close', 0);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(secondDone, '第二个任务必须真正执行完毕（闸门释放后全链路畅通）').toBe(true);
  });

  it('正常关闭后不得再被超时 kill（定时器必须随 settle 清除）', async () => {
    const child = useChild(new FakeChild());
    let count = 0;
    const promise = runNative('arp', ['-a'], 'gbk', 500).then((result) => {
      count += 1;
      return result;
    });

    await vi.advanceTimersByTimeAsync(400);
    child.emit('close', 0);
    await vi.advanceTimersByTimeAsync(200);

    expect(child.killCalls, '已完成的任务不得在其后被超时定时器补一刀').toBe(0);
    const result = await promise;
    expect({ count, timedOut: result.timedOut }).toEqual({ count: 1, timedOut: false });
  });

  it('close 与兜底都到达时只 settle 一次（不得双触发导致 unhandled rejection）', async () => {
    const child = useChild(new FakeChild());
    let settledTimes = 0;
    const promise = runNative('netstat', ['-e'], 'gbk', 500).then(
      () => {
        settledTimes += 1;
      },
      () => {
        settledTimes += 1;
      },
    );

    await vi.advanceTimersByTimeAsync(500); // 兜底到点
    child.emit('close', 0); // 迟到（已被 kill 的进程随后才派发 close）
    child.emit('error', Object.assign(new Error('late'), { code: 'ESRCH' }));
    await vi.advanceTimersByTimeAsync(10);
    await promise;

    expect(settledTimes, '兜底与 close 必须幂等，只允许 settle 一次').toBe(1);
  });
});
