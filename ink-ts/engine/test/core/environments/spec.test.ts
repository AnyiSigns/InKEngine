/**
 * EnvironmentSpec / 安装命令条目 单测——逐点对标 ink_engine/tests/
 * test_environments.py 的声明节（串行化往返/非法声明拒绝/结构化命令形态）。
 *
 * 纯数据与纯词法面（无真实进程/文件系统）：install_cmds 字符串形态的 shlex
 * 分词在本层单测覆盖（引号参数不裂开、结构化形态直取）；真实 fs/venv/子进程
 * 用例在 providers.test.ts 以注入 seam 假体覆盖（见该文件头注）。
 */
import { describe, expect, it } from 'vitest';

import {
  EnvironmentSpec,
  RuntimeKind,
} from '../../../src/core/environments/index.js';
import type { InstallCmd } from '../../../src/core/environments/install_cmd.js';
import {
  displayInstallCmd,
  parseInstallCmd,
  validateInstallCmd,
} from '../../../src/core/environments/install_cmd.js';
import { shlex_split } from '../../../src/core/environments/_shlex.js';

describe('EnvironmentSpec 序列化', () => {
  it('to_dict/from_dict 往返还原（值相等）', () => {
    const spec = new EnvironmentSpec({
      name: 'node_env',
      runtime: RuntimeKind.LOCAL,
      tools: ['node', 'npm'],
      install_cmds: ['npm install -g pkg'],
      version: '20',
      meta: { source: 'boot' },
    });
    const restored = EnvironmentSpec.from_dict(spec.to_dict());
    expect(restored.equals(spec)).toBe(true);
    expect(restored.runtime).toBe(RuntimeKind.LOCAL);
  });

  it('缺省字段省略 + runtime 缺省回落 local', () => {
    const spec = new EnvironmentSpec({ name: 'bare' });
    expect(spec.to_dict()).toEqual({ name: 'bare', runtime: 'local' });
    const restored = EnvironmentSpec.from_dict({ name: 'bare' });
    expect(restored.runtime).toBe(RuntimeKind.LOCAL);
    expect(restored.equals(spec)).toBe(true);
  });

  it('非法声明拒绝（from_dict 与构造器同文案面）', () => {
    expect(() => EnvironmentSpec.from_dict({ runtime: 'local' })).toThrow('缺 name');
    expect(() => EnvironmentSpec.from_dict({ name: 'e', runtime: 'k8s' })).toThrow(
      'runtime 非法',
    );
    expect(() => new EnvironmentSpec({ name: 'e', tools: [''] })).toThrow('tools');
    expect(() => EnvironmentSpec.from_dict({ name: 'e', tools: [1] })).toThrow('tools');
  });
});

describe('install_cmds 结构化形态（ENG6-11 回归）', () => {
  const cmds: InstallCmd[] = [
    'npm install -g typescript',
    { cmd: 'pip', args: ['install', '-r', 'requirements.txt'] },
  ];

  it('to_dict 原形往返 + 结构化条目校验拒绝缺 cmd / 非法 args', () => {
    const spec = new EnvironmentSpec({
      name: 'node_env',
      runtime: RuntimeKind.LOCAL,
      tools: ['node'],
      install_cmds: cmds,
    });
    expect(spec.to_dict()['install_cmds']).toEqual([
      'npm install -g typescript',
      { cmd: 'pip', args: ['install', '-r', 'requirements.txt'] },
    ]);
    const restored = EnvironmentSpec.from_dict(spec.to_dict());
    expect(restored.equals(spec)).toBe(true);
    expect(() =>
      new EnvironmentSpec({
        name: 'e',
        install_cmds: [{ args: ['x'] }] as unknown as InstallCmd[],
      }),
    ).toThrow('cmd');
    expect(() =>
      new EnvironmentSpec({
        name: 'e',
        install_cmds: [{ cmd: 'npm', args: [1] }] as unknown as InstallCmd[],
      }),
    ).toThrow('args');
  });

  it('结构化形态直取 (cmd, args)；字符串形态 shlex 分词引号参数不裂开', () => {
    const [command, args] = parseInstallCmd('npm install --prefix "C:/Program Files/node"');
    expect(command).toBe('npm');
    expect(args).toEqual(['install', '--prefix', 'C:/Program Files/node']);
    const structured = parseInstallCmd({ cmd: 'pip', args: ['install', 'x'] });
    expect(structured).toEqual(['pip', ['install', 'x']]);
  });

  it('validateInstallCmd / displayInstallCmd 口径', () => {
    expect(() => validateInstallCmd('', 'e')).toThrow('非空命令条目');
    expect(() => validateInstallCmd(42, 'e')).toThrow('字符串或 (cmd, args)');
    expect(displayInstallCmd({ cmd: 'npm', args: ['install', '-g', 'pkg'] })).toBe(
      'npm install -g pkg',
    );
    expect(displayInstallCmd('npm install -g pkg')).toBe('npm install -g pkg');
  });
});

describe('shlex_split（install_cmds 字符串形态的词法面）', () => {
  it('引号/转义分词规则', () => {
    expect(shlex_split('npm install --prefix "C:/Program Files/node"')).toEqual([
      'npm',
      'install',
      '--prefix',
      'C:/Program Files/node',
    ]);
    expect(shlex_split("echo 'a b' c")).toEqual(['echo', 'a b', 'c']);
    expect(shlex_split('a\\ b c')).toEqual(['a b', 'c']);
    expect(shlex_split('')).toEqual([]);
    expect(shlex_split('   ')).toEqual([]);
    expect(shlex_split('""')).toEqual(['']);
  });

  it('未闭合引号抛错（镜像 shlex ValueError，安装侧收口为 failed）', () => {
    expect(() => shlex_split('npm install "unclosed')).toThrow('No closing quotation');
    expect(() => parseInstallCmd("npm install 'unclosed")).toThrow(
      'No closing quotation',
    );
  });
});
