// gate: 超限(403 行) - W8A 主线产品能力 E2E（实时事件流/回合级配置/pose 工具档/附件透传）场景多、头注详尽，拆分会伤可读性
/**
 * rounds 执行主线 W8A 产品能力 E2E（fake llm 全链；能力断点修复面）。
 *
 * 测什么（逐项对应 W8A 任务书）：
 * - 实时事件流：运行中执行事件逐条到达观察链（round_transports → serve ws 面）
 *   与事件文件（JSONL），回合完成前已落位——不再收尾统一落；顺序 = run_start
 *   首、run_end 末；
 * - round_model 回合级模型覆写：request 级 provider/model_id 命中用户清单端点
 *   （会话默认模型零调用）；推理档位随请求体下发（reasoning_effort）；
 * - max_tool_rounds 生效：capability 记录活读 → llm_decider 上限（cap=1 恰
 *   一次模型调用即收口；put 后下轮生效）；
 * - pose 工具审批 seam（review 档挂卡）：review 档需审批工具 → 挂卡
 *   （pending key = gate:<tool>）；auto 档免弹直过出结论；deny 档免问直拒；
 * - 附件透传：消息附件进 ExecutionRequest.attachments（最简 dict 列表；
 *   seed_payload.attachments 文本投影延续，双通道并存）；非法附件项告警。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ToolGateConfig, exec_checkpoint_thread } from '@ink-ts/engine';
import type { EngineEvent as EngineEventType, EngineTransport, ExecutionRequest } from '@ink-ts/engine';

import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { FakeOpenAIServer } from '../_fake_openai.js';

const CTX = { autoApprove: false };

function dirs(): { dir: string; events: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-w8a-'));
  return { dir, events: path.join(dir, 'events') };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function chatConfig(baseUrl: string, apiKey: string, modelId: string) {
  return {
    protocol: 'openai_compatible' as const,
    base_url: baseUrl,
    api_key: apiKey,
    model_id: modelId,
  };
}

interface SendView {
  thread_id: string;
  round_id: string;
  reason: string;
  reply: string | null;
  events: { count: number; types: string[] };
  run_id?: string;
  pending_approval?: boolean;
  pending?: { key: string | null; checkpoint_id: number | null } | null;
  degraded_summaries?: string[];
  warnings?: string[];
}

/** 收集观察传输（EngineTransport；挂 runtime.round_transports 断言实时转发）。 */
class CollectorTransport implements EngineTransport {
  readonly events: EngineEventType[] = [];
  async send(event: EngineEventType): Promise<void> {
    this.events.push(event);
  }
  async close(): Promise<void> {}
}

/** 双厂商模型清单装配（agent-prov 会话默认 + scope-prov 覆写端点）。 */
async function bootTwoProviders(
  made: { dir: string; events: string },
  agentServer: FakeOpenAIServer,
  scopeServer: FakeOpenAIServer,
): Promise<HostHandle> {
  const handle = await createHost({
    data_dir: made.dir,
    events_dir: made.events,
    model_config: { agent_config: chatConfig(agentServer.baseUrl, 'sk-w8a-agent', 'agent-slot-model') },
  } as never);
  await handle.bridge.get('models.config.put')!(
    {
      config: {
        providers: [
          {
            provider_id: 'agent-prov',
            base_url: agentServer.baseUrl,
            adapter: 'openai_compatible',
            api_key: 'sk-w8a-agent',
            models: ['agent-slot-model'],
          },
          {
            provider_id: 'scope-prov',
            base_url: scopeServer.baseUrl,
            adapter: 'openai_compatible',
            api_key: 'sk-w8a-scope',
            models: ['scope-model-a'],
          },
        ],
        agent_pick: { provider_id: 'agent-prov', model_id: 'agent-slot-model' },
      },
    },
    CTX,
  );
  return handle;
}

describe('W8A 实时事件流：运行中逐条到达观察链与事件文件（不再收尾统一落）', () => {
  it('长回合完成前 scope_turn/route 已到达观察链与 JSONL；顺序 run_start 首、run_end 末', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({
      content: [
        '{"__next": {"kind": "scope", "target": "subagent"}}',
        '子代理结果',
        '最终收口',
      ],
      delayMs: 300,
    });
    await server.start();
    const handle = await createHost({
      data_dir: made.dir,
      events_dir: made.events,
      model_config: { agent_config: chatConfig(server.baseUrl, 'sk-w8a-stream', 'm') },
    } as never);
    const collector = new CollectorTransport();
    handle.runtime.round_transports.push(collector);
    try {
      let settled = false;
      const promise = (handle.bridge.get('rounds.send')!({ input: '长回合' }, CTX) as Promise<unknown>)
        .then((value) => {
          settled = true;
          return value;
        })
        .catch((error) => {
          settled = true;
          throw error;
        });
      // 在途断言：回合未完成时观察链已收到首段事件（实时转发面）
      await waitFor(() => collector.events.length >= 2);
      expect(settled).toBe(false);
      const inFlightTypes = collector.events.map((event) => event.type);
      expect(inFlightTypes[0]).toBe('run_start');
      expect(inFlightTypes).toContain('scope_turn');
      // 事件文件同窗口已落行（JSONL 逐条实时 flush）
      const files = readdirSync(made.events);
      expect(files.length).toBeGreaterThan(0);
      const firstFile = readFileSync(path.join(made.events, files[0]!), 'utf8');
      expect(firstFile.split('\n').filter((line) => line.trim() !== '').length).toBeGreaterThanOrEqual(2);
      const result = (await promise) as SendView;
      expect(result.reason).toBe('reply');
      expect(result.reply).toBe('最终收口');
      // 全量顺序：run_start 首、run_end 末；事件带与观察链同源同序
      const allTypes = collector.events.map((event) => event.type);
      expect(allTypes[0]).toBe('run_start');
      expect(allTypes[allTypes.length - 1]).toBe('run_end');
      expect(allTypes.some((type) => type.startsWith('route:'))).toBe(true);
      expect(allTypes).toContain('merge');
      const receiptEvents = result.events.types;
      expect(receiptEvents).toContain('run_end');
      // 观察链事件信封 = 引擎事件协议形态（thread_id/round_id 归属会话线程）
      const first = collector.events[0]!;
      expect(first.thread_id).toBe(result.thread_id);
      expect(first.round_id).toBe(result.round_id);
    } finally {
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });
});

describe('W8A round_model 回合级模型覆写（request 级 > 会话缺省；推理档位下发）', () => {
  it('覆写 provider/model_id → 请求打覆写端点（会话默认零调用）；推理档位随请求体', async () => {
    const made = dirs();
    const agentServer = new FakeOpenAIServer({ content: '默认模型不应回答' });
    const scopeServer = new FakeOpenAIServer({ content: '覆写模型答复' });
    await agentServer.start();
    await scopeServer.start();
    const handle = await bootTwoProviders(made, agentServer, scopeServer);
    try {
      const result = (await handle.bridge.get('rounds.send')!(
        {
          input: '用指定模型',
          model: { provider: 'scope-prov', model_id: 'scope-model-a', reasoning_effort: 'high' },
        },
        CTX,
      )) as SendView;
      expect(result.reason).toBe('reply');
      expect(result.reply).toBe('覆写模型答复');
      expect(scopeServer.requestCount).toBeGreaterThanOrEqual(1);
      expect(agentServer.requestCount).toBe(0);
      const seen = scopeServer.requests.some(
        (request) => request.body['model'] === 'scope-model-a',
      );
      expect(seen).toBe(true);
      const effortSeen = scopeServer.requests.some(
        (request) => request.body['reasoning_effort'] === 'high',
      );
      expect(effortSeen).toBe(true);
      // 无覆写的下一轮：回落会话默认模型（agent-prov 端点）
      const plain = (await handle.bridge.get('rounds.send')!(
        { input: '默认模型', thread_id: result.thread_id },
        CTX,
      )) as SendView;
      expect(plain.reason).toBe('reply');
      expect(agentServer.requestCount).toBeGreaterThanOrEqual(1);
    } finally {
      await handle.dispose();
      await agentServer.close();
      await scopeServer.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });

  it('覆写引用未命中用户清单 = 显式失败（不静默回落默认模型）', async () => {
    const made = dirs();
    const agentServer = new FakeOpenAIServer({ content: '不应回答' });
    const scopeServer = new FakeOpenAIServer({ content: 'x' });
    await agentServer.start();
    await scopeServer.start();
    const handle = await bootTwoProviders(made, agentServer, scopeServer);
    try {
      const result = (await handle.bridge.get('rounds.send')!(
        { input: '坏引用', model: { provider: 'ghost-prov', model_id: 'nope' } },
        CTX,
      )) as SendView;
      expect(result.reason).toBe('error');
      expect(String(result.degraded_summaries?.join('；'))).toContain('模型决议失败');
      expect(agentServer.requestCount).toBe(0);
      expect(scopeServer.requestCount).toBe(0);
    } finally {
      await handle.dispose();
      await agentServer.close();
      await scopeServer.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });
});

describe('W8A max_tool_rounds 工具回合上限（capability 活读 → llm_decider）', () => {
  it('cap=1 恰一次模型调用即收口（超限显式失败）；put 后下轮生效', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({ content: '', toolCall: { name: 'inspect_rules' } });
    await server.start();
    const handle = await createHost({
      data_dir: made.dir,
      events_dir: made.events,
      model_config: { agent_config: chatConfig(server.baseUrl, 'sk-w8a-cap', 'm') },
    } as never);
    try {
      await handle.bridge.get('capability.put')!({ max_tool_rounds: 1 }, CTX);
      const first = (await handle.bridge.get('rounds.send')!(
        { input: '查规则', pose: 'auto' },
        CTX,
      )) as SendView;
      expect(first.reason).toBe('error');
      // 引擎节点异常细节经执行循环归一（内层「工具回合超限」不直接透出）；
      // 上限生效证据 = 调用数恰为 cap（缺省 8 轮不会触发）
      expect(String(first.degraded_summaries?.join('；'))).toContain('加工失败');
      expect(server.requestCount).toBe(1);
      // 活读面：put 后下轮生效（cap=2 → 两次调用后收口）
      await handle.bridge.get('capability.put')!({ max_tool_rounds: 2 }, CTX);
      const second = (await handle.bridge.get('rounds.send')!(
        { input: '查规则再试', pose: 'auto', thread_id: first.thread_id },
        CTX,
      )) as SendView;
      expect(second.reason).toBe('error');
      expect(String(second.degraded_summaries?.join('；'))).toContain('加工失败');
      expect(server.requestCount).toBe(3);
    } finally {
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });
});

describe('W8A pose 工具审批 seam（round_pose 种子 → 三档裁定）', () => {
  async function bootReviewTier(made: { dir: string; events: string }, server: FakeOpenAIServer): Promise<HostHandle> {
    return createHost(
      {
        data_dir: made.dir,
        events_dir: made.events,
        model_config: { agent_config: chatConfig(server.baseUrl, 'sk-w8a-pose', 'm') },
      } as never,
      { tool_gate: new ToolGateConfig({ default_policy: 'review', review_tools: ['inspect_rules'] }) } as never,
    );
  }

  it('review 档：需审批工具调用挂卡（interrupted + pending key = gate:inspect_rules）', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({ content: '', toolCall: { name: 'inspect_rules' } });
    await server.start();
    const handle = await bootReviewTier(made, server);
    try {
      const result = (await handle.bridge.get('rounds.send')!(
        { input: '查规则（review）', pose: 'review' },
        CTX,
      )) as SendView;
      expect(result.reason).toBe('interrupted');
      expect(result.pending_approval).toBe(true);
      expect(result.pending?.key).toBe('gate:inspect_rules');
      expect(result.pending?.checkpoint_id).toBeGreaterThan(0);
      // 挂起卡随 exec 链 checkpoint 持久化（工具审批挂起 = turn_resume 相位）
      const execTail = await handle.runtime.storage!.get_latest_checkpoint(
        exec_checkpoint_thread(result.run_id!),
      );
      expect(execTail).not.toBeNull();
      expect(execTail!.interrupt?.key).toBe('gate:inspect_rules');
    } finally {
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });

  it('auto 档：需审批调用免弹直过（工具执行 + 正常收口，无挂起）', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({
      content: '收口回复',
      // 剧本：首轮工具调用（auto 免弹直过），次轮纯文本收口
      toolCall: [{ name: 'inspect_rules' }, null],
    });
    await server.start();
    const handle = await bootReviewTier(made, server);
    try {
      const result = (await handle.bridge.get('rounds.send')!(
        { input: '查规则（auto）', pose: 'auto' },
        CTX,
      )) as SendView;
      expect(result.reason).toBe('reply');
      expect(result.reply).toBe('收口回复');
      expect(result.pending_approval).toBe(false);
      // 工具实际执行（两轮模型调用：工具轮 + 收口轮）
      expect(server.requestCount).toBe(2);
    } finally {
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });

  it('deny 档：需审批调用免问直拒（回合失败收口）', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({ content: '不应收口', toolCall: { name: 'inspect_rules' } });
    await server.start();
    const handle = await bootReviewTier(made, server);
    try {
      const result = (await handle.bridge.get('rounds.send')!(
        { input: '查规则（deny）', pose: 'deny' },
        CTX,
      )) as SendView;
      expect(result.reason).toBe('error');
      expect(result.reply).toBeNull();
    } finally {
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });
});

describe('W8A 附件透传：消息附件进 ExecutionRequest.attachments（最简 dict 列表）', () => {
  it('附件随 request 专属字段透传（seed_payload.attachments 双通道并存）；非法项告警', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({ content: '看图答复' });
    await server.start();
    const handle = await createHost({
      data_dir: made.dir,
      events_dir: made.events,
      model_config: { agent_config: chatConfig(server.baseUrl, 'sk-w8a-att', 'm') },
    } as never);
    const seen: ExecutionRequest[] = [];
    const service = handle.execution;
    const original = service.runExecution.bind(service);
    service.runExecution = (async (request: ExecutionRequest, options?: never) => {
      seen.push(request);
      return original(request, options);
    }) as never;
    try {
      const result = (await handle.bridge.get('rounds.send')!(
        {
          input: '分析这张图',
          attachments: [
            { kind: 'image', url: 'file:///tmp/a.png', name: 'a.png', mime_type: 'image/png' },
            { kind: 'garbage', name: '非法项' },
          ],
        },
        CTX,
      )) as SendView;
      expect(result.reason).toBe('reply');
      expect(result.warnings).toEqual(['附件项形态非法已忽略（须含 kind 且 url/path 至少其一）']);
      expect(seen.length).toBe(1);
      const request = seen[0]!;
      // request 专属字段：最简 dict 列表（W8B 引擎侧图像分量消费面）
      expect(request.attachments).toEqual([
        { kind: 'image', url: 'file:///tmp/a.png', path: null, mime_type: 'image/png', name: 'a.png' },
      ]);
      // 文本投影延续通道：seed_payload.attachments 同源（doc 文本注入/文件名引用）
      const seed = request.seed_payload as Record<string, unknown>;
      expect(Array.isArray(seed['attachments'])).toBe(true);
      expect((seed['attachments'] as unknown[]).length).toBe(1);
      expect(request.task).toBe('分析这张图');
    } finally {
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });
});
