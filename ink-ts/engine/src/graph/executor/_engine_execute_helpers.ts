/**
 * 引擎主循环子过程面（executor.py Engine 的节点重试执行段移植）。
 *
 * - ``_run_node_attempts``：节点执行（重试 N 次 / 终止；兼容同步/异步节点
 *   函数），每次尝试复位收集器与终止标记。
 * - ``_run_parallel_group``：并行节点组批量执行（Promise.all 批跑——与
 *   展开段无关的批量执行段，S1 从 `_engine_parallel.ts` 折入保留）：隔离
 *   状态并发执行同图节点，结果按声明序合并。
 *
 * 错误路径与 Python 一致：
 * - InterruptSignal（控制流）→ 挂起态（负载剥离敏感键后随结果直返宿主）；
 * - 通用异常 → 重试到 max_node_retries 后按 error_on_exception 终止或跳过；
 *   事件/checkpoint 只落脱敏消息，细节进日志（trace_id 关联）。
 */
import { InterruptSignal } from '../../loop/interrupt/interrupt_types.js';
import { InterruptState } from '../../model/storage/interrupt_state.js';
import { TerminateReason } from '../../model/graph/graph_types.js';
import { BudgetExceededError } from '../../model/errors.js';
import { strip_sensitive } from '../../model/storage/sensitive.js';
import { current_node_context } from '../../loop/llm/guard.js';
import { TRACE_SUCCESS, TRACE_FAILED, TRACE_SKIPPED } from '../../loop/turn_settle/index.js';
import type { GraphLike } from '../exec_types.js';
import { _NodeContextImpl } from './_node_context.js';
import { EngineCheckpoint } from './_engine_checkpoint.js';
import { _interrupt_state, _PlanWorkOutcome, _warn } from './_internals.js';

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
export abstract class EngineExecuteHelpers extends EngineCheckpoint {
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
    graph: GraphLike;
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

  /**
   * 并行节点组：隔离状态并发执行同图节点，结果按声明序合并。
   *
   * 并发安全要点：
   * - 每个成员持有状态快照（dict 拷贝——节点只返回增量不就地改状态，快照
   *   即隔离；事件/checkpoint 共享父引擎与父线程，seq 由引擎锁串行化）；
   * - 失败语义与节点一致：error_on_exception=True = 整组失败（不合并任何
   *   成员结果，防部分成功污染调用方状态）；False = 失败成员剔除，成功成员
   *   按声明序合并；
   * - 中断/终止（成员内 interrupt/terminate）以控制流信号返回。
   *
   * TS 调度说明：Python 以 asyncio FIRST_COMPLETED + task.cancel 做「首信号
   * 取消兄弟」；JS 无任务取消原语——本实现以并发池调度：成员命中控制流信号
   * 即返回（结果不入 errors/overlay），兄弟成员（已启动且忽略信号的）后台跑完
   * 即弃、结果不并入。成员执行全量 try/catch：预算/节点/留痕任一异常都
   * 归一为成员失败或信号，promise 显式消费拒绝——无 unhandledRejection、无静默
   * 丢失败。
   *
   * @returns _PlanWorkOutcome：无信号 = 本步完成（overlay 可并入状态）；
   *   interrupt/terminate = 首信号控制流；error = 整组失败。
   */
  async _run_parallel_group(
    names: readonly string[],
    ctx: _NodeContextImpl,
    state: Record<string, unknown>,
    graph: GraphLike,
  ): Promise<_PlanWorkOutcome> {
    const outcome = new _PlanWorkOutcome();
    const results: Record<string, Record<string, unknown> | null> = {};
    const errors: Record<string, string> = {};
    const limit = Math.max(1, this.options.parallel_concurrency);
    const self = this;

    const run_member = async (name: string): Promise<void> => {
      const member_ctx = new _NodeContextImpl({
        engine: self,
        state: { ...state },
        graph_path: ctx.graph_path,
        round_id: ctx.round_id,
        trace_id: ctx.trace_id,
        thread_id: ctx.thread_id,
        transports: ctx._transports,
        resume_map: ctx.resume_map,
        scope_llm: ctx.scope_llm,
      });
      member_ctx.node = name;
      // 成员执行整体收敛（try/catch）：预算检查/节点执行/留痕任一异常都
      // 归一为成员失败或控制流信号——rejection 绝不逃出 run_member
      // （主调度显式消费，防 unhandledRejection 且成员失败静默丢失）
      try {
        if (self.options.budget !== null) {
          try {
            await self.options.budget.check(member_ctx);
          } catch (exc) {
            // 预算超限 = 整组终止信号（与主循环同语义），不复用错误通道
            outcome.terminate = TerminateReason.BUDGET_EXCEEDED;
            outcome.error = exc instanceof BudgetExceededError ? exc.message : `并行组预算检查失败: ${String(exc)}`;
            return;
          }
        }
        for (let attempt = 0; attempt <= self.options.max_node_retries; attempt++) {
          member_ctx._terminated = null;
          // 当前节点上下文注入（与主循环同口径）：并行成员执行期间 LLM 用量
          // 记入成员节点账 + llm_usage 指标事件
          const member_token = current_node_context.set(member_ctx);
          try {
            const fn = graph.nodes[name];
            if (fn === undefined) {
              throw new Error(`节点未注册: ${name}`);
            }
            let result = fn(member_ctx);
            if (isPromiseLike(result)) result = await result;
            if (result !== null && (typeof result !== 'object' || Array.isArray(result))) {
              throw new TypeError(
                `节点返回非法增量类型: ${result === null ? 'NoneType' : Array.isArray(result) ? 'list' : typeof result}`,
              );
            }
            results[name] = result as Record<string, unknown> | null;
            if (member_ctx.terminated) {
              outcome.terminate = member_ctx.terminate_reason ?? TerminateReason.REPLY;
            }
            // 成员步骤留痕（与主循环同口径；成败定型后直入轨迹）
            await self._trace_append_member(member_ctx.graph_path, name, TRACE_SUCCESS);
            return;
          } catch (exc) {
            if (exc instanceof InterruptSignal) {
              outcome.interrupt = _interrupt_state(exc, name, ctx.graph_path);
              await self._trace_append_member(member_ctx.graph_path, name, TRACE_SKIPPED);
              return;
            }
            if (attempt < self.options.max_node_retries) {
              continue;
            }
            errors[name] = `节点执行失败: ${name}`;
            _warn(`并行组成员执行失败 [${name}]: ${String(exc)}`);
            await self._trace_append_member(member_ctx.graph_path, name, TRACE_FAILED);
            return;
          } finally {
            current_node_context.reset(member_token);
          }
        }
      } catch (exc) {
        // 预装配/留痕等循环外异常的兜底收敛：与节点失败同语义（装配源异常 =
        // 成员不可执行），剔除留痕而非吞没或外溢成 rejection
        if (exc instanceof InterruptSignal) {
          outcome.interrupt = _interrupt_state(exc, name, ctx.graph_path);
          await self._trace_append_member(member_ctx.graph_path, name, TRACE_SKIPPED);
          return;
        }
        errors[name] = `节点执行失败: ${name}`;
        _warn(`并行组成员执行失败 [${name}]: ${String(exc)}`);
        await self._trace_append_member(member_ctx.graph_path, name, TRACE_FAILED);
        return;
      }
    };

    // 并发池调度：首控制流信号或全部成员完成即收口。无需独立信号唤醒机制
    // ——成员命中 interrupt/terminate 后立即返回并通知主调度（Python 首信号
    // 取消的等价语义：信号落定后不再等待/启动兄弟成员）。
    let cursor = 0;
    const active = new Set<Promise<void>>();
    const settleWaiters: Array<() => void> = [];
    const pump = (): void => {
      while (active.size < limit && cursor < names.length) {
        const name = names[cursor] as string;
        cursor += 1;
        const p = Promise.resolve().then(() => run_member(name));
        active.add(p);
        // 显式消费拒绝：run_member 已全量 try/catch（失败入 errors[]），此处
        // 为最后防线——promise 绝不静默拒绝成 unhandledRejection
        void p
          .then(
            () => undefined,
            (exc) => {
              errors[name] = `节点执行失败: ${name}`;
              _warn(`并行组成员未预期异常 [${name}]: ${String(exc)}`);
            },
          )
          .finally(() => {
            active.delete(p);
            for (const waiter of settleWaiters.splice(0)) waiter();
          });
      }
    };
    // 主调度：全部成员完成或首信号落定即收口（等兄弟完成——成员命中信号即
    // 返回，未命中兄弟后台跑完即弃、结果不并入）
    pump();
    for (;;) {
      if (active.size === 0) break;
      if (outcome.interrupt !== null || outcome.terminate !== null) break;
      const waiter = new Promise<void>((resolve) => settleWaiters.push(resolve));
      await waiter;
      pump();
    }
    if (outcome.interrupt !== null || outcome.terminate !== null) {
      if (outcome.terminate !== null) {
        // 终止成员的 overlay 随终态保留（与单节点 terminate 同语义：节点
        // 返回增量先并入状态再终止——已完成的兄弟成员同样并入，不因组级
        // 终止丢弃成员产出）
        for (const name of names) {
          const overlay = results[name];
          if (overlay !== null && overlay !== undefined && Object.keys(overlay).length > 0) {
            outcome.overlay = { ...outcome.overlay, ...overlay };
          }
        }
      }
      return outcome;
    }
    if (Object.keys(errors).length > 0) {
      if (self.options.error_on_exception) {
        outcome.error = `并行组失败 ${Object.keys(errors).length} 个成员: ${Object.values(errors).join(', ')}`;
        await ctx.emit('error', { node: ctx.node, message: outcome.error });
        return outcome;
      }
      _warn(`并行组成员失败（error_on_exception=False，剔除）: ${JSON.stringify(errors)}`);
    }
    const merged: Record<string, unknown> = {};
    for (const name of names) {
      const overlay = results[name];
      if (overlay !== null && overlay !== undefined && Object.keys(overlay).length > 0) {
        Object.assign(merged, overlay);
      }
    }
    outcome.overlay = merged;
    return outcome;
  }
}
