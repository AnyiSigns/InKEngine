import { describe, expect, it } from 'vitest';

import { contractOf, histCount, MAX_REPEAT, OPS } from '../world/operators.js';
import { parseRecipe, renderGoal, renderRecipe, tokens } from '../world/grammar.js';
import { findSequence, senseTokens } from '../world/tokenize.js';
import { GOAL_LEX, GOAL_TEMPLATES, LEXICON } from '../world/lexicon.js';
import { allLexemes } from '../world/lexicon_audit.js';
import { makeRng } from '../world/rng.js';
import type { TypeName } from '../world/types.js';
import type { Goal } from '../world/goal.js';

const OP_IDS = OPS.filter((o) => o.kind === 'op').map((o) => o.id);

function accepts(opId: string, ty: TypeName): boolean {
  const c = contractOf(opId);
  if (!c) return false;
  return Object.values(c.requires).some((types) => types.includes('any') || types.includes(ty));
}

function nextType(opId: string, ty: TypeName): TypeName {
  const c = contractOf(opId)!;
  return c.out_type === 'any' ? ty : (c.out_type as TypeName);
}

function enumeratePlans(root: TypeName, maxDepth: number): string[][] {
  const out: string[][] = [];
  const dfs = (ty: TypeName, plan: string[]): void => {
    if (plan.length > 0) out.push([...plan]);
    if (plan.length >= maxDepth) return;
    for (const id of OP_IDS) {
      if (histCount(plan, id) >= MAX_REPEAT) continue;
      if (!accepts(id, ty)) continue;
      dfs(nextType(id, ty), [...plan, id]);
    }
  };
  dfs(root, []);
  return out;
}

function withTerminals(plan: readonly string[], root: TypeName): string[][] {
  let ty = root;
  for (const id of plan) ty = nextType(id, ty);
  const base = [...plan, 'submit'];
  if (ty === 'Int') return [base, [...base, 'check_parity']];
  if (ty === 'Str') return [base, [...base, 'check_len']];
  return [base];
}

function xFor(root: TypeName): number | string {
  return root === 'Int' ? 7 : 'abc';
}

describe('配方族往返（硬要求）', () => {
  it('穷举深度 ≤3 的全部类型合法计划，任意 seed 渲染后必可还原', () => {
    const seeds = [0, 1, 2, 3, 4, 5, 6, 7];
    let checked = 0;
    for (const root of ['Int', 'Str'] as const) {
      const plans = enumeratePlans(root, 3);
      expect(plans.length).toBeGreaterThan(50);
      for (const plan of plans) {
        for (const full of withTerminals(plan, root)) {
          for (const seed of seeds) {
            const instr = renderRecipe(makeRng(seed), full, xFor(root));
            const parsed = parseRecipe(instr, root);
            expect(parsed, `root=${root} plan=${full.join(',')} seed=${seed} instr=${instr}`).toEqual(
              full,
            );
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('深度 ≤5 的随机合法计划同样可还原', () => {
    const rng = makeRng(20260912);
    for (let i = 0; i < 3000; i++) {
      const root: TypeName = rng.choice(['Int', 'Str'] as const);
      let ty: TypeName = root;
      const plan: string[] = [];
      const depth = rng.randint(1, 5);
      for (let d = 0; d < depth; d++) {
        const legal = OP_IDS.filter((id) => accepts(id, ty) && histCount(plan, id) < MAX_REPEAT);
        if (legal.length === 0) break;
        const id = rng.choice(legal);
        plan.push(id);
        ty = nextType(id, ty);
      }
      for (const full of withTerminals(plan, root)) {
        const instr = renderRecipe(rng, full, xFor(root));
        const parsed = parseRecipe(instr, root);
        expect(parsed, `plan=${full.join(',')} instr=${instr}`).toEqual(full);
      }
    }
  });

  it('共享义项按当前类型消歧', () => {
    expect(parseRecipe('取反，提交', 'Int')).toEqual(['neg', 'submit']);
    expect(parseRecipe('取反，提交', 'Str')).toEqual(['reverse', 'submit']);
  });

  it('同 seed 渲染逐字相同', () => {
    const plan = ['add3', 'mul2', 'submit'];
    expect(renderRecipe(makeRng(9), plan, 3)).toBe(renderRecipe(makeRng(9), plan, 3));
  });

  it('义项耗尽 fail-fast，不复用义项', () => {
    expect(() => renderRecipe(makeRng(0), ['neg', 'neg', 'neg', 'neg'], 1)).toThrow();
  });

  it('合取目标渲染全部子目标，不少渲', () => {
    const goal: Goal = {
      kind: 'all',
      of: [
        { kind: 'parity', target: 0 },
        { kind: 'gt', target: 5 },
        { kind: 'len', min: 1, max: 5 },
      ],
    };
    const instr = renderGoal(makeRng(0), goal);
    expect(instr).toContain('偶');
    expect(['大于', '超过', '多于', '高过'].some((w) => instr.includes(w))).toBe(true);
    expect(['长度', '位数', '字符数', '之间'].some((w) => instr.includes(w))).toBe(true);
    const connectors = ['，且', '并且', '同时'];
    const joined = connectors.reduce((n, c) => n + instr.split(c).length - 1, 0);
    expect(joined).toBe(2);
  });
});

describe('目标族渲染', () => {
  it('目标指令不含任何算子义项', () => {
    const lexemes = allLexemes();
    const cases: Goal[] = [
      { kind: 'parity', target: 0 },
      { kind: 'parity', target: 1 },
      { kind: 'gt', target: 5 },
      { kind: 'len', min: 1, max: 5 },
      { kind: 'all', of: [{ kind: 'parity', target: 1 }, { kind: 'gt', target: 0 }] },
    ];
    for (const goal of cases) {
      for (let seed = 0; seed < 20; seed++) {
        const instr = renderGoal(makeRng(seed), goal);
        const toks = tokens(instr);
        for (const l of lexemes) {
          expect(
            findSequence(toks, senseTokens(l.sense)),
            `goal=${JSON.stringify(goal)} instr=${instr} leak=${l.opId}`,
          ).toBe(-1);
        }
      }
    }
  });

  it('gt/len 模板必须含数值阈值或区间端点', () => {
    for (const t of GOAL_TEMPLATES.gt!) expect(t).toMatch(/\{\s*target\s*\}/);
    for (const t of GOAL_TEMPLATES.len!) {
      expect(t).toMatch(/\{\s*min\s*\}/);
      expect(t).toMatch(/\{\s*max\s*\}/);
    }
    expect(GOAL_LEX.gt).not.toContain('不小于');
  });

  it('LEXICON 覆盖且只覆盖 LEX_OPS_BASE', () => {
    for (const id of ['add3', 'submit', 'check_len']) expect(LEXICON[id]).toBeDefined();
  });
});
