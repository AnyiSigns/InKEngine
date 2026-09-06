/**
 * 产品默认 chat 图（工具回合）单测：脚本化模型 + 桩工具流水线直驱节点。
 *
 * 覆盖：模型产工具调用 → ToolPipeline 执行 → tool 结果回灌 → 终稿回复；
 * 未知工具 = round 错误；工具回合超限 = round 错误；无模型 = 确定性 stub。
 * 审批中断路径不经本测试（走引擎 checkpoint/重入语义，见 bridge approval 组）。
 */

import { describe, expect, it } from 'vitest';

import {
  LLMChunk,
  LLMConfig,
  Message,
  ToolCallDelta,
  ToolPipeline,
  ToolSpec,
  type LLMResult,
} from '@ink-ts/engine';
import { AsyncLLM } from '@ink-ts/engine';

import { buildProductChatGraph } from '../src/graph.js';

/** 桩工具流水线执行体（回显入参 JSON；计数供断言）。 */
function echoPipeline(): { pipeline: ToolPipeline; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const pipeline = new ToolPipeline({
    gate: null,
    extractor: null,
    executor: (_ctx, _spec, args) => {
      calls.push({ ...args });
      return JSON.stringify(args);
    },
    allow_unchecked: true,
  });
  return { pipeline, calls };
}

/** 脚本化模型：首轮工具调用 → 见 tool 结果后输出终稿文本。 */
class ScriptedToolLLM extends AsyncLLM {
  readonly adapter = 'scripted';
  seenMessages: Message[][] = [];

  constructor(
    private readonly toolName: string,
    private readonly alwaysCalls = false,
  ) {
    super(new LLMConfig({ adapter: 'scripted', model_id: 's', base_url: 'http://s' }));
  }

  async ainvoke(_messages: readonly Message[], _opts?: { tools?: readonly ToolSpec[] | null }): Promise<LLMResult> {
    throw new Error('graph 单测只用 astream');
  }

  async *astream(
    messages: readonly Message[],
    _opts?: { tools?: readonly ToolSpec[] | null },
  ): AsyncIterable<LLMChunk> {
    this.seenMessages.push([...messages]);
    const hasToolResult = messages.some((message) => message.role === 'tool');
    if (!hasToolResult || this.alwaysCalls) {
      // 首轮或恒工具轮：无 tool 结果（或恒工具模式）→ 声明一次工具调用
      yield new LLMChunk({
        tool_calls_delta: [
          new ToolCallDelta({ index: 0, id: 'call-1', name: this.toolName, arguments_delta: '' }),
        ],
      });
      yield new LLMChunk({
        tool_calls_delta: [
          new ToolCallDelta({ index: 0, arguments_delta: '{"text":"ping"}' }),
        ],
      });
      yield new LLMChunk({ finish_reason: 'tool_calls' });
      return;
    }
    // 次轮：tool 结果已回灌 → 输出终稿文本
    const toolMessage = messages.find((message) => message.role === 'tool');
    const content = toolMessage?.content ?? '';
    for (const token of `after:${content}`.split('')) {
      yield new LLMChunk({ token });
    }
    yield new LLMChunk({ finish_reason: 'stop' });
  }
}

/** 直驱 agent 节点的最小节点上下文（含审批中断面形态）。 */
function nodeCtx(state: Record<string, unknown>) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    state,
    emit: async (type: string, payload: Record<string, unknown>): Promise<void> => {
      events.push({ type, payload });
    },
    interrupt: async (): Promise<unknown> => {
      throw new Error('graph 单测不应触发审批中断');
    },
    get_interrupt_payload: async (): Promise<Record<string, unknown> | null> => null,
  };
  return { ctx, events };
}

function specFor(name: string): ToolSpec {
  return new ToolSpec({
    name,
    description: 'test',
    parameters: { type: 'object', properties: {} },
  });
}

describe('产品默认 chat 图（工具回合）', () => {
  it('工具调用经 pipeline 执行并回灌 → 终稿回复', async () => {
    const llm = new ScriptedToolLLM('echo_tool');
    const { pipeline, calls } = echoPipeline();
    const ctx = {
      llm,
      tool_pipeline: pipeline,
      tool_specs: [specFor('echo_tool')],
    };
    const graph = buildProductChatGraph(ctx as never, { maxToolRounds: 4 });
    const state: Record<string, unknown> = { input: 'hi' };
    const { ctx: node, events } = nodeCtx(state);
    const result = (await graph.nodes['agent']!(node)) as { reply: string };

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ text: 'ping' });
    expect(result.reply).toBe('after:{"text":"ping"}');
    expect(events.some((event) => event.type === 'reply_token')).toBe(true);
    // 消息链随 state 持久化（工具结果已入链，重入不重复执行）
    expect(Array.isArray(state['_tool_messages'])).toBe(true);
    const stored = state['_tool_messages'] as Array<{ role: string; tool_call_id?: string | null }>;
    expect(stored.some((message) => message.role === 'tool' && message.tool_call_id === 'call-1')).toBe(true);
    await llm.aclose();
  });

  it('未知工具调用 = round 错误（不静默吞）', async () => {
    const llm = new ScriptedToolLLM('ghost_tool');
    const { pipeline } = echoPipeline();
    const ctx = {
      llm,
      tool_pipeline: pipeline,
      tool_specs: [specFor('echo_tool')],
    };
    const graph = buildProductChatGraph(ctx as never, { maxToolRounds: 4 });
    const { ctx: node } = nodeCtx({ input: 'hi' });
    await expect(graph.nodes['agent']!(node)).rejects.toThrow(/未知工具: ghost_tool/);
    await llm.aclose();
  });

  it('工具回合超限 = round 错误（轮次上限生效）', async () => {
    // 恒产工具调用的模型（无终稿输出路径）
    const llm = new ScriptedToolLLM('echo_tool', true);
    const { pipeline } = echoPipeline();
    const ctx = {
      llm,
      tool_pipeline: pipeline,
      tool_specs: [specFor('echo_tool')],
    };
    const graph = buildProductChatGraph(ctx as never, { maxToolRounds: 2 });
    const { ctx: node } = nodeCtx({ input: 'hi' });
    await expect(graph.nodes['agent']!(node)).rejects.toThrow(/工具回合超限/);
    await llm.aclose();
  });

  it('无模型（llm=null）= 确定性 stub 回复', async () => {
    const { pipeline } = echoPipeline();
    const ctx = { llm: null, tool_pipeline: pipeline, tool_specs: [] };
    const graph = buildProductChatGraph(ctx as never);
    const { ctx: node, events } = nodeCtx({ input: 'hi' });
    const result = (await graph.nodes['agent']!(node)) as { reply: string };
    expect(result.reply).toBe('（host 默认会话已执行）');
    expect(events.length).toBeGreaterThan(0);
  });
});
