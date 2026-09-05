/**
 * Builder 构建管线单测——本机构建守卫/产物内容寻址节，逐点对标
 * ink_engine/tests/test_builder.py；冒烟门禁与 build_and_verify 见
 * builder_smoke.test.ts。共享内存假体在 _fixtures.ts（双文件 ≤350 行）。
 *
 * 语义检查点：
 * - 白名单外命令拒绝（fail-closed，不触达执行体）；
 * - 产物缺失/构建失败（exit≠0）→ BuildError（保留现状，无半成品记录）；
 * - 产物内容寻址：文件级 sha256 hex + kind-前缀 artifact_id；同内容幂等；
 * - 产物路径越界（绝对路径/.. 片段）拒绝；
 * - 文件级哈希校验（verify_hash）；产物目录可定位；
 * - 时间 seam 确定性：built_at 经注入 clock 取 epoch 秒。
 *
 * 执行体 seam 化说明：构建子进程经 ProcessSandbox 的 SpawnSeam（内存假体
 * 验证编排）；文件动作经 BuildFs seam（内存假体，产物产出以 on_spawn 模拟）。
 *
 * 延后用例（真实子进程 IO，宿主 seam 实弹回归）：test_build_* 的 python
 * 真实执行（成功/超时 kill/产物产出）——真实 spawn 与真实 fs 随宿主装配
 * （host/cli）落地后对标，本文件不触碰真实进程/磁盘。
 */
import { describe, expect, it } from 'vitest';

import { BuildError, BuildKind, BuildSpec } from '../../../src/core/builder/index.js';
import { sha256_hex } from '../../../src/core/builder/_sha256.js';
import {
  BUILD_CMD,
  buildSpec,
  encode,
  FakeFs,
  FakeSpawn,
  makeBuilder,
  sha256Text,
} from './_fixtures.js';

describe('_sha256（纯 TS 实现与 node:crypto 对标）', () => {
  it('已知输入摘要一致（含空串/跨块长输入）', () => {
    for (const text of ['', 'abc', 'hello\n', 'x'.repeat(1000), '构建内容'.repeat(50)]) {
      expect(sha256_hex(encode(text))).toBe(sha256Text(text));
    }
    expect(sha256_hex(encode(''))).toHaveLength(64);
  });
});

describe('Builder 构建（fail-closed 守卫）', () => {
  it('构建命令不在白名单：显式拒绝，不触达执行体', async () => {
    const fs = new FakeFs();
    const spawn = new FakeSpawn();
    const builder = makeBuilder(spawn, fs);
    const spec = new BuildSpec({
      kind: BuildKind.SERVICE,
      command: 'evil_installer',
      workdir: '.',
      output_paths: ['x.py'],
    });
    await expect(builder.build(spec)).rejects.toThrow(BuildError);
    await expect(builder.build(spec)).rejects.toThrow('不在白名单');
    expect(spawn.calls).toHaveLength(0);
  });

  it('构建失败（exit≠0）：抛 BuildError，不产出半成品记录', async () => {
    const fs = new FakeFs();
    fs.add_dir('C:\\ws\\build_dir');
    const spawn = new FakeSpawn();
    spawn.script = () => ({ exit_code: 7, stderr: 'boom' });
    const builder = makeBuilder(spawn, fs);
    const spec = buildSpec({ workdir: 'C:\\ws\\build_dir', output_paths: ['x.txt'] });
    await expect(builder.build(spec)).rejects.toThrow('构建失败');
    await expect(builder.build(spec)).rejects.toThrow('exit=7');
  });

  it('产物缺失：命令成功后未产出声明文件 = 构建失败', async () => {
    const fs = new FakeFs();
    fs.add_dir('C:\\ws\\build_dir');
    const spawn = new FakeSpawn();
    const builder = makeBuilder(spawn, fs);
    const spec = buildSpec({ workdir: 'C:\\ws\\build_dir', output_paths: ['dist.js'] });
    await expect(builder.build(spec)).rejects.toThrow('产物缺失');
    expect(spawn.calls).toHaveLength(1);
  });

  it('构建工作目录不存在：显式拒绝', async () => {
    const fs = new FakeFs();
    const spawn = new FakeSpawn();
    const builder = makeBuilder(spawn, fs);
    const spec = buildSpec({ workdir: 'C:\\ws\\no_such_dir', output_paths: ['x.js'] });
    await expect(builder.build(spec)).rejects.toThrow('构建工作目录不存在');
    expect(spawn.calls).toHaveLength(0);
  });
});

describe('Builder 产物内容寻址与哈希', () => {
  it('构建成功：文件级哈希 + 内容寻址 artifact_id + 产物落目录', async () => {
    const fs = new FakeFs();
    fs.add_dir('C:\\ws\\build_dir');
    fs.write_file('C:\\ws\\build_dir\\app.py', "print('hello')\n");
    const spawn = new FakeSpawn();
    spawn.on_spawn = (cwd) => {
      fs.write_file(`${cwd}\\out.txt`, 'ok');
    };
    const now = () => 123.5;
    const builder = makeBuilder(spawn, fs, now);
    const spec = buildSpec({
      kind: BuildKind.PYTHON_PACKAGE,
      workdir: 'C:\\ws\\build_dir',
      args: ['-c', "print('built')"],
      output_paths: ['app.py', 'out.txt'],
    });
    const artifact = await builder.build(spec);

    expect(artifact.kind).toBe(BuildKind.PYTHON_PACKAGE);
    expect(artifact.artifact_id).toMatch(/^python_package-[0-9a-f]{16}$/);
    const app_hash = artifact.files['app.py']!;
    const out_hash = artifact.files['out.txt']!;
    expect(app_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(app_hash).toBe(sha256Text("print('hello')\n"));
    expect(out_hash).toBe(sha256Text('ok'));
    // 内容寻址：artifact_id = kind + 文件内容哈希（按摘要排序拼接）前缀
    const content = sha256Text([app_hash, out_hash].sort().join(''));
    expect(artifact.artifact_id).toBe(`python_package-${content.slice(0, 16)}`);
    expect(artifact.built_at).toBe(123.5);

    // 文件级哈希校验（部署/回退前门禁）
    expect(builder.verify_hash(artifact, 'app.py', app_hash)).toBe(true);
    expect(builder.verify_hash(artifact, 'app.py', '0'.repeat(64))).toBe(false);
    expect(builder.verify_hash(artifact, 'missing.py', app_hash)).toBe(false);
    // 产物目录存在且可定位
    const dir = builder.artifact_dir(artifact);
    expect(dir).toBe(`C:\\ws\\artifacts\\${artifact.artifact_id}`);
    expect(fs.is_dir(dir)).toBe(true);
    expect(fs.text(`${dir}\\app.py`)).toBe("print('hello')\n");
    // 沙箱代执行：cwd = 解析后的构建目录，参数透传
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]!.command).toBe(BUILD_CMD);
    expect(spawn.calls[0]!.args).toEqual(['-c', "print('built')"]);
    expect(spawn.calls[0]!.cwd).toBe('C:\\ws\\build_dir');
  });

  it('同内容幂等：内容寻址 = 同内容同 artifact_id', async () => {
    const fs = new FakeFs();
    fs.add_dir('C:\\ws\\build_dir');
    const spawn = new FakeSpawn();
    spawn.on_spawn = (cwd) => {
      fs.write_file(`${cwd}\\a.txt`, 'same');
    };
    const builder = makeBuilder(spawn, fs);
    const spec = buildSpec({
      workdir: 'C:\\ws\\build_dir',
      output_paths: ['a.txt'],
    });
    const first = await builder.build(spec);
    const second = await builder.build(spec);
    expect(first.artifact_id).toBe(second.artifact_id);
    expect(first.files['a.txt']).toBe(sha256Text('same'));
  });

  it('产物路径越界（绝对路径/..）拒绝', async () => {
    const fs = new FakeFs();
    fs.add_dir('C:\\ws\\build_dir');
    const spawn = new FakeSpawn();
    const builder = makeBuilder(spawn, fs);
    for (const bad of ['C:\\evil.txt', '..\\evil.txt', 'dist\\..\\x.txt']) {
      const spec = buildSpec({ workdir: 'C:\\ws\\build_dir', output_paths: [bad] });
      await expect(builder.build(spec)).rejects.toThrow('产物路径越界');
    }
  });
});
