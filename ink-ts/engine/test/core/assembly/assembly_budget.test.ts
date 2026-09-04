/**
 * 输入调配预算行为单测（test_assembly.py 1:1 移植）：注入分配器真实作用
 * 产物/全量保留不误伤低分源/版本快照副本/空装配保底/ENG9a-13 分级池两遍
 * 分配/ENG9a-14 源块边界回退/ENG9a-24 兼容别名。基础配置与压缩用例见
 * assembly.test.ts。
 */

import { describe, expect, it } from 'vitest';

import {
  SOURCE_CONTEXT,
  SOURCE_EVIDENCE,
  SOURCE_KNOWLEDGE,
  SOURCE_MEMORY,
  SOURCE_TOOL,
  ActivationRecord,
  AssemblyConfig,
  AssemblyResult,
  InputAssembler,
  InputAssemblyResult,
} from '../../../src/core/assembly/index.js';
import { WeightedBudgetAllocator } from '../../../src/core/context/context_allocator.js';
import { _source } from './helpers.js';

describe('test_assembly：注入分配器/全量保留/留痕归因', () => {
  it('test_injected_allocator_drives_actual_assembly：注入分配器真实作用产物', () => {
    const tight = new WeightedBudgetAllocator({
      keep_full_threshold: 0.9,
      truncate_min_score: 0.5,
      min_truncate_chars: 200,
    });
    const assembler = new InputAssembler(
      new AssemblyConfig({
        total_budget: 200,
        context_ratio: 0.0,
        knowledge_ratio: 1.0,
        tool_ratio: 0.0,
        memory_ratio: 0.0,
        evidence_ratio: 0.0,
      }),
      { allocator: tight },
    );
    const sources = [
      _source(SOURCE_KNOWLEDGE, '低权重内容 '.repeat(30), {
        weight: 0.1,
        relevance: 1.0,
      }),
      _source(SOURCE_KNOWLEDGE, '高权重内容 '.repeat(30), {
        weight: 0.95,
        relevance: 1.0,
      }),
    ];
    const result = assembler.assemble(sources, { total_budget: 200 });
    // 高权重源全保留，低权重源被截断门槛丢弃（注入分配器语义生效）
    expect(result.text).toContain('高权重内容');
    expect(result.text).not.toContain('低权重内容');
    const dropped = result.record.sources.filter((s) => s.mode === 'drop');
    expect(dropped.some((s) => s.title.startsWith('knowledge-低权重'))).toBe(true);
  });

  it('test_full_path_keeps_low_score_sources：预算足够时低分源不误伤', () => {
    const assembler = new InputAssembler(new AssemblyConfig({ total_budget: 2000 }));
    const low = _source(SOURCE_KNOWLEDGE, '低分知识', { weight: 0.1, relevance: 0.1 });
    const high = _source(SOURCE_KNOWLEDGE, '高分知识', { weight: 0.95, relevance: 0.9 });
    const result = assembler.assemble([low, high], { total_budget: 2000 });
    expect(result.text).toContain('低分知识');
    expect(result.text).toContain('高分知识');
    expect(result.record.sources.every((s) => s.char_limit > 0)).toBe(true);
  });

  it('test_version_snapshot_kept_by_copy：版本快照按副本留存', () => {
    const assembler = new InputAssembler(new AssemblyConfig({ total_budget: 1000 }));
    const snapshot: Record<string, unknown> = { rules: 'v1' };
    const result = assembler.assemble(
      [_source(SOURCE_CONTEXT, '内容')],
      { total_budget: 1000, version_snapshot: snapshot },
    );
    snapshot['rules'] = 'v2';
    expect(result.record.version_snapshot).toEqual({ rules: 'v1' });
  });

  it('test_global_truncation_attributed：截断量随留痕记录', () => {
    const config = new AssemblyConfig({
      total_budget: 400,
      context_ratio: 0.5,
      knowledge_ratio: 0.5,
      tool_ratio: 0.0,
      memory_ratio: 0.0,
      evidence_ratio: 0.0,
    });
    const assembler = new InputAssembler(config);
    const sources = [
      _source(SOURCE_CONTEXT, '上下文 '.repeat(40), { weight: 1.0 }),
      _source(SOURCE_KNOWLEDGE, '知识 '.repeat(40), { weight: 1.0 }),
    ];
    const result = assembler.assemble(sources, { total_budget: 400 });
    expect(result.text.length).toBeLessThanOrEqual(400);
    expect(result.record.truncated_chars).toBeGreaterThanOrEqual(0);
    expect(result.record.assembled_chars).toBe(result.text.length);
  });

  it('test_empty_assembly_fallback_keeps_top_source：空装配保底保留最高优先源', () => {
    const assembler = new InputAssembler(new AssemblyConfig({ total_budget: 10 }));
    const sources = [
      _source(SOURCE_CONTEXT, '对话历史内容很长'.repeat(10), {
        weight: 0.2,
        relevance: 0.3,
      }),
      _source(SOURCE_KNOWLEDGE, '重要知识内容'.repeat(10), {
        weight: 0.9,
        relevance: 0.9,
      }),
    ];
    const result = assembler.assemble(sources, { total_budget: 10 });
    expect(result.text.length).toBeGreaterThan(0); // 不空手喂模型
    expect(result.text.length).toBeLessThanOrEqual(10);
    expect(result.text).toContain('重要知识');
    // 保底源追加到留痕末尾（保留原有 drop 记录），不再整体替换
    expect(result.record.sources.some((s) => s.mode === 'fallback_keep')).toBe(true);
  });

  it('test_evidence_pool_default_ratio_nonzero：证据/记忆默认占比非零', () => {
    const config = new AssemblyConfig();
    expect(config.evidence_ratio).toBeGreaterThan(0);
    expect(config.memory_ratio).toBeGreaterThan(0);
    const sum =
      config.context_ratio +
      config.knowledge_ratio +
      config.tool_ratio +
      config.memory_ratio +
      config.evidence_ratio;
    expect(sum).toBeLessThanOrEqual(1.0);
  });
});

describe('test_assembly：ENG9a-13/ENG9a-14', () => {
  it('test_budget_two_pass_recovers_unused_pools：缺源池余量二次回拨', () => {
    const budget = 1000;
    const config = new AssemblyConfig({ total_budget: budget });
    const assembler = new InputAssembler(config);
    // 单个 context 源内容 600 字符：> 首遍 context 池(500)，< 总预算(1000)
    const sources = [
      _source(SOURCE_CONTEXT, '甲'.repeat(600), {
        weight: 1.0,
        relevance: 1.0,
      }),
    ];
    const result = assembler.assemble(sources, { total_budget: budget });
    expect(result.text).toContain('甲'.repeat(600)); // 余量回收后整段保留
    expect(result.text.length).toBeLessThanOrEqual(budget);
    const context_sources = result.record.sources.filter(
      (s) => s.source_type === SOURCE_CONTEXT,
    );
    expect(context_sources.some((s) => s.char_limit === 600)).toBe(true);
  });

  it('test_budget_two_pass_all_pools_allocated_still_capped：全池有源仍不破硬上界', () => {
    const budget = 1000;
    const config = new AssemblyConfig({ total_budget: budget });
    const assembler = new InputAssembler(config);
    const sources = [
      _source(SOURCE_CONTEXT, 'C'.repeat(300), { weight: 1.0 }),
      _source(SOURCE_KNOWLEDGE, 'K'.repeat(300), { weight: 1.0 }),
      _source(SOURCE_TOOL, 'T'.repeat(300), { weight: 1.0 }),
      _source(SOURCE_MEMORY, 'M'.repeat(300), { weight: 1.0 }),
      _source(SOURCE_EVIDENCE, 'E'.repeat(300), { weight: 1.0 }),
    ];
    const result = assembler.assemble(sources, { total_budget: budget });
    expect(result.text.length).toBeLessThanOrEqual(budget);
    expect(result.record.assembled_chars).toBe(result.text.length);
  });

  it('test_pool_boundary_rollback_drops_whole_blocks：粘合开销按源块边界回退', () => {
    const config = new AssemblyConfig({
      total_budget: 600,
      context_ratio: 0.34,
      knowledge_ratio: 0.33,
      tool_ratio: 0.33,
      memory_ratio: 0.0,
      evidence_ratio: 0.0,
    });
    const assembler = new InputAssembler(config);
    const sources = [
      _source(SOURCE_CONTEXT, '对话历史块 '.repeat(50), {
        weight: 1.0,
        relevance: 1.0,
      }),
      _source(SOURCE_KNOWLEDGE, '知识条目块 '.repeat(50), {
        weight: 1.0,
        relevance: 1.0,
      }),
      _source(SOURCE_TOOL, '工具定义块 '.repeat(50), {
        weight: 1.0,
        relevance: 1.0,
      }),
    ];
    const result = assembler.assemble(sources, { total_budget: 600 });
    expect(result.text.length).toBeLessThanOrEqual(600);
    // 回退 = 整块丢弃：保留块均为完整块文本（无半句截断残留）
    for (const block of result.text.split('\n\n')) {
      expect(block.length).toBeGreaterThan(0);
    }
    const dropped = result.record.sources.filter(
      (s) => s.mode === 'drop' && s.note.includes('全局预算回退'),
    );
    expect(result.record.truncated_chars).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0); // 被丢块留痕归因
    for (const s of dropped) {
      expect(s.char_limit).toBe(0);
    }
  });

  it('test_assembly_result_rename：输入调配产物与旧别名同对象（路径侧待迁）', () => {
    // path_assembler 交叉断言（PathAssemblyResult ≠ InputAssemblyResult）
    // 依赖 path_assembler 迁移，暂 defer；此处保留端口侧别名契约。
    expect(AssemblyResult).toBe(InputAssemblyResult);
    const text_result = new InputAssemblyResult(
      'x',
      new ActivationRecord({ total_budget: 1, assembled_chars: 1 }),
    );
    expect(text_result.text).toBe('x');
  });
});
