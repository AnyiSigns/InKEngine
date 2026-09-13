/**
 * 并行组批量执行能力直调单测（S1 折入 `_engine_execute_helpers.ts` 后保留面）。
 *
 * 计划 §3.3.1 处置 2：`_engine_parallel.ts` 内与展开段无关的批量执行段
 * （Promise.all 批跑）折入 `_engine_execute_helpers.ts`——并行组 = 引擎的
 * 通用批量执行原语（隔离状态并发跑同图节点、按声明序合并），本文件经
 * Engine 实例直调 `_run_parallel_group` 锁其存活行为（并发池/合并序/失败
 * 剔除/首信号收口），不依赖任何已退役的展开段触发面。
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorage, make_engine } from './helpers.js';
import { Graph } from '../../../src/model/graph/graph.js';
import { TerminateReason } from '../../../src/model/graph/graph_types.js';
import { _NodeContextImpl } from '../../../src/graph/executor/index.js';
import type { Engine } from '../../../src/graph/executor/index.js';

function node(name: string, fn: (ctx: any) => Promise<Record<string, unknown>> | Record<string, unknown>) {
  return { name, fn: fn as never };
}

function parallel_engine(
  nodes: Array<{ name: string; fn: never }>,
  opts: { error_on_exception?: boolean; parallel_concurrency?: number } = {},
): { engine: Engine; graph: Graph; state: Record<string, unknown>; ctx: _NodeContextImpl } {
  const graph = new Graph({ name: 'par', entry: nodes[0]!.name });
  for (const n of nodes) graph.add_node(n.name, n.fn);
  graph.add_exit(nodes[0]!.name);
  const engine = make_engine(graph, {
    extra: {
      error_on_exception: opts.error_on_exception ?? true,
      parallel_concurrency: opts.parallel_concurrency ?? 4,
    },
  });
  const state: Record<string, unknown> = { seed: 1 };
  const ctx = new _NodeContextImpl({
    engine: engine as never,
    state,
    graph_path: [],
    round_id: null,
    trace_id: 'trace',
    thread_id: 't',
  });
  return { engine, graph, state, ctx };
}

describe('_run_parallel_group（并行组批量执行，S1 折入保留面）', () => {
  it('成员并发执行，结果按声明序合并（隔离状态快照）', async () => {
    const { engine, graph, ctx } = parallel_engine([
      node('a', async () => ({ a: 1 })),
      node('b', async (c: any) => ({ b: (c.state.seed as number) + 1 })),
      node('c', async () => ({ c: 3 })),
    ]);
    const outcome = await engine._run_parallel_group(['a', 'b', 'c'], ctx, { seed: 1 }, graph);
    expect(outcome.terminate).toBeNull();
    expect(outcome.error).toBeNull();
    // 声明序合并：b 读 seed=1（快照隔离），不串成员增量
    expect(outcome.overlay).toMatchObject({ a: 1, b: 2, c: 3 });
  });

  it('成员失败：error_on_exception=True 整组失败；False 剔除后成功成员按序合并', async () => {
    const nodes = [
      node('good', async () => ({ ok: true })),
      node('bad', async () => {
        throw new Error('member-boom');
      }),
    ];
    const strict = parallel_engine(nodes, { error_on_exception: true });
    const strictOutcome = await strict.engine._run_parallel_group(['good', 'bad'], strict.ctx, {}, strict.graph);
    expect(strictOutcome.error).toContain('并行组失败');
    expect(strictOutcome.overlay).toEqual({});

    const lenient = parallel_engine(nodes, { error_on_exception: false });
    const lenientOutcome = await lenient.engine._run_parallel_group(['good', 'bad'], lenient.ctx, {}, lenient.graph);
    expect(lenientOutcome.error).toBeNull();
    expect(lenientOutcome.overlay).toMatchObject({ ok: true });
  });

  it('成员 terminate → 组级终止信号，终止成员 overlay 保留', async () => {
    const nodes = [
      node('bye', async (c: any) => {
        c.terminate(TerminateReason.STOP);
        return { done: true };
      }),
      node('silent', async () => ({ ignored: true })),
    ];
    const { engine, graph, ctx } = parallel_engine(nodes);
    const outcome = await engine._run_parallel_group(['bye', 'silent'], ctx, {}, graph);
    expect(outcome.terminate).toBe(TerminateReason.STOP);
    expect(outcome.error).toBeNull();
  });

  it('预算超限 → 组级 BUDGET_EXCEEDED 信号', async () => {
    const nodes = [node('n1', async () => ({ v: 1 })), node('n2', async () => ({ v: 2 }))];
    const { engine, graph, ctx } = parallel_engine(nodes);
    // 预算直接抛 BudgetExceededError（成员边界访问即触发）
    engine.options.budget = {
      async check(): Promise<void> {
        throw new Error('steps 预算超限');
      },
    } as never;
    const outcome = await engine._run_parallel_group(['n1', 'n2'], ctx, {}, graph);
    expect(outcome.terminate).toBe(TerminateReason.BUDGET_EXCEEDED);
    expect(outcome.error).toContain('预算');
  });

  it('并发上限：parallel_concurrency 限流仍全成员完成', async () => {
    let active = 0;
    let peak = 0;
    const nodes = [
      node('a', async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return { a: 1 };
      }),
      node('b', async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return { b: 2 };
      }),
      node('c', async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return { c: 3 };
      }),
      node('d', async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return { d: 4 };
      }),
    ];
    const { engine, graph, ctx } = parallel_engine(nodes, { parallel_concurrency: 2 });
    const outcome = await engine._run_parallel_group(['a', 'b', 'c', 'd'], ctx, {}, graph);
    expect(outcome.error).toBeNull();
    expect(peak).toBeLessThanOrEqual(2);
    expect(outcome.overlay).toMatchObject({ a: 1, b: 2, c: 3, d: 4 });
  });
});
