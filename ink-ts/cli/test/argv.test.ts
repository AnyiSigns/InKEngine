import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/argv.js';
import type { CliOptions } from '../src/argv.js';

function expectOptions(argv: readonly string[]): CliOptions {
  const parsed = parseArgs(argv);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  if (parsed.ok) return parsed.options;
  throw new Error('unreachable');
}

function expectError(argv: readonly string[]): { error: string; mode: string } {
  const parsed = parseArgs(argv);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) return { error: parsed.error, mode: parsed.mode };
  throw new Error('unreachable');
}

describe('parseArgs 形态选择与公共参数', () => {
  it('缺省形态 = stdio；不放行审批；默认 assistant 图', () => {
    const options = expectOptions([]);
    expect(options).toMatchObject({ mode: 'stdio', approve: false, graph: 'assistant', help: false });
  });

  it('首参子命令 run / serve / stdio 选定形态', () => {
    expect(expectOptions(['run', '--round', 'x']).mode).toBe('run');
    expect(expectOptions(['serve', '--port', '0']).mode).toBe('serve');
    expect(expectOptions(['stdio']).mode).toBe('stdio');
  });

  it('--approve 显式声明放行；--help/-h 帮助姿态', () => {
    expect(expectOptions(['--approve']).approve).toBe(true);
    expect(expectOptions(['--help']).help).toBe(true);
    expect(expectOptions(['run', '--round', 'x', '-h']).help).toBe(true);
    expect(expectOptions(['serve', '--help']).help).toBe(true);
  });

  it('--graph 取值校验；未知图名拒绝', () => {
    expect(expectOptions(['run', '--round', 'x', '--graph', 'gate']).graph).toBe('gate');
    expect(expectError(['--graph', 'nope']).error).toContain('未知图配方');
  });

  it('未知参数拒绝并带形态（stdio exit1 / run exit2 判定依据）', () => {
    const unknown = expectError(['--cwd', '/tmp']);
    expect(unknown.error).toContain('--cwd');
    expect(unknown.mode).toBe('stdio');
    const runUnknown = expectError(['run', '--bogus']);
    expect(runUnknown.mode).toBe('run');
    expect(runUnknown.error).toContain('--bogus');
  });

  it('run/serve 专属参数不能用于缺省 stdio 形态（未知参数 fail-closed）', () => {
    const rejected = expectError(['--round', 'x']);
    expect(rejected.error).toContain('未知参数');
    expect(rejected.error).toContain('--round');
    expect(rejected.mode).toBe('stdio');
    const serveFlag = expectError(['serve', '--round', 'x']);
    expect(serveFlag.error).toContain('未知参数');
  });
});

describe('parseArgs run 形态', () => {
  it('run 需指定 --round/--op/--os-op/--audit 之一', () => {
    expect(expectError(['run']).error).toContain('需指定');
  });

  it('--round 解析文本与 trace/thread/round id', () => {
    const options = expectOptions(['run', '--round', '你好', '--trace-id', 't1', '--thread-id', 'th1', '--round-id', 'r1']);
    expect(options.mode).toBe('run');
    expect(options.run).toMatchObject({ command: 'round', arg: '你好', trace_id: 't1', thread_id: 'th1', round_id: 'r1' });
  });

  it('--op / --os-op / --audit 解析', () => {
    expect(expectOptions(['run', '--op', 'records.sessions', '--args', '{"a":1}']).run).toMatchObject({
      command: 'op',
      arg: 'records.sessions',
      args: '{"a":1}',
    });
    expect(expectOptions(['run', '--os-op', 'process_exec']).run).toMatchObject({
      command: 'os_op',
      arg: 'process_exec',
    });
    expect(expectOptions(['run', '--audit', 'export']).run).toMatchObject({ command: 'audit', arg: 'export' });
  });

  it('驱动参数互斥：--round 与 --audit 同给即拒绝', () => {
    expect(expectError(['run', '--round', 'x', '--audit', 'export']).error).toContain('互斥参数');
    expect(expectError(['run', '--op', 'a', '--os-op', 'b']).error).toContain('互斥参数');
  });

  it('audit 仅支持 export', () => {
    expect(expectError(['run', '--audit', 'truncate']).error).toContain('仅 export');
  });

  it('--args JSON 不在此层校验（信封层执行期解析）', () => {
    expect(expectOptions(['run', '--op', 'x', '--args', 'not-json']).run?.args).toBe('not-json');
  });
});

describe('parseArgs serve 形态', () => {
  it('--port/--host/--token/--static/--vite 解析（缺省端口 0）', () => {
    const options = expectOptions(['serve', '--port', '18731', '--host', '127.0.0.1', '--token', 'tok', '--static', './web', '--vite', 'http://localhost:5173']);
    expect(options.serve).toEqual({ port: 18731, host: '127.0.0.1', token: 'tok', static_dir: './web', vite_proxy: 'http://localhost:5173' });
    expect(expectOptions(['serve']).serve).toBeUndefined();
  });

  it('非法端口拒绝', () => {
    expect(expectError(['serve', '--port', '99999']).error).toContain('0-65535');
    expect(expectError(['serve', '--port', 'abc']).error).toContain('0-65535');
  });
});
