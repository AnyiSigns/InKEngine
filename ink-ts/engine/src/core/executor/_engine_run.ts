/**
 * 引擎流式/非流式入口面（executor.py Engine 的 run/ainvoke/换选段移植）。
 *
 * run = 流式执行入口：产出事件流（含子图事件，顺序 = 发射顺序），消费方
 * 逐条取事件；ainvoke = 非流式执行（独立子图/一次性任务语义）：执行到终止，
 * 返回终态 RunResult（事件仍经 options.transports + 本参数 transports 推送）。
 *
 * 两者差异与 Python 一致：run 多挂一条队列传输（_QueueTransport），事件经
 * 队列流式产出；注入值同样一次性清理（防残留泄漏，与 run 同语义）。
 *
 * TS 差异说明：Python asyncio.Task 支持主动取消（消费方提前退出时取消后台
 * 执行任务，防止 LLM/写 checkpoint 造成成本与数据泄漏）；JS Promise 无取消
 * 原语，消费方提前退出后后台 _execute 继续跑至自身完成（结果不再投递），
 * 残留的注入清理仍会照常执行——这是平台取消模型差异带来的关键降级点。
 */
import { RunResult } from '../run_result/run_result.js';
import { TerminateReason } from '../graph/graph_types.js';
import type { EngineEvent, EngineTransport } from '../events/events.js';
import { GraphDefinitionError, SimulationError } from '../errors.js';
import { EngineTrace } from './_engine_trace.js';
import { _AsyncQueue, _QueueTransport, _default_id } from './_internals.js';

/** run/ainvoke 的入口选项（镜像 Python 关键字参；全部可选）。 */
export interface EngineRunOptions {
  thread_id?: string | null;
  round_id?: string | null;
  resume_from?: number | null;
  continue_chain?: boolean;
  inject?: Record<string, unknown> | null;
  trace_id?: string | null;
  truncate_log_after?: number | null;
  parent_checkpoint?: number | null;
  transports?: EngineTransport[] | null;
}

/** 入口/换选分层段（Engine 方法群）。 */
export abstract class EngineRun extends EngineTrace {
  /**
   * 流式执行入口：产出事件流（含子图事件，顺序 = 发射顺序）。
   *
   * @param state 初始状态（无 checkpoint 时）。
   * @param opts.thread_id 会话/线程 id（版本链归属，缺省自动生成）。
   * @param opts.round_id 回合 id（事件契约）。
   * @param opts.resume_from checkpoint_id 锚点（恢复/续流；null = 从头执行）。
   *   恢复时输入 state 作为覆盖层（checkpoint 优先，输入补缺/追加）。
   * @param opts.continue_chain 新回合续链（True = 读链尾 checkpoint 为基底，
   *   输入 state 覆盖后从入口执行，版本链续接链尾；不重放事件）。
   * @param opts.inject interrupt 注入值（{review_key: value}，重入语义）。
   * @param opts.truncate_log_after 编辑重放：先截断执行日志 seq 之后，再续跑。
   * @param opts.parent_checkpoint 编辑重放：新 checkpoint 链的父锚点（分叉）。
   * @param opts.transports 追加事件传输（与 options.transports 叠加）。
   */
  async *run(state: Record<string, unknown>, opts: EngineRunOptions = {}): AsyncGenerator<EngineEvent> {
    const thread_id = opts.thread_id ?? _default_id('thread');
    const trace_id = opts.trace_id ?? _default_id('trace');
    const queue = new _AsyncQueue<EngineEvent | null>();
    // 事件流产出通道挂到传输列表（顺序 = 发射顺序；挂载后事件既落日志又进队列）
    const senders = [...this.options.transports, ...(opts.transports ?? []), new _QueueTransport(queue)];
    let task: Promise<[Record<string, unknown>, RunResult]> | null = null;
    // per-run 状态复位：run 是顶层入口（嵌套子图/spawn 走 _execute 不经过
    // 此处）——同实例串行多 run 的计数/seq 锚点/链尾标志不跨 run 残留
    this._event_counter = 0;
    this._latest_event_seq = null;
    this._chain_advanced = false;
    // 传输推送保序状态复位（同 thread 跨 run 不串台）
    this._transport_seq.reset();
    this._validate_entry_mode({ resume_from: opts.resume_from ?? null, continue_chain: opts.continue_chain ?? false });
    try {
      // 新回合入口（无 resume_from）：清 gate 发卡计数（上一回合的审批序号
      // 不漂移到本回合——同回合同工具第二次审批才掺指纹）
      if (opts.resume_from === null || opts.resume_from === undefined) {
        this._coordinator.reset_thread_gate_count(thread_id);
      }
      if (opts.inject !== null && opts.inject !== undefined) {
        this._coordinator.inject(opts.inject);
      }
      if (
        (opts.truncate_log_after !== null && opts.truncate_log_after !== undefined) &&
        this.options.storage !== null
      ) {
        await this.options.storage.truncate_events(thread_id, opts.truncate_log_after);
      }
      // 链级 rebase：顶层入口压缩历史前缀（版本链行数维度有界化）。编辑重放
      // （parent_checkpoint 分叉锚点指向历史链）与恢复续跑（resume_from 落点
      // 可能落在保留窗口外）均跳过压缩，避免删掉分叉目标/恢复锚点。
      if (
        (opts.parent_checkpoint === null || opts.parent_checkpoint === undefined) &&
        (opts.resume_from === null || opts.resume_from === undefined)
      ) {
        await this._maybe_compact_chain(thread_id);
      }
      task = this._execute({
        state,
        thread_id,
        round_id: opts.round_id ?? null,
        resume_from: opts.resume_from ?? null,
        continue_chain: opts.continue_chain ?? false,
        trace_id,
        parent_checkpoint: opts.parent_checkpoint ?? null,
        queue,
        transports: senders,
      });
      // 哨兵：任务结束（含异常）时入队，事件流据此收敛，无超时轮询
      void task.then(
        () => {
          void queue.put(null);
        },
        () => {
          void queue.put(null);
        },
      );
      for (;;) {
        const event = await queue.get();
        if (event === null) break;
        yield event;
      }
      const [, runResult] = await task;
      this._record_run_metrics(runResult);
      await this._settle_run(runResult, { thread_id, round_id: opts.round_id ?? null, trace_id });
    } finally {
      // 消费方提前退出（断连/break）：后台任务无法被取消（平台能力降级，
      // 见文件注释），但注入残留仍会清理——注入值一次性（已注入决策的审批
      // 视为放弃，防门控绕过），残留会泄漏到下一次 run 被静默消费
      if (opts.inject !== null && opts.inject !== undefined) {
        for (const key of Object.keys(opts.inject)) {
          this._coordinator.pending_inject.delete(key);
        }
      }
    }
  }

  /**
   * 非流式执行（独立子图/一次性任务语义）：执行到终止，返回终态 RunResult。
   *
   * 与 run 的差异：不产出事件队列（事件仍经 options.transports + 本参数
   * transports 推送，适合 CollectorTransport 收集/审计日志场景），直接返回
   * 最终结果。注入值同样一次性清理（防残留泄漏，与 run 同语义）。
   */
  async ainvoke(state: Record<string, unknown>, opts: EngineRunOptions = {}): Promise<RunResult> {
    const thread_id = opts.thread_id ?? _default_id('thread');
    const trace_id = opts.trace_id ?? _default_id('trace');
    // per-run 状态复位（与 run() 同语义：顶层入口不跨 run 残留）
    this._event_counter = 0;
    this._latest_event_seq = null;
    this._chain_advanced = false;
    // 传输推送保序状态复位（同 thread 跨 run 不串台）
    this._transport_seq.reset();
    this._validate_entry_mode({ resume_from: opts.resume_from ?? null, continue_chain: opts.continue_chain ?? false });
    try {
      // 新回合入口（无 resume_from）：清 gate 发卡计数（与 run() 同口径）
      if (opts.resume_from === null || opts.resume_from === undefined) {
        this._coordinator.reset_thread_gate_count(thread_id);
      }
      if (opts.inject !== null && opts.inject !== undefined) {
        this._coordinator.inject(opts.inject);
      }
      if (
        (opts.truncate_log_after !== null && opts.truncate_log_after !== undefined) &&
        this.options.storage !== null
      ) {
        await this.options.storage.truncate_events(thread_id, opts.truncate_log_after);
      }
      // 编辑重放（parent_checkpoint 分叉）与恢复续跑（resume_from 锚点可能
      // 落在保留窗口外）均跳过压缩，避免删掉分叉目标/恢复锚点
      if (
        (opts.parent_checkpoint === null || opts.parent_checkpoint === undefined) &&
        (opts.resume_from === null || opts.resume_from === undefined)
      ) {
        await this._maybe_compact_chain(thread_id);
      }
      const [, result] = await this._execute({
        state,
        thread_id,
        round_id: opts.round_id ?? null,
        resume_from: opts.resume_from ?? null,
        continue_chain: opts.continue_chain ?? false,
        trace_id,
        queue: null,
        parent_checkpoint: opts.parent_checkpoint ?? null,
        // 叠加而非替换：事件经 options.transports + 本参数 transports 推送
        // （与 run() 同口径，防静态审计/落库传输被静默停掉）
        transports: [...this.options.transports, ...(opts.transports ?? [])],
      });
      this._record_run_metrics(result);
      await this._settle_run(result, { thread_id, round_id: opts.round_id ?? null, trace_id });
      return result;
    } finally {
      if (opts.inject !== null && opts.inject !== undefined) {
        for (const key of Object.keys(opts.inject)) {
          this._coordinator.pending_inject.delete(key);
        }
      }
    }
  }

  /** 入口模式契约：续链与锚点恢复语义互斥，同置显式拒绝。 */
  _validate_entry_mode(opts: { resume_from: number | null; continue_chain: boolean }): void {
    if (opts.continue_chain && opts.resume_from !== null) {
      throw new GraphDefinitionError(
        'continue_chain 与 resume_from 语义互斥（续链 = 从链尾续接不重放；' +
          '恢复 = 按锚点快照 + 事件重放）',
      );
    }
  }

  /**
   * 回合指标采集（引擎自承载：记录自身可见的执行事实）。
   *
   * 顶层 run 收尾调用一次：回合成败（错误终止 = 失败）与错误摘要入回合指标；
   * 评审分/收敛轮数/挡位调用由使用方按事件语义填报（引擎只采集执行本身
   * 可见的统计，语义化指标不替使用方猜）。
   */
  _record_run_metrics(result: RunResult): void {
    const metrics = this.options.metrics;
    if (metrics === null) return;
    const failed = result.reason === TerminateReason.ERROR;
    metrics.record_turn({ failed, error: result.error ?? '' });
  }

  /**
   * 回溯换选：从决策点前锚点恢复，强制改选指定分支重放后续。
   *
   * 推演-回溯-换选的执行语义：决策点完成后主线提交的是择优结果；对落选分支
   * 做回溯对比/换选 = 回到决策点节点执行前的 checkpoint 锚点（决策点自身的
   * checkpoint 已是选择后状态），强制指定分支序号重放——重放只执行目标分支
   * （其余分支的结果保留在各自独立子链，可回溯对比），主线状态最终 = 目标
   * 分支的结果。锚点可用 Engine.decision_anchor 从决策事件反查。
   */
  async swap_branch(opts: {
    thread_id: string;
    before_checkpoint_id: number;
    branch_index: number;
    inject?: Record<string, unknown> | null;
    round_id?: string | null;
    trace_id?: string | null;
    transports?: EngineTransport[] | null;
  }): Promise<RunResult> {
    if (this.options.storage !== null) {
      const anchor = await this.options.storage.get_checkpoint(opts.before_checkpoint_id);
      if (anchor === null) {
        throw new SimulationError(`换选锚点不存在: ${opts.before_checkpoint_id}`);
      }
      if (anchor.reason !== null && anchor.reason !== 'interrupted') {
        throw new SimulationError(
          '换选锚点须为决策点执行前的 checkpoint' +
            `（当前锚点已是终态: ${anchor.reason}）`,
        );
      }
    }
    const original = this.options.branch_pick;
    this.options.branch_pick = opts.branch_index;
    try {
      return await this.ainvoke(
        {},
        {
          thread_id: opts.thread_id,
          round_id: opts.round_id ?? null,
          resume_from: opts.before_checkpoint_id,
          inject: opts.inject ?? null,
          trace_id: opts.trace_id ?? null,
          transports: opts.transports ?? null,
        },
      );
    } finally {
      this.options.branch_pick = original;
    }
  }
}
