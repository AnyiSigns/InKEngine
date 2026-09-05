/**
 * 引擎主循环子过程面（executor.py Engine 的节点重试执行段移植）。
 *
 * - ``_run_node_attempts``：节点执行（重试 N 次 / 终止；兼容同步/异步节点
 *   函数），每次尝试复位收集器与终止标记。
 *
 * 错误路径与 Python 一致：
 * - InterruptSignal（控制流）→ 挂起态（负载剥离敏感键后随结果直返宿主）；
 * - 通用异常 → 重试到 max_node_retries 后按 error_on_exception 终止或跳过；
 *   事件/checkpoint 只落脱敏消息，细节进日志（trace_id 关联）。
 */
import { InterruptSignal, InterruptState } from '../interrupt/interrupt_types.js';
import { TerminateReason } from '../graph/graph_types.js';
import { strip_sensitive } from '../security/security.js';
import { current_node_context } from '../llm/guard.js';
import type { Graph } from '../graph/graph.js';
import type { _NodeContextImpl } from './_node_context.js';
import { EngineMultipath } from './_engine_multipath.js';
import { _warn } from './_internals.js';

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/** 节点重试执行结果（主循环据此分支：中断挂起/错误终止/正常 overlay）。 */
export interface NodeAttemptOutcome {
  /** 节点返回增量（原始形态；非法类型由主循环收口）。 */
  overlay: unknown;
  /** 节点失败消息（错误收口用）。 */
  node_error: string | null;
  /** 节点内中断（挂起态；主循环提升为父图挂起卡）。 */
  interrupt: InterruptState | null;
  /** 终止原因（通用异常按 error_on_exception 终止时）。 */
  reason: string | null;
  /** 错误消息（reason=error 时）。 */
  error_msg: string | null;
}

/**
 * 主循环子过程分层段（Engine 方法群；被 _execute 主循环调用）。
 */
export abstract class EngineExecuteHelpers extends EngineMultipath {
  /**
   * 执行节点（重试 N 次 / 终止；兼容同步/异步节点函数）。
   *
   * 每次尝试复位收集器与终止标记：失败尝试的残留清单不得在重试成功后一并
   * 展开（序号冲突/重复执行），终止信号同理。当前节点上下文注入（用量闭环
   * 接线）：节点执行期间 current_node_context 指向本节点——LLM 链守卫包装
   * 据此把 usage 帧记入本节点成本账并发射 llm_usage 指标事件。
   */
  async _run_node_attempts(opts: {
    ctx: _NodeContextImpl;
    graph: Graph;
    current: string;
    on_first_execution?: (() => Promise<void>) | null;
  }): Promise<NodeAttemptOutcome> {
    const { ctx, graph, current } = opts;
    let overlay: unknown = null;
    let node_error: string | null = null;
    let interrupt: InterruptState | null = null;
    let reason: string | null = null;
    let error_msg: string | null = null;
    for (let attempt = 0; attempt <= this.options.max_node_retries; attempt++) {
      // 每次尝试复位收集器与终止标记：失败尝试的残留清单不得在重试成功后
      // 一并展开（序号冲突/重复执行），终止信号同理
      ctx._spawns.length = 0;
      ctx._terminated = null;
      const node_token = current_node_context.set(ctx);
      try {
        if (opts.on_first_execution !== null && opts.on_first_execution !== undefined && attempt === 0) {
          await opts.on_first_execution();
        }
        const fn = graph.nodes[current];
        if (fn === undefined) {
          throw new Error(`节点未注册: ${current}`);
        }
        let result = fn(ctx);
        if (isPromiseLike(result)) result = await result;
        overlay = result;
        break;
      } catch (exc) {
        if (exc instanceof InterruptSignal) {
          // 安全：中断负载（审批卡内容）经 RunResult 直返宿主，与落库通道
          // 同口径剥离敏感键（凭据只存运行期内存态）
          interrupt = new InterruptState(
            exc.key,
            strip_sensitive(exc.payload) as Record<string, unknown>,
            current,
            ctx.graph_path,
          );
          reason = 'interrupted';
          break;
        }
        if (attempt < this.options.max_node_retries) {
          _warn(`节点重试 [${current}] 第 ${attempt + 1}/${this.options.max_node_retries} 次: ${String(exc)}`);
          continue;
        }
        // 事件/checkpoint 只落脱敏消息，细节进日志（trace_id 关联），不向
        // 消费方暴露内部堆栈/连接串
        node_error = `节点执行失败: ${current}`;
        _warn(`节点执行失败 [${current}]: ${String(exc)}`);
        await ctx.emit('error', { node: current, message: node_error });
        if (this.options.error_on_exception) {
          error_msg = node_error;
          reason = TerminateReason.ERROR;
        } else {
          // 跳过语义：节点异常忽略（无增量），图继续按边走
          _warn(`节点异常跳过（error_on_exception=False）[${current}]: ${String(exc)}`);
        }
        break;
      } finally {
        current_node_context.reset(node_token);
      }
    }
    return { overlay, node_error, interrupt, reason, error_msg };
  }
}
