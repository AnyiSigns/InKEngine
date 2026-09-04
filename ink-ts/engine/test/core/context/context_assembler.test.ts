/**
 * core/context 测试：ContextAssembler 加权组装（含 1:1 移植自
 * test_context.py 的块格式 / 预算硬上界 / 装配重排等场景）。
 */

import { describe, expect, it } from 'vitest';

import { ContextAssembler } from '../../../src/core/context/context_assembler.js';
import {
  ContextSource,
  MODE_KEEP_FULL,
} from '../../../src/core/context/context_types.js';
import { WeightedBudgetAllocator } from '../../../src/core/context/context_allocator.js';

interface SrcFields {
  readonly type?: string;
  readonly weight?: number;
  readonly relevance?: number;
  readonly priority?: number;
  readonly title?: string | null;
}

function _src(type = 'chapter', content = '内容', fields: SrcFields = null as unknown as SrcFields): ContextSource {
  const f = fields ?? {};
  return new ContextSource(type, content, {
    title: f.title ?? null,
    weight: f.weight ?? 1.0,
    relevance: f.relevance ?? 0.9,
    priority: f.priority ?? 5,
  });
}

describe('TestContextAssembler：加权组装', () => {
  it('test_empty_sources：空源 = 空文本 + 0 used', () => {
    const result = new ContextAssembler().assemble([], { total_chars: 100 });
    expect(result.text).toBe('');
    expect(result.used_chars).toBe(0);
  });

  it('test_title_block_format：有标题块 = 【标题】\\n内容', () => {
    const result = new ContextAssembler().assemble(
      [_src('c', '正文', { title: '标题' })],
      { total_chars: 1000 },
    );
    expect(result.text).toBe('【标题】\n正文');
  });

  it('test_plain_block_without_title：无标题块 = 纯文本', () => {
    const result = new ContextAssembler().assemble([_src('c', '正文')], { total_chars: 1000 });
    expect(result.text).toBe('正文');
  });

  it('test_budget_hard_bound：装配文本 ≤ total_chars', () => {
    const sources = Array.from({ length: 10 }, (_, i) =>
      _src(`t${i}`, '字'.repeat(500), { title: `块${i}` }),
    );
    const result = new ContextAssembler().assemble(sources, { total_chars: 1000 });
    expect(result.text.length).toBeLessThanOrEqual(1000);
  });

  it('test_keep_full_source_survives_title_overhead：标题开销顶掉预算时仍截断保留', () => {
    const src = _src('c', 'x'.repeat(100), {
      title: '十个字标题啊',
      weight: 1.0,
      relevance: 1.0,
    });
    const result = new ContextAssembler().assemble([src], { total_chars: 100 });
    expect(result.included.map((i) => i.type)).toContain(src.type); // 源必在场
    expect(result.text.startsWith('【十个字标题啊】\n')).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.dropped.some((d) => d.reason.includes('截断'))).toBe(true);
  });

  it('test_budget_exhausted_drops_tail_sources：预算耗尽尾部源丢弃', () => {
    const sources = Array.from({ length: 4 }, (_, i) =>
      _src(`t${i}`, 'x'.repeat(500), { title: `块${i}` }),
    );
    const result = new ContextAssembler().assemble(sources, { total_chars: 1000 });
    expect(result.dropped.some((d) => d.reason === '预算耗尽')).toBe(true);
    expect(result.included.length).toBeLessThan(4);
  });

  it('test_included_and_dropped_records：留痕可断言', () => {
    const good = _src('chapter', 'A'.repeat(100));
    const bad = _src('memory', 'B', { weight: 0.1, relevance: 0.1 });
    const result = new ContextAssembler().assemble([good, bad], { total_chars: 1000 });
    expect(result.included.map((i) => [i.type, i.mode])).toEqual([
      ['chapter', MODE_KEEP_FULL],
    ]);
    expect(result.dropped[0]!.type).toBe('memory');
  });

  it('test_assemble_reorders_by_priority_not_input_order：高优 keep_full 必在前', () => {
    const low = _src('low', 'L'.repeat(500), { weight: 1.0, relevance: 0.9, priority: 1 });
    const high = _src('high', 'H'.repeat(500), { weight: 1.0, relevance: 0.9, priority: 10 });
    // 输入序 [低优, 高优]；预算只够一个整源
    const result = new ContextAssembler().assemble([low, high], { total_chars: 600 });
    expect(result.included[0]!.type).toBe('high');
    expect(result.text.includes('H'.repeat(500))).toBe(true);
    expect(result.text.includes('L'.repeat(500))).toBe(false);
    expect(result.text.length).toBeLessThanOrEqual(600);
  });

  it('test_default_budget_used：默认预算 = 4000', () => {
    const result = new ContextAssembler().assemble([_src('c', 'x'.repeat(10000))]);
    expect(result.total_chars).toBe(4000);
    expect(result.text.length).toBeLessThanOrEqual(4000);
  });

  it('test_negative_budget_rejected：负预算拒绝', () => {
    expect(() => new ContextAssembler().assemble([_src('c', 'x')], { total_chars: -1 })).toThrow(
      RangeError,
    );
  });
});

describe('构造期协议校验：ENG2-14 回归', () => {
  it('不满足 BudgetAllocator 协议的注入在装配期抛 TypeError', () => {
    // 镜像 Python: ContextAssembler(allocator=object()) —— TS 侧显式以 any 绕开
    // 类型层的接口约束，只测运行期协议校验
    const bad = { not_allocator: true } as unknown as object;
    expect(() => new ContextAssembler({ allocator: bad })).toThrow(/BudgetAllocator/);
    const assembler = new ContextAssembler({ allocator: new WeightedBudgetAllocator() });
    expect(assembler.allocator).toBeDefined();
  });
});