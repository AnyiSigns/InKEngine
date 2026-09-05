/**
 * canary 单回合试跑测（path_assembler.py canary 执行类用例回补，executor
 * 接线后真实跑）：候选图重建 + 单回合试跑走通 / 破坏性执行拒绝 / canary 态
 * 上下文标记 / 步数护栏截止 / 超时中止 / 组装指令 canary=True 全链验证。
 */
import { describe, expect, it } from 'vitest';

import { Graph } from '../../../src/core/graph/graph.js';
import { PathAssemblyConfig } from '../../../src/core/contracts/contracts.js';
import {
  PathAssemblyRuntime,
  canary_active,
  canary_instantiate,
  canary_round,
} from '../../../src/core/path_assembler/index.js';
import {
  DUMMY_NOW,
  make_assembler,
  make_registry,
  make_request,
} from './helpers.js';

/** 单节点可跑图（写 answer；可选抛错/延迟/读取 canary 态）。 */
function single_node_graph(
  init: {
    answer?: string;
    boom?: boolean;
    delay_ms?: number;
    read_flag?: boolean;
  } = {},
): Graph {
  const g = new Graph({ name: 'canary-g', entry: 'a' });
  const node = async (ctx: any): Promise<Record<string, unknown>> => {
    if (init.read_flag === true) {
      ctx.state['flag_seen'] = canary_active();
    }
    if (init.delay_ms !== undefined && init.delay_ms !== null) {
      await new Promise((resolve) => setTimeout(resolve, init.delay_ms));
    }
    if (init.boom === true) {
      throw new Error('canary boom');
    }
    return { answer: init.answer ?? 'ok' };
  };
  g.add_node('a', node as never);
  g.add_exit('a');
  return g;
}

/** 自循环图（无条件回到自身 → 步数护栏截止）。 */
function runaway_graph(): Graph {
  const g = new Graph({ name: 'canary-loop', entry: 'a' });
  g.add_node('a', (async () => ({ tick: true })) as never);
  g.add_conditional_edge(
    'a',
    'a',
    (async () => true) as never,
  );
  return g;
}

describe('canary 单回合试跑（真实 executor 执行）', () => {
  it('test_canary_round_success：合法图单回合走通（reply、无挂起 = 通过）', async () => {
    const result = await canary_round(single_node_graph({ answer: 'ok' }), {
      entry_state: { user_query: 'q' },
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('reply');
    expect(result.final_state).toEqual({ user_query: 'q', answer: 'ok' });
    expect(result.events_emitted).toBe(0);
  });

  it('test_canary_round_rejects_broken_execution：执行抛错 = 未通过（reason=error）', async () => {
    const result = await canary_round(single_node_graph({ boom: true }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('error');
  });

  it('test_canary_active_context_flag：canary 态在单回合期间置位、出口复位', async () => {
    const graph = single_node_graph({ answer: 'ok', read_flag: true });
    expect(canary_active()).toBe(false);
    const result = await canary_round(graph, { entry_state: {} });
    expect(result.ok).toBe(true);
    // 结点层读取到 canary 态（置位生效）
    expect(result.final_state['flag_seen']).toBe(true);
    // 出口复位
    expect(canary_active()).toBe(false);
  });

  it('test_canary_step_budget_caps_execution：步数护栏超限截止（预算缺省注入生效）', async () => {
    const result = await canary_round(runaway_graph(), { entry_state: {} });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('budget_exceeded');
  });

  it('test_canary_timeout_aborts：超时中止试跑', async () => {
    const graph = single_node_graph({ answer: 'slow', delay_ms: 400 });
    await expect(
      canary_round(graph, { entry_state: {}, canary_timeout: 0.05 }),
    ).rejects.toThrow(/超时/);
  });

  it('test_integration_candidate_roundtrip_and_canary_run：组装产物重建后单回合试跑走通', async () => {
    const registry = make_registry();
    const assembled = await make_assembler(registry).assemble(make_request(['answer']));
    const candidate = assembled.candidates[0]!;
    const graphData = candidate.to_dict()['graph'] as Record<string, unknown>;
    const rebuilt = canary_instantiate(graphData, { registry });
    expect(rebuilt.digest()).toBe(candidate.graph.digest());
    const result = await canary_round(rebuilt, { entry_state: {} });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('reply');
  });
});

describe('组装指令 canary=True 全链验证（runtime.assemble_plan）', () => {
  it('test_assemble_plan_runtime_canary_and_audit：canary 开启 → 候选单回合执行（executed=true）', async () => {
    const runtime = new PathAssemblyRuntime({
      registry: make_registry(),
      config: new PathAssemblyConfig({ enabled: true }),
      canary: true,
      now: DUMMY_NOW,
    });
    const records: Record<string, unknown>[] = [];
    const result = await runtime.assemble_plan(make_request(['answer']), {
      audit_sink: (r) => records.push(r),
    });
    expect(result.is_empty).toBe(false);
    expect(result.canary.length).toBe(result.candidates.length);
    for (const verdict of result.canary) {
      expect(verdict.ok).toBe(true);
      expect(verdict.executed).toBe(true);
    }
    expect(records.length).toBe(1 + result.candidates.length);
  });
});
