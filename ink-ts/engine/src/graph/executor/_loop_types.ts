/**
 * 主执行循环的可变循环状态（executor.py Engine._execute 的循环局部变量面）。
 *
 * 主循环是多局部变量的单循环状态机：current/current_state/parent/fork/中断/
 * 终止/信号等局部变量跨迭代存活、多阶段读写。TS 无 Python 函数级局部变量跨
 * 文件共享的形态，故以可变状态对象承载同一循环局部面（生命周期 = 一次
 * _execute），主循环分阶段方法（_loop_front/_loop_back）读写同一实例——阶段
 * 拆分不改变任何语义。
 */
import { InterruptState } from '../../model/storage/interrupt_state.js';
import { TerminateReason } from '../../model/graph/graph_types.js';
import type { CheckpointRecord } from '../../model/storage/storage_records.js';
import type { _NodeContextImpl } from './_node_context.js';

/** 主循环循环状态（阶段方法共享的可变循环局部面）。 */
export class LoopState {
  /** 节点上下文（本图执行的事件/状态面）。 */
  ctx: _NodeContextImpl;
  /** 当前节点名（每轮主循环取用）。 */
  current: string;
  /** 合并后的当前状态（checkpoint 快照/增量回流后的权威状态）。 */
  current_state: Record<string, unknown>;
  /** 最近 checkpoint（恢复锚点/链写父锚点；随写随更新）。 */
  last_checkpoint: CheckpointRecord | null;
  /** 中断挂起态（节点内中断提升；随终态快照持久化）。 */
  interrupt_state: InterruptState | null = null;
  /** 终止原因（reply/stop/budget_exceeded/error/interrupted）。 */
  reason: string = TerminateReason.REPLY;
  /** 错误消息（reason=error 时；脱敏）。 */
  error_msg: string | null = null;
  /** 链写父锚点（checkpoint 写入 parent；子图推进后跟随链尾）。 */
  parent_id: number | null = null;
  /** 链写状态（编辑重放分叉首写标志；写入后复位 False）。 */
  fork_write = false;
  /** 事件统计基准（events_emitted = 结束计数 − 此基准）。 */
  events_before = 0;

  // ── 恢复首轮特殊标志（已完成节点跳过）──────────────────────────────
  /** 已完成节点无出边：首轮跳过节点执行直接收尾。 */
  skip_first_node = false;

  /** 事件日志归属线程（checkpoint/事件落库定位）。 */
  thread_id: string;
  /** checkpoint 版本链归属（子图/实例 = 独立子链）。 */
  chain_thread: string;

  /** 组装时间线事件（UX 指标）：顶层图首个节点执行前发射一次后复位。 */
  first_timeline_emit = false;

  constructor(init: {
    ctx: _NodeContextImpl;
    current: string;
    current_state: Record<string, unknown>;
    last_checkpoint: CheckpointRecord | null;
    parent_id: number | null;
    fork_write: boolean;
    thread_id: string;
    chain_thread: string;
    first_timeline_emit?: boolean;
  }) {
    this.ctx = init.ctx;
    this.current = init.current;
    this.current_state = init.current_state;
    this.last_checkpoint = init.last_checkpoint;
    this.parent_id = init.parent_id;
    this.fork_write = init.fork_write;
    this.thread_id = init.thread_id;
    this.chain_thread = init.chain_thread;
    this.first_timeline_emit = init.first_timeline_emit ?? false;
  }
}
