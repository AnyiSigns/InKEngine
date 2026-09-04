/**
 * 进化工厂机制件（对标 test_knowledge_incubator.py 进化工厂纯逻辑段）：
 * 入队优先级（失败率优先/稳定者殿后）、候选收集过滤（ENG1-3：稳定高频零
 * 失败不入队、低活跃仍入队）、确定性变异（ENG1-10 深拷贝隔离母体、动态
 * 数量档位、无失败日志不产出无依据变异）、entry_metrics 母体指标基线。
 *
 * 零 IO、零执行器：闸门 seam（KnowledgeGate-like）注入与真实 executor/
 * real-storage 用例见 evolution_factory.test.ts 与 knowledge_gate /
 * evolution_writer 模块。
 */

import { describe, expect, it } from 'vitest';

import {
  DeterministicMutation,
  EvolutionCandidate,
  EvolutionFactory,
  entry_metrics,
} from '../../../src/core/evolution/index.js';
import type { JsonRecord } from '../../../src/core/json.js';
import { KnowledgeEntry } from '../../../src/core/knowledge_set/knowledge_entry.js';
import type { KnowledgeEntryOptions } from '../../../src/core/knowledge_set/knowledge_entry.js';

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

describe('entry_metrics 母体维度指标（L3 防退化基线）', () => {
  it('从未调用 = accuracy 1.0（无失败证据不降分）', () => {
    expect(
      entry_metrics(rule_entry('k-0', { usage_count: 0, fail_count: 0 })),
    ).toEqual({ accuracy: 1.0, safety: 1.0 });
  });

  it('有调用 = accuracy = 1 - 失败率（6 位定点）', () => {
    expect(
      entry_metrics(rule_entry('k-1', { usage_count: 10, fail_count: 4 })),
    ).toEqual({ accuracy: 0.6, safety: 1.0 });
  });

  it('失败率钳位 1.0（失败记录异常超额不产生负 accuracy）', () => {
    expect(
      entry_metrics(rule_entry('k-2', { usage_count: 10, fail_count: 20 })),
    ).toEqual({ accuracy: 0.0, safety: 1.0 });
  });
});

describe('EvolutionCandidate 优先级（失败率 × 10 + 低活跃 × 1）', () => {
  it('入队排序：失败率优先、低活跃次之、稳定者殿后', () => {
    const failing = new EvolutionCandidate({
      entry: rule_entry('k-f'),
      failure_rate: 0.8,
      failure_logs: ['失败1'],
    });
    const idle = new EvolutionCandidate({
      entry: rule_entry('k-i'),
      failure_rate: 0.0,
      is_idle: true,
    });
    const stable = new EvolutionCandidate({
      entry: rule_entry('k-s'),
      failure_rate: 0.0,
    });
    const ranked = EvolutionFactory.rank([stable, idle, failing]);
    expect(ranked.map((c) => c.entry.id)).toEqual(['k-f', 'k-i', 'k-s']);
    expect(failing.priority).toBe(8.0);
    expect(idle.priority).toBe(1.0);
    expect(stable.priority).toBe(0.0);
  });
});

describe('collect_candidates 候选收集过滤', () => {
  it('从未调用不入队；失败率/低活跃入队（失败率按留痕推算）', () => {
    const never = rule_entry('k-0', { usage_count: 0 });
    const failing = rule_entry('k-1', { usage_count: 10, fail_count: 6 });
    const idle = rule_entry('k-2', { usage_count: 1 });
    const candidates = EvolutionFactory.collect_candidates([never, failing, idle]);
    const byId = new Map(candidates.map((c) => [c.entry.id, c]));
    expect(byId.has('k-0')).toBe(false);
    expect(byId.get('k-1')!.failure_rate).toBe(0.6);
    expect(byId.get('k-1')!.is_idle).toBe(false);
    expect(byId.get('k-2')!.is_idle).toBe(true); // 低活跃 + credibility>0
  });

  it('失败日志按条目 id 汇入候选（反思式变异输入）', () => {
    const failing = rule_entry('k-1', { usage_count: 10, fail_count: 6 });
    const noLog = rule_entry('k-2', { usage_count: 5, fail_count: 3 });
    const candidates = EvolutionFactory.collect_candidates([failing, noLog], {
      failure_logs: { 'k-1': ['失败A', '失败B'] },
    });
    const byId = new Map(candidates.map((c) => [c.entry.id, c]));
    expect(byId.get('k-1')!.failure_logs).toEqual(['失败A', '失败B']);
    expect(byId.get('k-2')!.failure_logs).toEqual([]); // 无留痕 = 空输入
  });

  it('ENG1-3：稳定高频零失败不入队；零失败低活跃与有失败者仍入队', () => {
    const stable = rule_entry('k-s', { usage_count: 100, fail_count: 0 });
    const lowActive = rule_entry('k-i', { usage_count: 1, fail_count: 0 });
    const someFail = rule_entry('k-f', { usage_count: 100, fail_count: 1 });
    const candidates = EvolutionFactory.collect_candidates([
      stable,
      lowActive,
      someFail,
    ]);
    const ids = new Set(candidates.map((c) => c.entry.id));
    expect(ids.has('k-s')).toBe(false); // 高频零失败稳定 → 不入队
    expect(ids.has('k-i')).toBe(true); // 零失败但低活跃 → 仍入队（长期未调用档）
    expect(ids.has('k-f')).toBe(true); // 有失败率 → 入队
  });

  it('idle_threshold 可覆写（低活跃判定阈值随使用方调度策略调整）', () => {
    const mid = rule_entry('k-m', { usage_count: 4, fail_count: 0 });
    const strict = EvolutionFactory.collect_candidates([mid]);
    const loose = EvolutionFactory.collect_candidates([mid], {
      idle_threshold: 5,
    });
    expect(strict.map((c) => c.entry.id)).toEqual([]);
    expect(loose.map((c) => c.entry.id)).toEqual(['k-m']);
  });
});

describe('DeterministicMutation 确定性变异基线', () => {
  it('ENG1-10：变异体深拷贝——改写嵌套结构不污染母体', () => {
    const mother = rule_entry('k-1', {
      data: { rule: { id: 'r1', config: { forbid: 'bad' } } },
    });
    const variants = new DeterministicMutation().mutate(mother, ['失败日志']);
    expect(variants).toHaveLength(1);
    // 变异体改写嵌套字段：母体不受影响（深拷贝隔离）
    const variantRule = variants[0]!['rule'] as JsonRecord;
    variantRule['config'] = { forbid: 'HACKED' };
    const motherRule = mother.data['rule'] as JsonRecord;
    expect((motherRule['config'] as JsonRecord)['forbid']).toBe('bad');
    // 变异标记：修订原因（基于日志）+ 母体 id（同知识不同版本随补丁链分支）
    expect(variants[0]!['_mutation']).toEqual({
      based_on: '失败日志',
      variant_of: 'k-1',
    });
    expect(mother.data['_mutation']).toBeUndefined();
  });

  it('变异体数量按失败率动态决定（高活跃多探索、低活跃单变体控膨胀）', () => {
    const mutation = new DeterministicMutation();
    const high = new EvolutionCandidate({
      entry: rule_entry(),
      failure_rate: 0.5,
      failure_logs: ['a', 'b', 'c'],
    });
    const highOverflow = new EvolutionCandidate({
      entry: rule_entry(),
      failure_rate: 0.8,
      failure_logs: ['a', 'b', 'c', 'd', 'e'],
    });
    const low = new EvolutionCandidate({
      entry: rule_entry(),
      failure_rate: 0.1,
      failure_logs: ['a'],
    });
    const lowMany = new EvolutionCandidate({
      entry: rule_entry(),
      failure_rate: 0.1,
      failure_logs: ['a', 'b', 'c'],
    });
    expect(mutation.variant_count(high)).toBe(3);
    expect(mutation.variant_count(highOverflow)).toBe(3); // 实例上限 3 截顶
    expect(mutation.variant_count(low)).toBe(1);
    expect(mutation.variant_count(lowMany)).toBe(1); // 低失败率恒单变体
  });

  it('无失败日志 = 无从反思，不产出无依据变异', () => {
    expect(new DeterministicMutation().mutate(rule_entry(), [])).toEqual([]);
  });

  it('多条失败日志 = 每条日志一个定向修订变体（失败驱动的定向探索）', () => {
    const mutation = new DeterministicMutation();
    const variants = mutation.mutate(rule_entry('k-1'), ['日志一', '日志二']);
    expect(variants).toHaveLength(2);
    expect(variants.map((v) => v['_mutation'])).toEqual([
      { based_on: '日志一', variant_of: 'k-1' },
      { based_on: '日志二', variant_of: 'k-1' },
    ]);
  });
});
