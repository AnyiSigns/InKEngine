/**
 * host 装配冒烟（S2 验收对标 engine e2e：真存储 + 假 OpenAI 本地服务 +
 * Runtime.boot 装配跑通一轮 round，事件流非空 + 事件落文件实时刷新）。
 *
 * 覆盖：createHost 装配（memory 与 sqlite 两真存储后端）、rounds.send 一轮
 * 回复与事件、records.sessions / records.chain 查询、事件文件非空、dispose
 * 幂等。审批卡/裁决语义另在 bridge.test.ts 覆盖（gate 图无模型依赖）。
 */

import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHost } from '../src/index.js';
import type { HostHandle } from '../src/index.js';
import { chatGraphRecipe } from './_graphs.js';
import { FakeOpenAIServer } from './_fake_openai.js';

interface Ctx {
  dir: string;
  events: string;
}

function tempContext(): Ctx {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-host-test-'));
  const events = path.join(dir, 'events');
  return { dir, events };
}

const MEMORY_CONFIG = { data_dir: '', events_dir: '' };

describe('host 装配冒烟（真存储 + 假 OpenAI + 一轮 round）', () => {
  let ctx: Ctx;
  let server: FakeOpenAIServer;
  let handle: HostHandle;

  beforeEach(async () => {
    ctx = tempContext();
    server = new FakeOpenAIServer({ content: '你好，宿主' });
    await server.start();
  });

  afterEach(async () => {
    if (handle !== undefined && handle !== null) {
      await handle.dispose();
    }
    await server.close();
  });

  it('createHost memory 后端：rounds.send 一轮回复 + 事件流非空 + 事件落文件', async () => {
    const config = {
      ...MEMORY_CONFIG,
      data_dir: ctx.dir,
      events_dir: ctx.events,
      model_config: {
        agent_config: {
          protocol: 'openai_compatible',
          base_url: server.baseUrl,
          api_key: 'sk-host-test',
          model_id: 'host-chat',
        },
      },
    };
    handle = await createHost(config, { graph_recipe: chatGraphRecipe });
    expect(handle.config.storage_uri).toBe('memory://');
    expect(handle.config.autoApprove).toBe(false);

    const send = handle.bridge.get('rounds.send');
    expect(send).toBeTypeOf('function');
    const result = (await send!({ input: '你好' }, { autoApprove: false })) as {
      thread_id: string;
      round_id: string;
      reply: string;
      reason: string;
      events: { count: number; types: string[] };
    };
    expect(result.reply).toBe('你好，宿主');
    expect(result.reason).toBe('reply');
    expect(result.events.count).toBeGreaterThan(0);
    expect(result.events.types).toContain('reply_token');

    // 事件落文件实时刷新（非日志打印）：events 目录含 JSONL 且非空
    const files = readdirSync(ctx.events);
    expect(files.length).toBeGreaterThan(0);
    const first = files[0]!;
    const stats = statSync(path.join(ctx.events, first));
    expect(stats.size).toBeGreaterThan(0);

    // records.sessions 索引 + records.chain 链记录（引擎权威）
    const sessions = (await handle.bridge.get('records.sessions')!(
      {},
      { autoApprove: false },
    )) as Array<{ thread_id: string; round_count: number }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.thread_id).toBe(result.thread_id);
    expect(sessions[0]!.round_count).toBe(1);

    const chain = (await handle.bridge.get('records.chain')!(
      { thread_id: result.thread_id },
      { autoApprove: false },
    )) as { chain: unknown[]; checkpoints: unknown[] };
    expect(chain.chain.length).toBeGreaterThan(0);

    // 存储层 checkpoint 已落（真存储贯通）
    const cps = await handle.runtime.storage!.list_checkpoints(result.thread_id, { limit: 100 });
    expect(cps.length).toBeGreaterThan(0);

    // 二次同线程回合：会话 round_count 递增、续链不断链
    const again = (await handle.bridge.get('rounds.send')!(
      { input: '再来一轮', thread_id: result.thread_id },
      { autoApprove: false },
    )) as { reply: string };
    expect(again.reply).toBe('你好，宿主');
    const sessions2 = (await handle.bridge.get('records.sessions')!(
      {},
      { autoApprove: false },
    )) as Array<{ round_count: number }>;
    expect(sessions2[0]!.round_count).toBe(2);

    // dispose 幂等（Runtime.stop ×2）
    await handle.dispose();
    await handle.dispose();
    handle = null as unknown as HostHandle;
  });

  it('createHost sqlite 文件后端：rounds.send 落链可查（host 存储工厂路由）', async () => {
    const db = path.join(ctx.dir, 'host.db').replace(/\\/g, '/');
    const config = {
      storage_uri: `sqlite:///${db}`,
      data_dir: ctx.dir,
      events_dir: ctx.events,
      model_config: {
        agent_config: {
          protocol: 'openai_compatible',
          base_url: server.baseUrl,
          api_key: 'sk-host-test',
          model_id: 'host-chat',
        },
      },
    };
    handle = await createHost(config, { graph_recipe: chatGraphRecipe });
    expect(handle.config.storage_uri).toContain('sqlite://');
    const send = handle.bridge.get('rounds.send');
    const result = (await send!({ input: '持久化' }, { autoApprove: false })) as {
      thread_id: string;
      reply: string;
    };
    expect(result.reply).toBe('你好，宿主');
    const cps = await handle.runtime.storage!.list_checkpoints(result.thread_id, { limit: 100 });
    expect(cps.length).toBeGreaterThan(0);
    expect(statSync(db).size).toBeGreaterThan(0);
  });
});
