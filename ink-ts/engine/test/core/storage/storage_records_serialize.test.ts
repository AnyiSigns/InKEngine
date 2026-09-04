/**
 * CheckpointRecord to_dict/from_dict 序列化往返 + 敏感键剥离 +
 * PatchChain/Message/ToolCall 内联 marker 还原 + 嵌套 copy-on-write。
 *
 * 范围：jsonableStrip / fromJsonable 行为对标 Python _jsonable_strip /
 * _from_jsonable。核心断言：
 * - 内联 marker 三类（PatchChain / Message / ToolCall）精确还原；
 * - 敏感键置空保留（键结构不破坏，下游 .get 恒返回空串）；
 * - 嵌套 dict/list 递归剥离；子树无敏感键零拷贝（=== 比较返回同对象）；
 * - graph_path 元组 → readonly 数组归一；tuple 在 list 通道下也归一为数组。
 */

import { describe, expect, it } from 'vitest';

import { InterruptState } from '../../../src/core/interrupt/interrupt_types.js';
import { Message, ToolCall } from '../../../src/core/llm/messages.js';
import { PatchChain } from '../../../src/core/patch/patchChain.js';
import { CheckpointRecord, fromJsonable, jsonableStrip } from '../../../src/core/storage/storage_records.js';
import {
  MESSAGE_MARKER,
  PATCH_CHAIN_MARKER,
  TOOL_CALL_MARKER,
} from '../../../src/core/storage/storage_constants.js';

function makeCheckpoint(state: Record<string, unknown>): CheckpointRecord {
  return new CheckpointRecord({
    checkpoint_id: 1,
    thread_id: 't1',
    node: 'n1',
    state: state as never,
  });
}

describe('敏感键剥离：覆盖 Python strip_sensitive 同口径', () => {
  it('api_key 置空保留（键结构不破坏）', () => {
    const cp = makeCheckpoint({
      model_config: { api_key: 'sk-secret', model: 'x' },
      ok: 1,
    });
    const json = cp.to_dict()['state'] as Record<string, unknown>;
    expect((json['model_config'] as Record<string, unknown>)['api_key']).toBe('');
    expect((json['model_config'] as Record<string, unknown>)['model']).toBe('x');
    expect(json['ok']).toBe(1);
  });

  it('常见前后缀凭据键（openai_api_key / client_secret / auth_token）剥离', () => {
    const cp = makeCheckpoint({
      openai_api_key: 'sk',
      client_secret: 's',
      auth_token: 't',
      token_count: 3, // 指标键不误伤
      key_insight: '剧情关键', // 业务键不误伤
    });
    const state = cp.to_dict()['state'] as Record<string, unknown>;
    expect(state['openai_api_key']).toBe('');
    expect(state['client_secret']).toBe('');
    expect(state['auth_token']).toBe('');
    expect(state['token_count']).toBe(3);
    expect(state['key_insight']).toBe('剧情关键');
  });

  it('嵌套结构递归剥离（dict / list）', () => {
    const data = {
      api_key: 'sk',
      nested: { token: 't', keep: 1 },
      list: [{ secret: 's' }, { ok: 2 }],
    };
    const out = jsonableStrip(data) as Record<string, unknown>;
    expect(out['api_key']).toBe('');
    expect((out['nested'] as Record<string, unknown>)['token']).toBe('');
    expect((out['nested'] as Record<string, unknown>)['keep']).toBe(1);
    expect(((out['list'] as unknown[])[0] as Record<string, unknown>)['secret']).toBe('');
    expect((out['list'] as unknown[])[1]).toEqual({ ok: 2 });
  });
});

describe('PatchChain / Message / ToolCall 内联 marker 还原', () => {
  it('PatchChain 序列化 → 反序列化精确还原', () => {
    const chain = new PatchChain({ content: '' });
    chain.apply({ op: 'append', path: ['content'], value: '草稿一' });
    chain.apply({ op: 'append', path: ['content'], value: '草稿二' });
    const cp = makeCheckpoint({ draft: chain });
    const json = cp.to_dict()['state'] as Record<string, unknown>;
    expect((json['draft'] as Record<string, unknown>)[PATCH_CHAIN_MARKER]).toBe(true);
    const restored = fromJsonable(json['draft']) as PatchChain;
    expect(restored).toBeInstanceOf(PatchChain);
    expect(restored.assemble()['content']).toBe('草稿一草稿二');
  });

  it('Message / ToolCall 序列化 → 反序列化精确还原', () => {
    const msgs = [
      new Message('user', '你好', null, null, null, 'm1'),
      new Message(
        'assistant',
        '',
        null,
        [new ToolCall({ id: 'c1', name: 'lookup', arguments: '{"q":1}' })],
        '先查库',
        'm2',
      ),
      new Message('tool', '结果', 'c1', null, null, 'm3'),
    ];
    const cp = makeCheckpoint({ messages: msgs });
    const json = cp.to_dict()['state'] as Record<string, unknown>;
    const out = fromJsonable((json['messages'] as unknown[])[0]) as Message;
    expect(out).toBeInstanceOf(Message);
    expect(out.id).toBe('m1');
    const restored = (fromJsonable(json['messages']) as Message[]).map((m) => {
      expect(m).toBeInstanceOf(Message);
      return m;
    });
    expect(restored[0]?.id).toBe('m1');
    expect(restored[1]?.tool_calls?.[0]?.name).toBe('lookup');
    expect(restored[1]?.tool_calls?.[0]?.arguments).toBe('{"q":1}');
    expect(restored[1]?.reasoning).toBe('先查库');
    expect(restored[2]?.role).toBe('tool');
    expect(restored[2]?.tool_call_id).toBe('c1');
  });

  it('PATCH_CHAIN_MARKER 命中时 data 不递归内层 marker（仅 base/patches 走）', () => {
    const chain = new PatchChain({ model_config: { api_key: 'sk', model: 'x' } });
    chain.apply({ op: 'replace', path: ['model_config'], value: { api_key: 'sk', model: 'x' } });
    const cp = makeCheckpoint({ draft: chain });
    const got = cp.to_dict()['state'] as Record<string, unknown>;
    const restored = fromJsonable(got['draft']) as PatchChain;
    const assembled = restored.assemble() as Record<string, unknown>;
    expect((assembled['model_config'] as Record<string, unknown>)['api_key']).toBe('');
    expect((assembled['model_config'] as Record<string, unknown>)['model']).toBe('x');
  });

  it('ToolCall 独立 marker 还原（无 Message 包裹）', () => {
    const tc = new ToolCall({ id: 'c1', name: 'lookup', arguments: '{}' });
    const out = jsonableStrip(tc) as Record<string, unknown>;
    expect(out[TOOL_CALL_MARKER]).toBe(true);
    const back = fromJsonable(out) as ToolCall;
    expect(back).toBeInstanceOf(ToolCall);
    expect(back.id).toBe('c1');
    expect(back.name).toBe('lookup');
    expect(back.arguments).toBe('{}');
  });
});

describe('嵌套递归 + copy-on-write + 元组归一', () => {
  it('子树无敏感键零拷贝（同对象引用）', () => {
    const safe = { ok: 1, list: [1, 2, 3] };
    const out = jsonableStrip(safe);
    expect(out).toBe(safe);
  });

  it('含敏感键子树返回新对象（copy-on-write）', () => {
    const unsafe = { ok: 1, secret: 's' };
    const out = jsonableStrip(unsafe);
    expect(out).not.toBe(unsafe);
    expect((out as Record<string, unknown>)['secret']).toBe('');
  });

  it('list 子树全部干净时零拷贝', () => {
    const safe = [1, 2, 3];
    expect(jsonableStrip(safe)).toBe(safe);
  });

  it('tuple 归一为数组（无敏感键子树零拷贝返回）', () => {
    const tup = [1, 2, 3] as const;
    const out = jsonableStrip(tup);
    expect(Array.isArray(out)).toBe(true);
  });

  it('CheckpointRecord.to_dict 顶层字段类型稳定（graph_path 数组、interrupt 序列化为 dict）', () => {
    const cp = new CheckpointRecord({
      checkpoint_id: 7,
      thread_id: 't',
      node: 'n',
      graph_path: ['g1', 'g2'],
      parent_id: 3,
      reason: 'reply',
      interrupt: new InterruptState('gate:x', { why: 'review' }, 'n', ['g1']),
    });
    const json = cp.to_dict();
    expect(json['checkpoint_id']).toBe(7);
    expect(json['parent_id']).toBe(3);
    expect(json['graph_path']).toEqual(['g1', 'g2']);
    expect(json['reason']).toBe('reply');
    expect(json['interrupt']).toEqual({
      key: 'gate:x',
      payload: { why: 'review' },
      node: 'n',
      graph_path: ['g1'],
    });
  });
});
