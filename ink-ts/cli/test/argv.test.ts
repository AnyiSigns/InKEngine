import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/argv.js';

describe('parseArgs', () => {
  it('缺省不放行审批', () => {
    const parsed = parseArgs([]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.options).toEqual({ approve: false, help: false });
  });

  it('--approve 显式声明放行', () => {
    const parsed = parseArgs(['--approve']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.options.approve).toBe(true);
  });

  it('--help / -h 触发帮助姿态', () => {
    expect(parseArgs(['--help'])).toEqual({ ok: true, options: { approve: false, help: true } });
    expect(parseArgs(['-h'])).toEqual({ ok: true, options: { approve: false, help: true } });
  });

  it('未知参数拒绝并带错误（供入口 stderr + 退出码 1）', () => {
    const parsed = parseArgs(['--cwd', '/tmp']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('--cwd');
  });

  it('位置参数同样拒绝', () => {
    const parsed = parseArgs(['hello.txt']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('hello.txt');
  });
});
