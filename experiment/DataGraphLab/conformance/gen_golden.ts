/**
 * 金标生成器（“示例必须由参考实现生成并冻结”）。
 *
 * 运行 `npm run golden` 产出 `conformance/fixtures.json`；`npm run golden:check`
 * 重新生成并与冻结文件逐字比较，任何参考实现漂移都会红。文档里的示例不得手写，
 * 一律引用本文件产物；测试也直接读冻结 fixture 断言。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { buildHelpersDoc } from './helpers_doc.js';
import { makeRng } from '../world/rng.js';
import { canonicalJson, crc32, hashObj } from '../world/hash.js';
import { TYPE_LIST } from '../world/types.js';
import { HIST_SLOTS, NODE_SLOT } from '../controller/slots.js';
import { MAX_REPEAT, NODES_BASE, ROUTING, LEX_OPS_BASE } from '../world/operators.js';
import { mentionStats, tokens } from '../world/tokenize.js';
import { renderGoal, renderRecipe } from '../world/render.js';
import type { Goal } from '../world/goal.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures.json');
const HELPERS = join(HERE, '..', 'docs', 'helpers.md');
export const FIXTURES_PATH = OUT;
export const HELPERS_PATH = HELPERS;

const CANONICAL_INPUTS: ReadonlyArray<{ label: string; input: unknown }> = [
  { label: 'zero', input: 0 },
  { label: 'neg-zero', input: -0 },
  { label: 'tenth', input: 0.1 },
  { label: 'tiny', input: 1e-7 },
  { label: 'one', input: 1 },
  { label: 'nested', input: { b: [1, 2, 3], a: { n: 0.1 }, c: '中文' } },
  { label: 'cjk', input: { 中文键: '值' } },
];

const RECIPE_PLANS: ReadonlyArray<{ seed: number; root: 'Int' | 'Str'; x: number | string; plan: readonly string[] }> = [
  { seed: 0, root: 'Int', x: 12, plan: ['add3', 'mul2', 'sub1', 'submit'] },
  { seed: 1, root: 'Int', x: -7, plan: ['add3', 'add3', 'mod7', 'submit'] },
  { seed: 2, root: 'Str', x: 'abc', plan: ['upper', 'reverse', 'append_bang', 'submit'] },
  { seed: 3, root: 'Int', x: 9, plan: ['cond_even', 'submit', 'check_parity'] },
  { seed: 4, root: 'Str', x: 'abcd', plan: ['cond_long', 'submit', 'check_len'] },
  { seed: 5, root: 'Str', x: 'hello', plan: ['str_len', 'mul2', 'submit', 'check_parity'] },
  { seed: 6, root: 'Int', x: 5, plan: ['neg', 'add3', 'submit'] },
  { seed: 7, root: 'Str', x: 'ab', plan: ['reverse', 'lower', 'submit'] },
];

const GOALS: ReadonlyArray<{ seed: number; goal: Goal }> = [
  { seed: 0, goal: { kind: 'parity', target: 0 } },
  { seed: 1, goal: { kind: 'parity', target: 1 } },
  { seed: 2, goal: { kind: 'gt', target: 20 } },
  { seed: 3, goal: { kind: 'len', min: 1, max: 5 } },
  { seed: 4, goal: { kind: 'all', of: [{ kind: 'parity', target: 1 }, { kind: 'gt', target: 0 }] } },
];

const MENTION_CASES: ReadonlyArray<{ instruction: string; op: string }> = [
  { instruction: '加三，然后翻倍，接着减一', op: 'mul2' },
  { instruction: '加三，然后翻倍，接着减一', op: 'add3' },
  { instruction: '取反，再提交', op: 'reverse' },
  { instruction: '结果是偶数，且结果大于5', op: 'check_parity' },
];

export function buildFixtures(): Record<string, unknown> {  const nodeSlots: Record<string, number> = {};
  for (const nid of NODES_BASE) {
    const slot = NODE_SLOT.get(nid);
    if (slot !== undefined) nodeSlots[nid] = slot;
  }

  const rng = [0, 1, 42].map((seed) => {
    const r = makeRng(seed);
    return { seed, first8: Array.from({ length: 8 }, () => r.next()) };
  });

  const crc32Cases = ['', 'hello', '加三', '取反', 'task:0'].map((s) => ({ s, crc32: crc32(s) }));

  const canonical = CANONICAL_INPUTS.map((c) => ({
    label: c.label,
    json: canonicalJson(c.input),
    hash: hashObj(c.input),
  }));

  const tokenCases = [
    '加三，然后翻倍',
    '起点值12。按顺序做：加三，然后取反',
    '结果是偶数，且结果大于5',
    'abc',
  ].map((input) => ({ input, tokens: tokens(input) }));

  const mention = MENTION_CASES.map((m) => ({
    instruction: m.instruction,
    op: m.op,
    ...mentionStats(tokens(m.instruction), m.op),
  }));

  const recipe = RECIPE_PLANS.map((p) => ({
    seed: p.seed,
    root: p.root,
    x: p.x,
    plan: p.plan,
    instruction: renderRecipe(makeRng(p.seed), p.plan, p.x),
  }));

  const goal = GOALS.map((g) => ({
    seed: g.seed,
    goal: g.goal,
    instruction: renderGoal(makeRng(g.seed), g.goal),
  }));

  return {
    meta: { generator: 'conformance/gen_golden.ts', schema: 1 },
    constants: {
      TYPE_LIST,
      NODES_BASE,
      ROUTING,
      LEX_OPS_BASE,
      MAX_REPEAT,
      HIST_SLOTS,
    },
    nodeSlots,
    rng,
    crc32: crc32Cases,
    canonical,
    tokens: tokenCases,
    mentionStats: mention,
    renderRecipe: recipe,
    renderGoal: goal,
  };
}

function main(): void {
  const fixtures = buildFixtures();
  const fixturesText = `${JSON.stringify(fixtures, null, 2)}\n`;
  const helpersText = buildHelpersDoc(fixtures);
  if (process.argv.includes('--check')) {
    const compare = (path: string, text: string): boolean => {
      let frozen: string;
      try {
        frozen = readFileSync(path, 'utf8');
      } catch {
        console.error(`golden: missing ${path}; run "npm run golden"`);
        return false;
      }
      return frozen === text;
    };
    const okFixtures = compare(OUT, fixturesText);
    const okHelpers = compare(HELPERS, helpersText);
    if (!okFixtures || !okHelpers) {
      console.error('golden: generated artifacts drifted; run "npm run golden"');
      process.exit(1);
    }
    console.log('golden: fixtures and docs match reference implementation');
    return;
  }
  mkdirSync(dirname(HELPERS), { recursive: true });
  writeFileSync(OUT, fixturesText, 'utf8');
  writeFileSync(HELPERS, helpersText, 'utf8');
  console.log(`golden: wrote ${OUT}`);
  console.log(`golden: wrote ${HELPERS}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();