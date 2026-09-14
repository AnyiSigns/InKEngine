import { describe, expect, it } from 'vitest';

import { canonicalJson, hashObj } from '../world/hash.js';
import { MAX_REPEAT } from '../world/operators.js';
import { TRANSFORM_SEMANTICS, hashWorldVersion, lexiconFace, worldVersion } from '../world/version.js';
import { deepEq } from '../world/types.js';

describe('world/version/worldVersion（G0.1 与数据集回滚口径）', () => {
  it('worldVersion 是稳定 16 位十六进制，且对同表恒定', () => {
    expect(worldVersion).toMatch(/^[0-9a-f]{16}$/);
    // 不变量：hashWorldVersion 的词表参数默认 = 当前 lexiconFace() 投影，
    // 故两参调用仍逐字复现 worldVersion。
    expect(hashWorldVersion(TRANSFORM_SEMANTICS, MAX_REPEAT)).toBe(worldVersion);
    expect(hashWorldVersion(TRANSFORM_SEMANTICS, MAX_REPEAT)).toBe(worldVersion);
    expect(hashWorldVersion(TRANSFORM_SEMANTICS, MAX_REPEAT, lexiconFace())).toBe(worldVersion);
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

  it('词表任一组成变化即改变 worldVersion（P1-A：义项/目标词/模板/池漂移必失效旧数据旧权重）', () => {
    const face = lexiconFace();
    const asLists = (v: unknown): Record<string, readonly string[]> =>
      v as Record<string, readonly string[]>;
    const tweaks: Record<string, unknown>[] = [
      { ...face, lexicon: { ...asLists(face.lexicon), add3: ['加三', '增三', '添三', '又加三'] } },
      { ...face, goalLex: { ...asLists(face.goalLex), parity: ['偶数', '奇数'] } },
      { ...face, goalTemplates: { ...asLists(face.goalTemplates), len: ['长度仅在{min}到{max}'] } },
      { ...face, goalConnectors: ['然后'] },
      { ...face, recipePrefixes: ['依次执行：'] },
      { ...face, recipeConnectors: ['下一步'] },
    ];
    for (const t of tweaks) {
      expect(hashWorldVersion(TRANSFORM_SEMANTICS, MAX_REPEAT, t)).not.toBe(worldVersion);
    }
  });
});

describe('world/types/deepEq 与 canonicalJson 的 undefined 剔除口径一致（P3）', () => {
  // 两口径对齐属序列化/回滚面，归本文件守护（tests/types.test.ts 不在本组清单）。
  it('{a: undefined, b} ≡ {b}：deepEq 判等且与哈希口径一致；显式 null 不剔除', () => {
    expect(deepEq({ a: undefined, b: 1 }, { b: 1 })).toBe(true);
    expect(canonicalJson({ a: undefined, b: 1 })).toBe(canonicalJson({ b: 1 }));
    expect(hashObj({ a: undefined, b: 1 })).toBe(hashObj({ b: 1 }));
    expect(deepEq({ a: null, b: 1 }, { b: 1 })).toBe(false);
    expect(canonicalJson({ a: null, b: 1 })).not.toBe(canonicalJson({ b: 1 }));
    expect(hashObj({ a: null, b: 1 })).not.toBe(hashObj({ b: 1 }));
  });
});
