/**
 * 记忆策略原语单测（对标 ink_engine/tests/test_memory.py 纯机制段）：
 * 条目时效 / 来源分级默认权重 / 召回排序与截断 / 记录转换往返。
 * 时间一律经注入 now seam 固定，保证确定性，无需任何存储后端。
 */

import { describe, expect, it } from 'vitest';

import {
  MemoryEntry,
  PriorityRecallPolicy,
  SOURCE_WEIGHT_BY_SOURCE,
  _entry_to_record,
  _make_id,
  _record_to_entry,
} from '../../../src/core/memory/memory.js';

/** 固定时间轴线（测试全程确定性）。 */
const now = (): number => 1000;

/** 构造条目（缺省 book:1/plot/c/priority 5，created_at 走固定时间轴）。 */
function _entry(
  overrides: {
    namespace?: string;
    kind?: string;
    content?: string;
    priority?: number;
    created_at?: number;
    expires_at?: number | null;
    source?: string;
    weight?: number;
    title?: string | null;
    id?: string | null;
    meta?: Record<string, unknown>;
  } = {},
): MemoryEntry {
  return new MemoryEntry({
    namespace: 'book:1',
    kind: 'plot',
    content: 'c',
    priority: 5,
    created_at: now(),
    ...overrides,
  });
}

describe('MemoryEntry 时效与冻结语义', () => {
  it('is_expired：无过期/已过期/未到期判定', () => {
    const fresh = new MemoryEntry({ namespace: 'u', kind: 'k', content: 'x' });
    const dead = new MemoryEntry({
      namespace: 'u',
      kind: 'k',
      content: 'x',
      expires_at: now() - 1,
    });
    const soon = new MemoryEntry({
      namespace: 'u',
      kind: 'k',
      content: 'x',
      expires_at: now() + 100,
    });
    expect(fresh.is_expired(now())).toBe(false);
    expect(dead.is_expired(now())).toBe(true);
    expect(soon.is_expired(now())).toBe(false);
  });

  it('无参 is_expired 走注入时间源（缺省确定值 0，可复现）', () => {
    const bounded = new MemoryEntry({
      namespace: 'u',
      kind: 'k',
      content: 'x',
      expires_at: 5,
    });
    expect(bounded.is_expired()).toBe(false); // 缺省 now=0，未到失效线
    expect(bounded.is_expired(0)).toBe(false); // Python `or` 语义同缺省
    expect(bounded.is_expired(10)).toBe(true);
  });

  it('frozen 语义：构造后冻结，meta 每实例独立', () => {
    const a = new MemoryEntry({ namespace: 'u', kind: 'k', content: 'x' });
    const b = new MemoryEntry({ namespace: 'u', kind: 'k', content: 'x' });
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.meta).not.toBe(b.meta);
    a.meta['extra'] = 1;
    expect(b.meta['extra']).toBeUndefined();
    expect(a.weight).toBe(1.0);
  });
});

describe('来源分级 → 默认召回权重（分级词汇表统一口径）', () => {
  it('来源落在分级词汇表内 → 权重 = 该级可信度基准', () => {
    const web = new MemoryEntry({ namespace: 'u', kind: 'k', content: 'x', source: 'web' });
    const user = new MemoryEntry({ namespace: 'u', kind: 'k', content: 'x', source: 'user' });
    const manual = new MemoryEntry({ namespace: 'u', kind: 'k', content: 'x', source: 'custom' });
    expect(web.weight).toBe(0.3);
    expect(user.weight).toBe(0.9);
    expect(manual.weight).toBe(1.0); // 词汇表外来源保持中性
    expect(SOURCE_WEIGHT_BY_SOURCE['dialog']).toBe(0.6);
    expect(SOURCE_WEIGHT_BY_SOURCE['model']).toBe(0.7);
  });

  it('显式非默认权重优先', () => {
    const explicit = new MemoryEntry({
      namespace: 'u',
      kind: 'k',
      content: 'x',
      source: 'web',
      weight: 0.8,
    });
    expect(explicit.weight).toBe(0.8);
  });
});

describe('PriorityRecallPolicy 确定性召回', () => {
  it('排序：优先级降序，同优先级按创建时间线降序（新在前）', () => {
    const base = 1000;
    const low_old = _entry({ priority: 1, created_at: base - 100 });
    const high_new = _entry({ priority: 9, created_at: base - 10 });
    const high_old = _entry({ priority: 9, created_at: base - 200 });
    const result = new PriorityRecallPolicy({ now }).recall([low_old, high_new, high_old]);
    expect(result.map((entry) => entry.priority)).toEqual([9, 9, 1]);
    expect(result[0]).toBe(high_new); // 同优先级新在前
    expect(result[1]).toBe(high_old);
    expect(result[2]).toBe(low_old);
  });

  it('排除过期条目并按 limit 截断 top-k', () => {
    const base = 1000;
    const alive = Array.from({ length: 5 }, (_, i) =>
      _entry({ priority: i, created_at: base - i }),
    );
    const dead = _entry({ priority: 99, expires_at: base - 1 });
    const result = new PriorityRecallPolicy({ now }).recall([...alive, dead], {
      limit: 2,
    });
    expect(result).toHaveLength(2);
    expect(result).not.toContain(dead);
    expect(result.every((entry) => !entry.is_expired(base))).toBe(true);
    expect(result.map((entry) => entry.priority)).toEqual([4, 3]);
  });

  it('limit 缺省不截断（全量返回）', () => {
    const entries = [_entry({ priority: 2 }), _entry({ priority: 3 })];
    const result = new PriorityRecallPolicy({ now }).recall(entries);
    expect(result).toHaveLength(2);
  });
});

describe('记录转换（to/from dict）', () => {
  it('往返保真：全部字段一致，meta 引用共享', () => {
    const meta = { domain: 'd', related_entity_id: 'e1' };
    const entry = new MemoryEntry({
      namespace: 'n',
      kind: 'k',
      content: 'c',
      title: 't',
      source: 'web',
      priority: 3,
      meta,
      created_at: 500,
      expires_at: 900,
    });
    const rec = _entry_to_record(entry, 'id-1');
    expect(rec).toEqual({
      id: 'id-1',
      namespace: 'n',
      kind: 'k',
      content: 'c',
      title: 't',
      source: 'web',
      priority: 3,
      weight: 0.3, // 分级来源默认权重已解析，落库即终态
      meta,
      created_at: 500,
      expires_at: 900,
    });
    const back = _record_to_entry(rec);
    expect(back.namespace).toBe('n');
    expect(back.kind).toBe('k');
    expect(back.content).toBe('c');
    expect(back.title).toBe('t');
    expect(back.source).toBe('web');
    expect(back.priority).toBe(3);
    expect(back.weight).toBe(0.3);
    expect(back.created_at).toBe(500);
    expect(back.expires_at).toBe(900);
    expect(back.meta).toBe(meta); // Python dict 同引用语义
  });

  it('兼容旧记录：缺失字段走默认值', () => {
    const back = _record_to_entry({ namespace: 'old' });
    expect(back.id).toBeNull();
    expect(back.kind).toBe('');
    expect(back.content).toBe('');
    expect(back.title).toBeNull();
    expect(back.source).toBe('manual');
    expect(back.priority).toBe(5);
    expect(back.weight).toBe(1.0);
    expect(back.meta).toEqual({});
    expect(back.expires_at).toBeNull();
  });

  it('数值字段：字符串数值可解析、小数取整、非法回落缺省', () => {
    const back = _record_to_entry({
      namespace: 'n',
      kind: 'k',
      content: 'c',
      priority: '7.9',
      created_at: 5,
      expires_at: null,
    });
    expect(back.priority).toBe(7); // Python int() 口径
    expect(back.created_at).toBe(5);
    const broken = _record_to_entry({ created_at: 'abc' });
    expect(broken.created_at).toBe(0); // 非法值回落缺省（now 缺省 0）
  });
});

describe('id 生成', () => {
  it('_make_id：namespace 域内唯一（id 经注入 seam，缺省固定串）', () => {
    const entry = new MemoryEntry({ namespace: 'book:7', kind: 'k', content: 'c' });
    expect(_make_id(entry)).toBe('book:7:00000000000000000000000000000000');
    expect(_make_id(entry, () => 'ab')).toBe('book:7:ab');
  });
});