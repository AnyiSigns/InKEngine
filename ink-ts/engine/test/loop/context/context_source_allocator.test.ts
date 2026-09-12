/**
 * core/context 测试：ContextSource 元数据校验与 WeightedBudgetAllocator
 * 分配规则（含 1:1 移植自 test_context.py 的源元数据 / 预算分配场景）。
 */

import { describe, expect, it } from 'vitest';

import { WeightedBudgetAllocator } from '../../../src/core/context/context_allocator.js';
import {
  ContextSource,
  MODE_DROP,
  MODE_KEEP_FULL,
  MODE_TRUNCATE,
} from '../../../src/core/context/context_types.js';

interface SrcFields {
  readonly type?: string;
  readonly content?: string;
  readonly weight?: number;
  readonly relevance?: number;
  readonly priority?: number;
  readonly ttl?: number | null;
  readonly max_chars?: number | null;
  readonly dedup_key?: string | null;
  readonly title?: string | null;
  readonly created_at?: number;
}

function _src(type = 'chapter', content = '内容', fields: SrcFields = null as unknown as SrcFields): ContextSource {
  const f = fields ?? {};
  return new ContextSource(type, content, {
    title: f.title ?? null,
    weight: f.weight ?? 1.0,
    relevance: f.relevance ?? 0.9,
    priority: f.priority ?? 5,
    ttl: f.ttl ?? null,
    max_chars: f.max_chars ?? null,
    dedup_key: f.dedup_key ?? null,
    created_at: f.created_at ?? 0.0,
  });
}

describe('TestContextSource：源元数据校验', () => {
  it('test_validates_metadata：非法字段抛 RangeError', () => {
    expect(() => _src('x', 'y', { weight: -0.1 })).toThrow(RangeError);
    expect(() => _src('x', 'y', { relevance: 1.5 })).toThrow(RangeError);
    expect(() => _src('x', 'y', { ttl: -1 })).toThrow(RangeError);
    expect(() => _src('x', 'y', { max_chars: -1 })).toThrow(RangeError);
  });

  it('test_score_is_weight_times_relevance：score = w × r', () => {
    expect(_src('x', 'y', { weight: 2.0, relevance: 0.5 }).score()).toBe(1.0);
  });

  it('test_expiry：ttl 与 now 联合判定过期', () => {
    const src = _src('x', 'y', { ttl: 10 });
    expect(src.is_expired(0.0)).toBe(false);
    expect(src.is_expired(11.0)).toBe(true);
    // ttl=null 永不过期
    expect(_src('x', 'y').is_expired(1e18)).toBe(false);
  });
});

describe('TestWeightedBudgetAllocator：分配规则', () => {
  it('test_validates_params：构造参数校验', () => {
    expect(() => new WeightedBudgetAllocator({ keep_full_threshold: 1.5 })).toThrow(RangeError);
    // 高于全保留阈值
    expect(() => new WeightedBudgetAllocator({ truncate_min_score: 0.9 })).toThrow(RangeError);
    expect(() => new WeightedBudgetAllocator({ min_truncate_chars: -1 })).toThrow(RangeError);
  });

  it('test_empty_sources：空源列表 = 空分配', () => {
    expect(new WeightedBudgetAllocator().allocate([], 1000)).toEqual([]);
  });

  it('test_filters_expired_and_blank：过期与空内容被剔除', () => {
    const expired = _src('m', '旧', { ttl: 1, created_at: 0 });
    const blank = _src('m', '   ');
    // Python 侧走 time.time() 真实时间；TS 侧注入 now=100 让 ttl=1 / created_at=0 视为过期
    const allocs = new WeightedBudgetAllocator({ now: () => 100 }).allocate([expired, blank], 1000);
    expect(allocs).toEqual([]);
  });

  it('test_keep_full_high_score：高分源整源保留', () => {
    const allocs = new WeightedBudgetAllocator().allocate(
      [_src('c', 'A'.repeat(500))],
      1000,
    );
    expect(allocs[0]!.mode).toBe(MODE_KEEP_FULL);
    expect(allocs[0]!.char_limit).toBe(500);
  });

  it('test_keep_full_respects_max_chars：max_chars 兜底', () => {
    const allocs = new WeightedBudgetAllocator().allocate(
      [_src('c', 'A'.repeat(500), { max_chars: 100 })],
      1000,
    );
    expect(allocs[0]!.mode).toBe(MODE_KEEP_FULL);
    expect(allocs[0]!.char_limit).toBe(100);
  });

  it('test_medium_score_truncated_to_share：中等分源截断到剩余预算', () => {
    const b = _src('memory', 'B'.repeat(800), { weight: 0.7, relevance: 0.6 });
    const allocs = new WeightedBudgetAllocator().allocate([b], 400);
    expect(allocs[0]!.mode).toBe(MODE_TRUNCATE);
    expect(allocs[0]!.char_limit).toBe(400);
  });

  it('test_low_score_dropped：低分源直接丢弃', () => {
    const low = _src('m', 'L', { weight: 0.1, relevance: 0.5 });
    const allocs = new WeightedBudgetAllocator().allocate([low], 1000);
    expect(allocs[0]!.mode).toBe(MODE_DROP);
    expect(allocs[0]!.reason).toContain('门槛');
  });

  it('test_share_below_minimum_dropped：份额低于下限全部丢弃', () => {
    const a = _src('m', 'A'.repeat(1000), { weight: 0.3, relevance: 0.5 });
    const b = _src('m', 'B'.repeat(1000), { weight: 0.3, relevance: 0.5 });
    const allocs = new WeightedBudgetAllocator().allocate([a, b], 100);
    expect(allocs.map((x) => x.mode)).toEqual([MODE_DROP, MODE_DROP]);
    expect(allocs[0]!.reason).toContain('下限');
  });

  it('test_share_above_minimum_truncated：份额达标截断保留', () => {
    const a = _src('m', 'A'.repeat(1000), { weight: 0.3, relevance: 0.5 });
    const b = _src('m', 'B'.repeat(1000), { weight: 0.3, relevance: 0.5 });
    const allocs = new WeightedBudgetAllocator().allocate([a, b], 500);
    expect(allocs.map((x) => x.mode)).toEqual([MODE_TRUNCATE, MODE_TRUNCATE]);
    expect(allocs.reduce((acc, x) => acc + x.char_limit, 0)).toBe(500);
  });

  it('test_budget_hard_bound：总分配量 ≤ total_chars', () => {
    const sources = Array.from({ length: 8 }, (_, i) =>
      _src(`t${i}`, String(i).repeat(3000)),
    );
    const allocs = new WeightedBudgetAllocator().allocate(sources, 1000);
    const total = allocs.reduce((acc, x) => acc + x.char_limit, 0);
    expect(total).toBeLessThanOrEqual(1000);
  });

  it('test_degraded_keep_when_budget_short：预算不足降级截断', () => {
    const a = _src('chapter', 'A'.repeat(1000), { weight: 1.0, relevance: 0.9 });
    const b = _src('memory', 'B'.repeat(1000), { weight: 0.7, relevance: 0.6 });
    const allocs = new WeightedBudgetAllocator().allocate([a, b], 500);
    const byType: Record<string, { mode: string; char_limit: number }> = {};
    for (const x of allocs) byType[x.source.type] = { mode: x.mode, char_limit: x.char_limit };
    expect(byType['chapter']!.mode).toBe(MODE_TRUNCATE);
    expect(byType['memory']!.mode).toBe(MODE_TRUNCATE);
    expect(byType['chapter']!.char_limit).toBeGreaterThan(byType['memory']!.char_limit);
  });

  it('test_dedup_keeps_higher_priority：同 dedup_key 留高优', () => {
    const low = _src('c', '低优先', { priority: 3, dedup_key: 'k' });
    const high = _src('c', '高优先', { priority: 9, dedup_key: 'k' });
    const allocs = new WeightedBudgetAllocator().allocate([low, high], 1000);
    expect(allocs.length).toBe(1);
    expect(allocs[0]!.source).toBe(high);
  });

  it('test_deterministic：同输入同输出', () => {
    const sources = [
      _src('a', 'A'.repeat(700), { weight: 0.9, relevance: 0.7 }),
      _src('b', 'B'.repeat(700), { weight: 0.5, relevance: 0.5 }),
      _src('c', 'C'.repeat(700), { weight: 0.2, relevance: 0.6 }),
    ];
    const allocator = new WeightedBudgetAllocator();
    const first = allocator.allocate(sources, 800);
    const second = allocator.allocate(sources, 800);
    expect(first.map((a) => [a.mode, a.char_limit])).toEqual(
      second.map((a) => [a.mode, a.char_limit]),
    );
  });

  it('test_negative_budget_rejected：负预算拒绝', () => {
    expect(() => new WeightedBudgetAllocator().allocate([_src('c', 'x')], -1)).toThrow(RangeError);
  });

  it('test_budget_hard_bound_with_capped_source：封顶源 + 大源总分配不超预算', () => {
    const small = _src('a', 'A'.repeat(10), { weight: 0.5, relevance: 0.5 });
    const big = _src('b', 'B'.repeat(10000), { weight: 0.5, relevance: 0.5 });
    const allocs = new WeightedBudgetAllocator().allocate([small, big], 1000);
    const total = allocs.reduce((acc, x) => acc + x.char_limit, 0);
    expect(total).toBeLessThanOrEqual(1000);
    expect(allocs.some((a) => a.source === small)).toBe(true);
    expect(allocs.some((a) => a.source === big && a.char_limit > 0)).toBe(true);
  });

  it('test_pool_reflow_accumulates_not_overwrites：封顶源释放预算触发新轮时，份额累加而非覆写', () => {
    const a = _src('a', 'A'.repeat(100), { weight: 0.5, relevance: 0.5 }); // 0.25, 封顶
    const b = _src('b', 'B'.repeat(10000), { weight: 0.4, relevance: 0.5 }); // 0.20
    const c = _src('c', 'C'.repeat(10000), { weight: 0.3, relevance: 0.5 }); // 0.15
    const allocs = new WeightedBudgetAllocator().allocate([a, b, c], 1000);
    const byType: Record<string, { char_limit: number }> = {};
    for (const x of allocs) byType[x.source.type] = { char_limit: x.char_limit };
    expect(byType['a']!.char_limit).toBe(100); // 封顶整源
    // 累加而非被覆写变小
    expect(byType['b']!.char_limit).toBe(514);
    expect(byType['c']!.char_limit).toBe(385);
    const sum = allocs.reduce((acc, x) => acc + x.char_limit, 0);
    expect(sum).toBe(999); // 预算回流无静默浪费
  });
});