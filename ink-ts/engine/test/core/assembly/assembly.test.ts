/**
 * 输入调配管线单测（test_assembly.py 1:1 移植）：多源统一预算/激活留痕/
 * 一键开关/组装期条目内压缩。预算分配细节（注入分配器/两遍分配/源块边界
 * 回退/别名）见 assembly_budget.test.ts。
 *
 * 执行器接线相关用例（ctx.assemble / input_assembly 事件体裁剪 / 预装配 /
 * spawn 装配传播——依赖 Engine/RunOptions/Graph，随 executor 模块迁移后
 * 补测）已按迁移批次 defer：
 *   test_executor_ctx_assemble_wiring
 *   test_executor_input_assembly_event_trimmed
 *   test_executor_ctx_assemble_disabled_fallback
 *   test_executor_ctx_assemble_then_plan_coexist
 *   test_executor_preassemble_wiring
 *   test_executor_preassemble_disabled_skips
 *   test_executor_preassemble_cache_reset_per_node
 *   test_spawn_instance_inherits_assembly
 */

import { describe, expect, it } from 'vitest';

import {
  SOURCE_CONTEXT,
  SOURCE_KNOWLEDGE,
  SOURCE_MEMORY,
  SOURCE_TOOL,
  ActivationRecord,
  AssemblyConfig,
  InputAssembler,
  SourceActivation,
} from '../../../src/core/assembly/index.js';
import type { EntryCompressor } from '../../../src/core/assembly/index.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';
import { _source, _summary_compressor } from './helpers.js';

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

/** 知识源独占的装配配置（压缩测试聚焦知识池，其余分级占比清零）。 */
function _knowledge_only_config(): AssemblyConfig {
  return new AssemblyConfig({
    total_budget: 300,
    knowledge_ratio: 1.0,
    context_ratio: 0.0,
    tool_ratio: 0.0,
    memory_ratio: 0.0,
    evidence_ratio: 0.0,
  });
}

describe('test_assembly：统一预算分配', () => {
  it('test_total_budget_never_exceeded：多源调配合计不超调用点总预算', () => {
    const config = new AssemblyConfig({ total_budget: 500 });
    const assembler = new InputAssembler(config);
    const sources = [
      _source(SOURCE_CONTEXT, '对话历史 '.repeat(30), { weight: 1.0 }),
      _source(SOURCE_KNOWLEDGE, '知识条目 '.repeat(30), { weight: 0.8 }),
      _source(SOURCE_TOOL, '工具定义 '.repeat(20), { weight: 0.9 }),
    ];
    const result = assembler.assemble(sources, { total_budget: 500 });
    expect(result.text.length).toBeLessThanOrEqual(500);
    expect(result.record.total_budget).toBe(500);
    expect(result.record.assembled_chars).toBe(result.text.length);
  });

  it('test_full_activation_when_fits：能全量则全量（整包激活）', () => {
    const assembler = new InputAssembler(new AssemblyConfig({ total_budget: 1000 }));
    const sources = [
      _source(SOURCE_CONTEXT, '对话'),
      _source(SOURCE_KNOWLEDGE, '知识'),
      _source(SOURCE_TOOL, '工具'),
    ];
    const result = assembler.assemble(sources, { total_budget: 1000 });
    expect(result.record.sources.every((s) => s.mode === 'keep_full')).toBe(true);
    expect(result.text).toContain('对话');
    expect(result.text).toContain('知识');
    expect(result.text).toContain('工具');
  });

  it('test_tool_limit_applied：工具激活数上限裁剪（被裁剪工具同样留痕）', () => {
    const assembler = new InputAssembler(
      new AssemblyConfig({ total_budget: 300, max_tools: 2 }),
    );
    const sources = Array.from({ length: 5 }, (_, i) =>
      _source(SOURCE_TOOL, `工具${i}定义 `.repeat(10), {
        weight: 1.0,
        relevance: 0.9,
      }),
    );
    const result = assembler.assemble(sources, { total_budget: 300 });
    const tool_activations = result.record.sources.filter(
      (s) => s.source_type === SOURCE_TOOL,
    );
    const kept_tools = tool_activations.filter((s) => s.char_limit > 0);
    const dropped_tools = tool_activations.filter((s) => s.char_limit === 0);
    expect(kept_tools.length).toBeLessThanOrEqual(2);
    expect(kept_tools.length + dropped_tools.length).toBe(sources.length); // 全量留痕
    expect(dropped_tools.every((s) => s.mode === 'drop')).toBe(true);
    expect(
      dropped_tools.every((s) => s.note.includes('工具激活数超上限')),
    ).toBe(true);
  });

  it('test_grouped_budget_allocation：分级池分配（多源按占比分池）', () => {
    const config = new AssemblyConfig({
      total_budget: 1000,
      context_ratio: 0.5,
      knowledge_ratio: 0.3,
      tool_ratio: 0.1,
      memory_ratio: 0.1,
      evidence_ratio: 0.0,
    });
    const assembler = new InputAssembler(config);
    const sources = [
      _source(SOURCE_CONTEXT, '上下文内容 '.repeat(50), { weight: 1.0 }),
      _source(SOURCE_KNOWLEDGE, '知识内容 '.repeat(50), { weight: 1.0 }),
      _source(SOURCE_TOOL, '工具内容 '.repeat(50), { weight: 1.0 }),
      _source(SOURCE_MEMORY, '记忆内容 '.repeat(50), { weight: 1.0 }),
    ];
    const result = assembler.assemble(sources, { total_budget: 1000 });
    expect(result.text.length).toBeLessThanOrEqual(1000);
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe('test_assembly：激活留痕与开关', () => {
  it('test_version_snapshot_in_activation_record：留痕含版本快照', () => {
    const assembler = new InputAssembler();
    const result = assembler.assemble(
      [_source(SOURCE_KNOWLEDGE, '知识')],
      { version_snapshot: { rules: 'rules-v3', knowledge: 'ks-42' } },
    );
    expect(result.record.version_snapshot).toEqual({
      rules: 'rules-v3',
      knowledge: 'ks-42',
    });
  });

  it('test_activation_record_roundtrip：激活记录序列化 round-trip', () => {
    const record = new ActivationRecord({
      total_budget: 100,
      assembled_chars: 50,
      sources: [
        new SourceActivation({
          source_type: SOURCE_KNOWLEDGE,
          title: '知识',
          weight: 0.8,
          relevance: 0.6,
          char_limit: 30,
          mode: 'truncate',
          entry_ref: 'k-1',
        }),
      ],
      version_snapshot: { rules: 'v2' },
    });
    const rebuilt = ActivationRecord.from_dict(record.to_dict());
    expect(rebuilt.total_budget).toBe(100);
    expect(rebuilt.assembled_chars).toBe(50);
    expect(rebuilt.sources[0]?.entry_ref).toBe('k-1');
    expect(rebuilt.sources[0]?.mode).toBe('truncate');
    expect(rebuilt.version_snapshot).toEqual({ rules: 'v2' });
  });

  it('test_disabled_assembly_rejected：enabled=False → 装配拒绝', () => {
    const assembler = new InputAssembler(new AssemblyConfig({ enabled: false }));
    expectGraphError(
      () => assembler.assemble([_source(SOURCE_CONTEXT, '对话')]),
      /已禁用/,
    );
  });

  it('test_unknown_source_type_rejected：未知源类别拒绝', () => {
    const assembler = new InputAssembler();
    expectGraphError(
      () => assembler.assemble([_source('ghost', '未知类别')]),
      /未知装配源类别/,
    );
  });

  it('test_config_ratio_sum_validation：分级占比合计超限拒绝', () => {
    expectGraphError(
      () => new AssemblyConfig({ context_ratio: 0.7, knowledge_ratio: 0.5 }),
      /合计超限/,
    );
  });

  it('test_config_roundtrip：装配配置序列化 round-trip', () => {
    const config = new AssemblyConfig({
      enabled: false,
      total_budget: 6000,
      context_ratio: 0.5,
      max_tools: 6,
    });
    const rebuilt = AssemblyConfig.from_dict(config.to_dict());
    expect(rebuilt.to_dict()).toEqual(config.to_dict());
  });

  it('test_negative_budget_rejected：非正预算拒绝（构造期暴露）', () => {
    expectGraphError(
      () => new AssemblyConfig({ total_budget: 0 }),
      /总预算/,
    );
  });

  it('test_empty_sources_produce_empty_result：无源 = 空装配不抛错', () => {
    const assembler = new InputAssembler();
    const result = assembler.assemble([], { total_budget: 100 });
    expect(result.text).toBe('');
    expect(result.record.sources).toEqual([]);
  });

  it('test_allocation_keeps_high_weight_sources：高权重源全保留', () => {
    const config = new AssemblyConfig({ total_budget: 200 });
    const assembler = new InputAssembler(config);
    const sources = [
      _source(SOURCE_KNOWLEDGE, '高可信知识 '.repeat(10), {
        weight: 1.0,
        relevance: 0.9,
      }),
      _source(SOURCE_KNOWLEDGE, '低可信噪音 '.repeat(10), {
        weight: 0.1,
        relevance: 0.1,
      }),
    ];
    const result = assembler.assemble(sources, { total_budget: 200 });
    expect(result.text).toContain('高可信知识');
    expect(result.text.length).toBeLessThanOrEqual(200);
  });
});

describe('test_assembly：组装期条目内压缩', () => {
  it('test_entry_compression_applied_when_truncated：截断源经压缩钩子出摘要', () => {
    const assembler = new InputAssembler(_knowledge_only_config(), {
      compressor: _summary_compressor,
    });
    const long_source = _source(
      SOURCE_KNOWLEDGE,
      '很长的知识条目内容 '.repeat(60),
      { weight: 1.0, relevance: 0.9, entry_ref: 'k-1' },
    );
    const result = assembler.assemble([long_source], { total_budget: 300 });
    expect(result.text).toContain('摘要:'); // 压缩视图生效
    expect(result.text.length).toBeLessThanOrEqual(300);
    const modes = new Set(result.record.sources.map((s) => s.mode));
    expect(modes.has('compressed')).toBe(true);
  });

  it('test_entry_compression_original_untouched：压缩视图不改写原文', () => {
    const assembler = new InputAssembler(_knowledge_only_config(), {
      compressor: _summary_compressor,
    });
    const long_source = _source(
      SOURCE_KNOWLEDGE,
      '原文内容不被改写 '.repeat(40),
      { weight: 1.0, relevance: 0.9, entry_ref: 'k-1' },
    );
    const original = long_source.content;
    assembler.assemble([long_source], { total_budget: 300 });
    expect(long_source.content).toBe(original); // 原文不动
  });

  it('test_entry_compression_fallback_when_empty：压缩空串 → 默认截断', () => {
    const empty_compressor: EntryCompressor = () => '';
    const assembler = new InputAssembler(_knowledge_only_config(), {
      compressor: empty_compressor,
    });
    const source = _source(
      SOURCE_KNOWLEDGE,
      '没有压缩策略的内容 '.repeat(40),
      { weight: 1.0, relevance: 0.9 },
    );
    const result = assembler.assemble([source], { total_budget: 300 });
    expect(result.text.length).toBeLessThanOrEqual(300); // 截断兜底仍在
    expect(result.record.sources.some((s) => s.mode === 'compressed')).toBe(false);
  });

  it('test_entry_compressor_type_exported：压缩钩子类型名导出', () => {
    const typed: EntryCompressor = _summary_compressor;
    expect(typed).toBe(_summary_compressor);
  });
});
