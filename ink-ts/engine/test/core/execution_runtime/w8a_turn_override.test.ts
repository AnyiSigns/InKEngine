// gate: 超限(282 行) - W8A 回合级配置测试（模型覆写解析序/状态种子/工具上限/pose 三档）场景多、头注详尽，拆分会伤可读性
/**
 * 引擎装载作用域加工执行器的回合级配置测试（W8A：runtime_types 新字段 +
 * engine_turn_runner 消费面）。
 *
 * 测什么（逐项对应执行主线配置生效面）：
 * - round_model request 级覆写：provider/model_id 经 resolve_scope_llm 同链决议，
 *   覆写模型被调用（会话默认/作用域资产模型不调用）；
 * - 解析序：request 覆写 > 作用域资产 model > 缺省（两者同带引用时覆写胜出）；
 * - 纯推理档位覆写（无模型选择）：回落作用域资产模型；推理参数随 STATE_ROUND_MODEL
 *   键进子引擎状态（llm_decider 构造 LLMParams 的种子面）；
 * - round_pose 种子：auto/deny 随 STATE_ROUND_POSE 键进子引擎状态 → 工具审批
 *   seam 按姿态裁定（auto 免弹直过 / review 挂卡透出 interrupt / deny 免问直拒）；
 * - max_tool_rounds：run 级覆写进 llm_decider config——模型连发工具调用时按上限
 *   收口（调用数 = 上限，超限显式失败不无限循环）。
 */
import { describe, expect, it } from 'vitest';

import { ToolPipeline } from '../../../src/kernel/tool_pipeline/tool_pipeline.js';
import { ToolSpec } from '../../../src/kernel/llm/tools.js';
import { GateResult, REVIEW } from '../../../src/kernel/permissions/permissions.js';
import type { AsyncLLM, LLMChunk } from '../../../src/kernel/llm/_guard_types.js';
import type { Message } from '../../../src/kernel/llm/messages.js';
import { ToolCallDelta } from '../../../src/kernel/llm/messages.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import { make_engine_turn_runner } from '../../../src/core/execution_runtime/engine_turn_runner.js';
import type { RoundModelOverride, ScopeTurnContext } from '../../../src/core/execution_runtime/runtime_types.js';

/** 逐次返回脚本帧的 fake llm（每次 astream 消费一条；可发工具调用增量）。 */
class ScriptedLLM implements AsyncLLM {
  readonly adapter = 'scripted';
  readonly config = { adapter: 'scripted', model_id: 'scripted', base_url: '' };
  readonly calls: Array<{ messages: Message[] }> = [];
  constructor(
    readonly label: string,
    private queue: ReadonlyArray<{ text?: string; tool?: string }>,
  ) {}

  async ainvoke(): Promise<never> {
    throw new Error(`${this.label} 仅流式（astream）`);
  }

  async *astream(messages: readonly Message[]): AsyncIterable<LLMChunk> {
    this.calls.push({ messages: [...messages] });
    const rest = [...this.queue];
    const frame = rest.length > 0 ? rest[0]! : { text: '' };
    this.queue = rest.slice(1);
    if (frame.tool !== undefined) {
      yield {
        token: '',
        tool_calls_delta: [
          new ToolCallDelta({ index: 0, id: 'call_1', name: frame.tool, arguments_delta: '{}' }),
        ],
      };
      return;
    }
    yield { token: frame.text ?? '', tool_calls_delta: null };
  }

  async aclose(): Promise<void> {}
}

function entity(id: string, persona: string, model: Record<string, string> | null = null): EntitySpec {
  return new EntitySpec({ id, role: id, persona, model });
}

function turnCtx(scope: EntitySpec, extra: Partial<ScopeTurnContext> = {}): ScopeTurnContext {
  return {
    run_id: 'r',
    step: 1,
    scope,
    boot_system_prompt: '',
    input: '任务',
    payload: {},
    thread_id: 't',
    ...extra,
  };
}

/** 审批档工具流水线（probe 工具 gate 恒 review；记录每次执行的 ctx.state）。 */
function reviewPipeline(states: Array<Record<string, unknown> | undefined>): ToolPipeline {
  return new ToolPipeline({
    extractor: (spec) => (spec.name === 'probe' ? (['run', 'x'] as [string, string]) : null),
    gate: {
      check: () => new GateResult(REVIEW, 'probe', 'run', 'x', '门控分级需审批'),
    },
    executor: async (ctx) => {
      states.push((ctx as { state?: Record<string, unknown> }).state);
      return 'ok';
    },
  });
}

describe('round_model request 级覆写（解析序：覆写 > 作用域资产 > 缺省）', () => {
  it('覆写带 provider/model_id：resolve_scope_llm 收到覆写引用、覆写模型被调用', async () => {
    const dflt = new ScriptedLLM('dflt', [{ text: '默认不应回答' }]);
    const scoped = new ScriptedLLM('scoped', [{ text: '作用域不应回答' }]);
    const overridden = new ScriptedLLM('overridden', [{ text: '{"message":"覆写模型答复"}' }]);
    const resolverCalls: Array<Record<string, string>> = [];
    const runner = make_engine_turn_runner({
      llm: dflt,
      tool_pipeline: new ToolPipeline({ allow_unchecked: true, executor: async () => 'ok' }),
      resolve_scope_llm: (model) => {
        resolverCalls.push({ ...model });
        if (model['model_id'] === 'scope-m') return scoped;
        return overridden;
      },
    });
    const result = await runner.run_scope_turn(
      turnCtx(entity('main', '主持人'), {
        round_model: { provider: 'req-prov', model_id: 'req-m' } satisfies RoundModelOverride,
      }),
    );
    expect(result.ok).toBe(true);
    expect(overridden.calls.length).toBe(1);
    expect(scoped.calls.length).toBe(0);
    expect(dflt.calls.length).toBe(0);
    expect(resolverCalls).toEqual([{ provider: 'req-prov', model_id: 'req-m' }]);
  });

  it('解析序：request 覆写与作用域资产 model 同带引用时覆写胜出', async () => {
    const scoped = new ScriptedLLM('scoped', [{ text: '作用域模型不应回答' }]);
    const overridden = new ScriptedLLM('overridden', [{ text: '{"message":"覆写优先"}' }]);
    const seen: Array<Record<string, string>> = [];
    const runner = make_engine_turn_runner({
      llm: new ScriptedLLM('dflt', [{ text: '' }]),
      tool_pipeline: new ToolPipeline({ allow_unchecked: true, executor: async () => 'ok' }),
      resolve_scope_llm: (model) => {
        seen.push({ ...model });
        if (model['model_id'] === 'scope-m') return scoped;
        return overridden;
      },
    });
    const result = await runner.run_scope_turn(
      turnCtx(entity('main', '主持人', { provider: 'scope-prov', model_id: 'scope-m' }), {
        round_model: { provider: 'req-prov', model_id: 'req-m' } satisfies RoundModelOverride,
      }),
    );
    expect(result.ok).toBe(true);
    expect(overridden.calls.length).toBe(1);
    expect(scoped.calls.length).toBe(0);
    expect(seen).toEqual([{ provider: 'req-prov', model_id: 'req-m' }]);
  });

  it('纯推理档位覆写（无模型选择）：回落作用域资产模型；推理参数进 STATE_ROUND_MODEL', async () => {
    const scoped = new ScriptedLLM('scoped', [{ tool: 'probe' }, { text: '{"message":"作用域模型答复"}' }]);
    const states: Array<Record<string, unknown> | undefined> = [];
    const runner = make_engine_turn_runner({
      llm: new ScriptedLLM('dflt', [{ text: '' }]),
      // 审计钩子收到节点 ctx（任意执行路径都过 _audit——含直通执行）
      tool_pipeline: new ToolPipeline({
        allow_unchecked: true,
        executor: async (ctx) => {
          states.push((ctx as { state?: Record<string, unknown> }).state);
          return 'ok';
        },
      }),
      tool_specs: [new ToolSpec({ name: 'probe', description: '探测', parameters: {} })],
      resolve_scope_llm: (model) => {
        expect(model['model_id']).toBe('scope-m');
        return scoped;
      },
    });
    const result = await runner.run_scope_turn(
      turnCtx(entity('main', '主持人', { provider: 'scope-prov', model_id: 'scope-m' }), {
        round_model: { reasoning_effort: 'high', enable_thinking: true } satisfies RoundModelOverride,
      }),
    );
    expect(result.ok).toBe(true);
    expect(scoped.calls.length).toBe(2);
    expect(states.length).toBeGreaterThan(0);
    const seeded = states[0]!;
    expect(seeded['round_model']).toEqual({ reasoning_effort: 'high', enable_thinking: true });
    // 无 pose：round_pose 键不落（review 缺省零漂移）
    expect(seeded['round_pose']).toBeUndefined();
  });

  it('覆写解析失败 = 显式失败（不静默跑作用域/默认模型）', async () => {
    const runner = make_engine_turn_runner({
      llm: new ScriptedLLM('dflt', [{ text: 'x' }]),
      tool_pipeline: new ToolPipeline({ allow_unchecked: true, executor: async () => 'ok' }),
      resolve_scope_llm: async () => null,
    });
    const result = await runner.run_scope_turn(
      turnCtx(entity('main', 'p'), {
        round_model: { provider: 'ghost', model_id: 'nope' } satisfies RoundModelOverride,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('覆写无法解析');
  });
});

describe('round_pose 工具审批 seam（STATE_ROUND_POSE 种子 → 三档裁定）', () => {
  const toolSpecs = [new ToolSpec({ name: 'probe', description: '探测', parameters: {} })];
  const script = [
    { tool: 'probe' },
    { text: '{"message":"工具回合后收口"}' },
  ];

  it('auto 档：需审批调用免弹直过（工具执行 + 正常收口，无挂起）', async () => {
    const states: Array<Record<string, unknown> | undefined> = [];
    const llm = new ScriptedLLM('auto', script);
    const runner = make_engine_turn_runner({
      llm,
      tool_pipeline: reviewPipeline(states),
      tool_specs: toolSpecs,
    });
    const result = await runner.run_scope_turn(
      turnCtx(entity('main', '主持人'), { round_pose: 'auto' }),
    );
    expect(result.ok).toBe(true);
    expect(result.interrupt ?? null).toBeNull();
    // pose 种子进入工具审批 seam（ctx.state.round_pose = auto → approve_before_execute 直过）
    expect(states.some((s) => s?.['round_pose'] === 'auto')).toBe(true);
    expect(llm.calls.length).toBe(2);
  });

  it('review 档（缺省姿态）：需审批调用挂卡（interrupt 透出，turn 未完成）', async () => {
    const states: Array<Record<string, unknown> | undefined> = [];
    const llm = new ScriptedLLM('review', script);
    const runner = make_engine_turn_runner({
      llm,
      tool_pipeline: reviewPipeline(states),
      tool_specs: toolSpecs,
    });
    const result = await runner.run_scope_turn(turnCtx(entity('main', '主持人')));
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('');
    expect(result.interrupt).not.toBeNull();
    expect(result.interrupt!.key).toBe('gate:probe');
    // 挂卡点：工具未执行、无收口轮
    expect(states.length).toBe(0);
    expect(llm.calls.length).toBe(1);
  });

  it('deny 档：需审批调用免问直拒（turn 失败收口，无收口轮）', async () => {
    const llm = new ScriptedLLM('deny', script);
    const runner = make_engine_turn_runner({
      llm,
      tool_pipeline: reviewPipeline([]),
      tool_specs: toolSpecs,
    });
    const result = await runner.run_scope_turn(
      turnCtx(entity('main', '主持人'), { round_pose: 'deny' }),
    );
    // deny = 免问直拒：首轮工具即被拒 → turn 失败收口（后续收口轮不执行）
    expect(result.ok).toBe(false);
    expect(llm.calls.length).toBe(1);
  });
});

describe('max_tool_rounds 工具回合上限（run 级覆写进 llm_decider config）', () => {
  it('模型连发工具调用：上限 2 轮即收口（调用数 = 2，显式失败不无限循环）', async () => {
    const llm = new ScriptedLLM('loop', [
      { tool: 'probe' },
      { tool: 'probe' },
      { tool: 'probe' },
      { tool: 'probe' },
    ]);
    const runner = make_engine_turn_runner({
      llm,
      tool_pipeline: new ToolPipeline({ allow_unchecked: true, executor: async () => 'ok' }),
      tool_specs: [new ToolSpec({ name: 'probe', description: '探测', parameters: {} })],
    });
    const result = await runner.run_scope_turn(
      turnCtx(entity('main', '主持人'), { max_tool_rounds: 2 }),
    );
    // 上限 2：两轮工具调用后 llm_decider 超限收口 → turn 失败（缺省 8 轮不会触发）
    expect(result.ok).toBe(false);
    expect(llm.calls.length).toBe(2);
  });

  it('缺省（未传覆写）= 装配值生效（cap=3：三模型轮后收口）', async () => {
    const llm = new ScriptedLLM('loop', [
      { tool: 'probe' },
      { tool: 'probe' },
      { text: '{"message":"第三轮后收口"}' },
    ]);
    const runner = make_engine_turn_runner({
      llm,
      tool_pipeline: new ToolPipeline({ allow_unchecked: true, executor: async () => 'ok' }),
      tool_specs: [new ToolSpec({ name: 'probe', description: '探测', parameters: {} })],
      max_tool_rounds: 3,
    });
    const result = await runner.run_scope_turn(turnCtx(entity('main', '主持人')));
    expect(result.ok).toBe(true);
    expect(llm.calls.length).toBe(3);
  });
});
