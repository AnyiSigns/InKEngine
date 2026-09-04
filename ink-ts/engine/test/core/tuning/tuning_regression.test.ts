/**
 * 参数变更过 L2 效果评估回归单测（对标 Python test_tuning.py「参数变更过
 * L2 效果评估回归（M7 接线）」段）。
 *
 * 语义检查点：
 * - ParamRegressionExecutor：越界参数被样例拦截（fixture 语义与样例库
 *   同构——逐用例 = 对条目参数的一条契约断言）；
 * - tune_with_regression：边界内变更生效（快照随落库），越界变更被拒绝
 *   （回落原参数 + note + 显式 rejected——ENG1-17「无变化」与「有建议但
 *   被拒」权威区分）；无参数变化不空转回归；
 * - 参数条目回写知识集（与知识孵化闭环）：下次调参从条目读回基线；
 *   缺失/损坏参数条目回落引擎默认；
 * - 快照 sink 落库集成点：回归通过 → 收快照；拒绝 → 不收。
 *
 * 延后（defer）：executor/LLM-钩子集成用例（LLM 判定谓词经规则钩子接入
 * 样例闸门、宿主装配层的真实执行器实弹）——本套件只用确定性参数回归
 * 执行器与注入式宿主闸门形态，纯逻辑零 IO。
 */
import { describe, expect, it } from 'vitest';

import type { JsonRecord } from '../../../src/core/json.js';
import {
  GateL2Result,
  KnowledgeGate,
} from '../../../src/core/knowledge_gate/index.js';
import { KnowledgeEntry } from '../../../src/core/knowledge_set/knowledge_entry.js';
import {
  KnowledgeSet,
  seed_knowledge_set,
} from '../../../src/core/knowledge_set/index.js';
import { FixtureCase, FixtureSet } from '../../../src/core/rules/index.js';
import {
  GENERAL_WEIGHTS_SEED_ID,
  build_general_seed_entries,
} from '../../../src/core/seeds/seeds.js';
import {
  MIN_WEIGHT,
  MetaTuner,
  ParamRegressionExecutor,
  TunableParams,
  TurnMetrics,
} from '../../../src/core/tuning/index.js';

/** 参数回归样例：逐用例 = 对条目参数的一条契约断言。
 *
 * - weight_floor（expected_pass=True）：条目全部权重须落在声明边界内
 *   （下限 = 调参下限保护的可收紧版本）；
 * - threshold_floor（expected_pass=False）：条目阈值须存在低于下限的
 *   越界值（本例 pass=0.6 < 0.9 —— 拒绝契约成立，防回归样例失真）。
 */
function param_fixtures(options: { weight_min?: number } = {}): FixtureSet {
  const weightMin = options.weight_min ?? MIN_WEIGHT;
  return new FixtureSet({
    name: 'param-regression',
    cases: [
      new FixtureCase({
        id: 'weight_floor',
        data: {
          bounds: {
            weights: { min: weightMin, max: 1.0 },
            thresholds: { min: 0.0, max: 10.0 },
          },
        },
        expected_pass: true,
        description: '条目全部参数须落在声明边界内',
      }),
      new FixtureCase({
        id: 'threshold_floor',
        data: {
          bounds: {
            weights: { min: 0.0, max: 1.0 },
            thresholds: { min: 0.9, max: 10.0 },
          },
        },
        expected_pass: false,
        description: '条目阈值须存在低于 0.9 的越界值（0.6 触发）',
      }),
    ],
  });
}

/** 参数条目工厂（kind=weight；overrides 顶层覆盖声明数据）。 */
function params_entry(overrides: JsonRecord = {}): KnowledgeEntry {
  const data: JsonRecord = {
    weights: { A: 0.5, B: 0.5 },
    thresholds: { pass: 0.6 },
    divergence_width: 3,
    retry_budget: 1,
    web_verify_threshold: 0.5,
  };
  Object.assign(data, overrides);
  return new KnowledgeEntry({
    id: 'tune-1',
    level: 'work',
    kind: 'weight',
    data,
    source: 'model',
  });
}

function gate(): KnowledgeGate {
  return new KnowledgeGate({ l2_executor: new ParamRegressionExecutor() });
}

describe('ParamRegressionExecutor：越界参数被样例拦截', () => {
  it('边界内参数全绿（fixture 语义与样例库同构）', async () => {
    const executor = new ParamRegressionExecutor();
    const ok = await executor.run(params_entry(), param_fixtures());
    expect(ok.passed).toBe(true);
    expect(ok.accuracy).toBe(1.0);
  });

  it('越界参数被样例拦截（拒绝原因可读可审计）', async () => {
    const executor = new ParamRegressionExecutor();
    const bad = await executor.run(
      params_entry({ weights: { A: 0.5, B: 0.05 } }),
      param_fixtures(),
    );
    expect(bad.passed).toBe(false);
    expect(bad.fixture_results.some((r) => r.reason.includes('越界'))).toBe(true);
  });
});

describe('M7 接线：调参变更过 L2 效果评估回归', () => {
  it('越界变更被拒绝（回退原参数 + note + 显式 rejected）', async () => {
    const params = new TunableParams({
      weights: { A: 0.5, B: 0.15 },
      thresholds: { pass: 0.6 },
    });
    const metrics = new TurnMetrics();
    const result = await new MetaTuner().tune_with_regression(
      params,
      metrics,
      param_fixtures({ weight_min: 0.2 }), // 边界高于调参下限保护
      { feedback: { B: 0.0 }, gate: gate() }, // 低分降权 → B 权重跌破 0.2 边界
    );
    expect(result.changes).toEqual([]); // 变更被拒绝
    expect(result.params.weights).toEqual({ A: 0.5, B: 0.15 }); // 回落原参数
    expect(result.note).toContain('回归未通过');
    // ENG1-17：显式拒绝语义——调用方据 rejected 区分「无变化」与
    // 「有建议但被回归拒绝」（旧实现未置任何标记，changes 空会误判）
    expect(result.rejected).toBe(true);
    expect(result.snapshot).toBeNull(); // 拒绝 = 快照不落库
  });

  it('ENG1-17：拒绝（rejected=True）与无参数变化（rejected=False）显式区分', async () => {
    const tuner = new MetaTuner();
    // 无变化：rejected=False 且 changes 空
    const noChange = await tuner.tune_with_regression(
      new TunableParams({ retry_budget: 1 }),
      new TurnMetrics(),
      param_fixtures(),
      { gate: gate() },
    );
    expect(noChange.changes).toEqual([]);
    expect(noChange.rejected).toBe(false);
    // 有建议但被拒：changes 空但 rejected=True
    const params = new TunableParams({
      weights: { A: 0.5, B: 0.15 },
      thresholds: { pass: 0.6 },
    });
    const rejected = await tuner.tune_with_regression(
      params,
      new TurnMetrics(),
      param_fixtures({ weight_min: 0.2 }),
      { feedback: { B: 0.0 }, gate: gate() },
    );
    expect(rejected.changes).toEqual([]);
    expect(rejected.rejected).toBe(true);
    // to_dict 携带 rejected（审计/序列化面）
    expect(rejected.to_dict()['rejected']).toBe(true);
    expect(noChange.to_dict()['rejected']).toBe(false);
  });

  it('边界内变更过回归 → 新参数生效（快照随落库）', async () => {
    const params = new TunableParams({
      weights: { A: 0.5, B: 0.5 },
      thresholds: { pass: 0.6 },
    });
    const metrics = new TurnMetrics();
    const result = await new MetaTuner().tune_with_regression(
      params,
      metrics,
      param_fixtures(), // 默认边界 = 调参下限保护，降权不会跌破
      { feedback: { B: 0.1 }, rule_version: 'rules-v9', gate: gate() },
    );
    expect(result.params.weights['B']!).toBeLessThan(0.5); // 降权生效
    expect(result.snapshot).not.toBeNull(); // 回归通过的变更随快照落库
    expect(result.note).toBe('');
  });

  it('无参数变化 = 不空转回归（无变更无需评估）', async () => {
    const result = await new MetaTuner().tune_with_regression(
      new TunableParams({ retry_budget: 1 }),
      new TurnMetrics(),
      param_fixtures(),
      { gate: gate() },
    );
    expect(result.changes).toEqual([]);
    expect(result.note).toBe('');
  });
});

describe('参数条目回写知识集（与知识孵化闭环）', () => {
  it('回归通过后参数条目更新：下次调参从条目读回基线', async () => {
    const ks = new KnowledgeSet('u1');
    seed_knowledge_set(ks, build_general_seed_entries());
    const tuner = new MetaTuner({ knowledge_set: ks });
    const params = new TunableParams({
      weights: { quality: 0.5, consistency: 0.5 },
      thresholds: { pass: 0.6 },
    });
    const result = await tuner.tune_with_regression(
      params,
      new TurnMetrics(),
      param_fixtures(),
      { feedback: { quality: 1.0 }, rule_version: 'rules-v9', gate: gate() }, // 高分升权
    );
    expect(result.params.weights['quality']!).toBeGreaterThan(0.5);
    // 参数条目已回写：下次调参从条目读回基线
    const persisted = ks.get(GENERAL_WEIGHTS_SEED_ID);
    expect(persisted).not.toBeNull();
    expect(persisted!.data['weights']).toEqual(result.params.weights);
    const loaded = MetaTuner.load_params(ks);
    expect(loaded.weights['quality']!).toBeGreaterThan(0.5);
    expect(loaded.thresholds).toEqual({ pass: 0.6 });
  });

  it('参数基线读回：无参数条目时回落引擎默认（缺省可开箱）', () => {
    const ks = new KnowledgeSet('u1');
    const loaded = MetaTuner.load_params(ks);
    expect(loaded.divergence_width).toBe(3);
    expect(loaded.retry_budget).toBe(1);
  });
});

describe('依赖注入：宿主自定义闸门参与接线', () => {
  it('宿主闸门（自定义回归执行器）全权接管回归判定', async () => {
    class HostGate extends KnowledgeGate {
      async check_l2(
        _entry: KnowledgeEntry,
        _fixtures: FixtureSet,
        _options?: { regression?: FixtureSet | null; context_rules?: JsonRecord | null },
      ): Promise<GateL2Result> {
        // 宿主语义示例：回归判定完全由宿主执行器接管
        return new GateL2Result({ passed: true });
      }
    }

    const gateInstance = new HostGate();
    const params = new TunableParams({ weights: { A: 0.6, B: 0.6 } });
    const result = await new MetaTuner().tune_with_regression(
      params,
      new TurnMetrics(),
      param_fixtures(),
      { feedback: { A: 0.0, B: 0.0 }, gate: gateInstance },
    );
    expect(result.params.weights['A']!).toBeLessThan(0.6); // 变更经宿主闸门生效
    expect(result.note).toBe('');
  });
});

describe('参数快照落库集成点（snapshot sink）', () => {
  it('回归通过 → sink 收到快照；拒绝 → 不收', async () => {
    const sinks: unknown[] = [];
    const tuner = new MetaTuner({
      snapshot_sink: (snapshot) => {
        sinks.push(snapshot);
      },
    });
    const params = new TunableParams({
      weights: { A: 0.5, B: 0.5 },
      thresholds: { pass: 0.6 },
    });
    const metrics = new TurnMetrics();

    // 回归通过 → 快照经 sink 落库（回放/审计按快照重算）
    const ok = await tuner.tune_with_regression(
      params,
      metrics,
      param_fixtures(),
      { feedback: { B: 0.1 }, rule_version: 'rules-v9', gate: gate() },
    );
    expect(ok.snapshot).not.toBeNull();
    expect(sinks.length).toBe(1);
    const saved = sinks[0] as { rule_version: string | null };
    expect(saved.rule_version).toBe('rules-v9');

    // 回归被拒 → 变更不生效，快照不落库
    const rejected = await tuner.tune_with_regression(
      params,
      metrics,
      param_fixtures({ weight_min: 0.5 }), // B 降权 0.45 < 0.5 → 越界拒绝
      { feedback: { B: 0.0 }, rule_version: 'rules-v10', gate: gate() },
    );
    expect(rejected.changes).toEqual([]);
    expect(sinks.length).toBe(1); // sink 未收到被拒变更的快照
  });
});
