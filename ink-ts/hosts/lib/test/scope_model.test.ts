/**
 * 作用域 model 引用解析单测（scope_model_llm 装配接线位：设计稿 §五/§7.5
 * 「作用域属性天然生效」的宿主面）。
 *
 * 测什么：
 * - build_product_recipe 透传：init.scope_model_llm 进 recipe.scope_model_llm
 *   （装配接线位非死字段）；
 * - InkHost.resolve_scope_model：provider+model_id 命中厂商清单 → 可用链
 *   （真实请求打到该端点）；仅 model_id 命中清单内厂商 → 解析成功；命中 agent
 *   槽当前配置 = 复用会话默认链；provider+model_id 未命中 = null（引擎侧显式
 *   失败，不静默跑父模型）；空引用 = null；
 * - 端到端：目录作用域资产带 model 引用（用户清单内第二模型）→ execution.run
 *   子执行请求打到该模型端点（模型 id 与引用一致——作用域 override 天然生效）；
 *   引用未命中 = 作用域模型决议失败 → run 失败收口（fail-closed）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { build_product_recipe } from '../src/recipe.js';
import { createHost } from '../src/index.js';
import type { HostHandle } from '../src/index.js';
import { FakeOpenAIServer } from './_fake_openai.js';

const CTX = { autoApprove: false };

function dirs(): { dir: string; events: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-scope-model-test-'));
  return { dir, events: path.join(dir, 'events') };
}

describe('scope_model_llm 装配接线位', () => {
  it('build_product_recipe 透传 init.scope_model_llm（非死字段）', () => {
    const resolver = () => null;
    const recipe = build_product_recipe({ scope_model_llm: resolver });
    expect(recipe.scope_model_llm).toBe(resolver);
    const plain = build_product_recipe({});
    expect(plain.scope_model_llm).toBeNull();
  });
});

describe('InkHost.resolve_scope_model（用户 model 列表内解析）', () => {
  let handle: HostHandle;
  let scopeServer: FakeOpenAIServer;
  let agentServer: FakeOpenAIServer;
  let dir = '';

  beforeEach(async () => {
    const made = dirs();
    dir = made.dir;
    scopeServer = new FakeOpenAIServer({ content: '作用域模型回复' });
    agentServer = new FakeOpenAIServer({ content: '会话默认回复' });
    await scopeServer.start();
    await agentServer.start();
    handle = await createHost({
      data_dir: made.dir,
      events_dir: made.events,
      model_config: {
        agent_config: {
          protocol: 'openai_compatible',
          base_url: agentServer.baseUrl,
          api_key: 'sk-scope-agent',
          model_id: 'agent-slot-model',
        },
      },
    });
    // 厂商清单经 models.config.put 运行时应用（providers = 用户 model 列表真源；
    // agent-prov 供会话默认槽，scope-prov 供作用域 override）
    await handle.bridge.get('models.config.put')!(
      {
        config: {
          providers: [
            {
              provider_id: 'agent-prov',
              base_url: agentServer.baseUrl,
              adapter: 'openai_compatible',
              api_key: 'sk-scope-agent',
              models: ['agent-slot-model'],
            },
            {
              provider_id: 'scope-prov',
              base_url: scopeServer.baseUrl,
              adapter: 'openai_compatible',
              api_key: 'sk-scope-prov',
              models: ['scope-model-a', 'scope-model-b'],
            },
          ],
          agent_pick: { provider_id: 'agent-prov', model_id: 'agent-slot-model' },
        },
      },
      CTX,
    );
  });

  afterEach(async () => {
    await handle.dispose();
    await scopeServer.close();
    await agentServer.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('provider+model_id 命中厂商清单 → 链可用且打到该端点', async () => {
    const { user } = await import('@ink-ts/engine');
    const llm = await handle.host.resolve_scope_model({ provider: 'scope-prov', model_id: 'scope-model-b' });
    expect(llm).not.toBeNull();
    const result = await llm!.ainvoke([user('hi')]);
    expect(result.content).toBe('作用域模型回复');
  });

  it('仅 model_id（无 provider）→ 在用户清单内解析', async () => {
    const llm = await handle.host.resolve_scope_model({ model_id: 'scope-model-a' });
    expect(llm).not.toBeNull();
  });

  it('命中 agent 槽当前配置 = 复用会话默认链（resolve_llm 同实例）', async () => {
    const scoped = await handle.host.resolve_scope_model({ model_id: 'agent-slot-model' });
    const session = await handle.host.resolve_llm();
    expect(scoped).not.toBeNull();
    expect(scoped).toBe(session);
  });

  it('provider+model_id 未命中 = null（fail-closed，不静默回落）', async () => {
    expect(await handle.host.resolve_scope_model({ provider: 'ghost-prov', model_id: 'x' })).toBeNull();
    expect(await handle.host.resolve_scope_model({ model_id: 'not-in-list' })).toBeNull();
    expect(await handle.host.resolve_scope_model({})).toBeNull();
  });
});

describe('作用域资产 model 引用端到端（execution.run 子执行 override）', () => {
  let handle: HostHandle;
  let scopeServer: FakeOpenAIServer;
  let agentServer: FakeOpenAIServer;
  let dir = '';

  beforeEach(async () => {
    const made = dirs();
    dir = made.dir;
    scopeServer = new FakeOpenAIServer({ content: '作用域模型回复' });
    agentServer = new FakeOpenAIServer({ content: '会话默认回复' });
    await scopeServer.start();
    await agentServer.start();
    handle = await createHost({
      data_dir: made.dir,
      events_dir: made.events,
      model_config: {
        agent_config: {
          protocol: 'openai_compatible',
          base_url: agentServer.baseUrl,
          api_key: 'sk-scope-e2e-agent',
          model_id: 'agent-slot-model',
        },
      },
    });
    await handle.bridge.get('models.config.put')!(
      {
        config: {
          providers: [
            {
              provider_id: 'agent-prov',
              base_url: agentServer.baseUrl,
              adapter: 'openai_compatible',
              api_key: 'sk-scope-e2e-agent',
              models: ['agent-slot-model'],
            },
            {
              provider_id: 'scope-prov',
              base_url: scopeServer.baseUrl,
              adapter: 'openai_compatible',
              api_key: 'sk-scope-e2e',
              models: ['scope-model-e2e'],
            },
          ],
          agent_pick: { provider_id: 'agent-prov', model_id: 'agent-slot-model' },
        },
      },
      CTX,
    );
    // 目录作用域资产带 model 引用（宿主实体注册表登记；执行面即时生效）
    const { EntitySpec } = await import('@ink-ts/engine');
    handle.runtime.entity_registry!.register(
      new EntitySpec({
        id: 'deep_analyst',
        role: 'analyst',
        persona: '深度分析作用域',
        model: { provider: 'scope-prov', model_id: 'scope-model-e2e' },
      } as never),
    );
  });

  afterEach(async () => {
    await handle.dispose();
    await scopeServer.close();
    await agentServer.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('execution.run 入口 deep_analyst → 请求打 scope-prov 端点（模型 id 一致）', async () => {
    const run = handle.bridge.get('execution.run')!;
    const result = (await run({ task: '深度分析', entry_scope: 'deep_analyst' }, CTX)) as {
      blocked: boolean;
      outcome: string;
      final_product: Record<string, unknown>;
    };
    expect(result.blocked).toBe(false);
    expect(result.outcome).toBe('success');
    expect(result.final_product['message']).toBe('作用域模型回复');
    expect(scopeServer.requestCount).toBeGreaterThanOrEqual(1);
    expect(agentServer.requestCount).toBe(0);
    const modelSeen = scopeServer.requests.some(
      (request) => request.body['model'] === 'scope-model-e2e',
    );
    expect(modelSeen).toBe(true);
  });

  it('引用未命中（清单外模型）= 作用域模型决议失败 → run 失败收口（不静默跑父模型）', async () => {
    const { EntitySpec } = await import('@ink-ts/engine');
    handle.runtime.entity_registry!.register(
      new EntitySpec({
        id: 'broken_scope',
        role: 'analyst',
        persona: '坏引用作用域',
        model: { provider: 'ghost-prov', model_id: 'nope' },
      } as never),
    );
    const run = handle.bridge.get('execution.run')!;
    const result = (await run({ task: 'x', entry_scope: 'broken_scope' }, CTX)) as {
      blocked: boolean;
      outcome: string;
      degraded_summaries: string[];
    };
    expect(result.outcome).toBe('failure');
    expect(result.degraded_summaries.join('；')).toContain('模型决议失败');
    expect(scopeServer.requestCount).toBe(0);
    expect(agentServer.requestCount).toBe(0);
  });
});
