/**
 * 引擎主循环后半段（executor.py Engine._execute 的展开/checkpoint/下一步
 * 定位段移植）。
 *
 * 后半段职责（front 返回 'proceed' 后执行）：
 * - spawn 展开：嵌套深度/清单超限护栏 + run_spawned 结果回流（失败实例
 *   剔除留痕，父链继续；实例内中断提升为父图挂起卡）；
 * - 推演展开：分支独立子链推演 → 评估择优 → 提交主线（决策留痕事件）；
 * - 多径展开：候选集并行执行 → 汇流裁决 → 胜者增量回流（multipath_result
 *   事件全量留痕；降级单径不丢候选产物）；
 * - checkpoint 快照（每节点完成，版本链；计划激活时随附计划快照）；
 * - 下一步定位：计划推进（优先）or 条件边/出口。
 *
 * 返回 'break' = 迭代在展开/定位处终止；'continue' = 下一迭代。
 */
import { TerminateReason } from '../graph/graph_types.js';
import { InterruptSignal, InterruptState } from '../interrupt/interrupt_types.js';
import { SimulationError } from '../errors.js';
import { strip_sensitive } from '../security/security.js';
import { SimulationResult } from '../simulation/simulation.js';
import type { MultiPathResult } from '../multipath/results.js';
import type { JsonRecord } from '../json.js';
import { _locate_next, _merge_overlay, _warn } from './_internals.js';
import { EngineLoopFront } from './_engine_loop_front.js';
import type { LoopState } from './_loop_types.js';

/** 主循环后半段分层段（Engine 方法群）。 */
export abstract class EngineLoopBack extends EngineLoopFront {
  /**
   * 单迭代后半段（展开/checkpoint/下一步定位；见文件头注）。
   */
  async _loop_back(ls: LoopState): Promise<'continue' | 'break'> {
    const { ctx } = ls;
    const graph = this.graph;
    const schema = this.options.schema;
    const storage = this.options.storage;

    // ── spawn 展开（子任务清单并发展开为子图实例，结果回流）──
    if (ls.spawn_specs.length > 0) {
      if (
        this.options.spawn_max_depth > 0 &&
        this.options.spawn_depth + 1 > this.options.spawn_max_depth
      ) {
        const nodeError =
          `spawn 嵌套深度超限: ${this.options.spawn_depth + 1} > ${this.options.spawn_max_depth}`;
        _warn(`spawn 嵌套深度超限 [${ls.current}]: ${nodeError}`);
        await ctx.emit('error', { node: ls.current, message: nodeError });
        this._trace_mark_failed();
        ls.error_msg = nodeError;
        ls.reason = TerminateReason.ERROR;
        return 'break';
      }
      if (ls.spawn_specs.length > this.options.max_spawns) {
        const nodeError = `spawn 清单超限: ${ls.spawn_specs.length} > ${this.options.max_spawns}`;
        _warn(`spawn 清单超限 [${ls.current}]: ${nodeError}`);
        await ctx.emit('error', { node: ls.current, message: nodeError });
        this._trace_mark_failed();
        ls.error_msg = nodeError;
        ls.reason = TerminateReason.ERROR;
        return 'break';
      }
      try {
        const spawn_result = await this.run_spawned(ls.spawn_specs, ctx, {
          concurrency: this.options.spawn_concurrency,
          // 数据驱动路径由节点自身发射 spawn_start；命令式 ctx.spawn 路径无
          // 节点级发射——本次展开的事件发射仅对命令式来源兜底（防重复）
          emit_events: !ls.data_driven_spawn,
        });
        if (Object.keys(spawn_result.overlay).length > 0) {
          ls.current_state = _merge_overlay(schema, ls.current_state, spawn_result.overlay);
        }
        ctx._state = ls.current_state;
        // 失败实例留痕：剔除不阻断父链（部分失败语义），但必须可见可诊断
        if (spawn_result.failures.length > 0) {
          for (const failure of spawn_result.failures) {
            _warn(
              `spawn 实例失败（剔除，父链继续）[${ls.current}] index=${failure.index}: ${failure.error}`,
            );
          }
          await ctx.emit('error', {
            node: ls.current,
            message:
              `spawn 实例失败 ${spawn_result.failures.length} 个（已剔除，父链继续）: ` +
              spawn_result.failures.map((f) => `#${f.index}`).join(', '),
          });
        }
      } catch (exc) {
        if (exc instanceof InterruptSignal) {
          const sig = exc as InterruptSignal;
          ls.interrupt_state = new InterruptState(
            sig.key,
            strip_sensitive(sig.payload) as Record<string, unknown>,
            ls.current,
            ctx.graph_path,
          );
          this._trace_mark_skipped();
          ls.reason = 'interrupted';
          return 'break';
        }
        throw exc;
      }
    }

    // ── 推演展开（决策点：分支独立子链推演 → 评估择优 → 提交主线）──
    if (ls.had_simulate_data) {
      let sim_result: SimulationResult;
      try {
        sim_result = await this.run_simulated(ls.simulate_specs, ctx, {
          step_id: ls.simulate_step_id,
          budget: ls.simulate_budget,
          concurrency: this.options.simulate_concurrency,
        });
      } catch (exc) {
        if (exc instanceof InterruptSignal) {
          const sig = exc as InterruptSignal;
          ls.interrupt_state = new InterruptState(
            sig.key,
            strip_sensitive(sig.payload) as Record<string, unknown>,
            ls.current,
            ctx.graph_path,
          );
          this._trace_mark_skipped();
          ls.reason = 'interrupted';
          return 'break';
        }
        if (exc instanceof SimulationError) {
          const nodeError = `推演失败: ${String(exc)}`;
          _warn(`推演失败 [${ls.current}]: ${String(exc)}`);
          await ctx.emit('error', { node: ls.current, message: nodeError });
          this._trace_mark_failed();
          ls.error_msg = nodeError;
          ls.reason = TerminateReason.ERROR;
          return 'break';
        }
        throw exc;
      }
      if (Object.keys(sim_result.selection.overlay).length > 0) {
        ls.current_state = _merge_overlay(schema, ls.current_state, sim_result.selection.overlay);
      }
      ctx._state = ls.current_state;
      // 决策留痕事件：分支评估表 + 选中分支 + 来源留痕 + 分支子链引用
      await ctx.emit(
        'simulate_decision',
        {
          node: ls.current,
          step_id: ls.simulate_step_id,
          selected: [...sim_result.selection.selected],
          branches: sim_result.branches.map((b) => ({
            index: b.spec.index,
            description: b.spec.description,
            score: b.evaluation.score,
            passed: b.evaluation.passed,
            note: b.evaluation.note,
            rule_version: b.evaluation.rule_version,
            params_snapshot: b.evaluation.params_snapshot,
          })),
          provenance: sim_result.selection.provenance.map((p) => ({
            branch: p.branch_index,
            key: p.key,
            note: p.note,
          })),
          threads: sim_result.thread_ids,
        } as unknown as Record<string, unknown>,
        { step_id: ls.simulate_step_id ?? undefined },
      );
    }

    // ── 多径展开（候选集并行执行 → 汇流裁决 → 胜者增量回流主线）──
    if (ls.multipath_data !== undefined) {
      let mp_result: MultiPathResult;
      try {
        mp_result = (await this._run_multipath(ls.multipath_data as never, ctx)) as MultiPathResult;
      } catch (exc) {
        if (exc instanceof InterruptSignal) {
          const sig = exc as InterruptSignal;
          ls.interrupt_state = new InterruptState(
            sig.key,
            strip_sensitive(sig.payload) as Record<string, unknown>,
            ls.current,
            ctx.graph_path,
          );
          this._trace_mark_skipped();
          ls.reason = 'interrupted';
          return 'break';
        }
        const nodeError = `多径执行失败: ${String(exc)}`;
        _warn(`多径执行失败 [${ls.current}]: ${String(exc)}`);
        await ctx.emit('error', { node: ls.current, message: nodeError });
        this._trace_mark_failed();
        ls.error_msg = nodeError;
        ls.reason = TerminateReason.ERROR;
        return 'break';
      }
      const overlay_merge: Record<string, unknown> = {};
      if (mp_result.verdict !== null && Object.keys(mp_result.verdict.selection).length > 0) {
        Object.assign(overlay_merge, mp_result.verdict.selection);
      } else if (mp_result.k === 1 && mp_result.branches.length > 0) {
        // 降级单径：首个候选的回收增量直接回流（候选仍执行，机制降级不丢产物）
        Object.assign(overlay_merge, mp_result.branches[0]?.overlay ?? {});
      }
      if (Object.keys(overlay_merge).length > 0) {
        ls.current_state = _merge_overlay(schema, ls.current_state, overlay_merge);
      }
      ctx._state = ls.current_state;
      // 多径执行留痕事件（触发/支流/裁决/子链引用全量可审计）
      await ctx.emit('multipath_result', {
        node: ls.current,
        triggered: mp_result.triggered,
        k: mp_result.k,
        candidates: mp_result.candidates,
        winner: mp_result.winner,
        degraded_reason: mp_result.degraded_reason,
        branches: mp_result.branches.map((b) => b.to_dict()),
        verdict: mp_result.verdict !== null ? mp_result.verdict.to_dict() : null,
        threads: { ...mp_result.thread_ids },
      } as unknown as Record<string, unknown>);
    }

    // ── checkpoint 快照（每节点完成，版本链；计划激活时随附计划快照）──
    if (storage !== null) {
      const written = await this._write_checkpoint({
        storage,
        thread_id: ls.thread_id,
        chain_thread: ls.chain_thread,
        ctx,
        node: ls.current,
        state: ls.current_state,
        parent_id: ls.parent_id,
        fork_write: ls.fork_write,
        plan: ls.active_plan !== null ? (ls.active_plan.toDict() as JsonRecord) : null,
      });
      ls.last_checkpoint = written[0];
      ls.fork_write = written[1];
      ls.parent_id = ls.last_checkpoint.checkpoint_id;
    }

    // ── 下一步定位：计划推进（优先）or 条件边/出口 ──
    if (ls.active_plan !== null) {
      const advance = await this._plan_advance({
        plan: ls.active_plan,
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
        // 计划工作步内中断（并行组成员/spawn 实例）→ 提升为父图挂起卡
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
      // 计划耗尽：回到条件边/出口定位（current = 计划末节点）
    }
    const [locatedReason, nextNode] = await _locate_next(graph, ctx, ls.current);
    if (nextNode !== null) {
      ls.current = nextNode;
      return 'continue';
    }
    if (locatedReason !== null) {
      ls.reason = locatedReason;
    }
    return 'break';
  }
}
