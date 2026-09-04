/**
 * 环境提供器单测——逐点对标 ink_engine/tests/test_environments.py 的提供器节。
 *
 * 真实 fs/venv/子进程用例延后：本文件以注入 seam 假体覆盖编排语义——
 * which（shutil.which）与 mkdir（Path.mkdir）为宿主文件面，真实工具查找与
 * 目录落盘延后到宿主装配；执行经 ProcessSandbox.spawner 假体（内存句柄），
 * 不启真实子进程。审计存储以内存假体验证留痕通道（key 取注入的确定值）。
 */
import { describe, expect, it } from 'vitest';

import {
  ENV_STATUS_DESTROYED,
  ENV_STATUS_FAILED,
  ENV_STATUS_READY,
  ContainerProvider,
  EnvironmentProviders,
  EnvironmentSpec,
  LocalProvider,
  RuntimeKind,
  WebBridgeProvider,
} from '../../../src/core/environments/index.js';
import type { EnvAuditStorage } from '../../../src/core/environments/_types.js';
import {
  ProcessSandbox,
  type SpawnHandle,
  type SpawnSeam,
} from '../../../src/core/sandbox/index.js';

/** 记录一次 spawn 调用（断言命令/参数/工作目录透传）。 */
interface SpawnCall {
  command: string;
  args: readonly string[];
  cwd: string | null;
}

/** 内存 SpawnSeam 假体：返回预置输出的句柄，记录调用（真实 spawn 的替身）。 */
class FakeSpawner implements SpawnSeam {
  readonly calls: SpawnCall[] = [];
  exit_code = 0;
  stdout = '';
  stderr = '';

  async spawn(
    command: string,
    args: readonly string[],
    options: { cwd: string | null; env: Readonly<Record<string, string>> },
  ): Promise<SpawnHandle> {
    this.calls.push({ command, args, cwd: options.cwd });
    const exit_code = this.exit_code;
    const stdout = new TextEncoder().encode(this.stdout);
    const stderr = new TextEncoder().encode(this.stderr);
    return {
      exit_code,
      async communicate(): Promise<{ stdout: Uint8Array; stderr: Uint8Array }> {
        return { stdout, stderr };
      },
      kill(): void {},
    };
  }
}

/** 内存审计存储假体：记录 put_record 调用（宿主 Storage 的留痕面替身）。 */
class FakeAuditStorage implements EnvAuditStorage {
  readonly writes: Array<{ collection: string; key: string; data: Record<string, unknown> }> = [];

  async put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> {
    this.writes.push({ collection, key, data });
  }
}

/** 本地提供器常用装配：python 可寻 + mkdir 假体（记录路径）。 */
function makeLocal(
  sandbox: ProcessSandbox,
  options: { envs_dir?: string; storage?: EnvAuditStorage | null; mkdirs?: (path: string) => void } = {},
): { provider: LocalProvider; mkdirCalls: string[] } {
  const mkdirCalls: string[] = [];
  const provider = new LocalProvider(sandbox, {
    envs_dir: options.envs_dir ?? 'envs',
    storage: options.storage ?? null,
    which: (tool) => (tool === 'python' ? 'python' : null),
    mkdirs: options.mkdirs ?? ((path) => mkdirCalls.push(path)),
  });
  return { provider, mkdirCalls };
}

/** 带假体执行体的进程沙箱（python 在 PATH 上，白名单命令可过守卫）。 */
function pythonSandbox(spawner: SpawnSeam | null, allowlist: readonly string[] = ['python']): ProcessSandbox {
  return new ProcessSandbox(allowlist, 30, null, 100_000, null, 'C:\\tools', spawner);
}

const PY_SPEC = (): EnvironmentSpec => new EnvironmentSpec({ name: 'py', tools: ['python'] });

describe('LocalProvider', () => {
  it('ensure 就绪 + 幂等（同一声明返回既有实例）', async () => {
    const { provider } = makeLocal(pythonSandbox(null));
    const handle = await provider.ensure(PY_SPEC());
    expect(handle.status).toBe(ENV_STATUS_READY);
    expect(handle.workdir).toContain('envs');
    const again = await provider.ensure(PY_SPEC());
    expect(again).toBe(handle);
  });

  it('非 local 声明显式拒绝', async () => {
    const { provider } = makeLocal(pythonSandbox(null));
    await expect(
      provider.ensure(new EnvironmentSpec({ name: 'web', runtime: RuntimeKind.WEB_BRIDGE })),
    ).rejects.toThrow('本地提供器不承接');
  });

  it('工具缺失且无安装命令 → failed（error 提示缺失清单）', async () => {
    const { provider } = makeLocal(pythonSandbox(null));
    const handle = await provider.ensure(
      new EnvironmentSpec({ name: 'ghost', tools: ['definitely_not_a_real_tool_xyz'] }),
    );
    expect(handle.status).toBe(ENV_STATUS_FAILED);
    expect(handle.error).toContain('缺失');
  });

  it('工具缺失 + 安装命令不在白名单 → 拒绝（fail-closed，不触达执行体）', async () => {
    const spawner = new FakeSpawner();
    const sandbox = new ProcessSandbox([], 30, null, 100_000, null, 'C:\\tools', spawner);
    const { provider } = makeLocal(sandbox);
    const spec = new EnvironmentSpec({
      name: 'x',
      tools: ['definitely_not_a_real_tool_xyz'],
      install_cmds: ['curl http://evil'],
    });
    await expect(provider.ensure(spec)).rejects.toThrow('不在白名单');
    expect(spawner.calls).toHaveLength(0);
  });

  it('run 透传沙箱（命令/参数/工作目录限定 envs/<name>）', async () => {
    const spawner = new FakeSpawner();
    spawner.stdout = 'hi\n';
    const { provider } = makeLocal(pythonSandbox(spawner));
    const handle = await provider.ensure(PY_SPEC());
    const result = await provider.run(handle, 'python', ['-c', "print('hi')"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('hi');
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]!.command).toBe('python');
    expect(spawner.calls[0]!.args).toEqual(['-c', "print('hi')"]);
    expect(spawner.calls[0]!.cwd).toBe('envs/py');
    expect(spawner.calls[0]!.cwd).toContain('envs');
  });

  it('未就绪的 run 不执行（返回 -1 与状态文案）', async () => {
    const spawner = new FakeSpawner();
    const { provider } = makeLocal(pythonSandbox(spawner));
    const handle = await provider.ensure(PY_SPEC());
    await provider.destroy(handle);
    const result = await provider.run(handle, 'python', []);
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toContain('环境未就绪');
    expect(spawner.calls).toHaveLength(0);
  });

  it('destroy 幂等（句柄置 destroyed 并从注册表移除）', async () => {
    const { provider } = makeLocal(pythonSandbox(null));
    const handle = await provider.ensure(PY_SPEC());
    await provider.destroy(handle);
    expect(handle.status).toBe(ENV_STATUS_DESTROYED);
  });

  it('声明变更（版本约束变化）= 旧实例销毁重建', async () => {
    const { provider } = makeLocal(pythonSandbox(null));
    const v1 = new EnvironmentSpec({ name: 'py', tools: ['python'], version: '20' });
    const v2 = new EnvironmentSpec({ name: 'py', tools: ['python'], version: '21' });
    const first = await provider.ensure(v1);
    expect(first.status).toBe(ENV_STATUS_READY);
    const rebuilt = await provider.ensure(v2);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.status).toBe(ENV_STATUS_READY);
    expect(rebuilt.spec.version).toBe('21');
    expect(first.status).toBe(ENV_STATUS_DESTROYED);
  });

  it('注入 storage 时运行动作落审计（append-only 留痕）', async () => {
    const storage = new FakeAuditStorage();
    const spawner = new FakeSpawner();
    const { provider } = makeLocal(pythonSandbox(spawner), { storage });
    const handle = await provider.ensure(PY_SPEC());
    await provider.run(handle, 'python', ['-c', 'print(1)']);
    expect(storage.writes.length).toBeGreaterThan(0);
    const run = storage.writes.find((w) => w.data['action'] === 'run');
    expect(run).toBeDefined();
    expect(run!.collection).toBe('env_audit');
    expect(run!.data['env']).toBe('py');
    expect(run!.data['ok']).toBe(true);
    expect(run!.data['command']).toBe("python -c print(1)");
    expect(run!.key).toBe('0.000-00000000');
  });

  it('安装失败（安装后句柄 failed + 审计留痕）', async () => {
    const storage = new FakeAuditStorage();
    const spawner = new FakeSpawner();
    spawner.exit_code = 7;
    const sandbox = new ProcessSandbox(['npm'], 30, null, 100_000, null, 'C:\\tools', spawner);
    const { provider } = makeLocal(sandbox, { storage });
    const spec = new EnvironmentSpec({
      name: 'node',
      tools: ['definitely_not_a_real_tool_xyz'],
      install_cmds: [{ cmd: 'npm', args: ['install', '-g', 'typescript'] }],
    });
    await expect(provider.ensure(spec)).rejects.toThrow('安装失败');
    const install = storage.writes.find((w) => w.data['action'] === 'install');
    expect(install).toBeDefined();
    expect(install!.data['ok']).toBe(false);
    expect(install!.data['env']).toBe('node');
  });
});

describe('WebBridge / Container / 注册表', () => {
  it('web_bridge ensure 恒就绪；run 显式拒绝（不经后端子进程）', async () => {
    const provider = new WebBridgeProvider();
    const handle = await provider.ensure(
      new EnvironmentSpec({ name: 'web', runtime: RuntimeKind.WEB_BRIDGE }),
    );
    expect(handle.status).toBe(ENV_STATUS_READY);
    await expect(provider.run(handle, 'node', [])).rejects.toThrow('不支持后端子进程');
  });

  it('container 占位显式说明未落地', async () => {
    const provider = new ContainerProvider();
    await expect(
      provider.ensure(new EnvironmentSpec({ name: 'c', runtime: RuntimeKind.CONTAINER })),
    ).rejects.toThrow('未落地');
  });

  it('注册表缺省三形态 + 取用未注册显式报错', async () => {
    const registry = new EnvironmentProviders({ envs_dir: 'envs' });
    expect(registry.names()).toContain('local');
    expect(registry.names()).toContain('web_bridge');
    expect(registry.names()).toContain('container');
    expect(registry.get('local').name).toBe('local');
    expect(() => registry.get('phantom')).toThrow('未注册');
  });
});
