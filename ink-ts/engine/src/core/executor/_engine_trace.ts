/**
 * 引擎结点级成败留痕/沉淀钩子面（executor.py Engine 的 trace_ 系列与
 * _settle_run 段移植）。
 *
 * 结点级成败留痕（沉淀钩子输入）：本 run 的执行轨迹与成本账，不发射事件
 * （观测侧零影响）。_execute 入口复位；嵌套引擎（子图/实例/分支）执行完经
 * 合并点并入父引擎。
 *
 * 轨迹步骤形态复用 settle.TraceStep（graph_path 编码 = settle/path_key，
 * (graph_path, node) token 账键 = settle/token_key——与 SettleContext 同源，
 * 沉淀回放取用同一把键）。
 */
import { SettleContext, TraceStep } from '../settle/index.js';
import { DEFAULT_DOMAIN } from '../settle/index.js';
import { path_key, token_key } from '../settle/types.js';
import { TRACE_SUCCESS, TRACE_FAILED, TRACE_SKIPPED } from '../settle/index.js';
import type { Graph } from '../graph/graph.js';
import type { RunResult } from '../run_result/run_result.js';
import { EngineEvents } from './_engine_events.js';
import { _error } from './_internals.js';
/** 可并入轨迹的嵌套引擎形态（子图/实例/分支引擎共有的留痕字段面）。 */
export interface _TraceCarrier {
  _run_trace: TraceStep[];
  _trace_graphs: Map<string, Graph>;
  _node_tokens: Map<string, number>;
}

/**
 * 轨迹/沉淀分层段（Engine 方法群）。
 */
export abstract class EngineTrace extends EngineEvents {
  /**
   * 复位本引擎的轨迹（_execute 入口调用；嵌套引擎各自独立）。
   */
  _trace_reset(graph: Graph, graph_path: readonly string[]): void {
    this._run_trace = [];
    this._node_tokens = new Map<string, number>();
    this._trace_graphs = new Map<string, Graph>();
    this._pending_step = null;
    this._trace_graphs.set(path_key(graph_path), graph);
  }

  /** 打开当前结点的步骤（成败在收尾前经标记定型）。 */
  _trace_open(graph_path: readonly string[], node: string): void {
    this._pending_step = new TraceStep({ graph_path, node, status: TRACE_SUCCESS });
  }

  /** 当前结点步骤标记失败（结点块内异常/清单非法路径调用）。 */
  _trace_mark_failed(): void {
    if (this._pending_step !== null) {
      this._pending_step.status = TRACE_FAILED;
    }
  }

  /** 当前结点步骤标记跳过（中断挂起路径调用）。 */
  _trace_mark_skipped(): void {
    if (this._pending_step !== null) {
      this._pending_step.status = TRACE_SKIPPED;
    }
  }

  /** 收尾当前结点的步骤（成本归集 + 入轨迹；无待收尾 = 空操作）。 */
  async _trace_close_pending(): Promise<void> {
    const step = this._pending_step;
    if (step === null) return;
    this._pending_step = null;
    step.tokens = this._node_tokens.get(token_key(step.graph_path, step.node)) ?? 0;
    await this._trace_lock.with_lock(async () => {
      this._run_trace.push(step);
    });
  }

  /** 结点执行边界 token 计账（usage 帧纯算法归集；不发射事件）。 */
  _trace_add_tokens(graph_path: readonly string[], node: string, tokens: number): void {
    const key = token_key(graph_path, node);
    this._node_tokens.set(key, (this._node_tokens.get(key) ?? 0) + tokens);
  }

  /** 并行组成员步骤直入轨迹（member 标记：不参与边遍历推导）。 */
  async _trace_append_member(graph_path: readonly string[], node: string, status: string): Promise<void> {
    const step = new TraceStep({
      graph_path,
      node,
      status,
      tokens: this._node_tokens.get(token_key(graph_path, node)) ?? 0,
      member: true,
    });
    await this._trace_lock.with_lock(async () => {
      this._run_trace.push(step);
    });
  }

  /** 并入嵌套引擎（子图/实例/分支）的轨迹、图映射与成本账。 */
  _trace_merge_from(sub_engine: _TraceCarrier): void {
    this._run_trace.push(...sub_engine._run_trace);
    for (const [key, graph] of sub_engine._trace_graphs) {
      this._trace_graphs.set(key, graph);
    }
    for (const [key, tokens] of sub_engine._node_tokens) {
      this._node_tokens.set(key, (this._node_tokens.get(key) ?? 0) + tokens);
    }
  }

  /**
   * 沉淀钩子触发（run 收尾、指标采集之后；注册式扩展）。
   *
   * 只记录不裁决：钩子异常在注册体内捕获记日志，不阻断 run 结果交付；
   * 未注入沉淀钩子（RunOptions.settle=null）= 关闭，零影响。
   */
  async _settle_run(result: RunResult, opts: { thread_id: string; round_id: string | null; trace_id: string }): Promise<void> {
    const hooks = this.options.settle;
    if (hooks === null) return;
    const ctx = new SettleContext({
      thread_id: opts.thread_id,
      round_id: opts.round_id,
      trace_id: opts.trace_id,
      domain: this.options.domain ?? DEFAULT_DOMAIN,
      steps: this._run_trace,
      node_tokens: this._node_tokens,
      graphs: this._trace_graphs,
      result,
    });
    // 钩子异常隔离：沉淀钩子失败只记日志，不阻断 RunResult 交付
    try {
      await hooks.run(ctx);
    } catch (exc) {
      _error(`沉淀钩子执行失败（忽略，不阻断 run 结果交付）: ${String(exc)}`);
    }
  }
}
