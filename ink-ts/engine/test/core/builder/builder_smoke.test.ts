/**
 * Builder 冒烟门禁与统一上线入口单测——逐点对标 ink_engine/tests/
 * test_builder.py 的冒烟/构建+冒烟节；构建守卫与内容寻址见
 * builder_pipeline.test.ts。共享内存假体在 _fixtures.ts（双文件 ≤350 行）。
 *
 * 语义检查点：
 * - 冒烟门禁：通过/失败/白名单外探针拒绝（fail-closed，不触达执行体）；
 * - 探针工作目录 = 产物目录（probe 在产物上下文中运行）；
 * - build_and_verify = 构建 + 冒烟强制门禁统一上线入口（冒烟失败整体
 *   BuildError，产物目录保留供排查、不产出自称成功的记录）。
 *
 * 执行体 seam 化说明：冒烟子进程经 ProcessSandbox 的 SpawnSeam（内存假体
 * 验证编排）；文件动作经 BuildFs seam（内存假体，产物产出以 on_spawn 模拟）。
 *
 * 延后用例（真实子进程 IO，宿主 seam 实弹回归）：test_smoke_* 的 python
 * 真实执行（成功/超时 kill/冒烟启动）——真实 spawn 与真实 fs 随宿主装配
 * （host/cli）落地后对标，本文件不触碰真实进程/磁盘。
 */
import { describe, expect, it } from 'vitest';

import { BuildError, BuildKind, SmokeProbe } from '../../../src/core/builder/index.js';
import { BUILD_CMD, buildSpec, FakeFs, FakeSpawn, makeBuilder } from './_fixtures.js';

describe('Builder 冒烟门禁', () => {
  it('通过/失败/白名单外探针拒绝', async () => {
    const fs = new FakeFs();
    fs.add_dir('C:\\ws\\build_dir');
    const spawn = new FakeSpawn();
    spawn.on_spawn = (cwd) => {
      fs.write_file(`${cwd}\\run.py`, 'print(1)\n');
    };
    spawn.script = (command, args) => {
      if (args[0] === 'run.py') return { exit_code: 0, stdout: '1\n' };
      if (args[1] !== undefined && args[1].includes('SystemExit')) return { exit_code: 3 };
      return { exit_code: 0 };
    };
    const builder = makeBuilder(spawn, fs);
    const spec = buildSpec({
      workdir: 'C:\\ws\\build_dir',
      args: ['-c', 'build'],
      output_paths: ['run.py'],
    });
    const artifact = await builder.build(spec);

    const ok = await builder.smoke(
      artifact,
      new SmokeProbe({ command: BUILD_CMD, args: ['run.py'], timeout: 10.0 }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.output).toBe('1\n');
    expect(ok.exit_code).toBe(0);
    // 探针工作目录 = 产物目录（产物上下文内执行）
    expect(spawn.calls[1]!.cwd).toBe(builder.artifact_dir(artifact));

    const failed = await builder.smoke(
      artifact,
      new SmokeProbe({
        command: BUILD_CMD,
        args: ['-c', 'raise SystemExit(3)'],
        expect_exit: 0,
      }),
    );
    expect(failed.ok).toBe(false);
    expect(failed.exit_code).toBe(3);

    const blocked = await builder.smoke(
      artifact,
      new SmokeProbe({ command: 'malicious_probe' }),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.output).toBe('冒烟命令不在白名单（fail-closed）');
    // 白名单外探针不触达执行体（build + 通过 + 失败 共 3 次调用后无新增）
    expect(spawn.calls).toHaveLength(3);
  });
});

describe('Builder.build_and_verify（统一上线入口）', () => {
  it('冒烟通过返回可 promote 产物；冒烟失败整体 BuildError', async () => {
    const fs = new FakeFs();
    fs.add_dir('C:\\ws\\build_dir');
    fs.write_file('C:\\ws\\build_dir\\main.py', "print('hello')\n");
    const spawn = new FakeSpawn();
    spawn.script = (command, args) => {
      if (args[1] !== undefined && args[1].includes('sys.exit')) return { exit_code: 3 };
      return { exit_code: 0 };
    };
    const builder = makeBuilder(spawn, fs);
    const spec = buildSpec({
      kind: BuildKind.PYTHON_PACKAGE,
      workdir: 'C:\\ws\\build_dir',
      args: ['-c', "print('built')"],
      timeout: 30.0,
      output_paths: ['main.py'],
    });

    const artifact = await builder.build_and_verify(
      spec,
      new SmokeProbe({ command: BUILD_CMD, args: ['-c', "print('ok')"], timeout: 30.0 }),
    );
    expect(artifact.artifact_id).toMatch(/^python_package-/);

    await expect(
      builder.build_and_verify(
        spec,
        new SmokeProbe({
          command: BUILD_CMD,
          args: ['-c', 'import sys; sys.exit(3)'],
          timeout: 30.0,
        }),
      ),
    ).rejects.toThrow(BuildError);
    await expect(
      builder.build_and_verify(
        spec,
        new SmokeProbe({
          command: BUILD_CMD,
          args: ['-c', 'import sys; sys.exit(3)'],
          timeout: 30.0,
        }),
      ),
    ).rejects.toThrow('冒烟未通过（exit=3，期望 0）');
  });
});
