/**
 * 决策点推演（__simulate__）纯数据面单测。
 * 执行器级用例（make_engine / swap_branch / memory_storage / transport）留待 Engine.run_simulated 移植后回归。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { PatchChain } from '../../../src/core/patch/patchChain.js';
import { DimensionScore } from '../../../src/core/scoring/scoring.js';
import {
  BranchSelection,
  DimensionScorer,
  EvaluatedBranch,
  Evaluation,
  Evaluator,
  DEFAULT_MAX_SIMULATIONS,
  SIMULATE_KEY,
  BestBranchMixer,
  BranchMixer,
  PatchChainBranchMixer,
  ProvenanceNote,
  SimulateSpec,
  WeightedScorerEvaluator,
  fit_overlay,
  parse_simulate,
  simulate_thread_id,
} from '../../../src/core/simulation/simulation.js';

const noop = async () => ({});

function make_sub(): Graph {
  const g = new Graph({ name: 'sub', entry: 's1' });
  g.add_node('s1', noop);
  g.add_exit('s1');
  return g;
}

function make_sub_serializable(): Graph {
  const g = new Graph({ name: 'sub', entry: 's1' });
  g.add_node_type('s1', 's1_type', {});
  g.add_exit('s1');
  return g;
}

describe('SIMULATE_KEY', () => {
  it('值为 "__simulate__"', () => {
    expect(SIMULATE_KEY).toBe('__simulate__');
  });
});

describe('SimulateSpec', () => {
  it('构造后冻结', () => {
    const spec = new SimulateSpec({ subgraph: make_sub(), state: { seed: 1 }, index: 0 });
    expect(spec.index).toBe(0);
    expect(spec.description).toBe('');
  });

  it('to_dict 序列化子图+state+index', () => {
    const sub = make_sub_serializable();
    const spec = new SimulateSpec({ subgraph: sub, state: { seed: 10 } as Record<string, unknown>, index: 2, description: 'd' });
    const data = spec.to_dict();
    expect(data.index).toBe(2);
    expect(data.state).toEqual({ seed: 10 });
    expect((data.subgraph as Record<string, unknown>)['name']).toBe('sub');
  });

  it('to_dict 深拷贝 state', () => {
    const state: Record<string, unknown> = { seed: 1 };
    const spec = new SimulateSpec({ subgraph: make_sub_serializable(), state, index: 0 });
    const data = spec.to_dict();
    state['seed'] = 999;
    expect((data.state as Record<string, unknown>)['seed']).toBe(1);
  });

  it('from_dict Graph 直通', () => {
    const sub = make_sub();
    const spec = SimulateSpec.from_dict({ subgraph: sub, state: { x: 1 }, index: 3 });
    expect(spec.subgraph).toBe(sub);
    expect(spec.index).toBe(3);
  });

  it('from_dict 非法数据拒绝', () => {
    expect(() => SimulateSpec.from_dict(42 as unknown as Record<string, unknown>)).toThrow(GraphDefinitionError);
    expect(() => SimulateSpec.from_dict({ subgraph: make_sub(), index: 'oops' })).toThrow(GraphDefinitionError);
  });
});

describe('Evaluation', () => {
  it('构造后冻结', () => {
    const e = new Evaluation({ score: 0.8, passed: true, note: 'n' });
    expect(e.score).toBe(0.8);
    expect(e.passed).toBe(true);
  });

  it('to_dict / from_dict round-trip', () => {
    const evaluation = new Evaluation({
      score: 0.8,
      passed: true,
      note: 'n',
      dimensions: [new DimensionScore('quality', 0.6)],
      rule_version: 'rules-v3',
      params_snapshot: { weights: { quality: 0.5 } },
    });
    const rebuilt = Evaluation.from_dict(evaluation.to_dict());
    expect(rebuilt.score).toBe(0.8);
    expect(rebuilt.rule_version).toBe('rules-v3');
    expect(rebuilt.params_snapshot).toEqual({ weights: { quality: 0.5 } });
    expect(rebuilt.dimensions[0]!.name).toBe('quality');
  });

  it('缺省字段最小形态', () => {
    const e = new Evaluation();
    expect(e.to_dict()).toEqual({ score: 0, passed: true });
  });
});

describe('EvaluatedBranch', () => {
  it('to_dict 深拷贝防回流共享', () => {
    const spec = new SimulateSpec({ subgraph: make_sub_serializable(), state: {}, index: 0 });
    const branch = new EvaluatedBranch({ spec, overlay: { k: 1 }, evaluation: new Evaluation({ score: 0.5 }) });
    const data = branch.to_dict();
    expect(data.spec).toEqual(spec.to_dict());
    expect(data.overlay).toEqual({ k: 1 });
  });
});

describe('ProvenanceNote', () => {
  it('构造后冻结', () => {
    const p = new ProvenanceNote({ branch_index: 1, key: 'hero', note: '高分' });
    expect(p.branch_index).toBe(1);
    expect(p.key).toBe('hero');
  });
});

describe('BranchSelection', () => {
  it('构造后冻结', () => {
    const sel = new BranchSelection({
      selected: [0, 1],
      overlay: { a: 1 },
      provenance: [new ProvenanceNote({ branch_index: 0, key: 'a' })],
    });
    expect(sel.selected).toEqual([0, 1]);
    expect(sel.provenance).toHaveLength(1);
  });
});

describe('parse_simulate', () => {
  it('非 dict 或缺少 branches 拒绝', () => {
    expect(() => parse_simulate([], { max_branches: 4 })).toThrow(GraphDefinitionError);
    expect(() => parse_simulate({ x: 1 }, { max_branches: 4 })).toThrow(GraphDefinitionError);
  });

  it('空分支清单 / 超限 / 重复序号 / 预算非法 / 缺子图 拒绝', () => {
    expect(() => parse_simulate({ branches: [] }, { max_branches: 4 })).toThrow(GraphDefinitionError);
    expect(() =>
      parse_simulate({ branches: [{ subgraph: make_sub(), index: 0 }, { subgraph: make_sub(), index: 1 }] }, { max_branches: 1 }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      parse_simulate({ branches: [{ subgraph: make_sub(), index: 0 }, { subgraph: make_sub(), index: 0 }] }, { max_branches: 4 }),
    ).toThrow(GraphDefinitionError);
    expect(() => parse_simulate({ branches: [{ subgraph: make_sub(), index: 0 }], budget: -1 }, { max_branches: 4 })).toThrow(GraphDefinitionError);
    expect(() => parse_simulate({ branches: [{ index: 0 }] }, { max_branches: 4 })).toThrow(GraphDefinitionError);
  });

  it('Graph 直通 + step_id/budget 透传', () => {
    const [step_id, budget, branches] = parse_simulate(
      { step_id: 's-1', budget: 4000, branches: [{ subgraph: make_sub(), state: { x: 1 }, index: 3 }] },
      { max_branches: 4 },
    );
    expect(step_id).toBe('s-1');
    expect(budget).toBe(4000);
    expect(branches[0]!.index).toBe(3);
  });

  it('dict + resolve_graph 重建', () => {
    const sub = make_sub_serializable();
    const [,, branches] = parse_simulate(
      { branches: [{ subgraph: sub.to_dict(), state: { seed: 1 }, index: 0 }] },
      { max_branches: 4, resolve_graph: () => sub },
    );
    expect(branches[0]!.subgraph).toBe(sub);
  });

  it('index 缺省 = 已收集数', () => {
    const [,, branches] = parse_simulate(
      { branches: [{ subgraph: make_sub(), index: null, state: {} }, { subgraph: make_sub(), state: {} }] },
      { max_branches: 4 },
    );
    expect(branches.map((b) => b.index)).toEqual([0, 1]);
  });

  it('max_branches=0 禁用推演', () => {
    expect(() => parse_simulate({ branches: [{ subgraph: make_sub(), index: 0 }] }, { max_branches: 0 })).toThrow(GraphDefinitionError);
  });
});

describe('simulate_thread_id', () => {
  it('"{父thread}:simulate:{index}" 形式', () => {
    expect(simulate_thread_id('parent', 0)).toBe('parent:simulate:0');
    expect(simulate_thread_id('parent', 12)).toBe('parent:simulate:12');
  });
});

describe('BestBranchMixer', () => {
  it('最高分整体提交 / 平分取序号小者 / 未通过分支不参与 / 全部未通过拒绝 / 预算裁剪', async () => {
    const mixer = new BestBranchMixer();
    const mk = (score: number, passed = true, index = 0) =>
      new EvaluatedBranch({ spec: new SimulateSpec({ subgraph: make_sub(), state: {}, index }), overlay: { v: index }, evaluation: new Evaluation({ score, passed }) });

    expect((await mixer.mix([mk(0.3, true, 0), mk(0.9, true, 1)])).selected).toEqual([1]);
    expect((await mixer.mix([mk(0.5, true, 0), mk(0.5, true, 1)])).selected).toEqual([0]);
    expect((await mixer.mix([mk(0.9, true, 0), mk(0.8, false, 1)])).selected).toEqual([0]);
    await expect(mixer.mix([mk(0.1, false, 0)])).rejects.toThrow(GraphDefinitionError);
    const sel = await mixer.mix([mk(0.9, true, 0)], { budget: 200 });
    expect(typeof sel.overlay['v']).toBe('number');
  });
});

describe('PatchChainBranchMixer', () => {
  it('冲突由高分分支胜出 / 空 overlay 拒绝 / 预算裁剪', async () => {
    const mixer = new PatchChainBranchMixer();
    const mk = (score: number, overlay: Record<string, unknown>, index = 0) =>
      new EvaluatedBranch({ spec: new SimulateSpec({ subgraph: make_sub(), state: {}, index }), overlay, evaluation: new Evaluation({ score, passed: true }) });

    const sel = await mixer.mix([mk(0.3, { hero: '低分', plot: '低分情节' }, 0), mk(0.9, { hero: '高分', extra: '高分补充' }, 1)]);
    expect((sel.overlay['hero'] as string)).toBe('高分');
    expect((sel.overlay['plot'] as string)).toBe('低分情节');
    const by_key = Object.fromEntries(sel.provenance.map((p) => [p.key, p.branch_index]));
    expect(by_key['hero']).toBe(1);
    expect(by_key['plot']).toBe(0);

    await expect(mixer.mix([mk(0.5, {}, 0)])).rejects.toThrow(GraphDefinitionError);
    const sel2 = await mixer.mix([mk(0.9, { a: 'x'.repeat(500) }, 0)], { budget: 200 });
    expect((sel2.overlay['a'] as string).length).toBeLessThanOrEqual(200);
  });
});

describe('WeightedScorerEvaluator', () => {
  it('dimension_scorer 桥接评估 / 中性基线分', async () => {
    const fakeScorer = {
      score: (dims: Record<string, number>) => ({
        total: Object.keys(dims).length ? Object.entries(dims).reduce((s, [, v]) => s + v, 0) / Object.keys(dims).length : 1,
        passed: true,
        failing_dimensions: [],
        scores: Object.entries(dims).map(([name, score]) => ({ name, score, note: '' })),
      }),
    };
    const evaluator = new WeightedScorerEvaluator(fakeScorer, { dimension_scorer: () => ({ quality: 0.9, consistency: 0.8 }) });
    const spec = new SimulateSpec({ subgraph: make_sub(), state: {}, index: 0 });
    const result = await evaluator.evaluate(spec, {});
    expect(result.score).toBeCloseTo((0.9 + 0.8) / 2);
    expect(result.passed).toBe(true);

    const neutral = new WeightedScorerEvaluator(fakeScorer);
    expect((await neutral.evaluate(spec, {})).score).toBe(1);
  });
});

describe('fit_overlay', () => {
  it('null/非正预算不裁剪 / 字符串截断 / 非字符串纳入或跳过', () => {
    const overlay = { a: 1, b: 'x' };
    expect(fit_overlay(overlay, null)).toEqual(overlay);
    expect(fit_overlay(overlay, 0)).toEqual(overlay);
    const result = fit_overlay({ a: 'hello world', b: 'extra' }, 8);
    expect((result['a'] as string).length).toBeLessThanOrEqual(8);
    const big = fit_overlay({ small: 'y'.repeat(5), big: { data: 'x'.repeat(500) } }, 5000);
    expect(big['small']).toBeDefined();
    expect(big['big']).toBeDefined();
  });
});
