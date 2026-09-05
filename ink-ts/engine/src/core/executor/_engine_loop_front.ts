/**
 * 引擎主循环前半段（executor.py Engine._execute 的循环头至「节点终止信号」
 * 段移植）。
 *
 * 前半段职责：恢复首轮特殊处理（已完成节点跳过 / 计划恢复直达计划推进）、
 * 节点边界计数与回路/预算护栏、输入调配预装配、结点级成败留痕打开、节点
 * 执行（重试/VTM，见 _run_node_attempts）、增量类型防线、spawn/计划/推演/
 * 多径清单提取解析、增量合并与节点终止信号检查。
 *
 * 返回 'proceed' = 本迭代前半段完成且节点已执行（后半段继续：展开/
 * checkpoint/下一步定位）；'continue' = 前半段已直接推进到下一节点（跳过
 * 后半段，下一迭代从节点边界开始）；'break' = 任意终止出口命中
 * （reason/error_msg/interrupt 已在循环状态上落定）。
 */
import { TerminateReason } from '../graph/graph_types.js';
import { NodeExecutionError } from '../errors.js';
import { InterruptSignal } from '../interrupt/interrupt_types.js';
import { SPAWN_KEY, collect_spawn_specs } from '../spawn/spawn.js';
import { SIMULATE_KEY, parse_simulate } from '../simulation/simulation.js';
import { MULTIPATH_KEY } from '../multipath/index.js';
import { PLAN_KEY, Plan } from '../plan/plan.js';
import type { Graph } from '../graph/graph.js';
import { _locate_next, _merge_overlay, _now_epoch, _warn } from './_internals.js';
import { EngineExecuteHelpers } from './_engine_execute_helpers.js';
import type { LoopState } from './_loop_types.js';

/** 主循环前半段分层段（Engine 方法群）。 */
export abstract class EngineLoopFront extends EngineExecuteHelpers {
  /**
   * 单迭代前半段（循环头 → 节点终止信号检查；见文件头注）。
   */
  async _loop_front(ls: LoopState): Promise<'break' | 'proceed' | 'continue'> {
    const { ctx } = ls;
    const graph = this.graph;
    const schema = this.options.schema;
    const storage = this.options.storage;

    // ── 节点存在性防线（图校验/计划清单/恢复锚点都可能指向未注册节点）──
    if (!(ls.current in graph.nodes)) {
      throw new NodeExecutionError(ls.current, new Error(`节点未注册: ${ls.current}`));
    }
    ctx.node = ls.current;
    // 输入调配缓存按节点复位：预装配结果只对当前节点有效——跨节点复用会让
    // 后续节点拿到上一节点的陈旧上下文且无留痕
    ctx._assembled = null;
    // 上一结点步骤收尾（成败已在结点块内标记定型；成本此刻归集）
    await this._trace_close_pending();

    // ── 恢复终点：已完成节点无出边，直接进入终态收尾 ──
    if (ls.skip_first_node) {
      ls.skip_first_node = false;
      if (ls.active_plan === null) {
        // 终态快照沿用恢复锚点的已完成节点（不重跑已完成节点）
        if (ls.last_checkpoint !== null && ls.last_checkpoint.node) {
          ls.current = ls.last_checkpoint.node;
        }
        return 'break';
      }
      // 计划恢复：已完成节点不重跑，直接进入下一步定位（计划推进）
    }

    // ── 计划恢复首轮：跳过节点执行，直接推进计划游标 ──
    if (ls.plan_pending) {
      ls.plan_pending = false;
      const advance = await this._plan_advance({
        plan: ls.active_plan as Plan,
        ctx,
        graph,
        schema,
        state: ls.current_state,
        storage,
        thread_id: ls.thread_id,
        chain_thread: ls.chain_thread,
        parent_id: ls.parent_id,
        fork_write: ls.fork_write,
      });
      ls.current_state = advance.state;
      ls.work_step_signal = advance.interrupt !== null || advance.reason !== null;
      if (advance.interrupt !== null) {
        ls.interrupt_state = advance.interrupt;
        ls.reason = 'interrupted';
        return 'break';
      }
      if (advance.reason !== null) {
        ls.reason = advance.reason;
        ls.error_msg = advance.error;
        return 'break';
      }
      ls.parent_id = advance.parent_id;
      ls.fork_write = advance.fork_write;
      ls.active_plan = advance.plan;
      if (ls.active_plan !== null) {
        ls.current = advance.node as string;
        return 'continue';
      }
      // 计划耗尽：从已完成节点走边/出口定位（不重走 graph.entry）
      ls.current = ls.last_checkpoint !== null && ls.last_checkpoint.node ? ls.last_checkpoint.node : ls.current;
      const [planReason, planNext] = await _locate_next(graph, ctx, ls.current);
      if (planNext !== null) {
        ls.current = planNext;
        return 'continue';
      }
      if (planReason !== null) {
        ls.reason = planReason;
      }
      return 'break';
    }

    // ── 节点步数计数：与预算检查同位置的节点边界（计划推进等非节点迭代
    // 不计入）——策略经 ctx.step_count 按步数终止
    ctx.step_count += 1;
    // 引擎级步数累计（子链步数截止：分支/支流引擎执行后按此判超限）
    this.executed_node_steps += 1;

    // ── 执行回路护栏（ENG2-5）：单节点访问次数超限 = 疑似纯静态回路 ──
    if (this.options.max_cycle > 0) {
      const visits = (this._node_visits[ls.current] ?? 0) + 1;
      this._node_visits[ls.current] = visits;
      if (visits > this.options.max_cycle) {
        const nodeError =
          `执行回路超限（节点 ${ls.current} 访问 ${visits} 次 > ` +
          `max_cycle=${this.options.max_cycle}，疑似纯静态回路）`;
        _warn(`执行回路超限 [${ls.current}]: ${nodeError}`);
        await ctx.emit('error', { node: ls.current, message: nodeError });
        ls.error_msg = nodeError;
        ls.reason = TerminateReason.ERROR;
        return 'break';
      }
    }

    // ── 预算检查（节点边界，策略由业务注册）──
    if (this.options.budget !== null) {
      try {
        await this.options.budget.check(ctx);
      } catch (exc) {
        ls.reason = TerminateReason.BUDGET_EXCEEDED;
        ls.error_msg = exc instanceof Error ? exc.message : String(exc);
        return 'break';
      }
    }

    // ── 输入调配预装配（执行语义接线）：节点执行前统一走调配管线 ──
    if (ls.first_timeline_emit) {
      await ctx.emit('assembly_started', { ts: _now_epoch() });
    }
    await ctx.preassemble();
    if (ls.first_timeline_emit) {
      await ctx.emit('assembly_done', { ts: _now_epoch() });
    }

    // 结点级成败留痕：打开当前结点步骤（成败在结点块内标记，不发射事件）
    this._trace_open(ctx.graph_path, ls.current);

    // ── 执行节点（重试 N 次 / 终止；兼容同步/异步节点函数）──
    const attempt = await this._run_node_attempts({
      ctx,
      graph,
      current: ls.current,
      on_first_execution: ls.first_timeline_emit
        ? async () => {
            await ctx.emit('execution_started', { node: ls.current, ts: _now_epoch() });
            ls.first_timeline_emit = false;
          }
        : null,
    });
    if (attempt.node_error !== null) {
      this._trace_mark_failed();
    }
    if (attempt.interrupt !== null) {
      this._trace_mark_skipped();
      ls.interrupt_state = attempt.interrupt;
      ls.reason = 'interrupted';
      return 'break';
    }
    if (attempt.reason !== null) {
      ls.reason = attempt.reason;
      ls.error_msg = attempt.error_msg;
      return 'break';
    }

    // ── 增量类型防线：节点必须返回 dict（或 None）──
    const overlay = attempt.overlay;
    if (overlay !== null && overlay !== undefined) {
      if (typeof overlay !== 'object' || Array.isArray(overlay)) {
        const typeName = Array.isArray(overlay) ? 'list' : typeof overlay;
        const nodeError = `节点返回非法增量类型: ${typeName}（须为 dict 或 None）`;
        _warn(`节点返回非法增量类型 [${ls.current}]: ${typeName}`);
        await ctx.emit('error', { node: ls.current, message: nodeError });
        this._trace_mark_failed();
        ls.error_msg = nodeError;
        ls.reason = TerminateReason.ERROR;
        return 'break';
      }
    }
    const ov = (overlay as Record<string, unknown> | null) ?? null;

    // ── spawn 清单提取（保留键不落状态；与命令式收集项合并）──
    ls.spawn_specs = [];
    ls.data_driven_spawn = false;
    if (this.options.max_spawns > 0) {
      ls.data_driven_spawn = ov !== null && SPAWN_KEY in ov;
      try {
        ls.spawn_specs = collect_spawn_specs(ov, ctx._spawns, { resolve_graph: this._resolve_graph_data });
        // 命令式清单一次性消费：清空收集器，防清单泄漏到后续节点重复展开
        ctx._spawns.length = 0;
      } catch (exc) {
        const nodeError = `spawn 清单非法: ${String(exc)}`;
        _warn(`spawn 清单非法 [${ls.current}]: ${String(exc)}`);
        await ctx.emit('error', { node: ls.current, message: nodeError });
        this._trace_mark_failed();
        ls.error_msg = nodeError;
        ls.reason = TerminateReason.ERROR;
        return 'break';
      }
    } else {
      // spawn 禁用：保留键仍须从增量弹出（清单含 Graph 对象，泄漏会破坏
      // 状态可序列化性）
      if (ov !== null && SPAWN_KEY in ov) {
        delete ov[SPAWN_KEY];
      }
    }

    // ── 计划清单提取（保留键不落状态；__plan__ = 下一跳编排清单）──
    let plan_data: unknown = undefined;
    if (ov !== null && PLAN_KEY in ov) {
      plan_data = ov[PLAN_KEY];
      delete ov[PLAN_KEY];
    }
    if (plan_data !== null && plan_data !== undefined) {
      try {
        if (this.options.max_plan_steps <= 0) {
          throw new Error('计划已禁用（max_plan_steps=0）');
        }
        const registries = this.options.registries;
        ls.active_plan = Plan.parse(plan_data, {
          graph,
          edge_registry: registries !== null ? registries.edges : null,
          policy: this.options.plan_policy,
          max_steps: this.options.max_plan_steps,
          workflow: this.options.plan_workflow,
        });
      } catch (exc) {
        const nodeError = `计划清单非法: ${String(exc)}`;
        _warn(`计划清单非法 [${ls.current}]: ${String(exc)}`);
        await ctx.emit('error', { node: ls.current, message: nodeError });
        this._trace_mark_failed();
        ls.error_msg = nodeError;
        ls.reason = TerminateReason.ERROR;
        return 'break';
      }
    }

    // ── 推演清单提取（保留键不落状态；__simulate__ = 决策点标记）──
    let simulate_data: unknown = undefined;
    if (ov !== null && SIMULATE_KEY in ov) {
      simulate_data = ov[SIMULATE_KEY];
      delete ov[SIMULATE_KEY];
    }
    if (simulate_data !== null && simulate_data !== undefined) {
      ls.had_simulate_data = true;
      try {
        if (this.options.evaluator === null) {
          throw new Error('推演已启用但未注入评估器（RunOptions.evaluator）');
        }
        if (this.options.max_simulations <= 0) {
          throw new Error('推演已禁用（max_simulations=0）');
        }
        const parsed = parse_simulate(simulate_data, {
          resolve_graph: this._resolve_graph_data,
          max_branches: this.options.max_simulations,
        });
        ls.simulate_step_id = parsed[0];
        ls.simulate_budget = parsed[1];
        ls.simulate_specs = parsed[2];
      } catch (exc) {
        const nodeError = `推演清单非法: ${String(exc)}`;
        _warn(`推演清单非法 [${ls.current}]: ${String(exc)}`);
        await ctx.emit('error', { node: ls.current, message: nodeError });
        this._trace_mark_failed();
        ls.error_msg = nodeError;
        ls.reason = TerminateReason.ERROR;
        return 'break';
      }
    } else {
      ls.had_simulate_data = false;
      ls.simulate_step_id = null;
      ls.simulate_budget = null;
      ls.simulate_specs = [];
    }

    // ── 多径展开清单提取（保留键不落状态；__multipath__ 同语义）──
    ls.multipath_data = undefined;
    if (ov !== null && MULTIPATH_KEY in ov) {
      ls.multipath_data = ov[MULTIPATH_KEY];
      delete ov[MULTIPATH_KEY];
    }

    // ── 增量合并（reducer）──
    if (ov !== null && Object.keys(ov).length > 0) {
      ls.current_state = _merge_overlay(schema, ls.current_state, ov);
    }
    ctx._state = ls.current_state;

    // ── 节点终止信号（reply/止损/超限，业务策略表达）──
    if (ctx.terminated) {
      ls.reason = ctx.terminate_reason ?? TerminateReason.REPLY;
      if (!TerminateReason.is_valid(ls.reason)) {
        throw new Error(`非法终止原因: ${ls.reason}`);
      }
      return 'break';
    }
    return 'proceed';
  }
}

export type { Graph };
