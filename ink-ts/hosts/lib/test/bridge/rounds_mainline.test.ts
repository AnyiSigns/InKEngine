// gate: 超限(488 行) - W7-A 主线切换 E2E（直答/连续/失败/审批挂卡/注入/中止/回退）场景多、头注详尽，拆分会伤可读性
/**
 * rounds.send/resume 执行主线语义 E2E（W7-A 回合入口切换；fake llm 全链）。
 *
 * 测什么（逐项对应主线切换的对齐面）：
 * - send → 回复：execution 主线直答收口（reason='reply'，reply=汇聚点 message，
 *   事件带/回合归档 checkpoint/簿记 current_leaf/展示态 sessions.messages 成对）；
 * - 多轮连续性：同线程二次 send 经展示链投影 history（模型请求输入携带首轮问答）；
 * - review 卡挂起 → rounds.resume accept 续跑出结论（main 首轮不重跑：模型请求数
 *   = 挂起前 1 + 续跑 2）；reject 决议 fail-closed 收口；
 * - 挂起卡随 exec 链 checkpoint 持久化（interrupt 键 = gate:channel:guarded）；
 * - 运行中 send → §7.3 注入（reason='injected'；后续模型请求输入携带注入文本；
 *   主线回合展示流出现注入 user 条目；user_inject 事件在带）；
 * - 运行中 rounds.abort 投递 → round_aborted 显式拒绝 + 簿记 last_outcome='aborted'；
 * - flag 回退（INK_ROUNDS_ASSEMBLY_FALLBACK）：旧组装路径行为保持（无模型 →
 *   确定性 stub + round_pose 落链；exec 链不落主线留痕）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChannelSpec, exec_checkpoint_thread } from '@ink-ts/engine';

import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { FakeOpenAIServer } from '../_fake_openai.js';

const CTX = { autoApprove: false };

function dirs(): { dir: string; events: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-rounds-ml-'));
  return { dir, events: path.join(dir, 'events') };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function chatConfig(baseUrl: string, apiKey: string) {
  return {
    protocol: 'openai_compatible' as const,
    base_url: baseUrl,
    api_key: apiKey,
    model_id: 'rounds-ml-model',
  };
}

interface SendView {
  thread_id: string;
  round_id: string;
  reason: string;
  checkpoint_id: number | null;
  reply: string | null;
  events: { count: number; types: string[] };
  run_id?: string;
  injected?: boolean;
  pending_approval?: boolean;
  pending?: { key: string | null; payload: Record<string, unknown>; checkpoint_id: number | null } | null;
  execution_outcome?: string;
  degraded_summaries?: string[];
  error?: string | null;
}

interface MessagesView {
  thread_id: string;
  messages: Array<{ kind: string; text?: string; role?: string; round_id?: string }>;
}

async function readMessages(handle: HostHandle, thread_id: string): Promise<MessagesView> {
  return (await handle.bridge.get('sessions.messages')!({ thread_id }, CTX)) as MessagesView;
}

interface SessionRow {
  round_count: number;
  last_round_id: string | null;
  last_outcome?: string;
  current_leaf: number | null;
}

async function sessionRow(handle: HostHandle, thread_id: string): Promise<SessionRow> {
  const rows = (await handle.bridge.get('records.sessions')!(null, CTX)) as Array<
    SessionRow & { thread_id: string }
  >;
  return rows.find((row) => row.thread_id === thread_id)!;
}

async function bootHost(
  server: FakeOpenAIServer | null,
  dir: string,
): Promise<HostHandle> {
  const config: Record<string, unknown> = {
    data_dir: dir,
    events_dir: path.join(dir, 'events'),
  };
  if (server !== null) {
    config['model_config'] = { agent_config: chatConfig(server.baseUrl, 'sk-rounds-ml') };
  }
  return await createHost(config as never);
}

describe('rounds 执行主线（send → 回复 + 簿记/展示/链齐备）', () => {
  it('send 直答：reply/reason/事件带/回合链叶/簿记/展示态全对齐', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({ content: '主线直答' });
    await server.start();
    const handle = await bootHost(server, made.dir);
    try {
      const result = (await handle.bridge.get('rounds.send')!(
        { input: '主线一问' },
        CTX,
      )) as SendView;
      expect(result.reason).toBe('reply');
      expect(result.reply).toBe('主线直答');
      expect(result.run_id).toBe(`r:${result.thread_id}`);
      expect(result.execution_outcome).toBe('success');
      expect(result.pending_approval).toBe(false);
      // 事件带：执行主线动作词（并同步落 JSONL 事件文件观测渠道）
      expect(result.events.count).toBeGreaterThan(0);
      expect(result.events.types).toContain('scope_turn');
      expect(result.events.types).toContain('run_end');
      // 回合归档 checkpoint 薄留痕落会话线程链（无图：records.chain 可查）
      expect(result.checkpoint_id).not.toBeNull();
      const chain = (await handle.bridge.get('records.chain')!(
        { thread_id: result.thread_id },
        CTX,
      )) as { chain: unknown[]; checkpoints: Array<{ state: Record<string, unknown> }> };
      expect(chain.chain.length).toBeGreaterThan(0);
      expect(chain.checkpoints[0]!.state['execution']).toBe(true);
      expect(chain.checkpoints[0]!.state['_round_graph']).toBeUndefined();
      // 簿记：round_count/round_id/outcome/current_leaf
      const row = await sessionRow(handle, result.thread_id);
      expect(row.round_count).toBe(1);
      expect(row.last_round_id).toBe(result.round_id);
      expect(row.last_outcome).toBe('reply');
      expect(row.current_leaf).toBe(result.checkpoint_id);
      // 展示态：user + assistant 成对（sessions.messages 投影 kind='message'；assistant 带 round 归属）
      const view = await readMessages(handle, result.thread_id);
      const texts = view.messages.filter((message) => message.kind === 'message');
      expect(texts.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(texts[0]!.text).toBe('主线一问');
      expect(texts[1]!.text).toBe('主线直答');
      expect(texts[1]!.round_id).toBe(result.round_id);
    } finally {
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });

  it('同线程多轮：簿记递增 + history 连续性桥（次轮模型请求携带首轮问答）', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({ content: '稳定回复' });
    await server.start();
    const handle = await bootHost(server, made.dir);
    try {
      const first = (await handle.bridge.get('rounds.send')!(
        { input: '第一问' },
        CTX,
      )) as SendView;
      const second = (await handle.bridge.get('rounds.send')!(
        { input: '第二问', thread_id: first.thread_id },
        CTX,
      )) as SendView;
      expect(second.reason).toBe('reply');
      expect(second.reply).toBe('稳定回复');
      const row = await sessionRow(handle, first.thread_id);
      expect(row.round_count).toBe(2);
      expect(row.current_leaf).toBe(second.checkpoint_id);
      expect(server.requests.length).toBeGreaterThanOrEqual(2);
      const secondBody = JSON.stringify(server.requests[1]!.body);
      expect(secondBody).toContain('第一问');
      expect(secondBody).toContain('稳定回复');
    } finally {
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });

  it('无模型配置：主线执行失败显式收口（reason=error，reply 无，不静默）', async () => {
    const made = dirs();
    const handle = await bootHost(null, made.dir);
    try {
      const result = (await handle.bridge.get('rounds.send')!(
        { input: 'hi' },
        CTX,
      )) as SendView;
      expect(result.reason).toBe('error');
      expect(result.reply).toBeNull();
      expect(result.execution_outcome).toBe('failure');
      expect(result.degraded_summaries?.join('；')).toContain('会话默认模型');
      const row = await sessionRow(handle, result.thread_id);
      expect(row.last_outcome).toBe('error');
    } finally {
      await handle.dispose();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });

  it('pose 透传主线（review 缺省行为；回执扩展字段 pending=null）', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({ content: '档位回复' });
    await server.start();
    const handle = await bootHost(server, made.dir);
    try {
      for (const pose of ['auto', 'review', 'deny'] as const) {
        const result = (await handle.bridge.get('rounds.send')!(
          { input: 'hi', pose },
          CTX,
        )) as SendView;
        expect(result.reason).toBe('reply');
        expect(result.pending).toBeNull();
        expect(result.run_id).toBeTypeOf('string');
      }
    } finally {
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });
});

describe('rounds 主线审批挂卡：send 挂起 → resume 决议续跑（W7-D 协议）', () => {
  async function bootGuarded(
    script: string[],
  ): Promise<{ handle: HostHandle; server: FakeOpenAIServer; cleanup: () => Promise<void> }> {
    const made = dirs();
    const server = new FakeOpenAIServer({ content: script });
    await server.start();
    const handle = await bootHost(server, made.dir);
    // 审批档通道（guarded）：review 姿态 + hang=true → 转场挂卡而非 fail-closed
    handle.execution.channels.register(
      new ChannelSpec({ id: 'guarded', shape: 'delegate', conditions: { approval: 'L2' } }),
    );
    return {
      handle,
      server,
      cleanup: async () => {
        await handle.dispose();
        await server.close();
        rmSync(made.dir, { recursive: true, force: true });
      },
    };
  }

  const delegateScript = (conclusion: string): string[] => [
    '{"__next": {"kind": "channel", "channel": "guarded", "target": "subagent"}}',
    '子代理结论',
    conclusion,
  ];

  it('review 卡挂起：send 返回 interrupted + pending 卡；exec 链尾 checkpoint 持久化挂起卡', async () => {
    const { handle, cleanup } = await bootGuarded(delegateScript('汇总结论'));
    try {
      const result = (await handle.bridge.get('rounds.send')!(
        { input: '委托并汇总' },
        CTX,
      )) as SendView;
      expect(result.reason).toBe('interrupted');
      expect(result.pending_approval).toBe(true);
      expect(result.pending?.key).toBe('gate:channel:guarded');
      expect(result.pending?.checkpoint_id).toBeGreaterThan(0);
      expect(result.reply).toBeNull();
      const execTail = await handle.runtime.storage!.get_latest_checkpoint(
        exec_checkpoint_thread(result.run_id!),
      );
      expect(execTail).not.toBeNull();
      expect(execTail!.interrupt?.key).toBe('gate:channel:guarded');
      // 簿记收尾 = interrupted（挂起也是回合结局留痕）；展示流含等待审批提示
      const row = await sessionRow(handle, result.thread_id);
      expect(row.last_outcome).toBe('interrupted');
      const view = await readMessages(handle, result.thread_id);
      expect(
        view.messages.some((message) => String(message.text).includes('等待审批裁决')),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('accept 决议经 rounds.resume 续跑出结论（main 首轮不重跑；决议对象形态）', async () => {
    const { handle, server, cleanup } = await bootGuarded(delegateScript('汇总结论'));
    try {
      const first = (await handle.bridge.get('rounds.send')!(
        { input: '委托并汇总' },
        CTX,
      )) as SendView;
      expect(first.reason).toBe('interrupted');
      const requestsBeforeResume = server.requestCount;
      const resumed = (await handle.bridge.get('rounds.resume')!(
        { thread_id: first.thread_id, decision: { decision: 'accept' } },
        CTX,
      )) as { thread_id: string; resumed: boolean; result: SendView };
      expect(resumed.resumed).toBe(true);
      expect(resumed.result.reason).toBe('reply');
      expect(resumed.result.reply).toBe('汇总结论');
      expect(resumed.result.run_id).toBe(first.run_id);
      // main 首轮（委托剧本第 1 请求）不重跑：挂起前 1 请求，续跑只补子代理+汇总
      expect(requestsBeforeResume).toBe(1);
      expect(server.requestCount).toBe(3);
      // 续跑收尾：exec 链无残留挂卡（链尾 settled）；簿记/展示收口
      const execTail = await handle.runtime.storage!.get_latest_checkpoint(
        exec_checkpoint_thread(first.run_id!),
      );
      expect(execTail!.interrupt).toBeNull();
      const row = await sessionRow(handle, first.thread_id);
      expect(row.last_outcome).toBe('reply');
      const view = await readMessages(handle, first.thread_id);
      expect(
        view.messages.some(
          (message) => message.text === '汇总结论' && message.role === 'assistant',
        ),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('reject 决议（字符串形态）→ 转场阻断 fail-closed 收口（reason=error）', async () => {
    const { handle, cleanup } = await bootGuarded(delegateScript('不应出现'));
    try {
      const first = (await handle.bridge.get('rounds.send')!(
        { input: '委托并汇总' },
        CTX,
      )) as SendView;
      const resumed = (await handle.bridge.get('rounds.resume')!(
        { thread_id: first.thread_id, decision: 'reject' },
        CTX,
      )) as { result: SendView };
      expect(resumed.result.reason).toBe('error');
      expect(resumed.result.execution_outcome).toBe('failure');
      expect(String(resumed.result.error)).toContain('L2 未通过');
    } finally {
      await cleanup();
    }
  });

  it('无任何挂卡线程 rounds.resume → 组装审批卡语义回落（无卡显式拒绝）', async () => {
    const { handle, cleanup } = await bootGuarded(['普通回复']);
    try {
      // 组装回退语义保持原样：runtime.resume_run 裸 Error 上抛（既有行为零改动；
      // BridgeError 包装属 approval.resolve 的 approval 域职责，不在 rounds 域）
      await expect(
        handle.bridge.get('rounds.resume')!(
          { thread_id: 't-no-card', decision: 'accept' },
          CTX,
        ),
      ).rejects.toThrow(/无挂起审批卡/);
    } finally {
      await cleanup();
    }
  });
});

describe('rounds 主线运行中注入与中止（§7.3 + 既有 abort）', () => {
  it('运行中 send 同线程 → 注入（injected 回执；下一 main 轮输入携带 + user_inject 在带）', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({
      content: [
        '{"__next": {"kind": "scope", "target": "subagent"}}',
        '子代理初步结果',
        '按补充收口',
      ],
    });
    await server.start();
    const handle = await bootHost(server, made.dir);
    try {
      const threadId = 'ml-inject-thread';
      // send1 同步前缀登记在途（首个 await 前），send2 同步即可见 → 注入
      const runPromise = (handle.bridge.get('rounds.send')!)(
        { input: '委托任务主线', thread_id: threadId },
        CTX,
      ) as Promise<unknown>;
      const injected = (await handle.bridge.get('rounds.send')!(
        { input: '用户补充：改用方案 B', thread_id: threadId },
        CTX,
      )) as SendView;
      expect(injected.reason).toBe('injected');
      expect(injected.injected).toBe(true);
      expect(injected.checkpoint_id).toBeNull();
      expect(injected.run_id).toBe(`r:${threadId}`);
      const result = (await runPromise) as SendView;
      expect(result.reason).toBe('reply');
      expect(result.reply).toBe('按补充收口');
      expect(result.events.types).toContain('user_inject');
      // 注入文本经 next_user_input seam 并入 main 轮输入（排队语义下最快可达
      // 轮次消费；至少一次模型请求携带——与 execution 桥 inject E2E 同断言口径）
      const injectedInModelInput = server.requests.some((request) =>
        JSON.stringify(request.body).includes('用户补充：改用方案 B'),
      );
      expect(injectedInModelInput).toBe(true);
      // 展示流：原始 user 行在前、注入 user 行随后（本轮收尾统一落流）、assistant 收口
      const view = await readMessages(handle, result.thread_id);
      const users = view.messages.filter(
        (message) => message.kind === 'message' && message.role === 'user',
      );
      expect(users.map((message) => message.text)).toEqual([
        '委托任务主线',
        '用户补充：改用方案 B',
      ]);
      const row = await sessionRow(handle, result.thread_id);
      expect(row.round_count).toBe(2);
      expect(row.last_outcome).toBe('reply');
    } finally {
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });

  it('运行中 rounds.abort 投递 → round_aborted 显式拒绝 + 簿记 aborted', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({
      content: [
        '{"__next": {"kind": "scope", "target": "subagent"}}',
        '子代理慢应答',
        '不该到达这里',
      ],
      delayMs: 300,
    });
    await server.start();
    const handle = await bootHost(server, made.dir);
    try {
      const threadId = 'ml-abort-thread';
      const runPromise = (handle.bridge.get('rounds.send')!)(
        { input: '长回合主线', thread_id: threadId },
        CTX,
      ) as Promise<unknown>;
      await waitFor(() => server.requestCount >= 1);
      const aborted = (await handle.bridge.get('rounds.abort')!(null, CTX)) as {
        aborted: boolean;
      };
      expect(aborted.aborted).toBe(true);
      await expect(runPromise).rejects.toMatchObject({ code: 'round_aborted' });
      const row = await sessionRow(handle, threadId);
      expect(row.last_outcome).toBe('aborted');
    } finally {
      // 后台自然收尾窗口内先排空延迟响应，再关停（避免悬挂计时器噪声）
      await waitFor(() => server.requestCount >= 2, 4000).catch(() => undefined);
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });
});
