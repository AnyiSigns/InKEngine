/**
 * 引擎多径展开调度面（executor.py Engine._run_multipath 及其降级路径移植，
 * ENG2-1/2/3 接线）。
 *
 * 数据形态（组装编排节点产出）：``{request, candidates, entry_state,
 * signal, k?, quality_gate?, synth_provider?}``——request/candidates 为进程
 * 内对象（与 ``__spawn__`` 经 ``ctx._spawns`` 携带 Graph 对象同构，不落
 * 状态/checkpoint）。
 *
 * 机制开关读装配运行期（get_default_assembly_runtime 挂载的多径位；未挂载
 * = 关闭 = 零触发）。证据存储/审计回调同源取自运行期；无运行期时按单径
 * 降级执行首候选（候选不静默丢弃）。
 *
 * 注入透传（ENG2-12）：回合级注入值已在 run/ainvoke 入口进父 coordinator
 * ——支流与父图同一通道，但同 review_key 的注入值被首条命中支流 consume
 * 后其余支流会抛 InterruptError；把父 coordinator 的待消费注入快照传给支流
 * 执行器，由支流侧按分支隔离（每条支流各持副本消费）。
 *
 * 马尔可夫路径缓存回馈：多径实际执行结果回灌指纹缓存（命中成功 → 计数
 * +1；命中失败 → 条目失效，下次重组装）。观测不阻断：回馈失败只记日志。
 */
import { MultiPathConfig, MultipathRunner } from '../multipath/index.js';
import { get_default_assembly_runtime } from '../path_assembler/module_runtime.js';
import type { NodeContext } from './_internals.js';
import { EnginePlan } from './_engine_plan.js';
import { _warn } from './_internals.js';

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
   * 防御性降级：开关关闭但清单存在（编排节点与运行期不同步）——按单径
   * 执行首候选，不静默丢弃候选。
   */
  async _run_multipath(data: MultipathData, ctx: NodeContext): Promise<unknown> {
    const runtime = get_default_assembly_runtime();
    if (runtime === null || !runtime.multipath_enabled) {
      // 防御性降级：开关关闭但清单存在（编排节点与运行期不同步）——
      // 按单径执行首候选，不静默丢弃候选
      return await this._run_multipath_degraded_single(data, ctx);
    }
    const runner = new MultipathRunner(this, {
      evidence_store: runtime.evidence_store,
      config: new MultiPathConfig({ enabled: true }),
      sink: runtime.sink,
    });
    const request = data['request'];
    const candidates = [...(data['candidates'] ?? [])];
    const entry_state = { ...((data['entry_state'] as Record<string, unknown> | null) ?? {}) };
    if (candidates.length === 0) {
      throw new Error('多径展开清单缺候选（编排节点产出非法）');
    }
    // 注入透传（ENG2-12）：回合级注入快照由支流侧按分支隔离消费
    const pendingInject: Record<string, unknown> = {};
    for (const [key, value] of this._coordinator.pending_inject) {
      pendingInject[key] = value;
    }
    const result = await runner.run(
      request as never,
      candidates as never,
      {
        entry_state,
        thread_id: ctx.thread_id,
        round_id: ctx.round_id,
        trace_id: ctx.trace_id,
        k: (data['k'] as number | null) ?? null,
        quality_gate: data['quality_gate'] as never,
        synth_provider: data['synth_provider'] as never,
        inject: Object.keys(pendingInject).length > 0 ? pendingInject : null,
      },
    );
    // 马尔可夫路径缓存回馈：多径实际执行结果回灌指纹缓存（命中成功 →
    // 计数 +1；命中失败 → 条目失效，下次重组装）。观测不阻断。
    const report = runtime.report_cache_execution;
    if (report !== null && (result as { triggered?: boolean }).triggered === true) {
      try {
        await report(request as never, { ok: (result as { winner?: unknown }).winner !== null && (result as { winner?: unknown }).winner !== undefined });
      } catch (exc) {
        _warn(`路径缓存执行回馈失败（忽略）: ${String(exc)}`);
      }
    }
    return result;
  }

  /** 降级单径执行：不触发多径机制，仅执行首候选并回收增量。 */
  async _run_multipath_degraded_single(data: MultipathData, ctx: NodeContext): Promise<unknown> {
    const runner = new MultipathRunner(this, {
      evidence_store: null,
      config: new MultiPathConfig({ enabled: true }),
    });
    const request = data['request'];
    const candidates = [...((data['candidates'] ?? []) as unknown[])];
    return await runner.run(
      request as never,
      candidates.slice(0, 1) as never,
      {
        entry_state: { ...((data['entry_state'] as Record<string, unknown> | null) ?? {}) },
        thread_id: ctx.thread_id,
        round_id: ctx.round_id,
        trace_id: ctx.trace_id,
        k: 1,
        concurrency: 1,
      },
    );
  }
}
