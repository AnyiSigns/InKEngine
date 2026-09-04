import { describe, expect, it } from 'vitest';

import { Channel, StateSchema } from '../../../src/core/state/schema.js';
import {
  add_messages,
  get_reducer,
  last_value,
  merge_dicts,
  merge_metrics,
  patch_chain_reducer,
} from '../../../src/core/state/reducers.js';

describe('reducer 注册表', () => {
  it('按名取 reducer，None = 裸通道', () => {
    expect(get_reducer('add_messages')).toBe(add_messages);
    expect(get_reducer('merge_dicts')).toBe(merge_dicts);
    expect(get_reducer('merge_metrics')).toBe(merge_metrics);
    expect(get_reducer('patch_chain')).toBe(patch_chain_reducer);
    expect(get_reducer('last_value')).toBe(last_value);
    expect(get_reducer(null)).toBeNull();
  });
});

describe('StateSchema', () => {
  it('apply 按通道 reducer 合并', () => {
    const schema = new StateSchema({ messages: 'add_messages', count: null });
    let state: Record<string, unknown> = { messages: [{ id: 'm1' }], count: 1 };
    state = schema.apply(state, { messages: [{ id: 'm2' }], count: 2 });
    expect((state.messages as unknown[]).length).toBe(2);
    expect(state.count).toBe(2);
  });

  it('apply 未知通道宽容裸覆盖', () => {
    const schema = new StateSchema();
    const state = schema.apply({ a: 1 }, { unknown: 2 });
    expect(state).toEqual({ a: 1, unknown: 2 });
  });

  it('apply 空 overlay 为 noop 副本', () => {
    const schema = new StateSchema({ a: new Channel(null) });
    expect(schema.apply({ a: 1 }, {})).toEqual({ a: 1 });
  });

  it('add API 登记通道', () => {
    const schema = new StateSchema();
    schema.add('messages', 'add_messages');
    schema.add('plain');
    expect(schema.channels['messages']!.reducer).toBe('add_messages');
    expect(schema.channels['plain']!.reducer).toBeNull();
  });

  it('to_dict/from_dict 往返一致', () => {
    const schema = new StateSchema({ messages: 'add_messages', plain: null });
    const restored = StateSchema.from_dict(schema.to_dict());
    expect(restored).not.toBeNull();
    expect(restored?.to_dict()).toEqual(schema.to_dict());
  });

  it('未知 reducer 名在构造期拒绝（fail-fast）', () => {
    expect(() => new StateSchema({ x: 'no_such_reducer' })).toThrow();
  });
});
