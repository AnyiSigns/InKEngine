import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/argv.js';

describe('parseArgs', () => {
  it('缺省不放行审批', () => {
    expect(parseArgs([]).approve).toBe(false);
  });

  it('--approve 显式声明放行', () => {
    expect(parseArgs(['--approve']).approve).toBe(true);
  });

  it('--help 触发帮助姿态', () => {
    const opts = parseArgs(['--help']);
    expect(opts.help).toBe(true);
    expect(opts.approve).toBe(false);
  });
});
