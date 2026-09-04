/**
 * 引擎事件发布/状态修补面（executor.py Engine 的事件发布、外部状态补丁、
 * 公开发射、链级 rebase 与决策锚点段移植）。
 *
 * 事件发布纪律：
 * - 落执行日志（append-only，拿 seq）→ 推送全部传输；存储/传输消费失败
 *   都不影响主流程（观测不阻断执行），存储故障按时间窗降频记录；
 * - 并发安全：并行节点组（计划步骤）成员并发发射事件——计数与 seq 锚点
 *   的登记经引擎级事件锁串行化；传输推送的保序在 _deliver_event 内完成
 *   （按 seq 排定顺序，避免并行组并发 emit 时推送顺序违背落库顺序）；
 * - seq 分配在事件锁内完成；传输推送在锁外按 seq 保序（避免持锁 await
 *   I/O 的潜在死锁，同时保证事件顺序与执行/落库顺序一致）。
 *
 * 保序协调器跨引擎共享：父引擎与 spawn 实例/嵌套子图推进同一 thread 事件
 * 日志（seq 全局）、推送同一传输链——缺孔只能由全局协调器补齐。
 */
import { CheckpointRecord } from '../storage/storage_records.js';
import type { ChainLink } from '../storage/storage_records.js';
import type { Storage } from '../storage/storage.js';
import { EngineEvent, type EngineTransport } from '../events/events.js';
import type { InterruptState } from '../interrupt/interrupt_types.js';
import type { JsonRecord } from '../json.js';
import { maybe_compact_chain } from '../chain_rebase/chain_rebase.js';
import type { RunResult } from '../run_result/run_result.js';
import { EngineBase } from './_engine_base.js';
import { _error, _warn, _now_monotonic_ms } from './_internals.js';

/** 事件日志写失败降频窗（毫秒；镜像 Python 5 秒 monotonic 窗）。 */
const _EVENT_LOG_ERROR_WINDOW_MS = 5000;

/** 事件副本回填 seq（Python ``dataclasses.replace(event, seq=seq)``）。 */
function _with_seq(event: EngineEvent, seq: number): EngineEvent {
  return new EngineEvent({
    type: event.type,
    payload: event.payload,
    step_id: event.step_id,
    parent_step_id: event.parent_step_id,
    round_id: event.round_id,
    node: event.node,
    graph_path: event.graph_path,
    seq,
    trace_id: event.trace_id,
    thread_id: event.thread_id,
    version: event.version,
  });
}

/**
 * 事件发布/状态修补/链压缩分层段（Engine 方法群）。
 */
export abstract class EngineEvents extends EngineBase {
  async _publish(event: EngineEvent, opts: { transports?: EngineTransport[] | null } = {}): Promise<void> {
    const transports = opts.transports ?? this.options.transports;
    let seq: number | null = null;
    await this._event_lock.with_lock(async () => {
      this._event_counter += 1;
      if (this.options.storage !== null) {
        try {
          const assigned = await this.options.storage.append_event(event.thread_id, event);
          seq = assigned;
          this._latest_event_seq = assigned;
        } catch (exc) {
          const now = _now_monotonic_ms();
          if (now - this._event_log_error_ts >= _EVENT_LOG_ERROR_WINDOW_MS) {
            this._event_log_error_ts = now;
            _error(`事件日志写入失败（忽略，继续执行）: ${String(exc)}`);
          }
        }
      }
    });
    // seq 分配在事件锁内完成；传输推送在锁外按 seq 保序
    await this._deliver_event(seq !== null ? _with_seq(event, seq) : event, seq, transports);
  }

  /**
   * 按 seq 顺序把事件推送给各传输（并行组并发 emit 也不乱序）。
   *
   * 落库 seq 已在事件锁内分配；此处仅负责传输推送的保序：seq 连续到达
   * 即依次发送并冲刷后续已缓冲事件。seq 缺失（无存储/落库失败）则立即
   * 发送（无 seq 可排序，退化为到达序）。换 run 时由调用方复位协调器。
   */
  async _deliver_event(event: EngineEvent, seq: number | null, transports: EngineTransport[]): Promise<void> {
    const seqr = this._transport_seq;
    await seqr.lock.with_lock(async () => {
      if (seq === null) {
        for (const transport of transports) {
          try {
            await transport.send(event);
          } catch (exc) {
            _warn(`事件传输失败（忽略）: ${event.type}: ${String(exc)}`);
          }
        }
        return;
      }
      if (seqr.next_seq === null) {
        seqr.next_seq = seq;
      }
      if (seq !== seqr.next_seq) {
        // 不是下一个预期 seq：先缓冲，待缺孔补齐后由后续冲刷统一发送
        seqr.pending.set(seq, event);
        return;
      }
      // 从当前 seq 起连续冲刷已到达事件（含本事件）
      let curSeq = seq;
      let curEvent = event;
      for (;;) {
        seqr.next_seq = curSeq + 1;
        for (const transport of transports) {
          try {
            await transport.send(curEvent);
          } catch (exc) {
            _warn(`事件传输失败（忽略）: ${curEvent.type}: ${String(exc)}`);
          }
        }
        const nxt = seqr.pending.get(curSeq + 1);
        if (nxt === undefined) break;
        seqr.pending.delete(curSeq + 1);
        curSeq += 1;
        curEvent = nxt;
      }
    });
  }

  /**
   * 外部状态补丁：读最新 checkpoint，按 schema reducer 合并 values 后写回
   * 新 checkpoint——不执行任何节点。
   *
   * 弹卡注入（review_action 写 review_decision 等）/手动压缩裁剪/cancel
   * 清挂起共用：挂起卡保留在 checkpoint，注入值以新快照形式持久化，下一次
   * resume 恢复状态时即生效（版本链续接，线性不断）。
   */
  async update_state(thread_id: string, values: Record<string, unknown>): Promise<void> {
    if (this.options.storage === null || Object.keys(values).length === 0) return;
    const latest = await this.options.storage.get_latest_checkpoint(thread_id);
    if (latest === null) return;
    const schema = this.options.schema;
    const merged =
      schema !== null ? schema.apply(latest.state, values) : { ...latest.state, ...values };
    // event_seq 沿用链尾：update_state 不产生任何执行事件，链尾与新快照的
    // 增量日志区间恒为空——resume 以任一锚点重放 events_after 均无重复。
    // interrupt 不沿袭链尾：外部补丁不是挂起轮，新快照不带挂起卡标记。
    await this.options.storage.put_checkpoint(
      new CheckpointRecord({
        checkpoint_id: 0,
        thread_id,
        node: null,
        state: merged as JsonRecord,
        parent_id: latest.checkpoint_id,
        event_seq: latest.event_seq,
        graph_version: this._graph_digest,
        // 计划快照沿袭链尾：注入/裁剪产生的新链尾不得丢计划游标
        plan: latest.plan,
      }),
    );
  }

  /**
   * 读取链尾挂起卡（中断键 + 卡负载 + 定位），续流恢复定位锚点。
   * 链尾无挂起卡（未中断/补丁快照/无存储）返回 null。
   */
  async get_latest_interrupt(thread_id: string): Promise<InterruptState | null> {
    if (this.options.storage === null) return null;
    const latest = await this.options.storage.get_latest_checkpoint(thread_id);
    if (latest === null || latest.interrupt === null) return null;
    return latest.interrupt;
  }

  /**
   * 公开事件发射入口（机制件注入事件流：孵化动态 → 前端演化页签）。
   *
   * 构造系统信号（step_id=null——孵化动态非回合步骤），落执行日志 + 推送
   * 全部传输。观测不阻断：发射失败由 _publish 吞异常并记日志。
   */
  async publish_event(
    etype: string,
    payload: Record<string, unknown>,
    opts: { thread_id?: string | null; round_id?: string | null; node?: string | null } = {},
  ): Promise<void> {
    await this._publish(
      new EngineEvent({
        type: etype,
        payload: payload as JsonRecord,
        step_id: null,
        round_id: opts.round_id ?? null,
        node: opts.node ?? null,
        thread_id: opts.thread_id ?? '-',
        trace_id: '-',
      }),
    );
  }

  /**
   * 链级 rebase 入口（fail-open：压缩失败不阻断执行）。
   *
   * 宿主自定义存储未实现压缩原语时跳过——版本链照常增长，功能不受损；
   * 引擎内置后端（memory/sqlite/postgres）均已实现（宿主侧）。
   */
  async _maybe_compact_chain(thread_id: string): Promise<void> {
    const storage = this.options.storage;
    if (storage === null || this.options.checkpoint_keep <= 0) return;
    let outcome;
    try {
      outcome = await maybe_compact_chain(storage, thread_id, this.options.checkpoint_keep);
    } catch (exc) {
      _warn(`链级 rebase 不可用（跳过）: ${String(exc)}`);
      return;
    }
    if (outcome.compacted) {
      // 链级 rebase: 删除 N 行/改写 M 个链头/裁剪 K 条事件（观测留痕）
      _warn(
        `链级 rebase: thread=${thread_id} 删除 ${outcome.removed} 行、` +
          `改写链头 ${outcome.rewired} 个、裁剪事件 ${outcome.trimmed} 条`,
      );
    }
  }

  /**
   * 定位最近一次决策点执行前的恢复锚点（换选辅助）。
   *
   * 决策事件（simulate_decision）在事件流中记录决策点位置；锚点 = 该事件
   * seq 之前的最后一个 checkpoint（事件流与版本链同序对齐，恢复 = 快照 +
   * 增量重放，锚点取决策前的快照才可重演决策点）。null = 无决策点留痕。
   */
  static async decision_anchor(storage: Storage, thread_id: string): Promise<number | null> {
    const events = await storage.events_after(thread_id, 0);
    let anchor_seq: number | null = null;
    for (const event of events) {
      if (event.type === 'simulate_decision') {
        anchor_seq = event.seq;
      }
    }
    if (anchor_seq === null) return null;
    let best: ChainLink | null = null;
    for (const link of await storage.chain_index(thread_id)) {
      if (link.event_seq < anchor_seq && (best === null || link.event_seq > best.event_seq)) {
        best = link;
      }
    }
    return best !== null ? best.checkpoint_id : null;
  }
}

export type { EngineBase, RunResult };
