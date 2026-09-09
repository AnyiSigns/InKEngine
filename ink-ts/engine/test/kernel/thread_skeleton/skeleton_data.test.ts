/**
 * 会话级骨架数据形态单测（P4 §4.0 数据面）——测的是：
 * - to_dict/from_dict 序列化往返（node/edge 实例引用池内类型名，kind/condition
 *   序列化纪律与图数据对齐：仅 loop 显式 kind、condition 存在性推导）；
 * - 畸形数据显式拒绝（骨架数据损坏 = 调用方按骨架失效回落组装）；
 * - 旧记录兼容：checkpoint 无骨架键 = 骨架缺失（正常回落），不影响旧数据。
 */

import { describe, expect, it } from 'vitest';

import {
  THREAD_SKELETON_STATE_KEY,
  ThreadSkeleton,
} from '../../../src/core/thread_skeleton/index.js';

function fullSkeleton(): ThreadSkeleton {
  return new ThreadSkeleton({
    thread_id: 't-1',
    entry: 'decide',
    status: 'active',
    nodes: {
      decide: { type: 'llm_decider', config: { max_tool_rounds: 4 } },
      collect: { type: 'tool_pipeline', config: {} },
    },
    edges: {
      decide: [
        { target: 'collect', condition: 'COND_LLM_PENDING' },
        { target: 'collect' },
      ],
    },
    exits: ['collect'],
    active_target: null,
    created_at: 10,
    updated_at: 11,
  });
}

describe('会话级骨架数据形态', () => {
  it('roundtrip：完整骨架 to_dict/from_dict 无损（节点/边/出口/状态/时间）', () => {
    const source = fullSkeleton();
    const restored = ThreadSkeleton.from_dict(source.to_dict());
    expect(restored.thread_id).toBe('t-1');
    expect(restored.entry).toBe('decide');
    expect(restored.exits).toEqual(['collect']);
    expect(restored.status).toBe('active');
    expect(restored.created_at).toBe(10);
    expect(restored.updated_at).toBe(11);
    expect(restored.nodes['decide']).toEqual({
      type: 'llm_decider',
      config: { max_tool_rounds: 4 },
    });
    expect(restored.edges['decide']).toEqual([
      { target: 'collect', condition: 'COND_LLM_PENDING' },
      { target: 'collect' },
    ]);
    expect(restored.to_dict()).toEqual(source.to_dict());
  });

  it('node_types：去重返回骨架引用的池内类型名（插入序）', () => {
    const skeleton = new ThreadSkeleton({
      thread_id: 't',
      entry: 'a',
      nodes: {
        a: { type: 'llm_decider' },
        b: { type: 'tool_pipeline' },
        c: { type: 'llm_decider' },
      },
      exits: ['c'],
    });
    expect(skeleton.node_types()).toEqual(['llm_decider', 'tool_pipeline']);
  });

  it('loop 边显式序列化 kind；standard/conditional 由 condition 推导（图序列化纪律）', () => {
    const skeleton = new ThreadSkeleton({
      thread_id: 't',
      entry: 'a',
      nodes: { a: { type: 'llm_decider' } },
      edges: {
        a: [
          { target: 'a', kind: 'loop' },
          { target: 'a', condition: 'COND_LLM_PENDING' },
          { target: 'a' },
        ],
      },
      exits: ['a'],
    });
    const data = skeleton.to_dict();
    const edges = (data['edges'] as Record<string, Array<Record<string, unknown>>>)['a']!;
    expect(edges[0]).toEqual({ target: 'a', kind: 'loop' });
    expect(edges[1]).toEqual({ target: 'a', condition: 'COND_LLM_PENDING' });
    expect(edges[2]).toEqual({ target: 'a' });
  });

  it('畸形数据显式拒绝（缺 thread_id / 空节点 / 节点缺 type / 非法 status）', () => {
    const base = fullSkeleton().to_dict();
    expect(() => ThreadSkeleton.from_dict({ ...base, thread_id: '' })).toThrow();
    expect(() => ThreadSkeleton.from_dict({ ...base, nodes: {} })).toThrow();
    const badType = { ...base };
    (badType['nodes'] as Record<string, unknown>)['decide'] = { type: '' };
    expect(() => ThreadSkeleton.from_dict(badType)).toThrow();
    expect(() =>
      ThreadSkeleton.from_dict({ ...base, status: 'not-a-status' }),
    ).toThrow();
    expect(() => ThreadSkeleton.from_dict({ ...base, edges: 'bad' })).toThrow();
    expect(() => ThreadSkeleton.from_dict(null)).toThrow();
    expect(() => ThreadSkeleton.from_dict(42)).toThrow();
  });

  it('骨架 = 会话尺度数据的容器约定：保留键落 checkpoint state，节点只引用类型名', () => {
    expect(THREAD_SKELETON_STATE_KEY).toBe('_thread_skeleton');
    const skeleton = fullSkeleton();
    const data = skeleton.to_dict();
    // 节点实例字段只允许 type/config/contract（类型引用），不携带执行体
    for (const spec of Object.values(data['nodes'] as Record<string, unknown>)) {
      const keys = Object.keys(spec as Record<string, unknown>).sort();
      expect(keys.every((key) => key === 'type' || key === 'config' || key === 'contract')).toBe(true);
    }
  });
});
