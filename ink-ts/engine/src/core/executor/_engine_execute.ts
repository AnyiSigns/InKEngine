/**
 * 引擎主执行循环入口（executor.py Engine._execute 移植——顶层与嵌套子图/
 * 实例共用的执行状态机装配面）。
 *
 * 单循环状态机：取当前节点 → 执行（节点内 ctx.emit 发射事件）→ 增量按
 * reducer 合并 → checkpoint 快照 → 条件边选下一节点 → 终止/出口。无 Pregel
 * 中间状态；每节点完成写一次快照（版本链），回路任意点可恢复。
 *
 * 本文件承载入口装配：每轮执行独立计数/seq 锚点/回路护栏/轨迹复位、
 * 恢复解析（checkpoint 快照 + 增量日志重放）、节点上下文构造、恢复起点
 * 定位（中断/异常/正常/计划 checkpoint 的重入判据）与收尾（挂起卡事件/
 * 终态 checkpoint/RunResult）。循环单迭代的前/后半段见 _engine_loop_front/
 * _engine_loop_back（按 Python 方法边界拆分，语义零变化）。
 *
 * 恢复起点定位：
 * - 中断 checkpoint（reason=interrupted）：重入中断节点（注入值分支）；
 * - 异常 checkpoint（reason=error）：重入失败节点（该节点未完成，恢复即
 *   重试；error_on_exception=False 的跳过语义不落 error 终态）；
 * - 正常 checkpoint（节点已完成）：从已完成节点的下一节点继续；
 * - 计划 checkpoint：从计划的剩余步骤续跑（工作步中断 = 重入计划步本身，
 *   顺序节点步中断 = 重入该节点——显式 work_step 标记优先，旧存档回落
 *   节点名判据兼容）。
 */
import { Plan } from '../plan/plan.js';
import { RunResult } from '../run_result/run_result.js';
import { TerminateReason } from '../graph/graph_types.js';
import { InterruptState } from '../interrupt/interrupt_types.js';
import { resolve_resume } from '../recovery/index.js';
import type { CheckpointRecord } from '../storage/storage_records.js';
import type { JsonRecord } from '../json.js';
import { _NodeContextImpl } from './_node_context.js';
import { EngineLoopBack } from './_engine_loop_back.js';
import type { EngineBase, ExecuteOptions } from './_engine_base.js';
import { LoopState } from './_loop_types.js';
import {
  _locate_next,
  _node_in_plan_steps,
  _now_epoch,
  _plan_snapshot_is_work_step,
  _select_next_node,
} from './_internals.js';

/**
 * 执行引擎实例（分层链叶节点：字段/事件/轨迹/入口/实例/checkpoint/展开/
 * 计划/多径/子过程 + 主循环装配，镜像 Python executor.Engine）。
 */
export class Engine extends EngineLoopBack {
  /**
   * 主执行循环（顶层与嵌套子图/实例共用）。
   *
   * @param opts.state 初始状态（无 checkpoint 时）。
   * @param opts.queue 事件流产出队列（null = 非流式；replay 事件仅队列
   *   模式收集重放）。
   * @param opts.checkpoint_thread_id checkpoint 版本链归属（null = 与
   *   thread_id 相同；spawn 实例借此写入独立子链、事件日志仍落父链）。
   */
  async _execute(opts: ExecuteOptions): Promise<[Record<string, unknown>, RunResult]> {
    const {
      state,
      thread_id,
      round_id,
      resume_from,
      trace_id,
      queue,
      parent_checkpoint = null,
      continue_chain = false,
      graph_path = [],
      transports = null,
      resume_map = null,
      checkpoint_thread_id = null,
      parent_step_id = null,
    } = opts;
    const graph = this.graph;
    const schema = this.options.schema;
    const storage = this.options.storage;
    const effTransports = transports ?? this.options.transports;
    const chain_thread = checkpoint_thread_id ?? thread_id;

    // 每轮执行独立计数/seq 锚点：`_execute` 是顶层与嵌套子图/实例共用入口
    // ——缓存子图引擎跨 run 复用（run_subgraph 按图实例缓存）时，上一轮的
    // 累计值若残留，父引擎合并计数会虚高且陈旧 seq 会命中存储层 event_seq
    // 回退校验崩溃。此处复位保证每次执行从零起算。
    this._event_counter = 0;
    this._latest_event_seq = null;
    // 执行回路护栏计数复位（本引擎每轮独立）
    this._node_visits = {};
    // 结点级成败留痕复位（嵌套引擎执行完经合并点并入父引擎）
    this._trace_reset(graph, graph_path);

    // ── 恢复：checkpoint 快照 + 增量日志重放（断线续流，解析在 recovery）──
    let current: string = graph.entry;
    // 续链/续跑的首写 parent 须跟随当前链尾：置位后由 checkpoint 写入处查询
    if ((continue_chain || resume_from !== null) && storage !== null) {
      this._chain_advanced = true;
    }
    const resume = await resolve_resume({
      storage,
      state: state as unknown as JsonRecord,
      schema,
      thread_id,
      chain_thread,
      resume_from,
      continue_chain,
      graph_path,
      replay: queue !== null,
      resume_map,
      graph_version: this._graph_digest,
    });
    const current_state: Record<string, unknown> = { ...resume.state };
    let last_checkpoint = resume.last_checkpoint;
    // 增量日志重放：把最终锚点之后的事件补发给传输（断线续流）
    if (queue !== null) {
      for (const event of resume.replay) {
        await queue.put(event);
      }
    }

    const ctx = new _NodeContextImpl({
      engine: this,
      state: current_state,
      graph_path,
      round_id,
      trace_id,
      thread_id,
      transports: effTransports,
      resume_map: resume.resume_map,
      parent_step_id,
    });
    // ── 组装时间线事件（UX 指标；emit_timeline_events 开启且顶层图时发射）──
    const _top_level = graph_path.length === 0;
    const first_timeline_emit = this.options.emit_timeline_events && _top_level;
    if (first_timeline_emit) {
      await ctx.emit('turn_started', { round_id, ts: _now_epoch() });
    }

    // ── 恢复起点定位（见文件头注）──────────────────────────────────────
    let skip_first_node = false;
    let plan_pending = false;
    let active_plan: Plan | null = null;
    if (continue_chain) {
      // 新回合续链：从图入口执行，不做链尾节点定位（recovery 契约：链尾仅
      // 作状态基底——图是数据可被任意修改，从入口执行只依赖 entry 契约）
    } else if (last_checkpoint !== null && last_checkpoint.node) {
      if (last_checkpoint.reason === 'interrupted' || last_checkpoint.reason === TerminateReason.ERROR) {
        current = last_checkpoint.node;
        // 中断/失败发生在计划执行中：计划快照随 checkpoint 落盘——工作步
        // 中断 = 重入计划步本身（plan_pending 直达计划推进）；顺序节点步 =
        // 重入该节点。显式 work_step 标记优先，旧存档回落节点名判据。
        if (last_checkpoint.plan !== null && this.options.max_plan_steps > 0) {
          active_plan = Plan.fromDict(last_checkpoint.plan as unknown as Record<string, unknown>);
          if (
            _plan_snapshot_is_work_step(last_checkpoint.plan as unknown as Record<string, unknown> | null) ||
            !_node_in_plan_steps(current, active_plan)
          ) {
            plan_pending = true;
          }
        }
      } else if (last_checkpoint.plan !== null && this.options.max_plan_steps > 0) {
        // 普通计划 checkpoint：产出节点已完成，直接从计划剩余步骤续跑
        active_plan = Plan.fromDict(last_checkpoint.plan as unknown as Record<string, unknown>);
        plan_pending = true;
      } else {
        const nxt = await _select_next_node(graph, ctx, last_checkpoint.node);
        if (nxt !== null) {
          current = nxt;
        } else {
          // 已完成节点无出边：图已走完（或节点为出口），终止不再执行
          skip_first_node = true;
        }
      }
    }
    const parent_id: number | null =
      parent_checkpoint ?? (last_checkpoint !== null ? last_checkpoint.checkpoint_id : null);
    // 编辑重放分叉：首写 checkpoint 跳过存储层链尾校验（锚点指向历史链节点）
    const fork_write = parent_checkpoint !== null;

    const ls = new LoopState({
      ctx,
      current,
      current_state,
      last_checkpoint,
      parent_id,
      fork_write,
      thread_id,
      chain_thread,
      first_timeline_emit,
    });
    ls.skip_first_node = skip_first_node;
    ls.plan_pending = plan_pending;
    ls.active_plan = active_plan;
    ls.events_before = this._event_counter;

    // ── 主循环（单迭代 = 前/后半段；前/后半段按 'break' 信号收敛）──
    for (;;) {
      const front = await this._loop_front(ls);
      if (front === 'break') break;
      if (front === 'continue') continue;
      if ((await this._loop_back(ls)) === 'break') break;
    }

    // 收尾：最后一个结点的步骤留痕（成败已在退出路径标记定型）
    await this._trace_close_pending();

    // ── 审批挂起卡进事件流：中断负载随回合事件直出（key 补入 payload）──
    if (ls.interrupt_state !== null) {
      let cardPayload = ls.interrupt_state.payload;
      if (cardPayload !== null && typeof cardPayload === 'object' && !Array.isArray(cardPayload)) {
        cardPayload = { ...cardPayload, key: ls.interrupt_state.key };
      }
      await ctx.emit('review_card', cardPayload as Record<string, unknown>);
    }

    // ── 终态 checkpoint（携带终止原因/异常快照/计划快照，入轨迹与审计）──
    if (storage !== null) {
      let plan_snapshot: Record<string, unknown> | null = null;
      if (ls.active_plan !== null) {
        plan_snapshot = ls.active_plan.toDict();
        if (ls.work_step_signal) {
          // 工作步内中断/失败标记：恢复时据此重入计划步本身（显式信号，
          // 不依赖 checkpoint.node 的节点名猜测）
          plan_snapshot = { ...plan_snapshot, work_step: true };
        }
      }
      const written = await this._write_checkpoint({
        storage,
        thread_id,
        chain_thread,
        ctx,
        node: ls.current,
        state: ls.current_state,
        parent_id: ls.parent_id,
        fork_write: ls.fork_write,
        reason: ls.reason,
        error: ls.error_msg,
        // 挂起卡状态随终态快照持久化：reason=interrupted 时携带中断键与卡
        // 负载（续流恢复定位锚点，宿主据此注入决策值）
        interrupt: ls.interrupt_state,
        plan: plan_snapshot as JsonRecord | null,
      });
      last_checkpoint = written[0];
    }
    const result = new RunResult({
      state: ls.current_state,
      reason: ls.reason,
      checkpoint_id: last_checkpoint !== null ? last_checkpoint.checkpoint_id : null,
      interrupt: ls.interrupt_state,
      events_emitted: this._event_counter - ls.events_before,
      error: ls.error_msg,
    });
    return [ls.current_state, result];
  }
}

export type { CheckpointRecord, InterruptState };
export type { EngineBase };
