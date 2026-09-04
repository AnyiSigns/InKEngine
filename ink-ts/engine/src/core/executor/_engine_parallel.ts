/**
 * 引擎并行节点组分段（executor.py Engine._run_parallel_group 移植）。
 *
 * 并行节点组：隔离状态并发执行同图节点，结果按声明序合并。
 * 并发安全要点：
 * - 每个成员持有状态快照（dict 拷贝——节点只返回增量不就地改状态，快照
 *   即隔离；事件/checkpoint 共享父引擎与父线程，seq 由引擎锁串行化）；
 * - 成员内 spawn 收集经同一展开路径执行（实例并发上限按 spawn 配置）；
 * - 失败语义与节点一致：error_on_exception=True = 整组失败（不合并任何
 *   成员结果，防部分成功污染计划流）；False = 失败成员剔除，成功成员按
 *   声明序合并；
 * - 中断/终止（成员内 interrupt/terminate）以控制流信号返回。
 *
 * TS 调度说明：Python 以 asyncio FIRST_COMPLETED + task.cancel 做「首信号
 * 取消兄弟」；JS 无任务取消原语——本实现以并发池调度 + 信号出现后不再
 * 启动/等待兄弟成员（已启动且忽略信号的成员后台跑完即弃，结果不并入）。
 */
import { InterruptSignal, InterruptState } from '../interrupt/interrupt_types.js';
import { BudgetExceededError } from '../budget/budget.js';
import { TerminateReason } from '../graph/graph_types.js';
import { strip_sensitive } from '../security/security.js';
import { current_node_context } from '../llm/guard.js';
import { PLAN_KEY, PlanStep } from '../plan/plan.js';
import { SIMULATE_KEY } from '../simulation/simulation.js';
import { SPAWN_KEY, collect_spawn_specs } from '../spawn/spawn.js';
import type { Graph } from '../graph/graph.js';
import { TRACE_SUCCESS, TRACE_FAILED, TRACE_SKIPPED } from '../settle/index.js';
import type { NodeContext } from './_internals.js';
import { _NodeContextImpl } from './_node_context.js';
import { _PlanWorkOutcome, _warn } from './_internals.js';
import { EngineSimulate } from './_engine_simulate.js';

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/** 并行组执行分层段（Engine 方法群）。 */
export abstract class EngineParallel extends EngineSimulate {
  /**
   * 并行节点组：隔离状态并发执行同图节点，结果按声明序合并。
   *
   * @returns _PlanWorkOutcome：无信号 = 本步完成（overlay 可并入状态）；
   *   interrupt/terminate = 首信号控制流；error = 整组失败。
   */
  async _run_parallel_group(
    names: readonly string[],
    ctx: NodeContext,
    state: Record<string, unknown>,
    graph: Graph,
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
        thread_id: (ctx as _NodeContextImpl).thread_id,
        transports: (ctx as _NodeContextImpl)._transports,
        resume_map: (ctx as _NodeContextImpl).resume_map,
      });
      member_ctx.node = name;
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
      // 输入调配预装配（与主循环同口径：节点执行前统一走调配管线，并行
      // 执行面同样留痕可审计）
      await member_ctx.preassemble();
      for (let attempt = 0; attempt <= self.options.max_node_retries; attempt++) {
        member_ctx._spawns.length = 0;
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
          // 成员内命令式/数据驱动 spawn：同路径展开（结果并入成员增量）
          if (
            member_ctx._spawns.length > 0 ||
            (result !== null && SPAWN_KEY in (result as Record<string, unknown>))
          ) {
            const specs = collect_spawn_specs(result as Record<string, unknown> | null, member_ctx._spawns, {
              resolve_graph: self._resolve_graph_data,
            });
            const spawn_result = await self.run_spawned(specs, member_ctx, {
              concurrency: self.options.spawn_concurrency,
            });
            for (const failure of spawn_result.failures) {
              _warn(`并行组成员 spawn 实例失败（剔除）[${name}] index=${failure.index}: ${failure.error}`);
            }
            if (Object.keys(spawn_result.overlay).length > 0) {
              result = { ...(result ?? {}), ...spawn_result.overlay };
            }
          }
          if (result !== null && SIMULATE_KEY in (result as Record<string, unknown>)) {
            // 推演仅主循环支持：并行组成员返回 __simulate__ 是图设计错误
            // （决策点不应藏在并行组内），显式拒绝——保留键泄漏进状态会
            // 造成静默丢失
            throw new Error('并行组成员不支持 __simulate__（决策点推演仅主循环执行）');
          }
          if (result !== null && PLAN_KEY in (result as Record<string, unknown>)) {
            // 重规划仅主循环支持：并行组成员返回 __plan__ 与并行组声明序合并
            // 语义冲突，保留键弹出不落状态
            delete (result as Record<string, unknown>)[PLAN_KEY];
            _warn(`并行组成员 ${name} 返回的 __plan__ 已忽略（重规划仅主循环执行）`);
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
            outcome.interrupt = new InterruptState(
              exc.key,
              strip_sensitive(exc.payload) as Record<string, unknown>,
              name,
              ctx.graph_path,
            );
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
    };

    // 并发池调度：信号出现后不再启动/等待兄弟成员（等价 Python 首信号取消）
    let cursor = 0;
    const active = new Set<Promise<void>>();
    const settleWaiters: Array<() => void> = [];
    // 信号即达：任何成员落定 interrupt/terminate 控制流信号时立即唤醒主调度
    // （不等其余兄弟成员 settle——Python 首信号取消的等价语义）
    let fireSignal: (() => void) | null = null;
    const signalReady = (): Promise<void> =>
      new Promise<void>((resolve) => {
        fireSignal = resolve;
      });
    const signal = (): void => {
      if (fireSignal !== null) {
        fireSignal();
        fireSignal = null;
      }
    };
    const pump = (): void => {
      while (active.size < limit && cursor < names.length) {
        const name = names[cursor] as string;
        cursor += 1;
        const p = Promise.resolve().then(() => run_member(name));
        active.add(p);
        void p.finally(() => {
          active.delete(p);
          for (const waiter of settleWaiters.splice(0)) waiter();
        });
      }
    };
    // 主调度：首信号或全部成员完成即收口（signal 已落定时不再等兄弟）
    pump();
    for (;;) {
      if (active.size === 0) break;
      if (outcome.interrupt !== null || outcome.terminate !== null) break;
      const waiter = new Promise<void>((resolve) => settleWaiters.push(resolve));
      await Promise.race([signalReady(), waiter]);
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

export type { PlanStep };
