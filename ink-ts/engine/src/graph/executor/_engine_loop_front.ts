/**
 * 引擎主循环前半段（executor.py Engine._execute 的循环头至「节点终止信号」
 * 段移植）。
 *
 * 前半段职责：恢复首轮特殊处理（已完成节点跳过）、节点边界计数与回路/预算
 * 护栏、输入调配预装配、结点级成败留痕打开、节点执行（重试/VTM，见
 * _run_node_attempts）、增量类型防线、增量合并与节点终止信号检查。
 *
 * 返回 'proceed' = 本迭代前半段完成且节点已执行（后半段继续：checkpoint/
 * 下一步定位）；'continue' = 前半段已直接推进到下一节点（跳过后半段，下一
 * 迭代从节点边界开始）；'break' = 任意终止出口命中（reason/error_msg/
 * interrupt 已在循环状态上落定）。
 */
import { TerminateReason } from '../../model/graph/graph_types.js';
import { NodeExecutionError } from '../../model/errors.js';
import { _merge_overlay, _now_epoch, _warn } from './_internals.js';
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

    // ── 节点存在性防线（图校验/恢复锚点都可能指向未注册节点）──
    if (!(ls.current in graph.nodes)) {
      throw new NodeExecutionError(ls.current, new Error(`节点未注册: ${ls.current}`));
    }
    ctx.node = ls.current;
    // 上一结点步骤收尾（成败已在结点块内标记定型；成本此刻归集）
    await this._trace_close_pending();

    // ── 恢复终点：已完成节点无出边，直接进入终态收尾 ──
    if (ls.skip_first_node) {
      ls.skip_first_node = false;
      if (ls.last_checkpoint !== null && ls.last_checkpoint.node) {
        ls.current = ls.last_checkpoint.node;
      }
      return 'break';
    }

    // ── 节点步数计数：与预算检查同位置的节点边界（非节点迭代不计入）——
    // 策略经 ctx.step_count 按步数终止
    ctx.step_count += 1;
    // 引擎级步数累计（子链步数截止：子引擎执行后按此判超限）
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

    // ── 结点级成败留痕：打开当前结点步骤（成败在结点块内标记，不发射事件）
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
