/**
 * 引擎流式/非流式入口面（executor.py Engine 的 run/ainvoke/??段移植）。
 *
 * run = 流式?行入口：?出事件流（含子?事件，?序 = ?射?序），消?方
 * 逐条取事件；ainvoke = 非流式?行（独立子?/一次性任???）：?行到?止，
 * 返回?? RunResult（事件仍? options.transports + 本参数 transports 推送）。
 *
 * ?者差?与 Python 一致：run 多挂一条?列??（_QueueTransport），事件?
 * ?列流式?出；注入?同?一次性清理（防残留泄漏，与 run 同??）。
 *
 * TS 差?注?：Python asyncio.Task 支持主?取消（消?方提前退出?取消后台
 * ?行任?，防? LLM/写 checkpoint 的数据泄漏）；JS Promise 无?取消原?，
 * 消?方提前退出?后台 _execute ???至自身完成（?果不再投?），残留的
 * 注入清理??不????是平台取消模型的??降?点。
 */
import { RunResult } from '../run_result/run_result.js';
import { TerminateReason } from '../graph/graph_types.js';
import type { EngineEvent, EngineTransport } from '../events/events.js';
import { GraphDefinitionError, SimulationError } from '../errors.js';
import { EngineTrace } from './_engine_trace.js';
import { _AsyncQueue, _QueueTransport, _default_id } from './_internals.js';

/** run/ainvoke 的入口??（?像 Python ??字参；全部可?）。 */
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

/** 入口/??分?段（Engine 方法群）。 */
export abstract class EngineRun extends EngineTrace {
  /**
   * 流式?行入口：?出事件流（含子?事件，?序 = ?射?序）。
   *
   * @param state 初始状?（无 checkpoint ?）。
   * @param opts.thread_id 会?/?程 id（版本??属，缺省自?生成）。
   * @param opts.round_id 回合 id（事件契?）。
   * @param opts.resume_from checkpoint_id ?点（恢?/?流；null = 从??行）。
   *   恢???入 state 作?覆盖?（checkpoint ?先，?入?缺/追加）。
   * @param opts.continue_chain 新回合??（True = ??尾 checkpoint ?基底，
   *   ?入 state 覆盖后从入口?行，版本??接?尾；不重放事件）。
   * @param opts.inject interrupt 注入?（{review_key: value}，重入??）。
   * @param opts.truncate_log_after ??重放：先截断?行日志 seq 之后，再??。
   * @param opts.parent_checkpoint ??重放：新 checkpoint ?的父?点（分叉）。
   * @param opts.transports 追加事件??（与 options.transports ?加）。
   */
  async *run(state: Record<string, unknown>, opts: EngineRunOptions = {}): AsyncGenerator<EngineEvent> {
    const thread_id = opts.thread_id ?? _default_id('thread');
    const trace_id = opts.trace_id ?? _default_id('trace');
    const queue = new _AsyncQueue<EngineEvent | null>();
    // 事件流?出通道挂到??列表（?序 = ?射?序；挂?后事件既落日志又??列）
    const senders = [...this.options.transports, ...(opts.transports ?? []), new _QueueTransport(queue)];
    let task: Promise<[Record<string, unknown>, RunResult]> | null = null;
    // per-run 状??位：run 是??入口（嵌套子?/spawn 走 _execute 不??
    // 此?）??同?例串行多 run 的?数/seq ?点/?尾?志不跨 run 残留
    this._event_counter = 0;
    this._latest_event_seq = null;
    this._chain_advanced = false;
    // ??推送保序状??位（同 thread 跨 run 不串台）
    this._transport_seq.reset();
    this._validate_entry_mode({ resume_from: opts.resume_from ?? null, continue_chain: opts.continue_chain ?? false });
    try {
      // 新回合入口（无 resume_from）：清 gate ???数（上一回合的?批序号
      // 不漂移到本回合??同回合同工具第二次?批才?指?）
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
      // ?? rebase：??入口???史前?（版本?行数?度有界化）。??重放
      // （parent_checkpoint 分叉?点指向?史?）与恢???（resume_from 落点
      // 可能落在保留窗口外）均跳???，避免?掉分叉目?/恢??点。
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
      // 哨兵：任??束（含?常）?入?，事件流据此收?，无超???
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
      // 消?方提前退出（断?/break）：后台任?无法?取消（平台??降?，
      // ?文件?注），但注入残留仍?清理??注入?一次性（已注入决策的?批
      // ??放弃，防?控??），残留会泄漏到下一次 run 被静默消?
      if (opts.inject !== null && opts.inject !== undefined) {
        for (const key of Object.keys(opts.inject)) {
          this._coordinator.pending_inject.delete(key);
        }
      }
    }
  }

  /**
   * 非流式?行（独立子?/一次性任???）：?行到?止，返回?? RunResult。
   *
   * 与 run 的差?：不?出事件?列（事件仍? options.transports + 本参数
   * transports 推送，?合 CollectorTransport 收集/??日志?景），直接返回
   * 最??果。注入?同?一次性清理（防残留泄漏，与 run 同??）。
   */
  async ainvoke(state: Record<string, unknown>, opts: EngineRunOptions = {}): Promise<RunResult> {
    const thread_id = opts.thread_id ?? _default_id('thread');
    const trace_id = opts.trace_id ?? _default_id('trace');
    // per-run 状??位（与 run() 同??：??入口不跨 run 残留）
    this._event_counter = 0;
    this._latest_event_seq = null;
    this._chain_advanced = false;
    // ??推送保序状??位（同 thread 跨 run 不串台）
    this._transport_seq.reset();
    this._validate_entry_mode({ resume_from: opts.resume_from ?? null, continue_chain: opts.continue_chain ?? false });
    try {
      // 新回合入口（无 resume_from）：清 gate ???数（与 run() 同口径）
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
      // ??重放（parent_checkpoint 分叉）与恢???（resume_from ?点可能
      // 落在保留窗口外）均跳???，避免?掉分叉目?/恢??点
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
        // ?加而非替?：事件? options.transports + 本参数 transports 推送
        // （与 run() 同口径，防静???/落???被静默停掉）
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

  /** 入口模式契?：??与?点恢???互斥，同置?式拒?。 */
  _validate_entry_mode(opts: { resume_from: number | null; continue_chain: boolean }): void {
    if (opts.continue_chain && opts.resume_from !== null) {
      throw new GraphDefinitionError(
        'continue_chain 与 resume_from ??互斥（?? = 从?尾?接不重放；' +
          '恢? = 按?点快照 + 事件重放）',
      );
    }
  }

  /**
   * 回合指?采集（引擎自承?：??自身可?的?行事?）。
   *
   * ?? run 收尾?用一次：回合成?（???止 = 失?）与??摘要入回合指?；
   * ??分/收??数/?位?用由使用方按事件??填?（引擎只采集?行本身
   * 可?的??，??化指?不替使用方猜）。
   */
  _record_run_metrics(result: RunResult): void {
    const metrics = this.options.metrics;
    if (metrics === null) return;
    const failed = result.reason === TerminateReason.ERROR;
    metrics.record_turn({ failed, error: result.error ?? '' });
  }

  /**
   * 回溯??：从决策点前?点恢?，?制改?指定分支重放后?。
   *
   * 推演-回溯-??的?行??：决策点完成后主?提交的是???果；?落?分支
   * 做回溯?比/?? = 回到决策点?点?行前的 checkpoint ?点（决策点自身的
   * checkpoint 已是??后状?），?制指定分支序号重放??重放只?行目?分支
   * （其余分支的?果保留在各自独立子?，可回溯?比），主?状?最? = 目?
   * 分支的?果。?点可用 Engine.decision_anchor 从决策事件反?。
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
        throw new SimulationError(`???点不存在: ${opts.before_checkpoint_id}`);
      }
      if (anchor.reason !== null && anchor.reason !== 'interrupted') {
        throw new SimulationError(
          '???点??决策点?行前的 checkpoint' +
            `（当前?点已是??: ${anchor.reason}）`,
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
