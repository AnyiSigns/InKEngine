/**
 * 引擎多径展开调度面（executor.py Engine._run_multipath 及其降级路径移植，
 * ENG2-1/2/3 接线）。
 *
 * 数据形态（编排节点产出）：``{request, candidates, entry_state,
 * signal, k?, quality_gate?, synth_provider?}``——request/candidates 为进程
 * 内对象（与 ``__spawn__`` 经 ``ctx._spawns`` 携带 Graph 对象同构，不落
 * 状态/checkpoint）。
 *
 * 机制开关读引擎选项（RunOptions.multipath_enabled，默认 false = 关闭 =
 * 零触发）。开关关闭但清单存在（编排节点与运行期不同步）时按防御性单径
 * 降级：执行首候选，候选不静默丢弃——支流执行经 MultipathRunnerBase.
 * _execute_branches 真接线（独立实例引擎 + 子链 checkpoint + 事件并轨）。
 * 注入透传（ENG2-12）：回合级注入快照由支流侧按分支隔离消费。
 */
import type { QualityGate } from '../../model/contracts/contracts.js';
import type { JunctionSynthProvider } from '../multipath/verdict.js';
import { MultiPathConfig, MultipathRunner } from '../multipath/index.js';
import type { AssemblyCandidate, AssemblyRequest } from '../multipath/types.js';
import type { NodeContext } from './_internals.js';
import type { _NodeContextImpl } from './_node_context.js';
import { EnginePlan } from './_engine_plan.js';

/** 多径展开数据形态（编排节点产出，进程内对象）。 */
export interface MultipathData extends Record<string, unknown> {
  request: unknown;
  candidates?: readonly unknown[] | null;
  entry_state?: Record<string, unknown> | null;
  k?: unknown;
  quality_gate?: unknown;
  synth_provider?: unknown;
}

/** 多径展开分层段（Engine 方法群）。 */
export abstract class EngineMultipath extends EnginePlan {
  /**
   * 多径展开调度（ENG2-1/2/3 接线）：候选集 → MultipathRunner 执行。
   *
   * 引擎开关（RunOptions.multipath_enabled）默认关闭 = 机制不触发；关闭但
   * 清单存在（编排节点与运行期不同步）→ 防御性单径降级（执行首候选，不
   * 静默丢弃）。开启后经 MultipathRunner 执行候选（k≥2 支流并行 + 汇流
   * 裁决），支流为独立实例引擎展开。
   */
  async _run_multipath(data: MultipathData, ctx: NodeContext): Promise<unknown> {
    if (!this.options.multipath_enabled) {
      // 防御性降级：引擎开关关闭但清单存在（编排节点与运行期不同步）——
      // 按单径执行首候选，不静默丢弃候选
      return await this._run_multipath_degraded_single(data, ctx);
    }
    const runner = new MultipathRunner(this, {
      config: new MultiPathConfig({ enabled: true }),
    });
    const request = data['request'] as AssemblyRequest;
    const candidates = [...((data['candidates'] ?? []) as readonly AssemblyCandidate[])];
    const entry_state = { ...((data['entry_state'] as Record<string, unknown> | null) ?? {}) };
    if (candidates.length === 0) {
      throw new Error('多径展开清单缺候选（编排节点产出非法）');
    }
    // 注入透传（ENG2-12）：回合级注入快照由支流侧按分支隔离消费
    const pendingInject: Record<string, unknown> = {};
    for (const [key, value] of this._coordinator.pending_inject) {
      pendingInject[key] = value;
    }
    return await runner.run(request, candidates, {
      entry_state,
      thread_id: ctx.thread_id,
      round_id: ctx.round_id,
      trace_id: ctx.trace_id,
      k: (data['k'] as number | null | undefined) ?? null,
      quality_gate: data['quality_gate'] as QualityGate | null | undefined,
      synth_provider: data['synth_provider'] as JunctionSynthProvider | null | undefined,
      inject: Object.keys(pendingInject).length > 0 ? pendingInject : null,
      transports: (ctx as _NodeContextImpl)._transports,
    });
  }

  /** 降级单径执行：不触发多径机制，仅执行首候选并回收增量。 */
  async _run_multipath_degraded_single(data: MultipathData, ctx: NodeContext): Promise<unknown> {
    const runner = new MultipathRunner(this, {
      config: new MultiPathConfig({ enabled: true }),
    });
    const request = data['request'] as AssemblyRequest;
    const candidates = [...((data['candidates'] ?? []) as readonly AssemblyCandidate[])];
    return await runner.run(
      request,
      candidates.slice(0, 1),
      {
        entry_state: { ...((data['entry_state'] as Record<string, unknown> | null) ?? {}) },
        thread_id: ctx.thread_id,
        round_id: ctx.round_id,
        trace_id: ctx.trace_id,
        k: 1,
        concurrency: 1,
        transports: (ctx as _NodeContextImpl)._transports,
      },
    );
  }
}
