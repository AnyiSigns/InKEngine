/**
 * core/context 测试：block_source（块 → 物理输入纯函数层）。
 *
 * 覆盖（镜像 agent_execution_design §7.2 块→物理输入分层衔接 / §7.5 末条压缩随
 * 作用域 model 走 / §7.6 调配切片不进 messages 通道 + 产品侧三分预算先例
 * multi_agent_design §4.1/风险5）：
 * 1. 预算域隔离：协作块（task + N opinion + board）单列独立预算域——经既有
 *    WeightedBudgetAllocator 分配后域内硬上界可断言，协作块不挤占主持人结论；
 * 2. 权重：默认档位落既有三档（keep_full/truncate），options.weights 覆盖生效；
 * 3. 不同 cw 裁切差异：同块集在不同 context_window 下预算与裁切不同（复用既有
 *    resolve_compression_min_chars，不另造第二套）；
 * 4. 空块清单 = 与既有行为完全一致（零漂移）；
 * 5. 校验失败 fail-closed（块结构/context_window/占比/权重覆盖非法显式拒绝）。
 */

import { describe, expect, it } from 'vitest';

import { ContextAssembler } from '../../../src/loop/context/context_assembler.js';
import { WeightedBudgetAllocator } from '../../../src/loop/context/context_allocator.js';
import {
  AuthorizedBlock,
  BlockKind,
  BlockSourceOptions,
  BlockSourceResult,
  build_block_sources,
  SOURCE_TYPE_BOARD,
  SOURCE_TYPE_CONCLUSION,
  SOURCE_TYPE_OPINION,
  SOURCE_TYPE_SCOPE_CONTEXT,
  SOURCE_TYPE_SUMMARY,
  SOURCE_TYPE_TASK,
} from '../../../src/loop/context/block_source.js';
import {
  ContextSource,
  DEFAULT_BUDGET_CHARS,
  DEFAULT_RELEVANCE,
  MODE_KEEP_FULL,
  MODE_TRUNCATE,
} from '../../../src/loop/context/context_types.js';

function block(
  kind: BlockKind,
  owner: string,
  seq: number,
  content: string,
): AuthorizedBlock {
  return { kind, owner, content, seq };
}

/** 标准块集：协作域（task + 2 opinion + board）+ 主持人域（conclusion + summary）。 */
function standard_blocks(content_len = 20_000): AuthorizedBlock[] {
  const c = (ch: string): string => ch.repeat(content_len);
  return [
    block('task', 'main', 1, c('T')),
    block('opinion', 'a', 1, c('O')),
    block('opinion', 'b', 2, c('O')),
    block('board', 'a', 1, c('B')),
    block('conclusion', 'main', 1, c('C')),
    block('summary', 'main', 1, c('S')),
  ];
}

/** 经既有分配器分配后的域用量（按 meta.domain 聚合 char_limit）。 */
function used_by_domain(r: BlockSourceResult, domain: string): number {
  const allocations = new WeightedBudgetAllocator().allocate(r.sources, r.budget_chars);
  return allocations
    .filter((a) => a.source.meta['domain'] === domain)
    .reduce((acc, a) => acc + a.char_limit, 0);
}

describe('预算域隔离：协作块单列独立预算域', () => {
  it('域预算链与分配硬上界可断言（经既有 WeightedBudgetAllocator）', () => {
    const r = build_block_sources(standard_blocks(), '作用域私有上下文', 250_000);
    // 预算链：0.8×250k=200k → 调配切片 25% = 50k → 协作域 60% = 30k，主持人域余量 20k
    expect(r.budget_chars).toBe(Math.trunc(0.8 * 250_000 * 0.25));
    expect(r.collab_domain_budget).toBe(Math.trunc(r.budget_chars * 0.6));
    expect(r.moderator_domain_budget).toBe(r.budget_chars - r.collab_domain_budget);
    // 域内 max_chars 之和恰好封顶域预算（域预切分 = 硬上界）
    const collab_srcs = r.sources.filter((s) => s.meta['domain'] === 'collab');
    const moderator_srcs = r.sources.filter((s) => s.meta['domain'] === 'moderator');
    expect(collab_srcs.reduce((a, s) => a + (s.max_chars ?? 0), 0)).toBe(
      r.collab_domain_budget,
    );
    expect(moderator_srcs.reduce((a, s) => a + (s.max_chars ?? 0), 0)).toBe(
      r.moderator_domain_budget,
    );
    // 既有分配器分配后：协作域恰好用满自己的域预算，主持人域不超域预算，
    // 两域合计不超总预算——协作块挤占结论的通道被结构性封死
    expect(used_by_domain(r, 'collab')).toBe(r.collab_domain_budget);
    expect(used_by_domain(r, 'moderator')).toBeLessThanOrEqual(r.moderator_domain_budget);
    expect(used_by_domain(r, 'collab') + used_by_domain(r, 'moderator')).toBeLessThanOrEqual(
      r.budget_chars,
    );
  });

  it('协作域预算不被主持人面向域蚕食：主持人内容变大不改变协作域切分', () => {
    const collab = [
      block('task', 'main', 1, 'T'.repeat(20_000)),
      block('opinion', 'a', 1, 'O'.repeat(20_000)),
      block('board', 'a', 1, 'B'.repeat(20_000)),
    ];
    const small = build_block_sources(
      [...collab, block('conclusion', 'main', 1, 'C'.repeat(20))],
      'ctx',
      250_000,
    );
    const large = build_block_sources(
      [...collab, block('conclusion', 'main', 1, 'C'.repeat(200_000))],
      'ctx',
      250_000,
    );
    const collab_caps = (r: BlockSourceResult): (number | null)[] =>
      r.sources.filter((s) => s.meta['domain'] === 'collab').map((s) => s.max_chars);
    expect(collab_caps(small)).toEqual(collab_caps(large));
    expect(small.collab_domain_budget).toBe(large.collab_domain_budget);
  });

  it('块域归属与留痕 meta 正确标注（collab/moderator + kind/owner/seq）', () => {
    const r = build_block_sources(standard_blocks(10), 'ctx', 250_000);
    const by_type = new Map(r.sources.map((s) => [s.type, s]));
    expect(by_type.get(SOURCE_TYPE_TASK)!.meta['domain']).toBe('collab');
    expect(by_type.get(SOURCE_TYPE_OPINION)!.meta['domain']).toBe('collab');
    expect(by_type.get(SOURCE_TYPE_BOARD)!.meta['domain']).toBe('collab');
    expect(by_type.get(SOURCE_TYPE_CONCLUSION)!.meta['domain']).toBe('moderator');
    expect(by_type.get(SOURCE_TYPE_SUMMARY)!.meta['domain']).toBe('moderator');
    expect(by_type.get(SOURCE_TYPE_SCOPE_CONTEXT)!.meta['domain']).toBe('moderator');
    const opinion_srcs = r.sources.filter((s) => s.type === SOURCE_TYPE_OPINION);
    for (const opinion of opinion_srcs) {
      expect(opinion.meta['kind']).toBe('opinion');
      expect(opinion.meta['domain']).toBe('collab');
    }
    expect(opinion_srcs.map((s) => s.meta['owner'])).toEqual(['a', 'b']);
    expect(opinion_srcs.map((s) => s.meta['seq'])).toEqual([1, 2]);
  });
});

describe('权重：命名常量默认档位 + 覆盖', () => {
  it('默认权重使既有分配器落既有三档：task/board/conclusion keep_full，opinion/summary 截断', () => {
    const r = build_block_sources(standard_blocks(300), 'ctx', 250_000);
    const allocations = new WeightedBudgetAllocator().allocate(r.sources, r.budget_chars);
    const mode_of = (type: string): string =>
      allocations.find((a) => a.source.type === type)!.mode;
    expect(mode_of(SOURCE_TYPE_TASK)).toBe(MODE_KEEP_FULL);
    expect(mode_of(SOURCE_TYPE_BOARD)).toBe(MODE_KEEP_FULL);
    expect(mode_of(SOURCE_TYPE_CONCLUSION)).toBe(MODE_KEEP_FULL);
    expect(mode_of(SOURCE_TYPE_OPINION)).toBe(MODE_TRUNCATE);
    expect(mode_of(SOURCE_TYPE_SUMMARY)).toBe(MODE_TRUNCATE);
    // 分配分（weight × AUTHORIZED_BLOCK_RELEVANCE）确认档位依据
    const scores = new Map(
      r.sources.map((s) => [s.type, s.score()] as const),
    );
    expect(scores.get(SOURCE_TYPE_TASK)).toBeGreaterThanOrEqual(0.8);
    expect(scores.get(SOURCE_TYPE_OPINION)!).toBeGreaterThanOrEqual(0.15);
    expect(scores.get(SOURCE_TYPE_OPINION)!).toBeLessThan(0.8);
  });

  it('options.weights 覆盖改变域内预切分（opinion 权重上调 → max_chars 提升）', () => {
    const blocks = [
      block('task', 'main', 1, 'x'),
      block('opinion', 'a', 1, 'x'),
      block('opinion', 'b', 2, 'x'),
      block('board', 'a', 1, 'x'),
    ];
    const base = build_block_sources(blocks, 'ctx', 250_000);
    const boosted = build_block_sources(blocks, 'ctx', 250_000, {
      weights: { opinion: 1.0 },
    });
    const opinion_cap = (r: BlockSourceResult): number =>
      r.sources.find((s) => s.type === SOURCE_TYPE_OPINION)!.max_chars ?? 0;
    expect(opinion_cap(boosted)).toBeGreaterThan(opinion_cap(base));
  });

  it('权重覆盖在空块清单下同样生效于校验路径（非法值仍拒绝）', () => {
    expect(() =>
      build_block_sources([], 'ctx', 250_000, {
        weights: { task: -1 } as Partial<Record<BlockKind, number>>,
      }),
    ).toThrow(RangeError);
  });
});

describe('压缩/预算随作用域 model 走：不同 cw 裁切差异', () => {
  it('同块集在不同 context_window 下预算不同、意见块被裁得不同', () => {
    const blocks = standard_blocks(2000);
    const small = build_block_sources(blocks, '作用域私有上下文', 32_000);
    const big = build_block_sources(blocks, '作用域私有上下文', 250_000);
    // 预算沿既有 resolve_compression_min_chars 推算（0.8×cw），再取调配切片 25%
    expect(small.budget_chars).toBe(Math.trunc(0.8 * 32_000 * 0.25));
    expect(big.budget_chars).toBe(Math.trunc(0.8 * 250_000 * 0.25));
    expect(small.budget_chars).not.toBe(big.budget_chars);
    expect(small.collab_domain_budget).not.toBe(big.collab_domain_budget);
    // 同一块集被裁得不同：小 cw 意见块被截断（入装 chars < 内容长），大 cw 全量
    const asm = new ContextAssembler();
    const t_small = asm.assemble(small.sources, { total_chars: small.budget_chars });
    const t_big = asm.assemble(big.sources, { total_chars: big.budget_chars });
    const opinion_chars = (t: { included: readonly { type: string; chars: number }[] }): number =>
      t.included.find((i) => i.type === SOURCE_TYPE_OPINION)!.chars;
    expect(opinion_chars(t_small)).toBeLessThan(2000);
    expect(opinion_chars(t_big)).toBe(2000);
    expect(t_small.text).not.toBe(t_big.text);
    // 大 cw 下白板（共享事实底座）全量在场，小 cw 下被截断
    expect(t_big.text).toContain('B'.repeat(2000));
    expect(t_small.text).not.toContain('B'.repeat(2000));
  });

  it('档案缺失（null/undefined）走既有 200k 兜底预算', () => {
    const r = build_block_sources(standard_blocks(100), 'ctx', null);
    expect(r.budget_chars).toBe(Math.trunc(0.8 * 200_000 * 0.25));
  });
});

describe('空块清单：与既有行为完全一致（零漂移）', () => {
  it('空块清单产出与既有单源直通完全相同的源、预算与装配结果', () => {
    const ctx_text = '作用域私有上下文描述';
    const r = build_block_sources([], ctx_text, 250_000);
    expect(r.budget_chars).toBe(DEFAULT_BUDGET_CHARS);
    expect(r.collab_domain_budget).toBe(0);
    expect(r.moderator_domain_budget).toBe(0);
    expect(r.sources).toHaveLength(1);
    const src = r.sources[0]!;
    const baseline = new ContextSource(SOURCE_TYPE_SCOPE_CONTEXT, ctx_text);
    expect(src.type).toBe(baseline.type);
    expect(src.content).toBe(baseline.content);
    expect(src.weight).toBe(baseline.weight);
    expect(src.relevance).toBe(baseline.relevance);
    expect(src.priority).toBe(baseline.priority);
    expect(src.max_chars).toBeNull();
    expect(src.title).toBeNull();
    expect(src.relevance).toBe(DEFAULT_RELEVANCE);
    // 装配结果（文本/用量/留痕）逐字段与既有直通一致
    const asm = new ContextAssembler();
    const via = asm.assemble(r.sources, { total_chars: r.budget_chars });
    const direct = asm.assemble([baseline], { total_chars: DEFAULT_BUDGET_CHARS });
    expect(via.text).toBe(direct.text);
    expect(via.used_chars).toBe(direct.used_chars);
    expect(via.included.map((i) => [i.type, i.mode, i.chars])).toEqual(
      direct.included.map((i) => [i.type, i.mode, i.chars]),
    );
    // 任意 cw 下空块清单都退回既有默认（cw 不参与空装配，零漂移与 cw 无关）
    const other = build_block_sources([], ctx_text, 32_000);
    expect(other.budget_chars).toBe(DEFAULT_BUDGET_CHARS);
    expect(other.sources[0]!.content).toBe(ctx_text);
  });
});

describe('校验失败 fail-closed', () => {
  it('未知块类型拒绝', () => {
    expect(() =>
      build_block_sources(
        [{ kind: 'note', owner: 'a', content: 'x', seq: 0 } as unknown as AuthorizedBlock],
        'ctx',
        250_000,
      ),
    ).toThrow(/未知块类型/);
  });

  it('seq 负值 / 非整数拒绝', () => {
    expect(() => build_block_sources([block('task', 'm', -1, 'x')], 'ctx', 250_000)).toThrow(
      RangeError,
    );
    expect(() => build_block_sources([block('task', 'm', 1.5, 'x')], 'ctx', 250_000)).toThrow(
      RangeError,
    );
  });

  it('owner 缺失 / 空串拒绝', () => {
    expect(() => build_block_sources([block('task', '', 1, 'x')], 'ctx', 250_000)).toThrow(
      /owner/,
    );
    expect(() =>
      build_block_sources(
        [{ kind: 'task', content: 'x', seq: 0 } as unknown as AuthorizedBlock],
        'ctx',
        250_000,
      ),
    ).toThrow(/owner/);
  });

  it('content 非字符串拒绝', () => {
    expect(() =>
      build_block_sources(
        [{ kind: 'task', owner: 'a', content: 123, seq: 0 } as unknown as AuthorizedBlock],
        'ctx',
        250_000,
      ),
    ).toThrow(/content/);
  });

  it('context_window 非法（负 / NaN）拒绝；null/undefined 走 200k 兜底', () => {
    expect(() =>
      build_block_sources([block('task', 'm', 0, 'x')], 'ctx', -100),
    ).toThrow(RangeError);
    expect(() =>
      build_block_sources([block('task', 'm', 0, 'x')], 'ctx', Number.NaN),
    ).toThrow(RangeError);
    const r = build_block_sources([block('task', 'm', 0, 'x')], 'ctx', null);
    expect(r.budget_chars).toBe(Math.trunc(0.8 * 200_000 * 0.25));
  });

  it('占比非法（调配切片比例 / 协作域份额越界）拒绝', () => {
    const bad = (partial: BlockSourceOptions): void => {
      expect(() =>
        build_block_sources([block('task', 'm', 0, 'x')], 'ctx', 250_000, partial),
      ).toThrow(RangeError);
    };
    bad({ allocation_slice_ratio: 0 });
    bad({ allocation_slice_ratio: 1.2 });
    bad({ collab_domain_share: 1.5 });
    bad({ collab_domain_share: -0.1 });
  });

  it('权重 / 优先级覆盖非法（负值 / NaN / 未知键）拒绝', () => {
    const reject = (partial: BlockSourceOptions): void => {
      expect(() =>
        build_block_sources([block('task', 'm', 0, 'x')], 'ctx', 250_000, partial),
      ).toThrow(RangeError);
    };
    reject({ weights: { task: -1 } });
    reject({ priorities: { opinion: Number.NaN } });
    expect(() =>
      build_block_sources([block('task', 'm', 0, 'x')], 'ctx', 250_000, {
        weights: { note: 1 } as Partial<Record<BlockKind, number>>,
      }),
    ).toThrow(/未知块类型/);
  });

  it('blocks 非数组 / scope_context 非字符串拒绝', () => {
    expect(() =>
      build_block_sources(null as unknown as AuthorizedBlock[], 'ctx', 250_000),
    ).toThrow(TypeError);
    expect(() =>
      build_block_sources([block('task', 'm', 0, 'x')], 42 as unknown as string, 250_000),
    ).toThrow(TypeError);
  });
});

describe('纯函数性：确定性与零副作用', () => {
  it('同一输入得同一输出；不改写输入块清单', () => {
    const blocks = [block('task', 'm', 1, 'T'), block('opinion', 'a', 1, 'O')];
    const snapshot = JSON.parse(JSON.stringify(blocks)) as unknown[];
    const r1 = build_block_sources(blocks, 'ctx', 250_000);
    const r2 = build_block_sources(blocks, 'ctx', 250_000);
    expect(JSON.stringify(r1.sources)).toBe(JSON.stringify(r2.sources));
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(JSON.stringify(blocks)).toBe(JSON.stringify(snapshot));
  });
});
