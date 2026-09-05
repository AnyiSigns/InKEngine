/**
 * 恢复/续流解析单测（resume 锚点解析 + 覆盖层保留 + 图版本校验），
 * test_recovery.py 移植。
 *
 * 范围说明：本文件用内存 seam 双端（helpers.ts 的 FakeStorage，镜像
 * Python conftest 的 memory_storage 行为）覆盖 pure 解析机制的
 * resolve_resume 主路径。依赖真实存储后端（sqlite/postgres 集成）与
 * 执行器恢复接线的用例延后（随 host/exec 落地补齐）；
 * collect_resume_anchors/链线程契约见 recovery_anchors.test.ts。
 */

import { describe, expect, it } from 'vitest';

import { GraphVersionMismatchError, StorageError } from '../../../src/core/errors.js';
import { EngineEvent } from '../../../src/core/events/events.js';
import { StateSchema } from '../../../src/core/state/schema.js';
import { register_reducer } from '../../../src/core/state/reducers.js';
import { resolve_resume } from '../../../src/core/recovery/index.js';
import { asStore, chain, ckpt, FakeStorage, pathKey } from './helpers.js';

describe('resolve_resume：resume_from 基础恢复', () => {
  it('checkpoint 为基底，输入 state 为覆盖层（缺失键保留）', async () => {
    const store = new FakeStorage();
    const ids = await chain(store, [{ state: { input: '旧', keep: 'v' }, node: 'n1' }]);
    const cid = ids.keys().next().value as number;
    const res = await resolve_resume({
      storage: asStore(store),
      state: { input: '新' },
      schema: null,
      thread_id: 't1',
      chain_thread: 't1',
      resume_from: cid,
      continue_chain: false,
      graph_path: [],
      replay: false,
      resume_map: null,
    });
    expect(res.last_checkpoint).not.toBeNull();
    expect(res.last_checkpoint!.checkpoint_id).toBe(cid);
    expect(res.state['input']).toBe('新');
    expect(res.state['keep']).toBe('v');
  });

  it('resume_from 锚点不存在 → 显式 StorageError', async () => {
    const store = new FakeStorage();
    await expect(
      resolve_resume({
        storage: asStore(store),
        state: {},
        schema: null,
        thread_id: 't1',
        chain_thread: 't1',
        resume_from: 99,
        continue_chain: false,
        graph_path: [],
        replay: false,
        resume_map: null,
      }),
    ).rejects.toThrow(StorageError);
  });
});

describe('resolve_resume：续链与图版本校验', () => {
  it('continue_chain：链尾为基底，输入覆盖，不校验图版本、不重放', async () => {
    const store = new FakeStorage();
    await chain(store, [
      { state: { input: '旧', keep: 'v' }, node: 'n1', graph_version: 'g-old' },
    ]);
    const res = await resolve_resume({
      storage: asStore(store),
      state: { input: '新' },
      schema: null,
      thread_id: 't1',
      chain_thread: 't1',
      resume_from: null,
      continue_chain: true,
      graph_path: [],
      replay: true,
      resume_map: null,
      graph_version: 'g-new', // 续链不校验：换图续链合法
    });
    expect(res.last_checkpoint).not.toBeNull();
    expect(res.state['input']).toBe('新');
    expect(res.state['keep']).toBe('v');
    expect(res.replay).toEqual([]);
  });

  it('resume_from 恢复锚点图版本与当前不一致 → 显式拒绝', async () => {
    const store = new FakeStorage();
    const ids = await chain(store, [
      { state: { input: '旧' }, node: 'n1', graph_version: 'g-old' },
    ]);
    const cid = ids.keys().next().value as number;
    await expect(
      resolve_resume({
        storage: asStore(store),
        state: {},
        schema: null,
        thread_id: 't1',
        chain_thread: 't1',
        resume_from: cid,
        continue_chain: false,
        graph_path: [],
        replay: false,
        resume_map: null,
        graph_version: 'g-new',
      }),
    ).rejects.toThrow(GraphVersionMismatchError);
  });

  it('旧数据无图指纹 → 跳过校验（兼容既有库）', async () => {
    const store = new FakeStorage();
    const ids = await chain(store, [{ state: {}, node: 'n1' }]);
    const cid = ids.keys().next().value as number;
    const res = await resolve_resume({
      storage: asStore(store),
      state: {},
      schema: null,
      thread_id: 't1',
      chain_thread: 't1',
      resume_from: cid,
      continue_chain: false,
      graph_path: [],
      replay: false,
      resume_map: null,
      graph_version: 'g-new',
    });
    expect(res.last_checkpoint).not.toBeNull();
  });
});

describe('resolve_resume：顶层锚点回溯与覆盖层', () => {
  it('回溯后输入覆盖层不丢失（回归：回溯直接覆盖曾丢弃 state）', async () => {
    const store = new FakeStorage();
    // 链：1(顶层, 终态 reply) → 2(子图 s1 中断锚点)
    const ids = await chain(store, [
      { state: { input: '旧', keep: 'v' }, node: 'n1', reason: 'reply', graph_path: [] },
      {
        state: { input: '子图旧' },
        node: 'n2',
        parent_id: 1,
        reason: null,
        graph_path: ['s1'],
        event_seq: 3,
      },
    ]);
    const subId = ids.get(2)!.checkpoint_id;
    const res = await resolve_resume({
      storage: asStore(store),
      state: { input: '覆盖', fresh: 'x' },
      schema: null,
      thread_id: 't1',
      chain_thread: 't1',
      resume_from: subId,
      continue_chain: false,
      graph_path: [],
      replay: false,
      resume_map: null,
    });
    // 回溯到顶层锚点 1，但覆盖层仍生效
    expect(res.last_checkpoint).not.toBeNull();
    expect(res.last_checkpoint!.checkpoint_id).toBe(1);
    expect(res.state['input']).toBe('覆盖');
    expect(res.state['keep']).toBe('v');
    expect(res.state['fresh']).toBe('x');
    // 子图锚点入 resume_map
    expect(res.resume_map.get(pathKey(['s1']))).toBe(subId);
  });

  it('带 schema 时回溯后覆盖层经 reducer 合并（与 resume_from 分支同语义）', async () => {
    register_reducer('test_numeric_add', (base, overlay) =>
      ((base as number) ?? 0) + (overlay as number),
    );
    const schema = new StateSchema({ count: 'test_numeric_add' });
    const store = new FakeStorage();
    await chain(store, [
      { state: { count: 5 }, node: 'n1', reason: 'reply', graph_path: [] },
      { state: { count: 9 }, node: 'n2', parent_id: 1, reason: null, graph_path: ['s1'] },
    ]);
    const res = await resolve_resume({
      storage: asStore(store),
      state: { count: 3 },
      schema,
      thread_id: 't1',
      chain_thread: 't1',
      resume_from: 2,
      continue_chain: false,
      graph_path: [],
      replay: false,
      resume_map: null,
    });
    expect(res.last_checkpoint).not.toBeNull();
    expect(res.last_checkpoint!.checkpoint_id).toBe(1);
    // 基底 5 + 覆盖 3（add reducer 累加）
    expect(res.state['count']).toBe(8);
  });

  it('回溯后重放区间以顶层锚点为准（超集一次，防重复事件）', async () => {
    const store = new FakeStorage();
    await chain(store, [
      { state: {}, node: 'n1', reason: 'reply', graph_path: [], event_seq: 0 },
      {
        state: {},
        node: 'n2',
        parent_id: 1,
        reason: null,
        graph_path: ['s1'],
        event_seq: 3,
      },
    ]);
    await store.append_event('t1', new EngineEvent({ type: 'probe', payload: {} }));
    const res = await resolve_resume({
      storage: asStore(store),
      state: {},
      schema: null,
      thread_id: 't1',
      chain_thread: 't1',
      resume_from: 2,
      continue_chain: false,
      graph_path: [],
      replay: true,
      resume_map: null,
    });
    // 顶层锚点 event_seq=0，重放其后的事件
    expect(res.replay).toHaveLength(1);
    expect(res.replay[0]!.type).toBe('probe');
  });
});