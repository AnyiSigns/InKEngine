import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildFixtures, FIXTURES_PATH, HELPERS_PATH } from '../conformance/gen_golden.js';
import { buildHelpersDoc } from '../conformance/helpers_doc.js';
import { canonicalJson } from '../world/hash.js';
import { parseRecipe } from '../world/render.js';

interface RecipeFixture {
  root: 'Int' | 'Str';
  plan: string[];
  instruction: string;
}

describe('conformance/goldens', () => {
  it('冻结 fixture 与参考实现逐字一致（文档示例的唯一来源）', () => {
    const frozen = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as unknown;
    expect(canonicalJson(frozen)).toBe(canonicalJson(buildFixtures()));
  });

  it('docs/helpers.md 与生成器逐字一致，示例不由手写', () => {
    const frozen = readFileSync(HELPERS_PATH, 'utf8');
    expect(frozen).toBe(buildHelpersDoc(buildFixtures()));
  });

  it('冻结的 renderRecipe 金标本身满足往返', () => {
    const fx = buildFixtures() as { renderRecipe: RecipeFixture[] };
    for (const r of fx.renderRecipe) {
      expect(parseRecipe(r.instruction, r.root), `seed plan=${r.plan.join(',')}`).toEqual(r.plan);
    }
  });
});
