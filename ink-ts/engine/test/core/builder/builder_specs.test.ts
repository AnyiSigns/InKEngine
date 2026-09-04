/**
 * BuildSpec / BuildArtifact 声明序列化单测——逐点对标
 * ink_engine/tests/test_builder.py 的 roundtrip/非法拒绝节。
 *
 * 语义检查点：
 * - BuildSpec to_dict/from_dict 往返等值（kind 值面/args/env/output_paths/
 *   meta 条件序列化与缺省还原）；
 * - 非法拒绝（GraphDefinitionError）：类别非法/缺 command/负超时/清单项
 *   非空字符串/env·meta 非 dict；
 * - BuildArtifact to_dict/from_dict 往返 + 缺 artifact_id 拒绝。
 */
import { describe, expect, it } from 'vitest';

import { BuildArtifact, BuildKind, BuildSpec } from '../../../src/core/builder/index.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';

describe('BuildSpec 序列化', () => {
  it('roundtrip：to_dict → from_dict 等值还原', () => {
    const spec = new BuildSpec({
      kind: BuildKind.JS_BUNDLE,
      command: 'npm',
      args: ['run', 'build'],
      workdir: 'frontend',
      timeout: 60.0,
      output_paths: ['dist/index.js'],
      meta: { source: 'ai_generated' },
    });
    const restored = BuildSpec.from_dict(spec.to_dict());
    expect(restored.kind).toBe(BuildKind.JS_BUNDLE);
    expect(restored.to_dict()).toEqual(spec.to_dict());
    expect(restored.args).toEqual(['run', 'build']);
    expect(restored.timeout).toBe(60.0);
  });

  it('缺省字段往返：args/env/output_paths/meta 空则不入 dict', () => {
    const spec = new BuildSpec({
      kind: BuildKind.SERVICE,
      command: 'x',
      workdir: 'C:\\ws',
    });
    const data = spec.to_dict();
    expect(data['args']).toBeUndefined();
    expect(data['env']).toBeUndefined();
    expect(data['output_paths']).toBeUndefined();
    expect(data['meta']).toBeUndefined();
    const restored = BuildSpec.from_dict(data);
    expect(restored.args).toEqual([]);
    expect(restored.env).toBeNull();
    expect(restored.output_paths).toEqual([]);
    expect(restored.meta).toEqual({});
    expect(restored.workdir).toBe('C:\\ws');
    expect(restored.timeout).toBe(120.0);
  });

  it('非法拒绝：类别非法', () => {
    expect(() => BuildSpec.from_dict({ command: 'npm' })).toThrow(GraphDefinitionError);
    expect(() => BuildSpec.from_dict({ command: 'npm' })).toThrow('类别非法');
    expect(() => BuildSpec.from_dict({ command: 'npm', kind: 'swift_package' })).toThrow('类别非法');
  });

  it('非法拒绝：缺 command（白名单命令）', () => {
    expect(() => new BuildSpec({ kind: BuildKind.SERVICE, command: '' })).toThrow(
      GraphDefinitionError,
    );
    expect(() => new BuildSpec({ kind: BuildKind.SERVICE, command: '' })).toThrow('command');
    expect(() => BuildSpec.from_dict({ kind: 'service' })).toThrow('构建声明缺 command');
  });

  it('非法拒绝：超时须为正数', () => {
    expect(() => new BuildSpec({ kind: BuildKind.SERVICE, command: 'x', timeout: -1 })).toThrow(
      '超时',
    );
    expect(() => new BuildSpec({ kind: BuildKind.SERVICE, command: 'x', timeout: 0 })).toThrow(
      '超时须为正数',
    );
  });

  it('非法拒绝：args/output_paths 须为非空字符串清单，env/meta 须为 dict', () => {
    expect(
      () => BuildSpec.from_dict({ kind: 'service', command: 'x', args: ['ok', ''] }),
    ).toThrow('args 须为非空字符串清单');
    expect(
      () => BuildSpec.from_dict({ kind: 'service', command: 'x', output_paths: 'dist.js' }),
    ).toThrow('output_paths 须为非空字符串清单');
    expect(
      () => BuildSpec.from_dict({ kind: 'service', command: 'x', env: ['PATH=1'] }),
    ).toThrow('env 须为 dict');
    expect(
      () => BuildSpec.from_dict({ kind: 'service', command: 'x', meta: ['m'] }),
    ).toThrow('meta 须为 dict');
    expect(
      () => new BuildSpec({ kind: BuildKind.SERVICE, command: 'x', output_paths: [''] }),
    ).toThrow('output_paths 须为非空相对路径清单');
  });
});

describe('BuildArtifact 序列化', () => {
  it('roundtrip：to_dict → from_dict 等值还原', () => {
    const artifact = new BuildArtifact({
      artifact_id: 'svc-a1',
      kind: 'service',
      files: { 'run.py': 'a'.repeat(64) },
      built_at: 1.5,
      meta: { spec: { command: 'python' } },
    });
    const restored = BuildArtifact.from_dict(artifact.to_dict());
    expect(restored.to_dict()).toEqual(artifact.to_dict());
    expect(restored.files['run.py']).toBe('a'.repeat(64));
  });

  it('非法拒绝：缺 artifact_id / kind / files', () => {
    expect(() => BuildArtifact.from_dict({ kind: 'x' })).toThrow(GraphDefinitionError);
    expect(() => BuildArtifact.from_dict({ kind: 'x' })).toThrow('artifact_id');
    expect(() => BuildArtifact.from_dict({ artifact_id: 'a1' })).toThrow('kind');
    expect(
      () => BuildArtifact.from_dict({ artifact_id: 'a1', kind: 'x', files: ['f'] }),
    ).toThrow('files 须为文件 → 哈希 dict');
  });
});
