/**
 * 引擎装载作用域加工执行器测试（engine_turn_runner.ts：复用既有 executor/agent
 * 机制件的真实默认 ScopeTurnRunner）。
 *
 * 测什么：
 * - persona/boot 分层：boot 基线恒在前、作用域 persona 作自定义层叠加（不绕过
 *   boot）；model:null = 会话默认模型被调用；
 * - 作用域 model 引用：resolve_scope_llm 决议的模型被调用（默认模型不调用）；
 *   seam 缺失 / 解析失败 = 显式失败（不静默跑父模型，与 agent.ts 同口径）；
 * - 端到端：ExecutionRuntime + 引擎装载 runner + fake llm 的 JSON 回复 → `__next`
 *   文本解析 → delegate 子执行 → 归并 → 汇聚点最终产物（真实机制件链路）。
 */
import { describe, expect, it } from 'vitest';

import { ToolPipeline } from '../../../src/loop/tools/tool_pipeline/tool_pipeline.js';
import type { AsyncLLM, LLMChunk } from '../../../src/model/llm/_guard_types.js';
import type { Message } from '../../../src/model/llm/messages.js';
import { ChannelDirectory, default_channel_seeds } from '../../../src/model/channels/channel_directory.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import { make_engine_turn_runner } from '../../../src/loop/execution_runtime/engine_turn_runner.js';
import { ExecutionRuntime } from '../../../src/loop/execution_runtime/execution_runtime.js';

/** 逐次返回脚本文本的 fake llm（每次调用消费一条）。 */
class ScriptedLLM implements AsyncLLM {
  readonly adapter = 'scripted';
  readonly config = { adapter: 'scripted', model_id: 'scripted', base_url: '' };
  readonly calls: Array<{ messages: Message[] }> = [];
  constructor(
    readonly label: string,
    private queue: readonly string[],
  ) {}

  async ainvoke(): Promise<never> {
    throw new Error(`${this.label} 仅流式（astream）`);
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

function inert_pipeline(): ToolPipeline {
  return new ToolPipeline({ allow_unchecked: true, executor: async () => 'ok' });
}

function entity(id: string, persona: string, model: Record<string, string> | null = null): EntitySpec {
  return new EntitySpec({ id, role: id, persona, model });
}

describe('persona/boot 分层与模型解析', () => {
  it('boot 基线恒在前 + persona 自定义层（compose 叠加，不绕过 boot）', async () => {
    const llm = new ScriptedLLM('dflt', ['{"message":"答复"}']);
    const runner = make_engine_turn_runner({ llm, tool_pipeline: inert_pipeline(), boot_system_prompt: 'boot基线' });
    const result = await runner.run_scope_turn({
      run_id: 'r1',
      step: 1,
      scope: entity('main', '主持人 persona'),
      boot_system_prompt: 'boot基线',
      input: '任务',
      payload: {},
      thread_id: 't1',
    });
    expect(result.ok).toBe(true);
    const system = llm.calls[0]!.messages[0]!;
    expect(system.role).toBe('system');
    const content = String(system.content);
    expect(content.startsWith('boot基线')).toBe(true);
    expect(content.indexOf('boot基线')).toBeLessThan(content.indexOf('主持人 persona'));
  });

  it('model:null = 会话默认模型被调用', async () => {
    const llm = new ScriptedLLM('dflt', ['{"message":"ok"}']);
    const runner = make_engine_turn_runner({ llm, tool_pipeline: inert_pipeline() });
    const result = await runner.run_scope_turn({
      run_id: 'r',
      step: 1,
      scope: entity('main', '无指定模型', null),
      boot_system_prompt: '',
      input: 'hi',
      payload: {},
      thread_id: 't',
    });
    expect(result.ok).toBe(true);
    expect(llm.calls.length).toBe(1);
  });

  it('model 引用：resolve_scope_llm 决议的模型被调用（默认模型不调用）', async () => {
    const dflt = new ScriptedLLM('dflt', ['默认模型不应回答']);
    const scoped = new ScriptedLLM('scoped', ['{"message":"作用域模型答复"}']);
    let resolverCalls = 0;
    const runner = make_engine_turn_runner({
      llm: dflt,
      tool_pipeline: inert_pipeline(),
      resolve_scope_llm: (model) => {
        resolverCalls += 1;
        expect(model).toEqual({ provider: 'tp', model_id: 'm2' });
        return scoped;
      },
    });
    const result = await runner.run_scope_turn({
      run_id: 'r',
      step: 1,
      scope: entity('main', '指定模型', { provider: 'tp', model_id: 'm2' }),
      boot_system_prompt: '',
      input: 'hi',
      payload: {},
      thread_id: 't',
    });
    expect(result.ok).toBe(true);
    expect(scoped.calls.length).toBe(1);
    expect(dflt.calls.length).toBe(0);
    expect(resolverCalls).toBe(1);
  });

  it('model 引用缺解析 seam / 解析失败 = 显式失败（不静默跑父模型）', async () => {
    const noSeam = make_engine_turn_runner({ llm: new ScriptedLLM('d', ['x']), tool_pipeline: inert_pipeline() });
    const r1 = await noSeam.run_scope_turn({
      run_id: 'r',
      step: 1,
      scope: entity('main', 'p', { provider: 'tp', model_id: 'm' }),
      boot_system_prompt: '',
      input: 'hi',
      payload: {},
      thread_id: 't',
    });
    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain('resolve_scope_llm');

    const resolveFail = make_engine_turn_runner({
      llm: new ScriptedLLM('d2', ['x']),
      tool_pipeline: inert_pipeline(),
      resolve_scope_llm: async () => null,
    });
    const r2 = await resolveFail.run_scope_turn({
      run_id: 'r2',
      step: 1,
      scope: entity('main', 'p', { provider: 'tp', model_id: 'm' }),
      boot_system_prompt: '',
      input: 'hi',
      payload: {},
      thread_id: 't',
    });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('无法解析');
  });
});

describe('端到端：ExecutionRuntime + 引擎装载 runner', () => {
  it('fake llm JSON 回复 → `__next` 文本解析 → delegate 子执行 → 汇聚点产物', async () => {
    const scopes = new Map<string, EntitySpec>([
      ['main', entity('main', '主持人')],
      ['subagent', entity('subagent', '子代理')],
    ]);
    const llm = new ScriptedLLM('default', [
      '{"message":"委托子代理","__next":{"kind":"scope","target":"subagent"}}',
      '{"message":"子代理回合结果"}',
      '{"message":"引擎回合最终答复"}',
    ]);
    const runner = make_engine_turn_runner({ llm, tool_pipeline: inert_pipeline(), boot_system_prompt: '' });
    const channels = new ChannelDirectory();
    for (const spec of default_channel_seeds()) channels.register(spec);
    const runtime = new ExecutionRuntime({
      load_scope: (id) => scopes.get(id) ?? null,
      channels,
      turn: runner,
    });
    const result = await runtime.run({ task: '验证' });
    expect(result.root.outcome).toBe('success');
    // 汇聚点合成唯一最终产物（主持人的最终答复 + 子代理产物按 scope 键并入）
    expect(result.final_product['message']).toBe('引擎回合最终答复');
    expect(result.final_product['subagent']).toBeDefined();
    expect(result.runs.length).toBe(2);
  });
});
