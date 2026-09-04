/**
 * 链级 rebase 单测（语义对标 ink_engine/tests/test_chain_rebase.py）：
 * 只覆盖本模块（chain_rebase）自身语义——plan_compaction 纯函数规划、
 * maybe_compact_chain 编排（改写先行/版本戳并发护栏/幂等）。规划决策靠
 * 直接构造轻量链行；编排行为经一个测试用内存链仓（模拟 memory 后端
 * 的原语子集）驱动，不依赖 storage/engine 模块实现。
 */
import { describe, expect, it } from 'vitest';

import { CompactionPlan, maybe_compact_chain, plan_compaction } from '../../../src/core/chain_rebase/chain_rebase.js';
import type { ChainLink, Storage } from '../../../src/core/chain_rebase/chain_rebase.js';

function link(cid: number, parent: number | null, seq?: number, path: readonly string[] = [], reason: string | null = null): ChainLink {
  return {
    checkpoint_id: cid,
    parent_id: parent,
    event_seq: seq ?? cid * 2,
    graph_path: path,
    reason,
  };
}

// ── 测试用内存链仓（模拟 memory 后端的压缩/建链原语子集）──

interface ChainRow {
  checkpoint_id: number;
  thread_id: string;
  parent_id: number | null;
  event_seq: number;
  graph_path: readonly string[];
  reason: string | null;
  state: unknown;
}

interface StoredEvent {
  thread_id: string;
  seq: number;
  type: string;
  payload: unknown;
}

/** 内存链仓：实现 Storage seam + 建链/事件 scaffold（测试私有）。 */
class MemChainStore implements Storage {
  private rows: ChainRow[] = [];
  private events: StoredEvent[] = [];
  private nextCheckpointId = 1;
  private nextEventSeq = 1;

  async chain_index(threadId: string): Promise<ChainLink[]> {
    const sorted = this.rows
      .filter((r) => r.thread_id === threadId)
      .sort((a, b) => b.checkpoint_id - a.checkpoint_id);
    return sorted.map((r) => ({
      checkpoint_id: r.checkpoint_id,
      parent_id: r.parent_id,
      event_seq: r.event_seq,
      graph_path: r.graph_path,
      reason: r.reason,
    }));
  }

  async delete_checkpoints(threadId: string, ids: number[]): Promise<number> {
    const set = new Set(ids);
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.thread_id === threadId && set.has(r.checkpoint_id)));
    return before - this.rows.length;
  }

  async set_checkpoint_parent(
    threadId: string,
    checkpointId: number,
    parentId: number | null,
  ): Promise<number> {
    const row = this.rows.find((r) => r.thread_id === threadId && r.checkpoint_id === checkpointId);
    if (row === undefined) return 0;
    row.parent_id = parentId;
    return 1;
  }

  async trim_events(threadId: string, beforeSeq: number): Promise<number> {
    const before = this.events.length;
    this.events = this.events.filter((e) => !(e.thread_id === threadId && e.seq <= beforeSeq));
    return before - this.events.length;
  }

  async put_checkpoint(input: {
    thread_id: string;
    parent_id: number | null;
    event_seq: number;
    state: unknown;
  }): Promise<{ checkpoint_id: number }> {
    const row: ChainRow = {
      checkpoint_id: this.nextCheckpointId,
      thread_id: input.thread_id,
      parent_id: input.parent_id,
      event_seq: input.event_seq,
      graph_path: [],
      reason: null,
      state: input.state,
    };
    this.nextCheckpointId += 1;
    this.rows.push(row);
    return { checkpoint_id: row.checkpoint_id };
  }

  async append_event(input: { thread_id: string; type: string; payload: unknown }): Promise<number> {
    const seq = this.nextEventSeq;
    this.nextEventSeq += 1;
    this.events.push({ thread_id: input.thread_id, seq, type: input.type, payload: input.payload });
    return seq;
  }

  async latest_event_seq(threadId: string): Promise<number> {
    let max = 0;
    for (const e of this.events) {
      if (e.thread_id === threadId && e.seq > max) max = e.seq;
    }
    return max;
  }

  async get_latest_checkpoint(threadId: string): Promise<{ checkpoint_id: number; state: unknown } | null> {
    let best: ChainRow | undefined;
    for (const r of this.rows) {
      if (r.thread_id === threadId && (best === undefined || r.checkpoint_id > best.checkpoint_id)) {
        best = r;
      }
    }
    return best === undefined ? null : { checkpoint_id: best.checkpoint_id, state: best.state };
  }
}

/** 一致性自检（对标 validate_chain 沿链尾回溯的契约：空 = 一致）。 */
async function chainViolations(store: MemChainStore, threadId: string): Promise<string[]> {
  const links = await store.chain_index(threadId);
  const violations: string[] = [];
  if (links.length === 0) return violations;
  const byId = new Map(links.map((l) => [l.checkpoint_id, l]));
  let node: ChainLink | undefined = links[0];
  let walked = 0;
  while (node !== undefined) {
    walked += 1;
    if (walked > 100) {
      violations.push(`链遍历超限（疑似成环）: 停于 #${node.checkpoint_id}`);
      break;
    }
    const parent = node.parent_id !== null ? byId.get(node.parent_id) : undefined;
    if (node.parent_id !== null && parent === undefined) {
      violations.push(`悬挂父指针: #${node.checkpoint_id} -> parent #${node.parent_id} 不存在`);
      break;
    }
    if (parent !== undefined) {
      if (parent.checkpoint_id >= node.checkpoint_id) {
        violations.push(`父链非递减（环/自引用）: #${node.checkpoint_id} -> #${parent.checkpoint_id}`);
        break;
      }
      if (parent.event_seq > node.event_seq) {
        violations.push(`event_seq 回退: #${node.checkpoint_id} < 父 #${parent.checkpoint_id}`);
      }
    }
    node = parent;
  }
  return violations;
}

async function buildChain(store: MemChainStore, n = 10, threadId = 't1'): Promise<void> {
  let prev: number | null = null;
  for (let i = 1; i <= n; i++) {
    const rec = await store.put_checkpoint({
      thread_id: threadId,
      parent_id: prev,
      event_seq: i * 2,
      state: { v: i },
    });
    prev = rec.checkpoint_id;
  }
}

async function appendEvents(store: MemChainStore, n = 20, threadId = 't1'): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await store.append_event({ thread_id: threadId, type: 'log', payload: { i } });
  }
}

// ── plan_compaction 纯函数 ──

describe('plan_compaction：窗口规划', () => {
  it('线性链 keep=3：保留尾 3 行，窗口最旧行改链头，其余删除，事件裁剪到窗口最旧 seq', () => {
    const links = [];
    for (let i = 1; i <= 10; i++) links.push(link(i, i > 1 ? i - 1 : null, i * 2));
    const plan = plan_compaction(links, 3);
    expect(plan).toEqual(
      new CompactionPlan({
        delete_ids: [1, 2, 3, 4, 5, 6, 7],
        rewire_ids: [8],
        trim_before_seq: 16,
      }),
    );
  });
  it('链长 <= 窗口：整链保留，无改写无删除无裁剪', () => {
    const links = [];
    for (let i = 1; i <= 3; i++) links.push(link(i, i > 1 ? i - 1 : null));
    expect(plan_compaction(links, 3).is_empty).toBe(true);
    expect(plan_compaction(links, 10).is_empty).toBe(true);
  });
  it('keep=1 只保留叶行', () => {
    const links = [];
    for (let i = 1; i <= 5; i++) links.push(link(i, i > 1 ? i - 1 : null));
    const plan = plan_compaction(links, 1);
    expect(plan.delete_ids).toEqual([1, 2, 3, 4]);
    expect(plan.rewire_ids).toEqual([5]);
  });
  it('分叉链（编辑重放侧支）：每叶各自保留窗口，共享祖先改写去重', () => {
    const links = [];
    for (let i = 1; i <= 10; i++) links.push(link(i, i > 1 ? i - 1 : null));
    links.push(link(100, 5));
    links.push(link(101, 100));
    const plan = plan_compaction(links, 3);
    expect(new Set(plan.delete_ids)).toEqual(new Set([1, 2, 3, 4, 6, 7]));
    expect(new Set(plan.rewire_ids)).toEqual(new Set([5, 8]));
    // 执行后无悬挂：改写先行（窗口最旧行 parent -> None），再删除
    const kept = new Set(links.map((l) => l.checkpoint_id));
    for (const id of plan.delete_ids) kept.delete(id);
    const byId = new Map(links.map((l) => [l.checkpoint_id, l]));
    const rewireSet = new Set(plan.rewire_ids);
    for (const cid of kept) {
      const row = byId.get(cid);
      if (row === undefined) throw new Error('链路索引缺失');
      const parent = rewireSet.has(cid) ? null : row.parent_id;
      expect(parent === null || kept.has(parent)).toBe(true);
    }
  });
  it('空输入/禁用窗口：空计划', () => {
    expect(plan_compaction([], 3).is_empty).toBe(true);
    expect(plan_compaction([link(1, null)], 0).is_empty).toBe(true);
  });
});

// ── maybe_compact_chain：编排与幂等 ──

describe('maybe_compact_chain：压缩编排', () => {
  it('完整往返：删除/改写/裁剪计数、链长有界、幂等空操作', async () => {
    const store = new MemChainStore();
    await buildChain(store, 10);
    await appendEvents(store, 20);
    const outcome = await maybe_compact_chain(store, 't1', 3);
    expect(outcome.removed).toBe(7);
    expect(outcome.rewired).toBe(1);
    // 窗口最旧行 event_seq=16（第 8 行）→ 裁剪 seq <= 16 共 16 条
    expect(outcome.trimmed).toBe(16);
    expect(await store.latest_event_seq('t1')).toBe(20);
    expect(await chainViolations(store, 't1')).toEqual([]);
    const latest = await store.get_latest_checkpoint('t1');
    expect(latest?.state).toEqual({ v: 10 });
    const links = await store.chain_index('t1');
    expect(links.length).toBe(3);
    // 幂等：二次压缩空操作
    const second = await maybe_compact_chain(store, 't1', 3);
    expect(second.compacted).toBe(false);
  });
  it('链长 <= 窗口：不触发', async () => {
    const store = new MemChainStore();
    await buildChain(store, 3);
    const outcome = await maybe_compact_chain(store, 't1', 3);
    expect(outcome.compacted).toBe(false);
    expect(await chainViolations(store, 't1')).toEqual([]);
  });
  it('keep <= 0 禁用压缩', async () => {
    const store = new MemChainStore();
    await buildChain(store, 10);
    const outcome = await maybe_compact_chain(store, 't1', 0);
    expect(outcome.compacted).toBe(false);
    expect((await store.chain_index('t1')).length).toBe(10);
  });
  it('ENG5-10：rewire 与删除之间链尾被并发推进 -> 计划作废，跳过删除', async () => {
    const store = new MemChainStore();
    await buildChain(store, 10);
    await appendEvents(store, 20);
    const adv = new AdvancingTailStore(store);
    const outcome = await maybe_compact_chain(adv, 't1', 3);
    // rewire 已执行（无害），删除被跳过（版本戳不匹配）
    expect(outcome.removed).toBe(0);
    expect(outcome.rewired).toBe(1);
    expect(adv.delete_called).toBe(false);
    expect((await store.chain_index('t1')).length).toBe(10); // 行数未裁剪
    // 链仍一致（rewire 无害：归档链头脱离父链，校验只走链尾路径）
    expect(await chainViolations(store, 't1')).toEqual([]);
  });
  it('ENG5-10 反向确认：无并发推进时压缩照常执行', async () => {
    const store = new MemChainStore();
    await buildChain(store, 10);
    const outcome = await maybe_compact_chain(store, 't1', 3);
    expect(outcome.removed).toBe(7);
    expect(outcome.rewired).toBe(1);
    expect((await store.chain_index('t1')).length).toBe(3);
    expect(await chainViolations(store, 't1')).toEqual([]);
  });
});

/** 模拟压缩期并发推进：第二次 chain_index 返回链尾已前进的索引。 */
class AdvancingTailStore implements Storage {
  delete_called = false;
  private indexCalls = 0;

  constructor(private readonly inner: MemChainStore) {}

  async chain_index(threadId: string): Promise<ChainLink[]> {
    this.indexCalls += 1;
    const links = await this.inner.chain_index(threadId);
    if (this.indexCalls === 2) {
      const head = links[0];
      if (head === undefined) throw new Error('并发推进场景应有链尾');
      // 模拟并发推进：新链尾 = 旧链尾之后（parent 指向旧链尾）
      return [
        {
          checkpoint_id: head.checkpoint_id + 100,
          parent_id: head.checkpoint_id,
          event_seq: head.event_seq + 1,
          graph_path: [],
          reason: null,
        },
        ...links,
      ];
    }
    return links;
  }

  async set_checkpoint_parent(
    threadId: string,
    checkpointId: number,
    parentId: number | null,
  ): Promise<number> {
    return this.inner.set_checkpoint_parent(threadId, checkpointId, parentId);
  }

  async delete_checkpoints(threadId: string, ids: number[]): Promise<number> {
    this.delete_called = true;
    return this.inner.delete_checkpoints(threadId, ids);
  }

  async trim_events(): Promise<number> {
    return 0;
  }
}
