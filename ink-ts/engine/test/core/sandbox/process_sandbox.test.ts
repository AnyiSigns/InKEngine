/**
 * ProcessSandbox 单测——逐点对标 ink_engine/tests/test_sandbox.py 的进程节。
 *
 * 语义检查点：
 * - 守卫：非 exec 操作/命令不在白名单/裸命令名缺 PATH（含指引文案）拒绝；
 *   env.PATH 或 path 注入后裸命令名可过守卫；
 * - run：白名单 + 参数透传 + 干净环境（env 白名单外变量不进子进程）；
 *   PATH setdefault 只在 path 注入且 env 无 PATH 时生效；
 * - 输出截断（…（已截断）标记）；超时 kill 标记 timed_out（exit_code=-1）；
 * - 执行体全部经 SpawnSeam（core 零 IO），未注入 seam 的 run 拒绝。
 *
 * 延后用例（真实子进程 IO，宿主 seam 实弹回归）：test_process_run_* 的
 * sys.executable 真实执行（成功/超时 kill/输出截断/环境清理/白名单外拒
 * 绝）——本文件以内存 SpawnSeam 假体验证编排，真实 spawn 随宿主装配
 * （backend/cli）落地后对标。
 */
import { describe, expect, it } from 'vitest';

import { SandboxViolation } from '../../../src/core/errors.js';
import {
  ProcessResult,
  ProcessSandbox,
  type SpawnHandle,
  type SpawnSeam,
} from '../../../src/core/sandbox/index.js';
import { _truncate } from '../../../src/core/sandbox/process_sandbox.js';

const ABS_CMD = 'C:\\tools\\echo.exe';

/** 记录一次 spawn 调用的假体（真实 spawn 的纯逻辑替身）。 */
interface SpawnCall {
  command: string;
  args: readonly string[];
  cwd: string | null;
  env: Readonly<Record<string, string>>;
}

/** 可控子进程句柄假体：communicate 可挂起（等 kill 后放行/收尸）。 */
class FakeHandle implements SpawnHandle {
  readonly exit_code: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  hang_first = false;
  killed = false;
  private _calls = 0;

  constructor(options: {
    exit_code?: number | null;
    stdout?: Uint8Array;
    stderr?: Uint8Array;
    hang_first?: boolean;
  } = {}) {
    this.exit_code = options.exit_code ?? 0;
    this.stdout = options.stdout ?? new Uint8Array(0);
    this.stderr = options.stderr ?? new Uint8Array(0);
    this.hang_first = options.hang_first ?? false;
  }

  async communicate(): Promise<{ stdout: Uint8Array; stderr: Uint8Array }> {
    this._calls += 1;
    if (this.hang_first && this._calls === 1) {
      return await new Promise<{ stdout: Uint8Array; stderr: Uint8Array }>(() => {});
    }
    return { stdout: this.stdout, stderr: this.stderr };
  }

  kill(): void {
    this.killed = true;
  }
}

/** 内存 SpawnSeam 假体：记录调用并返回预置句柄。 */
class FakeSpawn implements SpawnSeam {
  readonly calls: SpawnCall[] = [];
  handle: FakeHandle | null = null;

  async spawn(
    command: string,
    args: readonly string[],
    options: { cwd: string | null; env: Readonly<Record<string, string>> },
  ): Promise<SpawnHandle> {
    this.calls.push({ command, args, cwd: options.cwd, env: options.env });
    return this.handle!;
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('ProcessSandbox.validate', () => {
  it('白名单命令（含分隔符）通过守卫', () => {
    const sb = new ProcessSandbox([ABS_CMD]);
    expect(sb.validate('exec', ABS_CMD)).toBeNull();
    expect(sb.guards_operation('exec')).toBe(true);
    expect(sb.guards_operation('write')).toBe(false);
  });

  it('命令不在白名单拒绝（fail-closed）', () => {
    const sb = new ProcessSandbox([ABS_CMD]);
    expect(() => sb.validate('exec', 'rm')).toThrow('命令不在白名单: rm');
  });

  it('非 exec 操作拒绝', () => {
    const sb = new ProcessSandbox([ABS_CMD]);
    expect(() => sb.validate('chmod', ABS_CMD)).toThrow('不支持的进程操作: chmod');
  });

  it('裸命令名 + 未注入 PATH 拒绝并给指引文案', () => {
    const sb = new ProcessSandbox(['git']);
    expect(() => sb.validate('exec', 'git')).toThrow(
      "命令 'git' 为裸命令名但未配置 PATH（ProcessSandbox.path 或 env.PATH）：请注入 PATH 或改用绝对路径",
    );
  });

  it('env.PATH 注入后裸命令名通过守卫', () => {
    const sb = new ProcessSandbox(['git'], 30, null, 100_000, { PATH: 'C:\\tools' });
    expect(sb.validate('exec', 'git')).toBeNull();
  });

  it('path 注入后裸命令名通过守卫', () => {
    const sb = new ProcessSandbox(['git'], 30, null, 100_000, null, 'C:\\tools');
    expect(sb.validate('exec', 'git')).toBeNull();
  });
});

describe('ProcessSandbox.run（注入 SpawnSeam）', () => {
  it('白名单命令成功执行：退出码 + 输出 + 干净环境', async () => {
    const spawn = new FakeSpawn();
    spawn.handle = new FakeHandle({ stdout: encode('hi\n') });
    const sb = new ProcessSandbox([ABS_CMD], 30, 'C:\\work', 100_000, null, null, spawn);
    const result = await sb.run(ABS_CMD, ['-c']);
    expect(result).toBeInstanceOf(ProcessResult);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('hi\n');
    expect(result.stderr).toBe('');
    expect(result.timed_out).toBe(false);
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]!.command).toBe(ABS_CMD);
    expect(spawn.calls[0]!.args).toEqual(['-c']);
    expect(spawn.calls[0]!.cwd).toBe('C:\\work');
    // env 白名单外变量不进子进程；未注入 path = 干净环境（无 PATH）
    expect(spawn.calls[0]!.env).toEqual({});
  });

  it('env 白名单透传 + path 注入经 setdefault 生效', async () => {
    const spawn = new FakeSpawn();
    spawn.handle = new FakeHandle({ stdout: encode('ok') });
    const sb = new ProcessSandbox(
      [ABS_CMD],
      30,
      null,
      100_000,
      { MARKER: 'ok' },
      'C:\\tools',
      spawn,
    );
    const result = await sb.run(ABS_CMD);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(spawn.calls[0]!.env).toEqual({ MARKER: 'ok', PATH: 'C:\\tools' });
  });

  it('非零退出码透传', async () => {
    const spawn = new FakeSpawn();
    spawn.handle = new FakeHandle({ exit_code: 3 });
    const sb = new ProcessSandbox([ABS_CMD], 30, null, 100_000, null, null, spawn);
    const result = await sb.run(ABS_CMD);
    expect(result.exit_code).toBe(3);
    expect(result.timed_out).toBe(false);
  });

  it('输出超限截断并带截断标记', async () => {
    const spawn = new FakeSpawn();
    spawn.handle = new FakeHandle({ stdout: encode('x'.repeat(100)) });
    const sb = new ProcessSandbox([ABS_CMD], 30, null, 10, null, null, spawn);
    const result = await sb.run(ABS_CMD);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('…（已截断）');
    expect(result.stdout.length).toBeLessThan(20);
    expect(_truncate(encode('abc'), 10)).toBe('abc');
  });

  it('命令不在白名单：守卫先行拒绝，不触达执行体', async () => {
    const spawn = new FakeSpawn();
    const sb = new ProcessSandbox([], 30, null, 100_000, null, null, spawn);
    await expect(sb.run(ABS_CMD)).rejects.toThrow(SandboxViolation);
    expect(spawn.calls).toHaveLength(0);
  });

  it('未注入 SpawnSeam 的 run 拒绝（执行体属宿主 seam）', async () => {
    const sb = new ProcessSandbox([ABS_CMD]);
    await expect(sb.run(ABS_CMD)).rejects.toThrow('spawner 未注入');
  });

  it('超时 kill：标记 timed_out 且退出码 -1', async () => {
    const spawn = new FakeSpawn();
    spawn.handle = new FakeHandle({ hang_first: true });
    const sb = new ProcessSandbox([ABS_CMD], 0.05, null, 100_000, null, null, spawn);
    const result = await sb.run(ABS_CMD);
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBe(-1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(spawn.handle!.killed).toBe(true);
  });
});
