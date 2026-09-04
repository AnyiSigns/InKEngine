/**
 * 引擎端到端回归（真适配器 + 真存储 + 进程内假 OpenAI 服务，零外网）。
 *
 * 组成语义镜像 stdio_host.py + test_runtime.py 的 AssemblyRecipe 直注配方
 * （boot 种子 / 系统提示词 / UI 描述 / 事件类型 / 自举 harness / 契约自指
 * 工具三路声明），但为**引擎侧**接线冒烟（无任何后端/宿主产品代码）：
 * - 真 MemoryStorage（adapters/storage）三通道生命周期；
 * - registry.create_llm → 真 OpenAICompatibleLLM → node:http 本地假服务
 *   （非流式 + SSE 流式全链路协议化断言）；
 * - CachingLLM/ModelChain 套真存储与真适配器的缓存闭环；
 * - Runtime.boot（Host 五件套真实现）装配出的 engine 经守卫链真实 ainvoke。
 *
 * Runtime 装配面说明：模型注入面 = Host 五件套的 resolve_llm()（返回
 * AsyncLLM；AssemblyRecipe 无 llm_config 字段），本组第 4 项据此完成装配
 * 冒烟，未改任何 Runtime 代码。每测试独立服务实例/存储/端口，绝不共享。
 */

import { describe, expect, it } from 'vitest';

import { create_memory_storage } from '../../src/adapters/storage/index.js';
import { create_llm } from '../../src/adapters/llm/registry.js';
import { Runtime } from '../../src/core/runtime/index.js';
import { CACHE_COLLECTION, CachingLLM } from '../../src/core/llm/cache.js';
import { ModelChain, RetryPolicy } from '../../src/core/llm/fallback.js';
import type { AsyncLLM } from '../../src/core/llm/base.js';
import { LLMConfigError } from '../../src/core/llm/errors.js';
import { system, user } from '../../src/core/llm/messages.js';
import { validate_chain } from '../../src/core/storage/storage.js';
import { FakeOpenAIServer } from './_fake_openai.js';
import {
  E2eHost,
  boot_runtime,
  e2e_recipe,
  eventsOf,
  latestTransport,
  linear_graph_recipe,
  llm_chat_graph_recipe,
} from './_e2e_fixtures.js';

// ---------------------------------------------------------------------------
// 1. 真 MemoryStorage 生命周期闭环（装配落库 → 跑图 → 二次续链 → 幂等关停）
// ---------------------------------------------------------------------------
describe('真 MemoryStorage 生命周期闭环', () => {
  it('boot 落 records；engine 跑图落 checkpoints；二次续链不断链；close 幂等', async () => {
    const host = new E2eHost();
    const runtime = await boot_runtime(host, e2e_recipe({ graph_recipe: linear_graph_recipe }));
    // records 通道已落（harness 定义经 records 持久化，可读回 = 已写盘）
    const saved = await runtime.harness_repository!.get('forge');
    expect(saved).not.toBeNull();
    // 第一回合：终态 checkpoint + 事件日志均已落真存储
    const first = await runtime.engine!.ainvoke(
      { input: '第一回合' },
      { thread_id: 't-life', round_id: 'r1' },
    );
    expect(first.checkpoint_id).not.toBeNull();
    const cps1 = await runtime.storage!.list_checkpoints('t-life', { limit: 100 });
    expect(cps1.length).toBeGreaterThan(0);
    const events = await runtime.storage!.events_after('t-life', 0);
    expect(events.length).toBeGreaterThan(0);
    // 同一实例二次跑（continue_chain 续链）：链尾续接不击穿
    const second = await runtime.engine!.ainvoke(
      { input: '第二回合' },
      { thread_id: 't-life', round_id: 'r2', continue_chain: true },
    );
    expect(second.checkpoint_id).not.toBeNull();
    const cps2 = await runtime.storage!.list_checkpoints('t-life', { limit: 100 });
    expect(cps2.length).toBeGreaterThan(cps1.length);
    expect((second.state as Record<string, unknown>)['reply']).toBe('回合:第二回合');
    // 链一致性纯校验：无悬挂/回退/跨线程违规
    const violations = await validate_chain(runtime.storage!, 't-life');
    expect(violations).toEqual([]);
    // 关停幂等（Runtime.stop ×2 + 存储 close ×2，真内存后端无操作语义）
    await runtime.stop();
    await runtime.stop();
    await runtime.storage!.close();
    await host.storage.close();
  });
});

// ---------------------------------------------------------------------------
// 2. registry.create_llm + 真适配器链路（本地假服务，非流式 + SSE 流式）
// ---------------------------------------------------------------------------
describe('registry.create_llm + 真适配器链路', () => {
  it('create_llm 装配 openai_compat → 非流式 ainvoke：协议载荷与解析产物', async () => {
    const server = new FakeOpenAIServer({
      content: '你好，InKEngine',
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    await server.start();
    try {
      const llm = create_llm({
        adapter: 'openai_compat',
        model_id: 'e2e-model',
        base_url: server.baseUrl,
        api_key: 'sk-e2e',
      });
      expect(llm.adapter).toBe('openai_compatible');
      const result = await llm.ainvoke([system('协议化提示'), user('测试')]);
      const req = server.requests[0]!;
      expect(req.url).toMatch(/\/v1\/chat\/completions$/);
      expect(req.method).toBe('POST');
      expect(req.headers['authorization']).toBe('Bearer sk-e2e');
      expect(req.headers['content-type']).toContain('application/json');
      expect(req.body['model']).toBe('e2e-model');
      expect(req.body['stream']).toBe(false);
      expect(req.body['messages']).toEqual([
        { role: 'system', content: '协议化提示' },
        { role: 'user', content: '测试' },
      ]);
      expect(result.content).toBe('你好，InKEngine');
      expect(result.finish_reason).toBe('stop');
      expect(Number(result.usage?.['completion_tokens'])).toBe(4);
      await llm.aclose();
    } finally {
      await server.close();
    }
  });

  it('astream（本地假服务 SSE）：token 增量 → usage 末帧 → [DONE] 收流', async () => {
    const server = new FakeOpenAIServer({ content: '流式输出', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    await server.start();
    try {
      const llm = create_llm({
        adapter: 'openai_compat',
        model_id: 'e2e-model',
        base_url: server.baseUrl,
        api_key: 'sk-e2e',
      });
      const chunks: Array<{ token: string | null; finish_reason: string | null; usage: Record<string, unknown> | null }> = [];
      for await (const chunk of llm.astream([user('你好')])) {
        chunks.push(chunk);
      }
      expect(chunks.map((c) => c.token ?? '').join('')).toBe('流式输出');
      expect(chunks.some((c) => c.finish_reason === 'stop')).toBe(true);
      const usageFrame = chunks.find((c) => c.usage !== null);
      expect(usageFrame).toBeTruthy();
      expect(Number(usageFrame!.usage?.['completion_tokens'])).toBe(5);
      const req = server.requests[0]!;
      expect(req.body['stream']).toBe(true);
      expect(req.body['stream_options']).toEqual({ include_usage: true });
      await llm.aclose();
    } finally {
      await server.close();
    }
  });

  it('create_llm 未注册适配器 fail-fast（LLMConfigError）', () => {
    expect(() =>
      create_llm({
        adapter: 'not-a-real-adapter',
        model_id: 'x',
        base_url: 'http://127.0.0.1:9/v1',
      }),
    ).toThrow(LLMConfigError);
  });
});

// ---------------------------------------------------------------------------
// 3. CachingLLM 套真 MemoryStorage（miss → 命中；存储可见；TTL/clear 失效）
// ---------------------------------------------------------------------------
describe('CachingLLM + 真 MemoryStorage 缓存闭环', () => {
  it('同参二次调用命中不二次请求；storage 可见缓存记录', async () => {
    const server = new FakeOpenAIServer({ content: '缓存回答' });
    await server.start();
    try {
      const storage = create_memory_storage();
      const cached = new CachingLLM(
        create_llm({
          adapter: 'openai_compat',
          model_id: 'cache-model',
          base_url: server.baseUrl,
          api_key: 'sk-e2e',
        }),
        { storage, tier: 'e2e' },
      );
      const messages = [user('缓存问题')];
      const first = await cached.ainvoke(messages);
      const second = await cached.ainvoke(messages);
      expect(first.content).toBe('缓存回答');
      expect(second.content).toBe(first.content);
      expect(server.requestCount).toBe(1); // 第二次命中缓存，不再打服务
      const records = await storage.list_records(CACHE_COLLECTION);
      expect(records.length).toBe(1);
      expect(records[0]!['tier']).toBe('e2e');
      const stats = await cached.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      await cached.aclose();
    } finally {
      await server.close();
    }
  });

  it('ModelChain(registry.create_llm) 作内层：链首指纹 + 命中闭环', async () => {
    const server = new FakeOpenAIServer({ content: '链式回答' });
    await server.start();
    try {
      const config = {
        adapter: 'openai_compat',
        model_id: 'chain-model',
        base_url: server.baseUrl,
        api_key: 'sk-e2e',
      };
      const chain = new ModelChain([config], {
        create: (cfg) => create_llm(cfg),
        retry: new RetryPolicy(),
      });
      // ModelChain 非 AsyncLLM 子类（configs 容器形态），鸭子转换入缓存包装
      const cached = new CachingLLM(chain as unknown as AsyncLLM, {
        storage: create_memory_storage(),
      });
      expect(cached.config.model_id).toBe('chain-model'); // 指纹取链首模型标签
      await cached.ainvoke([user('问题')]);
      await cached.ainvoke([user('问题')]);
      expect(server.requestCount).toBe(1);
      await cached.aclose();
    } finally {
      await server.close();
    }
  });

  it('TTL 过期触发再请求；clear() 物理清空记录并归零计数', async () => {
    const server = new FakeOpenAIServer({ content: 'ttl回答' });
    await server.start();
    try {
      const storage = create_memory_storage();
      let now = 1000;
      const cached = new CachingLLM(
        create_llm({
          adapter: 'openai_compat',
          model_id: 'ttl-model',
          base_url: server.baseUrl,
          api_key: 'sk-e2e',
        }),
        { storage, ttl: 60, clock: () => now },
      );
      await cached.ainvoke([user('过期问题')]);
      expect(server.requestCount).toBe(1);
      now += 61; // 超过 60s 保质期 → 记录失效按 miss
      await cached.ainvoke([user('过期问题')]);
      expect(server.requestCount).toBe(2);
      // 再次同参（新记录未过期）命中
      await cached.ainvoke([user('过期问题')]);
      expect(server.requestCount).toBe(2);
      const cleared = await cached.clear();
      expect(cleared).toBe(1);
      expect((await storage.list_records(CACHE_COLLECTION)).length).toBe(0);
      const stats = await cached.stats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      await cached.aclose();
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Runtime 组装接线冒烟（boot 种子 + MemoryStorage + 真适配器 → engine 可跑）
// ---------------------------------------------------------------------------
describe('Runtime 组装接线冒烟', () => {
  it('boot 配方直注 + 真存储 + 真适配器装配出的 engine 可 ainvoke（假服务流式）', async () => {
    const server = new FakeOpenAIServer({ content: '你好，世界' });
    await server.start();
    const host = new E2eHost(
      create_llm({
        adapter: 'openai_compat',
        model_id: 'runtime-model',
        base_url: server.baseUrl,
        api_key: 'sk-e2e',
      }),
    );
    try {
      const runtime = await boot_runtime(
        host,
        e2e_recipe({ graph_recipe: llm_chat_graph_recipe }),
      );
      // 配方缺省 Host.resolve_llm 已装配真适配器（被守卫链包装）
      expect(runtime.engine_llm).not.toBeNull();
      expect(host.storage).toBe(runtime.storage!.inner);
      const transport = latestTransport(host);
      const result = await runtime.engine!.ainvoke(
        { input: '打个招呼' },
        { thread_id: 't-asm', round_id: 'r', transports: [transport] },
      );
      expect((result.state as Record<string, unknown>)['reply']).toBe('你好，世界');
      const tokens = eventsOf(transport, 'reply_token')
        .map((e) => String(e.payload['token'] ?? ''))
        .join('');
      expect(tokens).toBe('你好，世界');
      // 真存储同样收到回合 checkpoint（引擎落盘面贯通）
      const cps = await runtime.storage!.list_checkpoints('t-asm', { limit: 100 });
      expect(cps.length).toBeGreaterThan(0);
      await runtime.stop();
    } finally {
      await server.close();
    }
  });
});
