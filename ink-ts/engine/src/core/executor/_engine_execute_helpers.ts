/**
 * 引擎主循环子过程面（executor.py Engine 的节点重试执行与 VTM 验证门控段移植）。
 *
 * - ``_run_node_attempts``：节点执行（重试 N 次 / 终止；兼容同步/异步节点
 *   函数），并把 VTM 验证器门控接入节点产出收口——节点返回值携带
 *   ``__verify__`` 保留键声明评审规格时才触发（缺省不评审，既有图零行为
 *   变化）。流程：评审 → pass 放行；fail 把违规清单写入
 *   ``state["__verify_feedback__"]`` 后重做节点（节点读反馈做定向修复），
 *   重做上限 ``verify_retry_limit``；重做耗尽仍 fail 抛
 *   ``OutputVerificationError``（消息带违规 → 演化 pitfall 定向教训）。
 *
 * 错误路径与 Python 一致：
 * - InterruptSignal（控制流）→ 挂起态（负载剥离敏感键后随结果直返宿主）；
 * - OutputVerificationError → 节点失败收口（不占 max_node_retries 盲重试
 *   槽位），error 事件消息带违规清单；
 * - 通用异常 → 重试到 max_node_retries 后按 error_on_exception 终止或跳过；
 *   事件/checkpoint 只落脱敏消息，细节进日志（trace_id 关联）。
 */
import { InterruptSignal, InterruptState } from '../interrupt/interrupt_types.js';
import { TerminateReason } from '../graph/graph_types.js';
import type { NodeExecutionError } from '../errors.js';
import { strip_sensitive } from '../security/security.js';
import { current_node_context } from '../llm/guard.js';
import { VERIFY_FEEDBACK_KEY, VERIFY_KEY, OutputVerificationError } from '../verifier/verifier.js';
import type { OutputVerifier } from '../verifier/verifier.js';
import type { Graph } from '../graph/graph.js';
import type { JsonRecord } from '../json.js';
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
  /** 节点失败消息（VTM 终败路径；错误收口用）。 */
  node_error: string | null;
  /** 节点内中断（挂起态；主循环提升为父图挂起卡）。 */
  interrupt: InterruptState | null;
  /** 终止原因（VTM/通用异常按 error_on_exception 终止时）。 */
  reason: string | null;
  /** 错误消息（reason=error 时）。 */
  error_msg: string | null;
}

/**
 * 主循环子过程分层段（Engine 方法群；被 _execute 主循环调用）。
 */
export abstract class EngineExecuteHelpers extends EngineMultipath {
  /**
   * VTM 验证器门控：产出评审 + 违规驱动重做（有界）。
   *
   * 节点返回值携带 ``__verify__`` 保留键声明评审规格时才触发（缺省不评审，
   * 既有图零行为变化）。流程：评审 → pass 放行；fail 把违规清单写入
   * ``state["__verify_feedback__"]`` 后重做节点（节点读反馈做定向修复），
   * 重做上限 ``verify_retry_limit``；重做耗尽仍 fail 抛
   * ``OutputVerificationError``（消息带违规 → 演化 pitfall 定向教训）。
   */
  async _verify_node_output(
    ctx: _NodeContextImpl,
    node: string,
    fn: (c: unknown) => unknown,
    overlay: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const spec = (overlay[VERIFY_KEY] as Record<string, unknown> | null) ?? null;
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      return overlay;
    }
    const verifier = this.options.output_verifier as OutputVerifier | null;
    if (verifier === null) return overlay;
    const limit = this.options.verify_retry_limit;
    for (let attempt = 0; attempt <= limit; attempt++) {
      const verdict = await verifier.verify(ctx, {
        node,
        output: overlay as JsonRecord,
        spec: spec as JsonRecord,
      });
      const passed = Boolean(verdict.pass);
      const violations: string[] = (verdict.violations ?? []).map((v) => String(v));
      await ctx.emit('output_verdict', {
        node,
        pass: passed,
        attempt,
        violations,
      });
      if (passed) {
        delete overlay[VERIFY_KEY];
        delete ctx.state[VERIFY_FEEDBACK_KEY];
        return overlay;
      }
      if (attempt >= limit) {
        delete ctx.state[VERIFY_FEEDBACK_KEY];
        const detail = violations.join('；') || '产出不满足硬性要求';
        const entityId = (spec['entity_id'] as string | null | undefined) ?? null;
        throw new OutputVerificationError(`节点产出未通过验证: ${node}（${detail}）`, entityId);
      }
      // 违规驱动重做：反馈写 state，节点重跑（定向修复）
      ctx.state[VERIFY_FEEDBACK_KEY] = violations;
      ctx._spawns.length = 0;
      ctx._terminated = null;
      const rerun = fn(ctx);
      const rerunResult = isPromiseLike(rerun) ? await rerun : rerun;
      overlay = rerunResult !== null && typeof rerunResult === 'object' && !Array.isArray(rerunResult)
        ? (rerunResult as Record<string, unknown>)
        : {};
    }
    return overlay;
  }

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
        // VTM 验证器门控：节点声明 __verify__ 且挂了 output_verifier → 产出
        // 评审 + 违规驱动重做（有界）；终败抛 OutputVerificationError 由
        // 下方分支按节点失败收口
        if (
          this.options.output_verifier !== null &&
          result !== null &&
          typeof result === 'object' &&
          !Array.isArray(result)
        ) {
          overlay = await this._verify_node_output(ctx, current, fn, result as Record<string, unknown>);
        }
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
        if (exc instanceof OutputVerificationError) {
          // VTM 终败：违规驱动重做已在门控内耗尽（不占 max_node_retries 盲
          // 重试槽位）。error 事件消息带违规清单 → 演化管线自动归为 pitfall
          // 教训（定向变异）；entity_id 归因到实体。
          node_error = exc.message;
          _warn(`节点产出未通过验证 [${current}]: ${exc.message}`);
          await ctx.emit('error', {
            node: current,
            message: node_error,
            context: { entity_id: exc.entity_id },
          });
          if (this.options.error_on_exception) {
            error_msg = node_error;
            reason = TerminateReason.ERROR;
          } else {
            _warn(`节点产出未通过验证跳过（error_on_exception=False）[${current}]: ${exc.message}`);
          }
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
