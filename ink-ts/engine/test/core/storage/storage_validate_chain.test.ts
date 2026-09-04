/**
 * validate_chain 测试：链一致性校验纯逻辑（不依赖真实后端）。
 *
 * 范围：storage.ts 的 validate_chain + ChainLink 数据面。fake storage
 * 仅实现 chain_index + get_checkpoint 两个原语（seam 子集，校验器
 * 不依赖其他方法）。坏链经 fake 的内部结构直接注入（写入端不变量
 * 已拒绝这些形态；此处验证校验器对存量坏链的检出能力，与 Python
 * test_storage.py::test_validate_chain_detects_violations 行为一致）。
 *
 * 覆盖：正常链 / missing thread；悬挂父指针（get_checkpoint 返回
 * null）；跨线程父指针（get_checkpoint 返回跨线程记录）；event_seq
 * 回退；自引用环；环检测立即终止（不触发遍历超限）；单 chain_index
 * 取回（避免逐跳重查询）。
 */

import { describe, expect, it } from 'vitest';

import { CheckpointRecord, ChainLink } from '../../../src/core/storage/storage_records.js';
import { validate_chain, type Storage } from '../../../src/core/storage/storage.js';
import { DEFAULT_CHAIN_WALK_LIMIT } from '../../../src/core/storage/storage_constants.js';

class FakeStorage implements Pick<Storage, 'chain_index' | 'get_checkpoint'> {
  chainIndexCalls = 0;
  constructor(
    private readonly links: Map<string, ChainLink[]>,
    private readonly checkpoints: Map<number, CheckpointRecord>,
  ) {}

  async chain_index(thread_id: string): Promise<ChainLink[]> {
    this.chainIndexCalls += 1;
    return this.links.get(thread_id) ?? [];
  }

  async get_checkpoint(checkpoint_id: number): Promise<CheckpointRecord | null> {
    return this.checkpoints.get(checkpoint_id) ?? null;
  }
}

function link(
  checkpoint_id: number,
  parent_id: number | null,
  event_seq = 0,
  reason: string | null = null,
): ChainLink {
  return new ChainLink({ checkpoint_id, parent_id, event_seq, reason });
}

describe('validate_chain：正常链与边界', () => {
  it('空链 / missing thread 返回空违规', async () => {
    const store = new FakeStorage(new Map(), new Map());
    expect(await validate_chain(store as unknown as Storage, 't-missing')).toEqual([]);
    expect(await validate_chain(store as unknown as Storage, 't-missing', { max_walk: 10 })).toEqual([]);
  });

  it('正常线性链（event_seq 单调不减）返回空违规', async () => {
    const links = [link(3, 2, 5), link(2, 1, 5), link(1, null, 0)];
    const store = new FakeStorage(new Map([['t', links]]), new Map());
    expect(await validate_chain(store as unknown as Storage, 't')).toEqual([]);
  });

  it('单次 chain_index 取回整链（不逐跳重查询）', async () => {
    const links = [link(3, 2, 5), link(2, 1, 5), link(1, null, 0)];
    const store = new FakeStorage(new Map([['t', links]]), new Map());
    await validate_chain(store as unknown as Storage, 't');
    expect(store.chainIndexCalls).toBe(1);
  });
});

describe('validate_chain：违规检出', () => {
  it('悬挂父指针：parent 不在本线程索引且 get_checkpoint 返回 null', async () => {
    const links = [link(101, 999, 3)];
    const store = new FakeStorage(new Map([['t', links]]), new Map());
    const violations = await validate_chain(store as unknown as Storage, 't');
    expect(violations.some((v) => v.includes('悬挂父指针'))).toBe(true);
    expect(violations.some((v) => v.includes('#999'))).toBe(true);
  });

  it('跨线程父指针：parent 存在但归属其他 thread', async () => {
    const links = [link(102, 50, 4)];
    const crossRecord = new CheckpointRecord({
      checkpoint_id: 50,
      thread_id: 't-other',
      node: 'n',
    });
    const store = new FakeStorage(
      new Map([['t', links]]),
      new Map([[50, crossRecord]]),
    );
    const violations = await validate_chain(store as unknown as Storage, 't');
    expect(violations.some((v) => v.includes('跨线程父指针'))).toBe(true);
    expect(violations.some((v) => v.includes('t-other'))).toBe(true);
  });

  it('event_seq 回退：父 event_seq 大于子 event_seq', async () => {
    const links = [link(103, 101, 1), link(101, null, 5)];
    const store = new FakeStorage(new Map([['t', links]]), new Map());
    const violations = await validate_chain(store as unknown as Storage, 't');
    expect(violations.some((v) => v.includes('event_seq 回退'))).toBe(true);
  });

  it('自引用环：parent_id === checkpoint_id', async () => {
    const links = [link(104, 104, 0)];
    const store = new FakeStorage(new Map([['t', links]]), new Map());
    const violations = await validate_chain(store as unknown as Storage, 't');
    expect(violations.some((v) => v.includes('父链非递减'))).toBe(true);
    // 环检测立即终止：不触发遍历超限
    expect(violations.some((v) => v.includes('遍历超限'))).toBe(false);
  });

  it('check_event_seq=false 时 event_seq 回退不报告', async () => {
    const links = [link(103, 101, 1), link(101, null, 5)];
    const store = new FakeStorage(new Map([['t', links]]), new Map());
    const violations = await validate_chain(store as unknown as Storage, 't', {
      check_event_seq: false,
    });
    expect(violations).toEqual([]);
  });
});

describe('validate_chain：遍历超限', () => {
  it('max_walk 生效：链长超 max_walk 报遍历超限', async () => {
    // 构造长链：N+1 → N → N-1 → ... → 0
    const links: ChainLink[] = [];
    for (let i = 4; i >= 0; i--) {
      links.push(link(i, i === 0 ? null : i - 1, i));
    }
    const store = new FakeStorage(new Map([['t', links]]), new Map());
    const violations = await validate_chain(store as unknown as Storage, 't', { max_walk: 2 });
    expect(violations.some((v) => v.includes('链遍历超限'))).toBe(true);
    expect(violations.some((v) => v.includes('>2'))).toBe(true);
  });

  it('默认 max_walk 等于 DEFAULT_CHAIN_WALK_LIMIT（魔法数字已抽为常量）', async () => {
    // 不真正构造 10000 节点，只确认默认值与 seam 一致
    expect(DEFAULT_CHAIN_WALK_LIMIT).toBe(10000);
  });
});
