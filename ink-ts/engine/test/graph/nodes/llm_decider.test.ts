/**
 * llm_decider 思考事件发射单测：reasoning_token 流 → thinking_start/thinking_end
 * 事件（前端思考卡消费）。覆盖分片追加、稳定 step_id、无推理不发射。
 */

import { describe, expect, it } from 'vitest';

import { make_llm_decider_factory } from '../../../src/graph/nodes/llm_decider.js';
import { _EngineNodeSeamsBox } from '../../../src/graph/nodes/seams.js';
import { LLMChunk, LLMConfig } from '../../../src/dock/ports/llm.js';
import type { AsyncLLM } from '../../../src/model/llm/_guard_types.js';
import type { Message } from '../../../src/model/llm/messages.js';
import { ToolCallDelta } from '../../../src/model/llm/messages.js';
import type { ToolSpec } from '../../../src/model/llm/tools.js';
import type { LLMParams } from '../../../src/dock/ports/llm.js';

/** 单次 astream 内发射多帧的 mock 模型（reasoning_token + token 混合）。 */
function fakeLLM(frames: Array<{ reasoning?: string; token?: string }>): AsyncLLM {
  return {
    adapter: 'fake',
    config: new LLMConfig({ adapter: 'fake', model_id: 'm', base_url: 'http://x' }),
    async ainvoke(
      _messages: readonly Message[],
      _opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
    ): Promise<never> {
      throw new Error('ainvoke 不应在流式路径被调用');
    },
    async *astream(
      _messages: readonly Message[],
      _opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
    ): AsyncIterable<LLMChunk> {
      for (const frame of frames) {
        if (frame.reasoning) yield new LLMChunk({ reasoning_token: frame.reasoning });
        if (frame.token) yield new LLMChunk({ token: frame.token });
      }
    },
  } as unknown as AsyncLLM;
}

/** 按 astream 调用次数消费分帧的 mock 模型（工具多轮回合用）。 */
function fakeLLMByCall(frames: Array<{ reasoning?: string; token?: string; tools?: ToolCallDelta[] }>): AsyncLLM {
  let callCount = 0;
  return {
    adapter: 'fake',
    config: new LLMConfig({ adapter: 'fake', model_id: 'm', base_url: 'http://x' }),
    async ainvoke(
      _messages: readonly Message[],
      _opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
    ): Promise<never> {
      throw new Error('ainvoke 不应在流式路径被调用');
    },
    async *astream(
      _messages: readonly Message[],
      _opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
    ): AsyncIterable<LLMChunk> {
      const frame = frames[callCount] ?? { token: '' };
      callCount += 1;
      if (frame.reasoning) yield new LLMChunk({ reasoning_token: frame.reasoning });
      if (frame.token) yield new LLMChunk({ token: frame.token });
      if (frame.tools) yield new LLMChunk({ tool_calls_delta: frame.tools });
    },
  } as unknown as AsyncLLM;
}

interface EmitRecord {
  type: string;
  payload: Record<string, unknown>;
  step_id?: string | null;
}

/** 收集 emit 调用的 ctx 替身。 */
function fakeCtx(emits: EmitRecord[]) {
  return {
    state: { input: '你好' } as Record<string, unknown>,
    thread_id: 't',
    async emit(
      etype: string,
      payload: Record<string, unknown>,
      opts: { step_id?: string | null } = {},
    ): Promise<void> {
      emits.push({ type: etype, payload, step_id: opts.step_id ?? null });
    },
  };
}

describe('llm_decider 思考事件发射', () => {
  it('推理 token 流 → thinking_start（分片）+ thinking_end，稳定 step_id', async () => {
    const emits: EmitRecord[] = [];
    const ctx = fakeCtx(emits);
    const factory = make_llm_decider_factory(new _EngineNodeSeamsBox({
      llm: fakeLLM([
        { reasoning: '让我想想' },
        { reasoning: '怎么回答' },
        { token: '你好' },
      ]),
      tool_pipeline: {} as never,
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
    }));
    const node = factory({});
    await node(ctx);

    const thinking = emits.filter((e) => e.type === 'thinking_start' || e.type === 'thinking_end');
    expect(thinking.length).toBe(4);
    // 开卡：空 content
    expect(thinking[0]).toMatchObject({ type: 'thinking_start', payload: { content: '', status: 'running' } });
    expect((thinking[0] as { step_id?: string | null }).step_id).toBe('think:1');
    // 两个推理分片追加
    expect(thinking[1]).toMatchObject({ type: 'thinking_start', payload: { content: '让我想想' } });
    expect((thinking[1] as { step_id?: string | null }).step_id).toBe('think:1');
    expect(thinking[2]).toMatchObject({ type: 'thinking_start', payload: { content: '怎么回答' } });
    expect((thinking[2] as { step_id?: string | null }).step_id).toBe('think:1');
    // 收尾
    expect(thinking[3]).toMatchObject({ type: 'thinking_end', payload: { status: 'completed' } });
    expect((thinking[3] as { step_id?: string | null }).step_id).toBe('think:1');

    // 正文仍按 token 发射（reply_token 不受影响）
    const replies = emits.filter((e) => e.type === 'reply_token');
    expect(replies.map((r) => r.payload.token)).toEqual(['你好']);

    // 展示态已由事件展示聚合器（DisplayStreamCollector）从事件流派生；
    // llm_decider 只发射事件，不再写 display_messages（本节点不产展示态）。
    expect(ctx.state['display_messages']).toBeUndefined();
    // 上下文 messages 应只含正文，不含推理（reasoning 不进模型历史）
    const messages = ctx.state['messages'] as Array<Record<string, unknown>>;
    expect(messages.some((m) => m['reasoning'] !== null && m['reasoning'] !== undefined)).toBe(false);
  });

  it('无推理 token → 不发射 thinking 事件，仅正文', async () => {
    const emits: EmitRecord[] = [];
    const ctx = fakeCtx(emits);
    const factory = make_llm_decider_factory(new _EngineNodeSeamsBox({
      llm: fakeLLM([{ token: '直接回答' }]),
      tool_pipeline: {} as never,
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
    }));
    const node = factory({});
    await node(ctx);

    const thinking = emits.filter((e) => e.type === 'thinking_start' || e.type === 'thinking_end');
    expect(thinking.length).toBe(0);
    expect(emits.filter((e) => e.type === 'reply_token').map((r) => r.payload.token)).toEqual(['直接回答']);
  });

  it('工具调用 → tool_start/tool_end 成对发射且 step_id 稳定', async () => {
    const emits: EmitRecord[] = [];
    const ctx = fakeCtx(emits);
    const factory = make_llm_decider_factory(new _EngineNodeSeamsBox({
      // 第一轮发推理 + 工具增量（触发执行），第二轮发最终 token（无工具）
      llm: fakeLLMByCall([
        { reasoning: '推理一', token: '先看', tools: [new ToolCallDelta({ index: 0, id: 'call-1', name: 'inspect_graph', arguments_delta: '{"x":1}' })] },
        { token: '已完成' },
      ]),
      tool_pipeline: {
        async execute() {
          return { ok: true, output: '工具结果', decision: 'allow' } as never;
        },
      } as never,
      tool_specs: [
        { name: 'inspect_graph', description: '查图', parameters: null } as unknown as ToolSpec,
      ],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
    }));
    const node = factory({});
    await node(ctx);

    const starts = emits.filter((e) => e.type === 'thinking_start');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect((starts[0] as { step_id?: string | null }).step_id).toBe('think:1');

    // 工具卡事件：tool_start/tool_end 成对发射，step_id 按 tool_call_id 稳定
    const toolStart = emits.filter((e) => e.type === 'tool_start');
    const toolEnd = emits.filter((e) => e.type === 'tool_end');
    expect(toolStart.length).toBe(1);
    expect(toolEnd.length).toBe(1);
    expect(toolStart[0]).toMatchObject({ payload: { tool: 'inspect_graph' } });
    expect(toolEnd[0]).toMatchObject({ payload: { tool: 'inspect_graph', success: true } });
    expect((toolStart[0] as { step_id?: string | null }).step_id).toBe((toolEnd[0] as { step_id?: string | null }).step_id);
  });
});

describe('llm_decider 每轮推理覆盖（state.round_model → LLMParams）', () => {
  it('round_model 携带 effort/enable_thinking/thinking_budget 时原样传给 astream params', async () => {
    const emits: EmitRecord[] = [];
    let seenParams: LLMParams | null | undefined;
    const capturing = {
      adapter: 'fake',
      config: new LLMConfig({ adapter: 'fake', model_id: 'm', base_url: 'http://x' }),
      async ainvoke(): Promise<never> {
        throw new Error('ainvoke 不应在流式路径被调用');
      },
      async *astream(
        _messages: readonly Message[],
        opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
      ): AsyncIterable<LLMChunk> {
        seenParams = opts?.params ?? null;
        yield new LLMChunk({ token: '回答' });
      },
    } as unknown as AsyncLLM;
    const ctx = fakeCtx(emits);
    ctx.state['round_model'] = {
      reasoning_effort: 'xhigh',
      enable_thinking: true,
      thinking_budget: 8192,
    };
    const node = make_llm_decider_factory(new _EngineNodeSeamsBox({
      llm: capturing,
      tool_pipeline: {} as never,
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
    }))({});
    await node(ctx);
    expect(seenParams?.reasoning_effort).toBe('xhigh');
    expect(seenParams?.enable_thinking).toBe(true);
    expect(seenParams?.thinking_budget).toBe(8192);
  });

  it('round_model 缺省/空 → params 为 null（跟随模型默认，不注入）', async () => {
    const emits: EmitRecord[] = [];
    let seenParams: LLMParams | null | undefined;
    const capturing = {
      adapter: 'fake',
      config: new LLMConfig({ adapter: 'fake', model_id: 'm', base_url: 'http://x' }),
      async ainvoke(): Promise<never> {
        throw new Error('ainvoke 不应在流式路径被调用');
      },
      async *astream(
        _messages: readonly Message[],
        opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
      ): AsyncIterable<LLMChunk> {
        seenParams = opts?.params ?? null;
        yield new LLMChunk({ token: '回答' });
      },
    } as unknown as AsyncLLM;
    const node = make_llm_decider_factory(new _EngineNodeSeamsBox({
      llm: capturing,
      tool_pipeline: {} as never,
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
    }))({});
    await node(fakeCtx(emits));
    expect(seenParams).toBeNull();
  });
});

describe('llm_decider system 合成（seams boot + config 自定义拼一条；boot 恒前）', () => {
  /** 记录每次 astream 收到的消息链的 stub（收尾 token 一帧）。 */
  function recordingLLM(calls: Message[][]) {
    return {
      adapter: 'fake',
      config: new LLMConfig({ adapter: 'fake', model_id: 'm', base_url: 'http://x' }),
      async ainvoke(): Promise<never> {
        throw new Error('llm_decider 单测只走 astream');
      },
      async *astream(
        messages: readonly Message[],
        _opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
      ): AsyncIterable<LLMChunk> {
        calls.push([...messages]);
        yield new LLMChunk({ token: '收口' });
      },
    } as unknown as AsyncLLM;
  }

  /** 单轮节点执行（无工具调用）；返回模型首轮收到的消息链。 */
  async function runWith(
    boot: string,
    custom: string,
  ): Promise<Message[]> {
    const calls: Message[][] = [];
    const factory = make_llm_decider_factory(new _EngineNodeSeamsBox({
      llm: recordingLLM(calls),
      tool_pipeline: {} as never,
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: boot,
    }));
    const node = factory(custom === '' ? {} : { system_prompt: custom });
    const emits: EmitRecord[] = [];
    const ctx = fakeCtx(emits);
    await node(ctx);
    return calls[0]!;
  }

  it('boot + custom 双非空 → 单条 system = boot + \\n\\n + custom（boot 恒前）', async () => {
    const messages = await runWith('BOOT-BASE', 'CUSTOM-CFG');
    const first = messages[0]!;
    expect(first.role).toBe('system');
    expect(String((first as unknown as { content: string }).content)).toBe('BOOT-BASE\n\nCUSTOM-CFG');
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
  });

  it('仅 boot（config 无自定义）→ system = boot 原样', async () => {
    const messages = await runWith('BOOT-BASE', '');
    const first = messages[0]!;
    expect(first.role).toBe('system');
    expect(String((first as unknown as { content: string }).content)).toBe('BOOT-BASE');
  });

  it('仅 custom（boot 空）→ system = custom 原样（boot 未注入回落）', async () => {
    const messages = await runWith('', 'CUSTOM-CFG');
    const first = messages[0]!;
    expect(first.role).toBe('system');
    expect(String((first as unknown as { content: string }).content)).toBe('CUSTOM-CFG');
  });

  it('boot 与 custom 双空 → 不注入 system（消息链以 user 开局）', async () => {
    const messages = await runWith('', '');
    expect(messages.some((message) => message.role === 'system')).toBe(false);
    expect(messages[0]!.role).toBe('user');
  });
});
