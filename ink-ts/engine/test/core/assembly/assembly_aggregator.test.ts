/**
 * 激活留痕利用率聚合单测（test_assembly.py MoE 借鉴部分 1:1 移植）：
 * 过热/过冷提示、drop 不计激活、InputAssembler 挂接聚合器随批喂留痕。
 */

import { describe, expect, it } from 'vitest';

import {
  SOURCE_CONTEXT,
  SOURCE_KNOWLEDGE,
  SOURCE_TOOL,
  ActivationAggregator,
  ActivationRecord,
  ActivationSummary,
  AssemblyConfig,
  InputAssembler,
  SourceActivation,
} from '../../../src/core/assembly/index.js';
import { MODE_DROP } from '../../../src/core/context/context_types.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';
import { _source } from './helpers.js';

/** 断言抛 GraphDefinitionError 且消息匹配（镜像 pytest.raises match）。 */
function expectGraphError(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GraphDefinitionError);
    expect(String((error as Error).message)).toMatch(pattern);
    return;
  }
  throw new Error('期望抛出 GraphDefinitionError，实际未抛');
}

/** 激活记录构造辅助（无条目引用 → 不参与聚合；全 keep_full）。 */
function _record(...refs: string[]): ActivationRecord {
  return new ActivationRecord({
    total_budget: 100,
    assembled_chars: 50,
    sources: refs.map(
      (ref) =>
        new SourceActivation({
          source_type: SOURCE_KNOWLEDGE,
          title: ref,
          weight: 1.0,
          relevance: 0.5,
          char_limit: 30,
          mode: 'keep_full',
          entry_ref: ref,
        }),
    ),
  });
}

/** 单条激活构造辅助（聚合器场景可指定 char_limit/mode/weight）。 */
function _activation(
  entry_ref: string,
  char_limit: number,
  mode: string,
  weight = 1.0,
): SourceActivation {
  return new SourceActivation({
    source_type: SOURCE_KNOWLEDGE,
    title: 't',
    weight,
    relevance: 0.5,
    char_limit,
    mode,
    entry_ref,
  });
}

describe('test_assembly：激活利用率聚合', () => {
  it('test_aggregator_utilization_and_overheated：高频激活条目判过热', () => {
    const aggregator = new ActivationAggregator({
      overheated_rate: 0.85,
      cold_window: 5,
    });
    for (let i = 0; i < 5; i++) {
      if (i === 4) {
        aggregator.record(_record('k-hot')); // k-other 本轮未激活
      } else {
        aggregator.record(_record('k-hot', 'k-other'));
      }
    }
    const summary = aggregator.snapshot();
    expect(summary.calls).toBe(5);
    expect(summary.total_refs).toBe(2);
    expect(summary.utilization).toBe(1.0);
    expect(summary.overheated).toEqual(['k-hot']); // 激活率 1.0 ≥ 0.85
    expect(summary.overheated.includes('k-other')).toBe(false); // 0.8 < 0.85
    const by_ref = new Map(
      summary.per_entry.map((s) => [s.entry_ref, s] as const),
    );
    expect(by_ref.get('k-hot')?.activations).toBe(5);
    expect(by_ref.get('k-hot')?.activation_rate).toBe(1.0);
    expect(by_ref.get('k-other')?.activation_rate).toBe(0.8);
  });

  it('test_aggregator_cold_after_window：窗口内零激活 → 过冷归档候选', () => {
    const aggregator = new ActivationAggregator({
      overheated_rate: 0.8,
      cold_window: 3,
    });
    aggregator.record(_record('k-cold')); // 第 1 次调用激活
    for (let i = 0; i < 3; i++) {
      aggregator.record(_record('k-other')); // 之后只激活另一个
    }
    const summary = aggregator.snapshot();
    expect(summary.calls).toBe(4);
    expect(summary.cold).toEqual(['k-cold']); // 最近 3 次调用零激活
    expect(summary.active_refs).toBe(1);
    expect(summary.utilization).toBe(0.5);
  });

  it('test_aggregator_empty_and_single_call：空快照/单次调用不判过热', () => {
    const empty = new ActivationAggregator().snapshot();
    expect(empty.calls).toBe(0);
    expect(empty.overheated).toEqual([]);
    expect(empty.cold).toEqual([]);

    const aggregator = new ActivationAggregator();
    aggregator.record(_record('k-1'));
    const summary = aggregator.snapshot();
    expect(summary.calls).toBe(1);
    expect(summary.overheated).toEqual([]); // 单次调用不判定
  });

  it('test_aggregator_summary_roundtrip：利用率快照序列化 round-trip', () => {
    const aggregator = new ActivationAggregator();
    aggregator.record(_record('k-1', 'k-2'));
    const summary = aggregator.snapshot();
    const rebuilt = ActivationSummary.from_dict(summary.to_dict());
    expect(rebuilt.calls).toBe(summary.calls);
    expect(rebuilt.total_refs).toBe(summary.total_refs);
    expect(rebuilt.overheated).toEqual(summary.overheated);
    expect(rebuilt.cold).toEqual(summary.cold);
    expect(rebuilt.per_entry.map((s) => s.entry_ref)).toEqual(
      summary.per_entry.map((s) => s.entry_ref),
    );
  });

  it('test_aggregator_invalid_params_rejected：聚合阈值非法拒绝', () => {
    expectGraphError(
      () => new ActivationAggregator({ overheated_rate: 1.5 }),
      /过热/,
    );
    expectGraphError(
      () => new ActivationAggregator({ cold_window: 0 }),
      /过冷窗口/,
    );
  });

  it('test_aggregator_skips_unnamed_sources：无条目引用的源不参与聚合', () => {
    const aggregator = new ActivationAggregator();
    aggregator.record(
      new ActivationRecord({
        total_budget: 100,
        assembled_chars: 50,
        sources: [
          new SourceActivation({
            source_type: SOURCE_CONTEXT,
            title: '对话',
            weight: 1.0,
            relevance: 0.5,
            char_limit: 30,
            mode: 'keep_full',
            entry_ref: '', // 无条目引用
          }),
          new SourceActivation({
            source_type: SOURCE_KNOWLEDGE,
            title: '知识',
            weight: 1.0,
            relevance: 0.5,
            char_limit: 30,
            mode: 'keep_full',
            entry_ref: 'k-1',
          }),
        ],
      }),
    );
    const summary = aggregator.snapshot();
    expect(summary.total_refs).toBe(1);
    expect(summary.per_entry[0]?.entry_ref).toBe('k-1');
  });

  it('test_aggregator_skips_dropped_sources：drop/零分配源不计激活', () => {
    const aggregator = new ActivationAggregator();
    aggregator.record(
      new ActivationRecord({
        total_budget: 100,
        assembled_chars: 50,
        sources: [
          _activation('kept', 30, 'keep_full'),
          _activation('dropped', 0, MODE_DROP),
          _activation('zero', 0, 'truncate'),
        ],
      }),
    );
    const summary = aggregator.snapshot();
    const refs = new Set(summary.per_entry.map((s) => s.entry_ref));
    expect(refs).toEqual(new Set(['kept']));
    expect(summary.total_refs).toBe(1);
  });

  it('test_aggregator_compressed_and_truncated_still_count：非丢弃档仍计激活', () => {
    const aggregator = new ActivationAggregator();
    aggregator.record(
      new ActivationRecord({
        total_budget: 100,
        assembled_chars: 50,
        sources: [
          _activation('trunc', 20, 'truncate'),
          _activation('comp', 10, 'compressed'),
        ],
      }),
    );
    const summary = aggregator.snapshot();
    expect(summary.total_refs).toBe(2);
    expect(summary.active_refs).toBe(2);
  });

  it('test_input_assembler_feeds_aggregator：InputAssembler 挂接聚合器随批喂留痕', () => {
    const aggregator = new ActivationAggregator();
    const assembler = new InputAssembler(
      new AssemblyConfig({ total_budget: 1000 }),
      { aggregator },
    );
    const result = assembler.assemble(
      [
        _source(SOURCE_KNOWLEDGE, '知识甲', { weight: 1.0, entry_ref: 'k1' }),
        _source(SOURCE_KNOWLEDGE, '知识乙', { weight: 1.0, entry_ref: 'k2' }),
      ],
      { total_budget: 1000 },
    );
    expect(result.record.assembled_chars).toBeGreaterThan(0);
    const summary = aggregator.snapshot();
    expect(summary.calls).toBe(1);
    expect(summary.total_refs).toBe(2);
    // 预算裁剪下 drop 源不误计：工具超上限被丢的条目不进聚合
    const aggregator2 = new ActivationAggregator();
    const assembler2 = new InputAssembler(
      new AssemblyConfig({ total_budget: 300, max_tools: 1 }),
      { aggregator: aggregator2 },
    );
    const tools = Array.from({ length: 3 }, (_, i) =>
      _source(SOURCE_TOOL, `工具${i}定义内容 `.repeat(20), {
        weight: 1.0,
        entry_ref: `tool${i}`,
      }),
    );
    assembler2.assemble(tools, { total_budget: 300 });
    const summary2 = aggregator2.snapshot();
    expect(summary2.total_refs).toBeLessThanOrEqual(1); // 被裁剪的工具不计激活
  });
});
