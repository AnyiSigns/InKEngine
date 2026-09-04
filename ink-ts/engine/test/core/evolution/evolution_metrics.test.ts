/**
 * EvolutionFactory.evolve 指标接线（evolution_factory.test.ts 的姊妹文件）：
 * evaluate 钩子产物接入 L3 new_metrics（schema/fixtures 原样透传、异常回落
 * 默认口径）；old_metrics 防退化基线——未传时按母体调用留痕派生（ENG1-1：
 * accuracy = 1 - 失败率，劣于母体不过 L3）。
 *
 * 闸门 seam（KnowledgeGate-like）注入；executor / real-storage 暂缓清单与
 * 主文件 evolution_factory.test.ts 头注一致。
 */

import { describe, expect, it } from 'vitest';

import {
  DeterministicMutation,
  EvolutionCandidate,
  EvolutionFactory,
  type EvolutionGate,
  type MutationStrategy,
} from '../../../src/core/evolution/index.js';
import type { JsonRecord } from '../../../src/core/json.js';
import { GateL1Result, GateL2Result, GateL3Result } from '../../../src/core/knowledge_gate/index.js';
import { KnowledgeEntry } from '../../../src/core/knowledge_set/knowledge_entry.js';
import type { KnowledgeEntryOptions } from '../../../src/core/knowledge_set/knowledge_entry.js';

type CheckOptions = Parameters<EvolutionGate['check']>[1];

/** 规则条目工厂（闸门 seam 下的承载载体——data 形态不参与执行语义）。 */
function rule_entry(
  id = 'k-1',
  extra: Partial<KnowledgeEntryOptions> = {},
): KnowledgeEntry {
  return new KnowledgeEntry({
    id,
    level: 'work',
    kind: 'rule',
    data: {
      rule: {
        id: `r-${id}`,
        message: '规则',
        predicate: 'forbid_value',
        config: { forbid: 'bad' },
        kind: 'rule',
      },
    },
    source: 'model',
    credibility: 0.7,
    title: '规则',
    ...extra,
  });
}

function pass(): [GateL1Result, GateL2Result, GateL3Result] {
  return [
    new GateL1Result({ passed: true }),
    new GateL2Result({ passed: true }),
    new GateL3Result({ passed: true }),
  ];
}

function fail_l3(reason: string): [GateL1Result, GateL2Result, GateL3Result] {
  return [
    new GateL1Result({ passed: true }),
    new GateL2Result({ passed: true }),
    new GateL3Result({ passed: false, reason }),
  ];
}

/** 假闸门（KnowledgeGate-like seam）：默认全过 + 全程调用留痕。 */
class ScriptedGate implements EvolutionGate {
  readonly calls: Array<{ entry: KnowledgeEntry; options: CheckOptions }> = [];

  async check(
    entry: KnowledgeEntry,
    options: CheckOptions,
  ): Promise<readonly [GateL1Result, GateL2Result, GateL3Result]> {
    this.calls.push({ entry, options });
    return pass();
  }
}

describe('evolve evaluate 钩子与指标接线', () => {
  it('evaluate 产物作为 new_metrics 传入 L3；schema/fixtures/regression 原样透传', async () => {
    const evaluated: Array<{
      variant_data: JsonRecord;
      schema: unknown;
      fixtures: unknown;
    }> = [];
    class EvaluatedMutation extends DeterministicMutation {
      async evaluate(
        variant_data: JsonRecord,
        schema: unknown,
        fixtures: unknown,
      ): Promise<Record<string, number> | null> {
        evaluated.push({ variant_data, schema, fixtures });
        return { accuracy: 0.9, safety: 1.0 };
      }
    }
    const gate = new ScriptedGate();
    const candidate = new EvolutionCandidate({
      entry: rule_entry('k-1'),
      failure_rate: 0.4,
      failure_logs: ['失败日志'],
    });
    const regression = { cases: ['r1'] };
    const outcome = await new EvolutionFactory(
      gate,
      new EvaluatedMutation(),
    ).evolve(candidate, {
      schema: { name: 'knowledge_entry' },
      fixtures: { name: 'demo' },
      regression,
    });
    expect(outcome.kept).toBe(1);
    // evaluate 钩子收到变异体 data + schema/fixtures（反思式变异评估口）
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]!.schema).toEqual({ name: 'knowledge_entry' });
    expect(evaluated[0]!.fixtures).toEqual({ name: 'demo' });
    // new_metrics 由钩子产物接入 L3；old_metrics 由工厂传给闸门
    expect(gate.calls[0]!.options.new_metrics).toEqual({ accuracy: 0.9, safety: 1.0 });
    expect(gate.calls[0]!.options.old_metrics).toEqual({ accuracy: 1.0, safety: 1.0 });
    expect(gate.calls[0]!.options.regression).toEqual({ cases: ['r1'] });
    expect(gate.calls[0]!.options.schema).toEqual({ name: 'knowledge_entry' });
    expect(gate.calls[0]!.options.fixtures).toEqual({ name: 'demo' });
  });

  it('evaluate 异常 = 回落默认口径（new_metrics=null，不阻断进化）', async () => {
    class ThrowingMutation implements MutationStrategy {
      mutate(entry: KnowledgeEntry): JsonRecord[] {
        return [{ ...entry.data, _mutation: { based_on: 'x', variant_of: entry.id } }];
      }

      async evaluate(): Promise<Record<string, number> | null> {
        throw new Error('评估器故障');
      }
    }
    const gate = new ScriptedGate();
    const candidate = new EvolutionCandidate({
      entry: rule_entry('k-1'),
      failure_rate: 0.4,
      failure_logs: ['失败日志'],
    });
    const outcome = await new EvolutionFactory(gate, new ThrowingMutation()).evolve(
      candidate,
      { schema: 's', fixtures: 'f' },
    );
    expect(outcome.kept).toBe(1);
    expect(gate.calls[0]!.options.new_metrics).toBeNull();
  });
});

describe('evolve old_metrics 防退化基线（ENG1-1）', () => {
  /** 假 L3 基线：new accuracy 低于 old accuracy 即拒绝（seam 内联闸门语义）。 */
  class BaselineGate implements EvolutionGate {
    readonly calls: Array<{ entry: KnowledgeEntry; options: CheckOptions }> = [];

    async check(entry: KnowledgeEntry, options: CheckOptions) {
      this.calls.push({ entry, options });
      const oldAccuracy = options.old_metrics?.['accuracy'] ?? 1.0;
      const newAccuracy = options.new_metrics?.['accuracy'] ?? 1.0;
      if (newAccuracy < oldAccuracy) {
        return fail_l3('劣于旧版: accuracy');
      }
      return pass();
    }
  }

  function motherWithUsage(): KnowledgeEntry {
    return rule_entry('k-1', { usage_count: 10, fail_count: 4 });
  }

  function metered(accuracy: number): MutationStrategy {
    return {
      mutate(entry: KnowledgeEntry, logs: readonly string[]): JsonRecord[] {
        return logs.map((log) => ({
          ...entry.data,
          _mutation: { based_on: log, variant_of: entry.id },
        }));
      },
      async evaluate(): Promise<Record<string, number> | null> {
        return { accuracy, safety: 1.0 };
      },
    };
  }

  it('未传 old_metrics = 按母体调用留痕派生（accuracy = 1 - 失败率）', async () => {
    const gate = new BaselineGate();
    const candidate = new EvolutionCandidate({
      entry: motherWithUsage(),
      failure_rate: 0.4,
      failure_logs: ['失败日志'],
    });
    const outcome = await new EvolutionFactory(gate, metered(0.4)).evolve(
      candidate,
      { schema: 's', fixtures: 'f' },
    );
    // 母体成功率 0.6；变异体 0.4 劣于母体 → L3 拒绝（防退化不再被绕过）
    expect(gate.calls[0]!.options.old_metrics).toEqual({ accuracy: 0.6, safety: 1.0 });
    expect(outcome.kept).toBe(0);
    expect(outcome.rejected.some((r) => r.includes('L3'))).toBe(true);
  });

  it('优于母体的变异体按派生基线保留（ENG1-1 正向）', async () => {
    const gate = new BaselineGate();
    const candidate = new EvolutionCandidate({
      entry: motherWithUsage(),
      failure_rate: 0.4,
      failure_logs: ['失败日志'],
    });
    const outcome = await new EvolutionFactory(gate, metered(0.9)).evolve(
      candidate,
      { schema: 's', fixtures: 'f' },
    );
    expect(outcome.kept).toBe(1);
  });

  it('显式 old_metrics 原样传入（调用方口径优先于派生）', async () => {
    const gate = new ScriptedGate();
    const candidate = new EvolutionCandidate({
      entry: motherWithUsage(),
      failure_rate: 0.4,
      failure_logs: ['失败日志'],
    });
    await new EvolutionFactory(gate).evolve(candidate, {
      schema: 's',
      fixtures: 'f',
      old_metrics: { accuracy: 0.95, latency: 0.7, safety: 1.0 },
    });
    expect(gate.calls[0]!.options.old_metrics).toEqual({
      accuracy: 0.95,
      latency: 0.7,
      safety: 1.0,
    });
  });
});
