import { describe, expect, it } from 'vitest';

import { MAX_REPEAT } from '../world/operators.js';
import { hashWorldVersion, TRANSFORM_SEMANTICS, worldVersion } from '../world/version.js';

describe('world/version/worldVersion（G0.1 与数据集回滚口径）', () => {
  it('worldVersion 是稳定 16 位十六进制，且对同表恒定', () => {
    expect(worldVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(hashWorldVersion(TRANSFORM_SEMANTICS, MAX_REPEAT)).toBe(worldVersion);
    expect(hashWorldVersion(TRANSFORM_SEMANTICS, MAX_REPEAT)).toBe(worldVersion);
  });

  it('TRANSFORM_SEMANTICS 覆盖 B.2 全部 23 个节点（op/terminal/decoy + entry/exit）', () => {
    expect(Object.keys(TRANSFORM_SEMANTICS)).toHaveLength(23);
  });

  it('修改 TRANSFORM_SEMANTICS 任一条目即改变 worldVersion', () => {
    const targets = ['add3', 'cond_even', 'shuffle', 'check_parity', 'echo'];
    for (const opId of targets) {
      const tweaked = { ...TRANSFORM_SEMANTICS, [opId]: `${TRANSFORM_SEMANTICS[opId]}!` };
      expect(hashWorldVersion(tweaked, MAX_REPEAT), `op=${opId}`).not.toBe(worldVersion);
    }
  });

  it('修改 MAX_REPEAT 即改变 worldVersion（它决定可枚举骨架空间）', () => {
    expect(hashWorldVersion(TRANSFORM_SEMANTICS, MAX_REPEAT + 1)).not.toBe(worldVersion);
    expect(hashWorldVersion(TRANSFORM_SEMANTICS, MAX_REPEAT - 1)).not.toBe(worldVersion);
  });
});
