/**
 * 图像分量进模型消息链契约测试（W8B 交棒形状：turn 输入 → state.attachments
 * → llm_decider 消息附件 → 模型调用多模态 user 消息）。
 *
 * 测什么（scope_turn 投影 + 引擎既有附件通道的合龙，run_loop/runner 接线
 * 由 W8A 收口）：
 * - 子引擎 state 携 scope_turn `turn_image_to_attachment` 投影的附件 dict 时，
 *   llm_decider 消息构造出带图像附件的 user 消息（data URL 引用进消息面，
 *   不进文本域——input 文本保持纯文本）；
 * - 无附件回合零漂移：user 消息 attachments 为空、input 文本原样。
 */
import { describe, expect, it } from 'vitest';

import { ToolPipeline } from '../../../src/kernel/tool_pipeline/tool_pipeline.js';
import type { AsyncLLM, LLMChunk } from '../../../src/kernel/llm/_guard_types.js';
import type { Message } from '../../../src/kernel/llm/messages.js';
import { Graph } from '../../../src/model/graph/graph.js';
import { RunOptions } from '../../../src/core/run_result/run_result.js';
import { Engine } from '../../../src/kernel/executor/index.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import { GraphRegistries } from '../../../src/core/registry/registry.js';
import {
  bind_engine_node_seams,
  default_engine_pool_seed,
  register_engine_node_types,
} from '../../../src/core/nodes/index.js';
import { _build_agent_scope_graph } from '../../../src/core/nodes/agent.js';
import {
  build_turn_input_with_media,
  turn_image_to_attachment,
} from '../../../src/core/execution_runtime/scope_turn.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==';
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

/** 捕获消息链的 fake llm（流式直答固定文本）。 */
class CapturingLLM implements AsyncLLM {
  readonly adapter = 'capture';
  readonly config = { adapter: 'capture', model_id: 'capture', base_url: '' };
  readonly calls: Message[][] = [];

  async ainvoke(): Promise<never> {
    throw new Error('capture 仅流式（astream）');
  }

  async *astream(messages: readonly Message[]): AsyncIterable<LLMChunk> {
    this.calls.push([...messages]);
    yield { token: '{"message":"图片已理解"}', tool_calls_delta: null } as LLMChunk;
  }

  async aclose(): Promise<void> {}
}

function scope_engine(llm: CapturingLLM): Engine {
  const graph: Graph = _build_agent_scope_graph(
    new EntitySpec({ id: 'main', role: 'main', persona: '', model: null }),
    {},
  );
  const registries = new GraphRegistries();
  register_engine_node_types(registries, default_engine_pool_seed().node_types);
  bind_engine_node_seams(registries, {
    llm,
    tool_pipeline: new ToolPipeline({ allow_unchecked: true, executor: async () => 'ok' }),
    tool_specs: [],
    all_tool_specs: [],
    collect_specs: null,
    boot_system_prompt: '',
    resolve_entity: null,
    resolve_scope_llm: null,
  });
  return new Engine(graph, new RunOptions({ registries }));
}

describe('图像分量 → 模型多模态消息（交棒契约形状）', () => {
  it('state.attachments 携投影附件：user 消息带图像附件，input 文本无 base64', async () => {
    const payload = { task: '看看这张图', attachments: [{ kind: 'image', url: PNG_URL, mime_type: 'image/png', name: 'a.png' }] };
    // 装配形态与 run_loop 一致：注入文本为空，task 文本来自载荷投影
    const { text, images } = await build_turn_input_with_media('', payload, undefined);
    expect(text).toBe('看看这张图');
    expect(images).toHaveLength(1);
    const llm = new CapturingLLM();
    const result = await scope_engine(llm).ainvoke(
      { input: text, attachments: images.map(turn_image_to_attachment) },
      { thread_id: 't1', round_id: 'r1' },
    );
    expect(result.reason).not.toBe('error');
    const messages = llm.calls[0]!;
    const userMessage = messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage!.content).toBe('看看这张图');
    expect(userMessage!.attachments).toHaveLength(1);
    expect(userMessage!.attachments[0]!.kind).toBe('image');
    expect(userMessage!.attachments[0]!.url).toBe(PNG_URL);
  });

  it('无附件回合零漂移：state 无 attachments 键时 user 消息附件为空、文本原样', async () => {
    const llm = new CapturingLLM();
    await scope_engine(llm).ainvoke({ input: '纯文本任务' }, { thread_id: 't2', round_id: 'r2' });
    const userMessage = llm.calls[0]!.find((m) => m.role === 'user');
    expect(userMessage!.content).toBe('纯文本任务');
    expect(userMessage!.attachments).toHaveLength(0);
  });
});
