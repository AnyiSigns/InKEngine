/**
 * EvolutionFactory.evolve 语义（对标 test_knowledge_incubator.py 进化工厂
 * 段——按 seam 注入 KnowledgeGate-like 的迁移口径改写）：反思式变异（失败
 * 日志驱动）→ 逐变体过三层闸门 → 保留不退化者；无日志拒绝文案区分（ENG1-
 * 22）；变异体数量动态接线；evaluate 钩子指标入 L3 new_metrics；old_metrics
 * 派生防退化基线（ENG1-1）。
 *
 * 暂缓用例（header note，属 real-storage / executor）：
 * - executor：Python 进化工厂用例以真实 KnowledgeGate + GateL2FixtureExecutor
 *   + forbid_value 谓词注册表跑规则样例（degraded/good variant 的 L2 拦/放、
 *   L3 劣于母体拒绝、CountingMutation 全绿过闸）——真实执行语义由
 *   knowledge_gate 规则执行器承载，待规则集成接线后按 knowledge_gate_helpers
 *   的 rule_schema/fixtures/rule_registry 形态补测（闸门自身语义已由
 *   knowledge_gate 测试覆盖）；
 * - real-storage：evolve 产物落库（补丁链 append / GuardedStorage）由
 *   evolution_writer 与存储面承接——本模块 zero-IO 不持存储。
 */

import { describe, expect, it } from 'vitest';

import {
  DeterministicMutation,
  EvolutionCandidate,
  EvolutionFactory,
  EvolutionOutcome,
  type EvolutionGate,
  type MutationStrategy,
} from '../../../src/core/evolution/index.js';
import type { JsonRecord } from '../../../src/core/json.js';
import {
  GateL1Result,
  GateL2Result,
  GateL3Result,
  KnowledgeGate,
} from '../../../src/core/knowledge_gate/index.js';
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

/** 三层结果工厂。 */
function pass(): [GateL1Result, GateL2Result, GateL3Result] {
  return [
    new GateL1Result({ passed: true }),
    new GateL2Result({ passed: true }),
    new GateL3Result({ passed: true }),
  ];
}

function fail_l2(note: string): [GateL1Result, GateL2Result, GateL3Result] {
  return [
    new GateL1Result({ passed: true }),
    new GateL2Result({ passed: false, note }),
    new GateL3Result({ passed: false }),
  ];
}

function fail_l1(errors: string[]): [GateL1Result, GateL2Result, GateL3Result] {
  return [
    new GateL1Result({ passed: false, errors }),
    new GateL2Result({ passed: false }),
    new GateL3Result({ passed: false }),
  ];
}

function fail_l3(reason: string): [GateL1Result, GateL2Result, GateL3Result] {
  return [
    new GateL1Result({ passed: true }),
    new GateL2Result({ passed: true }),
    new GateL3Result({ passed: false, reason }),
  ];
}

/** 假闸门（KnowledgeGate-like seam）：可编程队列 + 全程调用留痕。 */
class ScriptedGate implements EvolutionGate {
  readonly calls: Array<{ entry: KnowledgeEntry; options: CheckOptions }> = [];
  private readonly queue: Array<
    () => [GateL1Result, GateL2Result, GateL3Result]
  > = [];

  enqueue(
    make: () => [GateL1Result, GateL2Result, GateL3Result],
  ): void {
    this.queue.push(make);
  }

  async check(
    entry: KnowledgeEntry,
    options: CheckOptions,
  ): Promise<readonly [GateL1Result, GateL2Result, GateL3Result]> {
    this.calls.push({ entry, options });
    const make = this.queue.shift();
    return make !== undefined ? make() : pass();
  }
}

describe('evolve 无失败日志拒绝文案（ENG1-22）', () => {
  it('失败率 = 0 = 稳定条目（无失败可反思）；有失败率无日志 = 留痕缺口', async () => {
    const gate = new ScriptedGate();
    const factory = new EvolutionFactory(gate);
    const stable = new EvolutionCandidate({
      entry: rule_entry('k-s'),
      failure_rate: 0.0,
    });
    const missing = new EvolutionCandidate({
      entry: rule_entry('k-m'),
      failure_rate: 0.5,
    });
    const out1 = await factory.evolve(stable, { schema: 's', fixtures: 'f' });
    const out2 = await factory.evolve(missing, { schema: 's', fixtures: 'f' });
    expect(out1.kept).toBe(0);
    expect(out1.rejected.some((r) => r.includes('稳定条目无失败可反思'))).toBe(true);
    expect(out2.rejected.some((r) => r.includes('日志缺失'))).toBe(true);
    expect(out1.rejected.some((r) => r.includes('日志缺失'))).toBe(false);
    expect(gate.calls).toHaveLength(0); // 无日志短路，不触闸门
  });
});

describe('evolve 全闸通过保留变异体（默认确定性变异）', () => {
  it('多日志多变体保留：id 派生、标题标记、修订留痕、母体不受污染', async () => {
    const mother = rule_entry('k-1', {
      usage_count: 10,
      fail_count: 6,
      tags: ['t1'],
      data: {
        rule: {
          id: 'r1',
          message: '规则',
          predicate: 'forbid_value',
          config: { forbid: 'bad' },
          kind: 'rule',
        },
      },
    });
    const candidate = new EvolutionCandidate({
      entry: mother,
      failure_rate: 0.6,
      failure_logs: ['日志一', '日志二'],
    });
    const gate = new ScriptedGate();
    const outcome = await new EvolutionFactory(gate).evolve(candidate, {
      schema: 's',
      fixtures: 'f',
    });
    expect(outcome).toBeInstanceOf(EvolutionOutcome);
    expect(outcome.kept).toBe(2);
    expect(outcome.rejected).toEqual([]);
    expect(outcome.variants.map((v) => v.id)).toEqual(['k-1:v1', 'k-1:v2']);
    expect(outcome.gate_results).toHaveLength(2);
    expect(outcome.gate_results.every((l3) => l3.passed)).toBe(true);
    for (let i = 0; i < 2; i++) {
      const variant = outcome.variants[i]!;
      expect(variant.title).toBe('规则（变异）');
      expect(variant.level).toBe('work');
      expect(variant.kind).toBe('rule');
      expect(variant.tags).toEqual(['t1']); // 母体标签继承
      expect(variant.data['_mutation']).toEqual({
        based_on: `日志${i === 0 ? '一' : '二'}`,
        variant_of: 'k-1',
      });
    }
    // 母体 data 不被改写（无 _mutation、嵌套 config 原样）
    expect(mother.data['_mutation']).toBeUndefined();
    const motherRule = mother.data['rule'] as JsonRecord;
    expect((motherRule['config'] as JsonRecord)['forbid']).toBe('bad');
    // 每次过闸都带上变异体（变异输入 = 失败日志，非成功轨迹）
    expect(gate.calls.map((c) => c.entry.id)).toEqual(['k-1:v1', 'k-1:v2']);
  });
});

describe('evolve 变异体数量动态接线', () => {
  /** 每条失败日志产出一个修订变体（样例可接受形态）——覆写 mutate，
   *   variant_count 继承动态档位。 */
  class CountingMutation extends DeterministicMutation {
    constructor() {
      super(3);
    }

    mutate(entry: KnowledgeEntry, logs: readonly string[]): JsonRecord[] {
      return logs.map((log) => ({
        ...entry.data,
        rule: {
          ...((entry.data['rule'] as JsonRecord | undefined) ?? {}),
          config: { forbid: 'bad' },
        },
        _mutation: { based_on: log, variant_of: entry.id },
      }));
    }
  }

  it('高失败率 3 条日志 → 3 变体全过闸；低失败率同日志量 → 单变体（控膨胀）', async () => {
    const mother = rule_entry('k-1', {
      data: {
        rule: {
          id: 'r1',
          message: '规则',
          predicate: 'forbid_value',
          config: { forbid: 'ok' },
          kind: 'rule',
        },
      },
    });
    const high = new EvolutionCandidate({
      entry: mother,
      failure_rate: 0.5,
      failure_logs: ['日志一', '日志二', '日志三'],
    });
    const low = new EvolutionCandidate({
      entry: mother,
      failure_rate: 0.1,
      failure_logs: ['日志一', '日志二', '日志三'],
    });
    const factory = new EvolutionFactory(new ScriptedGate(), new CountingMutation());
    const highOutcome = await factory.evolve(high, { schema: 's', fixtures: 'f' });
    expect(highOutcome.kept).toBe(3);
    expect(highOutcome.variants.map((v) => v.id)).toEqual([
      'k-1:v1',
      'k-1:v2',
      'k-1:v3',
    ]);
    const lowOutcome = await factory.evolve(low, { schema: 's', fixtures: 'f' });
    expect(lowOutcome.kept).toBe(1); // 低失败率单变体（防知识膨胀）
  });
});

describe('evolve 闸门拒绝留痕（防退化不落库）', () => {
  const candidate = new EvolutionCandidate({
    entry: rule_entry('k-1'),
    failure_rate: 0.5,
    failure_logs: ['失败日志'],
  });

  it('L3 拒绝 = 劣于旧版（防退化底线：不差于旧版才保留）', async () => {
    const gate = new ScriptedGate();
    gate.enqueue(() => fail_l3('劣于旧版: accuracy'));
    const outcome = await new EvolutionFactory(gate).evolve(candidate, {
      schema: 's',
      fixtures: 'f',
    });
    expect(outcome.kept).toBe(0);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]).toContain('L3 未通过（劣于旧版');
    expect(outcome.gate_results[0]!.passed).toBe(false);
  });

  it('L2 拒绝（fixture 非谈判项）——留痕注明 L2', async () => {
    const gate = new ScriptedGate();
    gate.enqueue(() => fail_l2('样例未全绿: x'));
    const outcome = await new EvolutionFactory(gate).evolve(candidate, {
      schema: 's',
      fixtures: 'f',
    });
    expect(outcome.kept).toBe(0);
    expect(outcome.rejected[0]).toContain('L2 未通过（样例未全绿: x）');
  });

  it('L1 拒绝——错误清单入留痕（短路占位信息缺失时的兜底）', async () => {
    const gate = new ScriptedGate();
    gate.enqueue(() => fail_l1(['格式错误: id 缺失']));
    const outcome = await new EvolutionFactory(gate).evolve(candidate, {
      schema: 's',
      fixtures: 'f',
    });
    expect(outcome.kept).toBe(0);
    expect(outcome.rejected[0]).toContain('L1 未通过');
    expect(outcome.rejected[0]).toContain('格式错误: id 缺失');
  });
});

describe('EvolutionGate seam 与真实闸门', () => {
  it('真实 KnowledgeGate 结构上满足 seam（接线可直接注入）', () => {
    const gate: EvolutionGate = new KnowledgeGate();
    expect(typeof gate.check).toBe('function');
  });
});
