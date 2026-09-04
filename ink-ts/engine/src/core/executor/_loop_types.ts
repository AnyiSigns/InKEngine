/**
 * 主执行循环的可变循环状态（executor.py Engine._execute 的循环局部变量面）。
 *
 * 主循环是多局部变量的单循环状态机：current/current_state/active_plan/
 * parent/fork/中断/终止/信号/解析产物等局部变量跨迭代存活、多阶段读写。
 * TS 无 Python 函数级局部变量跨文件共享的形态，故以可变状态对象承载同一
 * 循环局部面（生命周期 = 一次 _execute），主循环分阶段方法（_loop_front/
 * _loop_back）读写同一实例——阶段拆分不改变任何语义。
 */
import { Plan } from '../plan/plan.js';
import { InterruptState } from '../interrupt/interrupt_types.js';
import { TerminateReason } from '../graph/graph_types.js';
import type { CheckpointRecord } from '../storage/storage_records.js';
import type { SpawnSpec } from '../spawn/spawn.js';
import type { SimulateSpec } from '../simulation/simulation_types.js';
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
  /** 运行中计划（null = 无计划；推进/耗尽随迭代更新）。 */
  active_plan: Plan | null = null;
  /** 中断挂起态（节点/计划步内中断提升；随终态快照持久化）。 */
  interrupt_state: InterruptState | null = null;
  /** 终止原因（reply/stop/budget_exceeded/error/interrupted）。 */
  reason: string = TerminateReason.REPLY;
  /** 错误消息（reason=error 时；脱敏）。 */
  error_msg: string | null = null;
  /** 计划工作步信号（并行组/spawn 步内中断/失败 → 终态计划快照 work_step）。 */
  work_step_signal = false;
  /** 链写父锚点（checkpoint 写入 parent；子图/spawn 推进后跟随链尾）。 */
  parent_id: number | null = null;
  /** 链写状态（编辑重放分叉首写标志；写入后复位 False）。 */
  fork_write = false;
  /** 事件统计基准（events_emitted = 结束计数 − 此基准）。 */
  events_before = 0;

  // ── 恢复首轮特殊标志（计划恢复/已完成节点跳过）──────────────────────
  /** 已完成节点无出边：首轮跳过节点执行直接收尾。 */
  skip_first_node = false;
  /** 计划恢复首轮：跳过节点执行，直接推进计划游标。 */
  plan_pending = false;

  // ── 单迭代解析产物（front 阶段产出、back 阶段消费）──────────────────
  /** spawn 清单（overlay 数据驱动 + ctx 命令式合并结果）。 */
  spawn_specs: SpawnSpec[] = [];
  /** 数据驱动来源标记（展示形态事件由节点自身发射，防重复兜底）。 */
  data_driven_spawn = false;
  /** 推演清单解析产物（决策点步骤 id/预算/分支规格）。 */
  had_simulate_data = false;
  simulate_step_id: string | null = null;
  simulate_budget: number | null = null;
  simulate_specs: SimulateSpec[] = [];
  /** 多径展开清单（pop 后不落状态；进程内对象形态）。 */
  multipath_data: unknown = undefined;

  /** 事件日志归属线程（checkpoint/事件落库定位）。 */
  thread_id: string;
  /** checkpoint 版本链归属（spawn 实例 = 独立子链）。 */
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
