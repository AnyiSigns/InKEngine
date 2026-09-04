/**
 * Runtime 在途 run 登记 + 审批决议重入样板（runtime.py 移植）。
 *
 * 在途 run 登记表 + 排空信号（stop 据此等待自然完成）；abort_current_run
 * 以「当前 run」为粒度（多任务并发路由主机自行管理各自任务的取消）。
 * resume_run = 审批决议重入样板：挂起卡 → checkpoint 锚点 → ainvoke
 * (resume_from, inject) 下沉（决议形态由宿主构造与校验，本方法只负责
 * 重入执行本身）。
 *
 * TS seam 差异：Python asyncio 任务取消（CancelledError 穿透引擎、节点
 * 不归异常重试路径）无 JS Promise 对应——_active_run_task 为宿主取消
 * 句柄 seam（cancel()/done() 协议），引擎侧取消语义随宿主 seam 迁移。
 */

import { TerminateReason } from '../graph/graph_types.js';
import { CheckpointRecord } from '../storage/storage_records.js';
import type { EngineTransport } from '../events/events.js';
import { MetaTuner } from '../tuning/index.js';
import { RuntimeState } from './_types.js';
import { _uuid_hex } from './_runtime_base.js';
import { RuntimeStateMachine } from './_runtime_state.js';

/** 在途 run 任务取消句柄 seam（宿主注入；镜像 Python asyncio.Task 子集）。 */
export interface RunTaskHandle {
  done(): boolean;
  cancel(): void;
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

/** 回合登记 + 决议重入基座。 */
export abstract class RuntimeRunControl extends RuntimeStateMachine {
  /** 登记一个在途 run（非 running 状态显式报错：pause 拒新、stop 拒新）。 */
  begin_run(thread_id?: string | null): { id: string } {
    if (this._state !== RuntimeState.RUNNING) {
      throw new Error(
        `运行时状态不允许开始新 run: ${this._state}`
          + '（pause 拒新、stop 拒新，在途 run 自然完成后可恢复）',
      );
    }
    const ticket = { id: _uuid_hex() };
    this._active_runs[ticket.id] = ticket;
    this._active_ticket_id = ticket.id;
    this._active_run_task = null; // 由宿主登记任务句柄（无句柄 = 只登记）
    this._active_run_thread = thread_id ?? null;
    this._drained.done = false;
    return ticket;
  }

  /** 宿主登记当前 run 的任务取消句柄（abort_current_run 的依据）。 */
  register_active_run_task(task: RunTaskHandle | null): void {
    this._active_run_task = task;
  }

  /** 注销一个在途 run（幂等；全部注销后 stop 的排空等待解除）。 */
  end_run(ticket: { id: string }): void {
    if (ticket.id in this._active_runs) {
      delete this._active_runs[ticket.id];
      if (ticket.id === this._active_ticket_id) {
        this._active_ticket_id = null;
        this._active_run_task = null;
        this._active_run_thread = null;
      }
      if (Object.keys(this._active_runs).length === 0) {
        this._signal_drained();
      }
    }
  }

  /** 中止当前在途 run（取消 → CANCELLED 终止快照 → 可续跑）。
   *  True = 有在途 run 且已中止；False = 无在途 run / 任务已自然完成。
   *  自取消（从被中止的 run 自身发起）显式报错。 */
  async abort_current_run(): Promise<boolean> {
    if (Object.keys(this._active_runs).length === 0) {
      return false;
    }
    const task = this._active_run_task;
    if (task === null || task.done()) return false;
    if (task.then === undefined) return false;
    // 线程 id 先取用：任务收尾时 end_run 会清空登记（快照锚点须在取消前读取）
    const thread_id = this._active_run_thread;
    task.cancel();
    // 等待任务真正停止（取消只是投递；异常属预期终止路径，吞掉即可）
    try {
      await (task as unknown as PromiseLike<unknown>);
    } catch {
      // CancelledError 属预期终止路径
    }
    await this._write_abort_checkpoint(thread_id);
    return true;
  }

  /** 取消后的 CANCELLED 终止快照（链尾续接，恢复锚点语义与中断卡一致）。
   *  快照写入失败只吞异常：中止本身已完成，快照是续跑的恢复锚点。 */
  async _write_abort_checkpoint(thread_id: string | null): Promise<void> {
    if (this.storage === null) return;
    if (thread_id === null) return;
    try {
      const latest = await this.storage.get_latest_checkpoint(thread_id);
      if (latest === null) return;
      await this.storage.put_checkpoint(
        new CheckpointRecord({
          checkpoint_id: 0,
          thread_id,
          node: latest.node,
          graph_path: latest.graph_path,
          state: latest.state,
          parent_id: latest.checkpoint_id,
          reason: TerminateReason.CANCELLED,
          event_seq: latest.event_seq,
          graph_version: latest.graph_version,
          plan: latest.plan as never,
        }),
      );
    } catch {
      // 中止快照写入失败（不影响中止本身）
    }
  }

  /** 审批决议重入：挂起卡 → 决议注入 → 续跑。无挂起卡或卡已失效显式报错。 */
  async resume_run(
    thread_id: string,
    decision: Record<string, unknown>,
    options: { round_id?: string | null; transports?: EngineTransport[] | null } = {},
  ): Promise<unknown> {
    if (this.engine === null || this.storage === null) {
      throw new Error('运行时未装配或引擎未重建（无法决议重入）');
    }
    const interrupt = await this.engine.get_latest_interrupt(thread_id);
    if (interrupt === null) {
      throw new Error('该会话无挂起审批卡');
    }
    const latest = await this.storage.get_latest_checkpoint(thread_id);
    if (latest === null || latest.interrupt === null) {
      throw new Error('挂起卡已失效，请重新发起回合');
    }
    const ticket = this.begin_run(thread_id);
    let result: unknown = null;
    try {
      result = await this.engine.ainvoke(
        {},
        {
          thread_id,
          round_id: options.round_id ?? null,
          resume_from: latest.checkpoint_id,
          inject: { [interrupt.key]: decision },
          transports: options.transports ?? null,
        },
      );
      return result;
    } finally {
      this.end_run(ticket);
      this._tune_round_end(result);
    }
  }

  /** 回合收尾调参（E-P5 接线入口）：失败信号聚合 → MetaTuner 调参。
   *  未装配（meta_tuner 缺省 null）或调参无变化 = no-op。 */
  tune_after_round(options: { failed?: boolean; error?: string } = {}): unknown {
    const failed = options.failed ?? false;
    const error = options.error ?? '';
    if (this.meta_tuner === null || this.turn_metrics === null) return null;
    if (this.knowledge_set === null) return null;
    this.turn_metrics.record_turn({ failed, error });
    const params = MetaTuner.load_params(this.knowledge_set);
    return this.meta_tuner.tune_persisted(params, this.turn_metrics);
  }

  /** resume_run 收尾调参（best-effort；结果缺失 = 失败信号）。 */
  _tune_round_end(result: unknown): void {
    if (this.meta_tuner === null) return;
    try {
      const error = (result as { error?: unknown } | null)?.error;
      const failed = result === null || result === undefined || Boolean(error);
      this.tune_after_round({
        failed,
        error: error
          ? String(error)
          : result === null || result === undefined
            ? '回合执行异常（无结果）'
            : '',
      });
    } catch {
      // 回合收尾调参失败（忽略）
    }
  }
}
