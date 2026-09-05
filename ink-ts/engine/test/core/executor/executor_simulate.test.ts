/**
 * 执行引擎推演展开面单测（run_simulated 分支执行/换选路径）：换选（branch_pick）
 * 只执行目标分支，且分支失败归约报告真实分支序号（fan_out 任务列表位置 ≠
 * 分支序号时不错位）——与 spawn 实例展开同构的执行面回归。
 */
import { describe, expect, it } from 'vitest';
import { make_engine } from './helpers.js';
import { _NodeContextImpl } from '../../../src/core/executor/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { SimulationError } from '../../../src/core/errors.js';
import { SimulateSpec } from '../../../src/core/simulation/simulation_types.js';

function graph_with(entry: string, run: (ctx: any) => unknown, exit = true): Graph {
  const g = new Graph({ name: `sim-${entry}`, entry });
  g.add_node(entry, run as never);
  if (exit) g.add_exit(entry);
  return g;
}

describe('Engine.run_simulated 换选路径', () => {
  it('换选分支失败：失败归约报真实分支序号（非任务列表位置 0）', async () => {
    const ok_graph = graph_with('ok', async (_ctx: unknown): Promise<Record<string, unknown>> => ({ v: 1 }));
    const boom_graph = graph_with('boom', async (_ctx: unknown): Promise<never> => {
      throw new Error('boom');
    });
    const specs = [
      new SimulateSpec({ subgraph: ok_graph, state: {}, index: 0, description: 'ok' }),
      new SimulateSpec({ subgraph: boom_graph, state: {}, index: 1, description: 'boom' }),
    ];
    const engine = make_engine(graph_with('root', async () => ({})));
    const ctx = new _NodeContextImpl({
      engine,
      state: {},
      graph_path: [],
      round_id: null,
      trace_id: 'trace-sim',
      thread_id: 't-sim',
    });
    // 换选目标 = 分支 1（失败分支）：fan_out 任务列表只有一个任务（位置 0），
    // 失败归约必须报告真实分支序号 #1（旧实现错取 specs[0].index → #0）
    engine.options.branch_pick = 1;
    try {
      const promise = engine.run_simulated(specs, ctx, { concurrency: 2 });
      await expect(promise).rejects.toThrow(SimulationError);
      await expect(engine.run_simulated(specs, ctx, { concurrency: 2 })).rejects.toThrow('#1');
    } finally {
      engine.options.branch_pick = null;
    }
  });
});
