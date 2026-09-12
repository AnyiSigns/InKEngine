/**
 * llm_decider 字段 I/O 执行测试（P4.2a-3 机制 A）：
 * - output_field：回复写入非 reply 键（plan/review），缺省 = reply 零漂移；
 *   保留键（_route_to 等）工厂期拒绝；
 * - read_fields：既有状态字段内容以只读投影进提示（模型调用可见），不写入
 *   持久化消息链（不污染消息链语义）；无命中字段 = 不追加投影；
 * - 工具回合多轮次每次模型调用都携带投影（重算自状态）；
 * - 无模型 stub 路径同样写 output_field 键（字段链无模型也可推进）。
 */
import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/model/errors.js';
import { make_llm_decider_factory } from '../../../src/core/nodes/llm_decider.js';
import { _EngineNodeSeamsBox } from '../../../src/core/nodes/seams.js';
import { LLMChunk, LLMConfig } from '../../../src/kernel/llm/base.js';
import type { AsyncLLM } from '../../../src/kernel/llm/_guard_types.js';
import { ToolCallDelta, type Message } from '../../../src/kernel/llm/messages.js';
import type { ToolSpec } from '../../../src/kernel/llm/tools.js';
import type { LLMParams } from '../../../src/kernel/llm/base.js';

interface EmitRecord {
  type: string;
  payload: Record<string, unknown>;
}

/** 记录每次 astream 收到的消息链 + 按调用序回放正文的 stub 模型。 */
function recordingLLM(replies: readonly string[]): {
  llm: AsyncLLM;
  seen: Message[][];
} {
  const seen: Message[][] = [];
  let call = 0;
  const llm = {
    adapter: 'fake',
    config: new LLMConfig({ adapter: 'fake', model_id: 'm', base_url: 'http://x' }),
    async ainvoke(): Promise<never> {
      throw new Error('字段 I/O 单测只走 astream');
    },
    async *astream(
      messages: readonly Message[],
      _opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
    ): AsyncIterable<LLMChunk> {
      seen.push([...messages]);
      const text = replies[call] ?? '收口';
      call += 1;
      if (text !== '') yield new LLMChunk({ token: text });
    },
    async aclose(): Promise<void> {},
  } as AsyncLLM;
  return { llm, seen };
}

/** 按调用序发工具增量（先工具后收口）的 stub；记录每次消息链。 */
function toolRoundLLM(): { llm: AsyncLLM; seen: Message[][] } {
  const seen: Message[][] = [];
  let call = 0;
  const llm = {
    adapter: 'fake',
    config: new LLMConfig({ adapter: 'fake', model_id: 'm', base_url: 'http://x' }),
    async ainvoke(): Promise<never> {
      throw new Error('字段 I/O 单测只走 astream');
    },
    async *astream(
      messages: readonly Message[],
      _opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
    ): AsyncIterable<LLMChunk> {
      seen.push([...messages]);
      if (call === 0) {
        yield new LLMChunk({
          tool_calls_delta: [
            new ToolCallDelta({ index: 0, id: 't1', name: 'probe', arguments_delta: '{}' }),
          ],
        });
      } else {
        yield new LLMChunk({ token: '收口' });
      }
      call += 1;
    },
    async aclose(): Promise<void> {},
  } as AsyncLLM;
  return { llm, seen };
}

function seams(llm: AsyncLLM): _EngineNodeSeamsBox {
  return new _EngineNodeSeamsBox({
    llm,
    tool_pipeline: {
      async execute(): Promise<{ ok: boolean; output: string; decision: string }> {
        return { ok: true, output: 'probe:ok', decision: 'allow' };
      },
    } as never,
    tool_specs: [{ name: 'probe', description: '探测', parameters: null } as unknown as ToolSpec],
    all_tool_specs: [],
    collect_specs: null,
    boot_system_prompt: '',
  });
}

function ctx(state: Record<string, unknown>) {
  return {
    state,
    thread_id: 't',
    async emit(_type: string, _payload: Record<string, unknown>): Promise<void> {
      void _type;
      void _payload;
    },
  } as never;
}

const lastContent = (messages: readonly Message[]): string =>
  String((messages[messages.length - 1] as unknown as { content: string }).content ?? '');

describe('output_field：回复落点分化', () => {
  it('缺省 config 零漂移：回复写 reply（无 plan/review 键）', async () => {
    const { llm } = recordingLLM(['直接回答']);
    const node = make_llm_decider_factory(seams(llm))({});
    const state: Record<string, unknown> = { input: '你好' };
    const result = (await node(ctx(state))) as Record<string, unknown>;
    expect(result['reply']).toBe('直接回答');
    expect(state['reply']).toBe('直接回答');
    expect(state['plan']).toBeUndefined();
  });

  it('output_field=plan → 回复写 plan（reply 不产出）', async () => {
    const { llm } = recordingLLM(['P1']);
    const node = make_llm_decider_factory(seams(llm))({ output_field: 'plan', system_prompt: '你是规划器' });
    const state: Record<string, unknown> = { input: '目标' };
    const result = (await node(ctx(state))) as Record<string, unknown>;
    expect(result['plan']).toBe('P1');
    expect(state['plan']).toBe('P1');
    expect(state['reply']).toBeUndefined();
  });

  it('无模型 stub：同样写 output_field 键（字段链无模型可推进）', async () => {
    const box = new _EngineNodeSeamsBox({
      llm: null,
      tool_pipeline: null,
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
    });
    const node = make_llm_decider_factory(box)({ output_field: 'plan' });
    const state: Record<string, unknown> = { input: 'x' };
    const result = (await node(ctx(state))) as Record<string, unknown>;
    expect(typeof result['plan']).toBe('string');
    expect(result['reply']).toBeUndefined();
  });

  it('保留键 output_field（_route_to/_thread_skeleton/messages）工厂期拒绝', () => {
    const box = new _EngineNodeSeamsBox({ llm: null, tool_pipeline: null, tool_specs: [], all_tool_specs: [], collect_specs: null, boot_system_prompt: '' });
    for (const key of ['_route_to', '_thread_skeleton', '_round_continuation', 'messages', 'pending']) {
      expect(() => make_llm_decider_factory(box)({ output_field: key })).toThrow(GraphDefinitionError);
    }
  });
});

describe('read_fields：只读投影进提示（不污染消息链）', () => {
  it('命中字段 → 追加投影 user 消息（含 [key] 块）；不写入持久化消息链', async () => {
    const { llm, seen } = recordingLLM(['答复']);
    const node = make_llm_decider_factory(seams(llm))({
      read_fields: ['plan', 'review'],
    });
    const state: Record<string, unknown> = { input: '综合', plan: '先查资料', review: '计划可行' };
    await node(ctx(state));
    const prompt = seen[0]!;
    const last = lastContent(prompt);
    expect(last).toContain('[plan]');
    expect(last).toContain('先查资料');
    expect(last).toContain('[review]');
    expect(last).toContain('计划可行');
    // 投影不在持久化消息链内（仅输入 user；无「只读投影」消息）
    const stored = state['messages'] as Array<Record<string, unknown>>;
    expect(stored.filter((m) => m['role'] === 'user')).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('[plan]');
  });

  it('无命中字段 → 提示不追加投影（消息链直通）', async () => {
    const { llm, seen } = recordingLLM(['答复']);
    const node = make_llm_decider_factory(seams(llm))({ read_fields: ['plan'] });
    const state: Record<string, unknown> = { input: '无计划' };
    await node(ctx(state));
    const prompt = seen[0]!;
    expect(lastContent(prompt)).not.toContain('[plan]');
  });

  it('缺省 read_fields → 提示与现状一致（最后消息 = 输入 user）', async () => {
    const { llm, seen } = recordingLLM(['答复']);
    const node = make_llm_decider_factory(seams(llm))({});
    const state: Record<string, unknown> = { input: '直接' };
    await node(ctx(state));
    expect(lastContent(seen[0]!)).toBe('直接');
  });

  it('工具回合多次模型调用每次都带投影（重算自状态，不因中间消息丢失）', async () => {
    const { llm, seen } = toolRoundLLM();
    const node = make_llm_decider_factory(seams(llm))({ read_fields: ['plan'] });
    const state: Record<string, unknown> = { input: '任务', plan: '预案' };
    await node(ctx(state));
    expect(seen.length).toBe(2);
    for (const messages of seen) {
      expect(lastContent(messages)).toContain('[plan]');
      expect(lastContent(messages)).toContain('预案');
    }
    // 首轮工具消息回灌后消息链仍不含投影
    const stored = state['messages'] as Array<Record<string, unknown>>;
    expect(JSON.stringify(stored)).not.toContain('[plan]');
  });
});
