/**
 * host 装配冒烟（对标 engine e2e：真存储 + 假 OpenAI 本地服务 +
 * Runtime.boot 装配跑通一轮 round，事件流非空 + 事件落文件实时刷新）。
 *
 * 覆盖：createHost 装配（memory 与 sqlite 两真存储后端）、rounds.send 一轮
 * 回复与事件、records.sessions / records.chain 查询、事件文件非空、dispose
 * 幂等。审批卡/裁决语义另在 rounds_mainline 覆盖（exec 链挂卡 + rounds.resume）。
 * W7-B 迁移注：组装回退 flag 已随组装链路退役，本文件走 execution 主线默认
 * 回合；主线事件带/落链语义见 rounds_mainline.test.ts。
 */

import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOOT_SYSTEM_PROMPT } from '@ink-ts/engine';

import { createHost } from '../src/index.js';
import type { HostHandle } from '../src/index.js';
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

const MEMORY_CONFIG = { storage_uri: 'memory://', data_dir: '', events_dir: '' };

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
    handle = await createHost(config);
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
    // 主线事件带 = 执行运行时动作词（组装路 reply_token 事件流随组装退役）
    expect(result.events.types).toContain('scope_turn');

    // P4.2b：boot 系统提示词经配方 AssemblyRecipe.boot_system_prompt 注入 →
    // llm 类结点 system 消息合成（真实回合多出 boot 只读基线，非知识条目检索）
    const llmRequest = server.requests.find((request) =>
      Array.isArray((request.body as { messages?: unknown }).messages),
    );
    expect(llmRequest).toBeDefined();
    const sentMessages = (llmRequest!.body as {
      messages: Array<{ role: string; content: string }>;
    }).messages;
    expect(sentMessages[0]!.role).toBe('system');
    // 主线 system = boot 只读基线 + 作用域 persona 增量叠加（含 boot 前缀即对齐）
    expect(sentMessages[0]!.content.startsWith(BOOT_SYSTEM_PROMPT)).toBe(true);

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
    handle = await createHost(config);
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
