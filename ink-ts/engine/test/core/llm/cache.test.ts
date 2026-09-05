/**
 * LLM 调用缓存单测（对标 Python test_llm_cache.py 命中/分桶/往返/直通段）：
 * 同参命中、messages/tools/params/model/tag 指纹分桶、结果往返（usage 计费
 * 键经存储剥离）、落库记录字段、存储写失败 fail-open、流式直通/无存储直通/
 * aclose 委托。
 */

import { describe, expect, it } from 'vitest';

import { ToolCall } from '../../../src/core/llm/_shapes.js';
import { LLMParams, LLMResult } from '../../../src/core/llm/base.js';
import { CACHE_COLLECTION, CachingLLM } from '../../../src/core/llm/cache.js';
import { user } from '../../../src/core/llm/messages.js';
import { ToolSpec } from '../../../src/core/llm/tools.js';

import {
  ChainCountingLLM,
  CountingLLM,
  MemStorage,
  makeCached,
} from './helpers.js';

describe('命中与指纹分桶', () => {
  it('同参重复调用命中：内层不再调用', async () => {
    const storage = new MemStorage();
    const { cached, inner } = makeCached(storage);
    const messages = [user('你好')];
    const first = await cached.ainvoke(messages);
    expect(inner.ainvoke_calls).toBe(1);
    const second = await cached.ainvoke(messages);
    expect(inner.ainvoke_calls).toBe(1); // 命中：内层不再调用
    expect(second.content).toBe(first.content);
    expect(second.content).toBe('default-answer');
  });

  it('不同 messages 指纹区分：不命中', async () => {
    const { cached, inner } = makeCached(new MemStorage());
    await cached.ainvoke([user('a')]);
    await cached.ainvoke([user('b')]);
    expect(inner.ainvoke_calls).toBe(2);
  });

  it('不同 params 指纹区分：不命中（温度改变生成分布）', async () => {
    const { cached, inner } = makeCached(new MemStorage());
    await cached.ainvoke([user('a')], { params: new LLMParams({ temperature: 0.1 }) });
    await cached.ainvoke([user('a')], { params: new LLMParams({ temperature: 0.9 }) });
    expect(inner.ainvoke_calls).toBe(2);
  });

  it('不同 tools 指纹区分：不命中', async () => {
    const { cached, inner } = makeCached(new MemStorage());
    const toolA = new ToolSpec({ name: 'a', description: '', parameters: {} });
    const toolB = new ToolSpec({ name: 'b', description: '', parameters: {} });
    await cached.ainvoke([user('a')], { tools: [toolA] });
    await cached.ainvoke([user('a')], { tools: [toolB] });
    expect(inner.ainvoke_calls).toBe(2);
  });

  it('tag 标签分桶：同模型不同用途桶互不复用', async () => {
    const storage = new MemStorage();
    const inner = new CountingLLM();
    const cached = new CachingLLM(inner, { storage, tag: 'router' });
    await cached.ainvoke([user('a')]);
    const cached2 = new CachingLLM(inner, { storage, tag: 'main' });
    await cached2.ainvoke([user('a')]);
    expect(inner.ainvoke_calls).toBe(2); // tag 不同 → 分桶
  });

  it('model id 分桶：同存储不同模型互不复用', async () => {
    const storage = new MemStorage();
    const innerA = new CountingLLM(); // counting-model
    const ca = new CachingLLM(innerA, { storage });
    const innerB = new ChainCountingLLM('other-model');
    const cb = new CachingLLM(innerB, { storage });
    await ca.ainvoke([user('x')]);
    await cb.ainvoke([user('x')]);
    expect(innerA.ainvoke_calls).toBe(1);
    expect(innerB.head_calls).toBe(1);
  });
});

describe('链形包装（config 空占位 → configs[0] 标签）', () => {
  it('标签取链首模型 id（包装器 config.model_id = 链首）', () => {
    const chain = new ChainCountingLLM('chain-a');
    const cached = new CachingLLM(chain, { storage: new MemStorage() });
    expect(cached.config.model_id).toBe('chain-a');
  });

  it('缓存包链命中：链不再进模型', async () => {
    const chain = new ChainCountingLLM('chain-a');
    const cached = new CachingLLM(chain, { storage: new MemStorage() });
    await cached.ainvoke([user('q')]);
    await cached.ainvoke([user('q')]);
    expect(chain.head_calls).toBe(1); // 缓存命中 → 链不再被调
  });
});

describe('结果往返', () => {
  it('tool_calls/reasoning/finish 还原；usage 计费键经存储剥离置空', async () => {
    const storage = new MemStorage();
    const inner = new CountingLLM(
      new LLMResult({
        content: 'ok',
        reasoning: '想',
        tool_calls: [new ToolCall({ id: 'c1', name: 'lookup', arguments: '{"a":1}' })],
        finish_reason: 'tool_calls',
        usage: { total_tokens: 5 },
      }),
    );
    const cached = new CachingLLM(inner, { storage });
    const first = await cached.ainvoke([user('q')]);
    const second = await cached.ainvoke([user('q')]);
    expect(inner.ainvoke_calls).toBe(1);
    expect(second.content).toBe('ok');
    expect(second.reasoning).toBe('想');
    expect(second.tool_calls).toEqual(first.tool_calls);
    expect(second.tool_calls![0]!.arguments).toBe('{"a":1}');
    expect(second.finish_reason).toBe('tool_calls');
    // 存储记录契约：usage 的 token 计费键命中敏感键启发式（_tokens 后缀）
    // 被置空——缓存内容不依赖计费值
    expect(second.usage).toEqual({ total_tokens: '' });
  });
});

describe('落库记录字段', () => {
  it('五字段齐全：fingerprint/response/tag/created_at/patch_version', async () => {
    const storage = new MemStorage();
    const { cached } = makeCached(storage, { tag: 'router' });
    await cached.ainvoke([user('r')]);
    const records = await storage.list_records(CACHE_COLLECTION);
    expect(records.length).toBe(1);
    const record = records[0]!;
    for (const key of ['fingerprint', 'response', 'tag', 'created_at', 'patch_version']) {
      expect(record).toHaveProperty(key);
    }
    expect(record['tag']).toBe('router');
    expect((record['response'] as Record<string, unknown>)['content']).toBe('default-answer');
    expect(typeof record['created_at']).toBe('number');
    expect(record['fingerprint']).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });
});

describe('存储写失败 fail-open', () => {
  it('put_record 抛错不影响调用结果', async () => {
    class FailingWriteStorage extends MemStorage {
      async put_record(): Promise<void> {
        throw new Error('disk full');
      }
    }
    const { cached, inner } = makeCached(new FailingWriteStorage());
    const result = await cached.ainvoke([user('q')]);
    expect(result.content).toBe('default-answer');
    expect(inner.ainvoke_calls).toBe(1);
  });
});

describe('流式直通 / 无存储直通 / aclose', () => {
  it('astream 总是委托内层（不缓存）', async () => {
    const { cached, inner } = makeCached(new MemStorage());
    const tokens: string[] = [];
    for await (const chunk of cached.astream([user('s')])) {
      if (chunk.token) tokens.push(chunk.token);
    }
    expect(inner.astream_calls).toBe(1);
    expect(tokens).toEqual(['chunk-1']);
  });

  it('无存储 = 直通不缓存', async () => {
    const { cached, inner } = makeCached(null);
    await cached.ainvoke([user('q')]);
    await cached.ainvoke([user('q')]);
    expect(inner.ainvoke_calls).toBe(2); // 无存储 → 不缓存
  });

  it('aclose 委托内层', async () => {
    const { cached, inner } = makeCached(new MemStorage());
    await cached.aclose();
    expect(inner.aclosed).toBe(true);
  });
});
