/**
 * router_judge 执行体单测：单次无工具 LLM 判断 → 目标 key 写入 `_route_to`。
 *
 * 覆盖：命中候选写 key；带代码围栏/换行噪声仍严格匹配；未命中 = 显式空走向
 * （写空串清陈旧决议，不猜测）；无模型（seams.llm null）/空候选清单 = 空走向
 * 不调用模型不写键；复用既有消息链但决策不进消息链（不污染对话正文）；
 * 契约输出 schema 声明 `_route_to` 通道。
 */

import { describe, expect, it } from 'vitest';

import { make_router_judge_factory, router_judge_contract } from '../../../src/graph/nodes/router.js';
import { _EngineNodeSeamsBox } from '../../../src/graph/nodes/seams.js';
import type { AsyncLLM, LLMChunk } from '../../../src/kernel/llm/_guard_types.js';
import type { Message } from '../../../src/kernel/llm/messages.js';
import { TYPE_ROUTER_JUDGE } from '../../../src/graph/nodes/constants.js';

/** 按调用序回放文本的 stub 模型（记录每次收到的消息链供断言）。 */
function scriptedLLM(replies: readonly string[]): { llm: AsyncLLM; calls: Message[][] } {
  const calls: Message[][] = [];
  const llm = {
    adapter: 'fake',
    config: { adapter: 'fake', model_id: 'm', base_url: '' },
    async ainvoke(): Promise<never> {
      throw new Error('router 单测只走 astream');
    },
    async *astream(messages: readonly Message[]): AsyncIterable<LLMChunk> {
      calls.push([...messages]);
      const text = replies[calls.length - 1] ?? '';
      if (text !== '') yield { token: text, tool_calls_delta: null };
    },
    async aclose(): Promise<void> {},
  } as AsyncLLM;
  return { llm, calls };
}

/** 记录 astream 调用数的 stub（断言“未调用模型”场景）。 */
function countingLLM(): { llm: AsyncLLM; holder: { calls: number } } {
  const holder = { calls: 0 };
  const llm = {
    adapter: 'fake',
    config: { adapter: 'fake', model_id: 'm', base_url: '' },
    async ainvoke(): Promise<never> {
      throw new Error('router 单测只走 astream');
    },
    async *astream(): AsyncIterable<LLMChunk> {
      holder.calls += 1;
      yield { token: 'A', tool_calls_delta: null };
    },
    async aclose(): Promise<void> {},
  } as AsyncLLM;
  return { llm, holder };
}

/** 节点级 ctx 替身（消费面最小形态）。 */
function fakeCtx(state: Record<string, unknown>) {
  return { state };
}

/** 构造 router 节点执行函数（routes/prompt 经 config 透传；boot 经 seams 注入）。 */
function makeNode(config: Record<string, unknown>, llm: AsyncLLM | null, boot = '') {
  const box = new _EngineNodeSeamsBox({
    llm,
    tool_pipeline: null,
    tool_specs: [],
    all_tool_specs: [],
    collect_specs: null,
    boot_system_prompt: boot,
  });
  return make_router_judge_factory(box)(config);
}

describe('router_judge 节点执行', () => {
  it('模型输出命中候选 key → 写 state._route_to 并返回增量', async () => {
    const { llm, calls } = scriptedLLM(['A']);
    const node = makeNode(
      {
        routes: [
          { key: 'A', label: '直接答', description: '目标已明确' },
          { key: 'B', label: '深究', description: '需要先研究' },
        ],
      },
      llm,
    );
    const ctx = fakeCtx({ input: '请判断' });
    const overlay = await node(ctx);
    expect(overlay).toEqual({ _route_to: 'A' });
    expect(ctx.state['_route_to']).toBe('A');
    // 路由指令恒在消息链末尾（系统/输入之后），仅一次调用、无工具注入
    expect(calls.length).toBe(1);
    const last = calls[0]![calls[0]!.length - 1]!;
    expect(String((last as unknown as { content: string }).content)).toContain('路由判断任务');
    expect(String((last as unknown as { content: string }).content)).toContain('key=A');
    expect(ctx.state['messages']).toBeUndefined();
  });

  it('模型输出带代码围栏/换行噪声仍严格匹配到候选 key', async () => {
    const { llm } = scriptedLLM(['```\nB\n```']);
    const node = makeNode({ routes: ['A', 'B'] }, llm);
    const ctx = fakeCtx({ input: '' });
    const overlay = await node(ctx);
    expect(overlay).toEqual({ _route_to: 'B' });
    expect(ctx.state['_route_to']).toBe('B');
  });

  it('模型输出未命中候选 → 空走向（写空串清陈旧决议，不猜候选）', async () => {
    const { llm } = scriptedLLM(['C']);
    const node = makeNode({ routes: ['A', 'B'] }, llm);
    // 预置陈旧决议（上次运行残留）：未命中须清空而非误路由
    const ctx = fakeCtx({ input: '请判断', _route_to: 'A' });
    const overlay = await node(ctx);
    expect(overlay).toEqual({ _route_to: '' });
    expect(ctx.state['_route_to']).toBe('');
  });

  it('无模型（seams.llm null）→ 空走向且不写 _route_to（诚实失败不崩溃）', async () => {
    const node = makeNode({ routes: ['A', 'B'] }, null);
    const ctx = fakeCtx({ input: '请判断' });
    const overlay = await node(ctx);
    expect(overlay).toEqual({});
    expect(ctx.state['_route_to']).toBeUndefined();
  });

  it('空候选清单 → 空走向且不调用模型', async () => {
    const { llm, holder } = countingLLM();
    const node = makeNode({ routes: [] }, llm);
    const ctx = fakeCtx({ input: '请判断' });
    const overlay = await node(ctx);
    expect(overlay).toEqual({});
    expect(ctx.state['_route_to']).toBeUndefined();
    expect(holder.calls).toBe(0);
  });

  it('复用既有消息链；决策文本不写入消息链', async () => {
    const { llm, calls } = scriptedLLM(['A']);
    const node = makeNode({ routes: ['A', 'B'] }, llm);
    const prior = [
      { role: 'user', content: '上一轮内容' },
      { role: 'assistant', content: '上一轮回复' },
    ];
    const ctx = fakeCtx({ input: '本轮输入', messages: [...prior] });
    await node(ctx);
    // 消息链原样保留（router 不追加/改写对话正文）
    expect(ctx.state['messages']).toEqual(prior);
    // 模型实际收到 = 既有链 + 追加的候选清单指令
    expect(calls[0]!.length).toBe(prior.length + 1);
    expect(calls[0]![calls[0]!.length - 1]!.role).toBe('user');
  });
});

describe('router_judge system 合成（seams boot + config 自定义拼一条；boot 恒前）', () => {
  it('boot + custom 双非空 → 首条 system = boot + \\n\\n + custom，随后 user + 路由指令', async () => {
    const { llm, calls } = scriptedLLM(['A']);
    const node = makeNode(
      { routes: ['A', 'B'], system_prompt: 'CUSTOM-CFG' },
      llm,
      'BOOT-BASE',
    );
    const ctx = fakeCtx({ input: '请判断' });
    await node(ctx);
    const sent = calls[0]!;
    const first = sent[0]!;
    expect(first.role).toBe('system');
    expect(String((first as unknown as { content: string }).content)).toBe('BOOT-BASE\n\nCUSTOM-CFG');
    expect(sent.filter((message) => message.role === 'system')).toHaveLength(1);
    // 路由指令恒在末尾（user 输入 + 候选清单其后）
    expect(String((sent[sent.length - 1] as unknown as { content: string }).content)).toContain('路由判断任务');
  });

  it('仅 boot（无 config.system_prompt）→ 首条 system = boot 原样', async () => {
    const { llm, calls } = scriptedLLM(['B']);
    const node = makeNode({ routes: ['A', 'B'] }, llm, 'BOOT-BASE');
    const ctx = fakeCtx({ input: '' });
    await node(ctx);
    const first = calls[0]![0]!;
    expect(first.role).toBe('system');
    expect(String((first as unknown as { content: string }).content)).toBe('BOOT-BASE');
  });

  it('仅 custom（boot 空）→ 首条 system = custom 原样（回落不变）', async () => {
    const { llm, calls } = scriptedLLM(['A']);
    const node = makeNode({ routes: ['A', 'B'], system_prompt: 'CUSTOM-CFG' }, llm);
    const ctx = fakeCtx({ input: '请判断' });
    await node(ctx);
    const first = calls[0]![0]!;
    expect(first.role).toBe('system');
    expect(String((first as unknown as { content: string }).content)).toBe('CUSTOM-CFG');
  });

  it('boot 与 custom 双空 → 不注入 system（user 开局）', async () => {
    const { llm, calls } = scriptedLLM(['A']);
    const node = makeNode({ routes: ['A', 'B'] }, llm);
    const ctx = fakeCtx({ input: '请判断' });
    await node(ctx);
    const sent = calls[0]!;
    expect(sent.some((message) => message.role === 'system')).toBe(false);
    expect(sent[0]!.role).toBe('user');
  });
});

describe('router_judge 契约声明', () => {
  it('契约安全档 0、版本 1、输出 schema 声明 _route_to 字符串通道', () => {
    const contract = router_judge_contract();
    expect(contract.safety_tier).toBe(0);
    expect(contract.version).toBe(1);
    expect(contract.input_schema).toBeNull();
    const field = contract.output_schema!.fields[0]!;
    expect(field.name).toBe('_route_to');
    expect(field.kind).toBe('string');
    expect(field.required).toBe(false);
  });

  it('契约随类型名登记（engine_nodes 池种子带该契约）', () => {
    expect(TYPE_ROUTER_JUDGE).toBe('router_judge');
  });
});
