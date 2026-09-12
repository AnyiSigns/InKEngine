/**
 * 白板端到端测试（ExecutionRuntime + 引擎装载 runner + fake llm）。
 *
 * 测什么：
 * - turn input 携带装配源进 llm 调用：带白板的 run 下，子作用域 llm 调用的
 *   user 消息内容含被授权块内容（装配段经 run_loop 装进 input，engine_turn_
 *   runner 原样透传）；
 * - reply 产物形态不变：白板在场不改变 `__next` 路由 / 归并 / 汇聚点产物形态
 *   （与无白板 delegate 场景同构）。
 */
import { describe, expect, it } from 'vitest';

import { ToolPipeline } from '../../../src/kernel/tool_pipeline/tool_pipeline.js';
import type { AsyncLLM, LLMChunk } from '../../../src/kernel/llm/_guard_types.js';
import type { Message } from '../../../src/kernel/llm/messages.js';
import { ChannelDirectory, default_channel_seeds } from '../../../src/model/channels/channel_directory.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import { make_engine_turn_runner } from '../../../src/core/execution_runtime/engine_turn_runner.js';
import { ExecutionRuntime } from '../../../src/core/execution_runtime/execution_runtime.js';
import { default_whiteboard_grants } from '../../../src/core/whiteboard/index.js';
import type { WhiteboardBlock } from '../../../src/core/whiteboard/index.js';

/** 逐次返回脚本文本的 fake llm（每次调用消费一条）。 */
class ScriptedLLM implements AsyncLLM {
  readonly adapter = 'scripted';
  readonly config = { adapter: 'scripted', model_id: 'scripted', base_url: '' };
  readonly calls: Array<{ messages: Message[] }> = [];
  constructor(private queue: readonly string[]) {}

  async ainvoke(): Promise<never> {
    throw new Error('仅流式（astream）');
  }

  async *astream(messages: readonly Message[]): AsyncIterable<LLMChunk> {
    this.calls.push({ messages: [...messages] });
    const rest = [...this.queue];
    const text = rest.length > 0 ? rest[0]! : '';
    this.queue = rest.slice(1);
    yield { token: text, tool_calls_delta: null };
  }

  async aclose(): Promise<void> {}
}

describe('端到端：白板装配源进 llm 调用，产物形态不变', () => {
  it('子作用域 llm user 消息含被授权块内容；delegate 路由/归并/汇聚点形态与无白板一致', async () => {
    const scopes = new Map<string, EntitySpec>([
      ['main', new EntitySpec({ id: 'main', role: 'main', persona: '主持人' })],
      ['collab_a', new EntitySpec({ id: 'collab_a', role: 'collaborator', persona: '协作者甲' })],
    ]);
    const llm = new ScriptedLLM([
      '{"message":"委托子代理","__next":{"kind":"scope","target":"collab_a"}}',
      '{"message":"子代理回合结果"}',
      '{"message":"引擎回合最终答复"}',
    ]);
    const runner = make_engine_turn_runner({ llm, tool_pipeline: new ToolPipeline({ allow_unchecked: true, executor: async () => 'ok' }) });
    const channels = new ChannelDirectory();
    for (const spec of default_channel_seeds()) channels.register(spec);
    const taskBlock: WhiteboardBlock = {
      id: 'b-task', kind: 'task', owner: 'main', content: '白板任务内容标记', seq: 0,
    };
    const runtime = new ExecutionRuntime({
      load_scope: (id) => scopes.get(id) ?? null,
      channels,
      turn: runner,
    });
    const result = await runtime.run({
      task: '验证白板链路',
      whiteboard: {
        grants: default_whiteboard_grants('blind', ['collab_a']),
        blocks: [taskBlock],
      },
    });
    expect(result.root.outcome).toBe('success');
    expect(result.final_product['message']).toBe('引擎回合最终答复');
    expect(result.final_product['collab_a']).toBeDefined();
    expect(result.runs.length).toBe(2);

    // 调用序：main#1 → collab_a → main#2；子作用域 user 消息含被授权任务块内容
    expect(llm.calls.length).toBe(3);
    const collabUser = String(llm.calls[1]!.messages[llm.calls[1]!.messages.length - 1]!.content);
    expect(collabUser).toContain('白板任务内容标记');
    // main 的 user 消息同样含块内容（主持人全可见）
    const mainUser = String(llm.calls[0]!.messages[llm.calls[0]!.messages.length - 1]!.content);
    expect(mainUser).toContain('白板任务内容标记');
  });
});
