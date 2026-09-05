/**
 * 引擎计划推进/工作步执行面（executor.py Engine 的 _plan_advance、
 * _eval_condition、_execute_plan_work_step、_run_plan_spawns 段移植）。
 *
 * 计划游标推进循环语义（skip 型步骤内联消耗，直至产出可执行节点或计划
 * 耗尽）：
 * - 条件门：按条件名求值（注册表解析），不满足 = 跳过该步；
 * - 顺序节点步：产出节点名（主循环执行，每节点 checkpoint 粒度）；
 * - 并行组/spawn 步：本方法内执行（隔离状态并发/实例展开），结果合并后
 *   写入 checkpoint（计划快照 index 推进）——恢复不重跑有副作用的步骤；
 * - 计划耗尽：返回 plan=null（主循环转条件边/出口定位）。
 *
 * 计划步内的终止/中断（并行组成员 terminate、spawn 实例 interrupt）以控制流
 * 信号返回（不落 checkpoint——终态快照由主循环统一写入）。
 */
import { InterruptSignal } from '../interrupt/interrupt_types.js';
import { TerminateReason } from '../graph/graph_types.js';
import { KIND_NODES, KIND_PARALLEL, KIND_SPAWNS, PLAN_KEY, Plan } from '../plan/plan.js';
import type { PlanStep } from '../plan/plan.js';
import { GraphDefinitionError } from '../errors.js';
import { SPAWN_KEY, collect_spawn_specs, type SpawnSpec } from '../spawn/spawn.js';
import type { Graph } from '../graph/graph.js';
import type { StateSchema } from '../state/schema.js';
import type { Storage } from '../storage/storage.js';
import type { JsonRecord } from '../json.js';
import type { NodeContext } from './_internals.js';
import { _NodeContextImpl } from './_node_context.js';
import { _PlanAdvance, _PlanWorkOutcome, _interrupt_state, _merge_overlay, _warn } from './_internals.js';
import { EngineParallel } from './_engine_parallel.js';

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/** 计划游标 +1 的不可变副本（Python ``dataclasses.replace(plan, index=..)``）。 */
function _advance_plan_index(plan: Plan): Plan {
  return new Plan({ steps: plan.steps, index: plan.index + 1 });
}

/** 计划推进/工作步分层段（Engine 方法群）。 */
export abstract class EnginePlan extends EngineParallel {
  /**
   * 计划游标推进：取下一执行节点 / 执行无节点形态的计划步。
   *
   * 循环语义见文件头注；计划步完成标记（ENG2-13）：工作步（并行/spawn）
   * 完成的 checkpoint 其 node 字段是计划产出节点，实际执行的是计划步本身
   * ——plan 快照附加 ``plan_step`` 标记，审计/消费方可区分「节点步
   * checkpoint」与「计划工作步 checkpoint」（恢复重入只认 ``work_step``
   * 中断标记，不受影响）。
   */
  async _plan_advance(opts: {
    plan: Plan;
    ctx: NodeContext;
    graph: Graph;
    schema: StateSchema | null;
    state: Record<string, unknown>;
    storage: Storage | null;
    thread_id: string;
    chain_thread: string;
    parent_id: number | null;
    fork_write: boolean;
  }): Promise<_PlanAdvance> {
    let { plan, state, parent_id, fork_write } = opts;
    for (;;) {
      if (plan.index >= plan.steps.length) {
        return new _PlanAdvance({ state, parent_id, fork_write });
      }
      const step = plan.steps[plan.index] as PlanStep;
      const nxt_plan = _advance_plan_index(plan);
      if (step.condition !== null && !(await this._eval_condition(step.condition, opts.ctx))) {
        plan = nxt_plan;
        continue;
      }
      if (step.kind === KIND_NODES) {
        return new _PlanAdvance({
          node: step.nodes[0] as string,
          plan: nxt_plan,
          state,
          parent_id,
          fork_write,
        });
      }
      const outcome = await this._execute_plan_work_step(step, opts.ctx, state, opts.graph, opts.schema);
      if (outcome.interrupt !== null) {
        return new _PlanAdvance({ interrupt: outcome.interrupt, state, parent_id, fork_write });
      }
      if (outcome.terminate !== null) {
        // 终止成员/已完成成员的 overlay 先并入状态（与单节点 terminate 同
        // 语义：增量随终态快照保留，不因组级终止丢弃）
        if (Object.keys(outcome.overlay).length > 0) {
          state = _merge_overlay(opts.schema, state, outcome.overlay);
        }
        return new _PlanAdvance({ reason: outcome.terminate, error: outcome.error, state, parent_id, fork_write });
      }
      if (outcome.error !== null) {
        // 计划步失败（并行组成员失败/清单非法）→ 整轮按错误终止
        return new _PlanAdvance({
          reason: TerminateReason.ERROR,
          error: outcome.error,
          state,
          parent_id,
          fork_write,
        });
      }
      if (Object.keys(outcome.overlay).length > 0) {
        state = _merge_overlay(opts.schema, state, outcome.overlay);
      }
      (opts.ctx as _NodeContextImpl)._state = state;
      plan = nxt_plan;
      if (opts.storage !== null) {
        const plan_snapshot: Record<string, unknown> = { ...plan.toDict(), plan_step: true };
        const [record, newForkWrite] = await this._write_checkpoint({
          storage: opts.storage,
          thread_id: opts.thread_id,
          chain_thread: opts.chain_thread,
          ctx: opts.ctx,
          node: opts.ctx.node ?? '',
          state,
          parent_id,
          fork_write,
          plan: plan_snapshot as JsonRecord,
        });
        parent_id = record.checkpoint_id;
        fork_write = newForkWrite;
      }
    }
  }

  /**
   * 计划条件门按名求值（经注册表解析；异常按不满足处理，不阻断执行）。
   *
   * 条件函数是业务判定（与条件边同语义）：失败视为不满足（跳过该计划步）
   * 并留痕——条件异常阻断整轮执行得不偿失，跳步是安全的降级（步骤本身会
   * 在后续规划中重估）。
   */
  async _eval_condition(name: string, ctx: NodeContext): Promise<boolean> {
    const registries = this.options.registries;
    if (registries === null) {
      throw new GraphDefinitionError(`条件未注册（无注册表可解析）: ${name}`);
    }
    try {
      const condition = registries.edges.create(name);
      const result = condition(ctx);
      const outcome = isPromiseLike(result) ? await result : result;
      return Boolean(outcome);
    } catch (exc) {
      _warn(`计划条件求值失败（按不满足处理）[${name}]: ${String(exc)}`);
      return false;
    }
  }

  /**
   * 执行无节点形态的计划步（并行组/spawn 子任务），返回合并增量与控制流
   * 信号。顺序节点步不经过本方法（主循环逐节点执行，保留每节点 checkpoint
   * 粒度）；此处两种形态都内联消耗。
   */
  async _execute_plan_work_step(
    step: PlanStep,
    ctx: NodeContext,
    state: Record<string, unknown>,
    graph: Graph,
    schema: StateSchema | null,
  ): Promise<_PlanWorkOutcome> {
    if (step.kind === KIND_PARALLEL) {
      return await this._run_parallel_group(step.nodes, ctx, state, graph);
    }
    if (step.kind === KIND_SPAWNS) {
      return await this._run_plan_spawns(step.spawns, ctx);
    }
    throw new Error(`未知计划步骤类型: ${step.kind}`);
  }

  /**
   * 计划 spawn 步：子任务清单实例展开（与 __spawn__ 共用展开执行器）。
   *
   * 清单项经 _resolve_graph_data 解析（Graph 直通/图定义数据重建）；失败
   * 实例剔除不阻断计划流（与节点 spawn 同语义，留痕可见）。
   */
  async _run_plan_spawns(items: readonly Record<string, unknown>[], ctx: NodeContext): Promise<_PlanWorkOutcome> {
    const outcome = new _PlanWorkOutcome();
    const overlay_payload: Record<string, unknown> = {
      [SPAWN_KEY]: items.map((item) => ({ ...item })),
    };
    let specs: SpawnSpec[];
    try {
      specs = collect_spawn_specs(overlay_payload, [], { resolve_graph: this._resolve_graph_data });
    } catch (exc) {
      _warn(`计划 spawn 清单非法: ${String(exc)}`);
      await ctx.emit('error', { node: ctx.node, message: `spawn 清单非法: ${String(exc)}` });
      outcome.error = `spawn 清单非法: ${String(exc)}`;
      return outcome;
    }
    if (specs.length > this.options.max_spawns) {
      // 成本护栏：与主路径 __spawn__ 同语义（max_spawns 上限防清单爆炸）
      const message = `计划 spawn 清单超限: ${specs.length} > ${this.options.max_spawns}`;
      _warn(`计划 spawn 清单超限 [${ctx.node}]: ${message}`);
      await ctx.emit('error', { node: ctx.node, message });
      outcome.error = message;
      return outcome;
    }
    let spawn_result;
    try {
      spawn_result = await this.run_spawned(specs, ctx, {
        concurrency: this.options.spawn_concurrency,
      });
    } catch (exc) {
      if (exc instanceof InterruptSignal) {
        outcome.interrupt = _interrupt_state(exc, ctx.node, ctx.graph_path);
        return outcome;
      }
      throw exc;
    }
    if (spawn_result.failures.length > 0) {
      for (const failure of spawn_result.failures) {
        _warn(`计划 spawn 实例失败（剔除，计划继续）index=${failure.index}: ${failure.error}`);
      }
      if (this.options.error_on_exception) {
        // 与并行组同语义：error_on_exception=True = 计划步失败即中止计划
        // （不合并部分成功污染计划流）；False = 剔除失败项继续
        outcome.error =
          `计划 spawn 实例失败 ${spawn_result.failures.length} 个: ` +
          spawn_result.failures.map((f) => `#${f.index}`).join(', ');
        await ctx.emit('error', { node: ctx.node, message: outcome.error });
        return outcome;
      }
      await ctx.emit('error', {
        node: ctx.node,
        message:
          `spawn 实例失败 ${spawn_result.failures.length} 个（已剔除，计划继续）: ` +
          spawn_result.failures.map((f) => `#${f.index}`).join(', '),
      });
    }
    outcome.overlay = spawn_result.overlay;
    return outcome;
  }
}
