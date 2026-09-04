/**
 * 恢复/续流解析单测（子图锚点回溯 + 顶层链线程契约），test_recovery.py
 * 移植的后半段。
 *
 * 范围说明：collect_resume_anchors/tail_checkpoint 的纯机制经内存 seam
 * 双端覆盖；依赖真实存储后端与执行器恢复接线的用例延后（随
 * backend/executor 移植补齐）。resolve_resume 主路径见
 * recovery.test.ts。
 */

import { describe, expect, it } from 'vitest';

import { collect_resume_anchors, resolve_resume, tail_checkpoint } from '../../../src/core/recovery/index.js';
import { asStore, chain, FakeStorage, pathKey } from './helpers.js';

describe('collect_resume_anchors / tail_checkpoint', () => {
  it('子链终态（reply）不作恢复锚点，仅中断/未完成锚点入表', async () => {
    const store = new FakeStorage();
    await chain(store, [
      { state: {}, node: 'n1', graph_path: [] },
      { state: {}, node: 'n2', parent_id: 1, reason: 'reply', graph_path: ['done'] },
      { state: {}, node: 'n3', parent_id: 2, reason: null, graph_path: ['pending'] },
    ]);
    const tail = await tail_checkpoint(asStore(store), 't1');
    expect(tail).not.toBeNull();
    const [top, map] = await collect_resume_anchors(asStore(store), tail!, new Map());
    expect(top).toBe(1);
    expect(map.has(pathKey(['pending']))).toBe(true);
    expect(map.has(pathKey(['done']))).toBe(false);
  });
});

describe('resolve_resume：顶层链线程契约（ENG5-13）', () => {
  it('顶层分离 = 契约违例；嵌套路径合法；纯内存执行不受限', async () => {
    const store = new FakeStorage();
    // 顶层分离（graph_path 空 + chain_thread 与 thread_id 不一致）
    await expect(
      resolve_resume({
        storage: asStore(store),
        state: {},
        schema: null,
        thread_id: 't1',
        chain_thread: 't1:spawn:0',
        resume_from: null,
        continue_chain: true,
        graph_path: [],
        replay: false,
        resume_map: null,
      }),
    ).rejects.toThrow('顶层恢复路径');
    // 嵌套路径合法（spawn/分支的显式隔离形态）
    const res = await resolve_resume({
      storage: asStore(store),
      state: { x: 1 },
      schema: null,
      thread_id: 't1',
      chain_thread: 't1:spawn:0',
      resume_from: null,
      continue_chain: true,
      graph_path: ['sub', '0'],
      replay: false,
      resume_map: null,
    });
    expect(res.state).toEqual({ x: 1 });
    // 纯内存执行（storage=null）无线程语义，不触发契约
    const res2 = await resolve_resume({
      storage: null,
      state: { x: 1 },
      schema: null,
      thread_id: 't1',
      chain_thread: 'anything',
      resume_from: null,
      continue_chain: true,
      graph_path: [],
      replay: false,
      resume_map: null,
    });
    expect(res2.state).toEqual({ x: 1 });
  });
});