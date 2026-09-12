/**
 * Runtime 在途 run 登记 + 审批决议辅助（runtime.py 移植）。
 *
 * 在途 run 登记表 + 排空信号（stop 据此等待自然完成）；abort_current_run
 * 以「当前 run」为粒度（多任务并发路由主机自行管理各自任务的取消）。
 * 审批决议续跑由执行运行时承载（execution.resume：checkpoint 锚点恢复 +
 * 决议注入，见 core/execution_runtime 与宿主 execution service），本层提供
 * 决议事件留痕与回合收尾调参入口。
 *
 * TS seam 差异：Python asyncio 任务取消（CancelledError 穿透引擎、节点
 * 不归异常重试路径）无 JS Promise 对应——_active_run_task 为宿主取消
 * 句柄 seam（cancel()/done() 协议），引擎侧取消语义随宿主 seam 迁移。
 */

import { TerminateReason } from '../../model/graph/graph_types.js';
import { CheckpointRecord } from '../../core/storage/storage_records.js';
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

  /** 审批决议 → 回合确认类事件（accept/edit/reject 归一；随线程累积，回合
   *  收尾账本钩子并入事实集合，防跨回合残留见 settle 边界清理钩子）。 */
  _record_review_decision(thread_id: string, key: string, injected: unknown): void {
    const value =
      typeof injected === 'string'
        ? injected
        : (injected as { decision?: unknown } | null)?.decision;
    const kind = typeof value === 'string' ? value : '';
    if (kind !== 'accept' && kind !== 'edit' && kind !== 'reject') return;
    const reason = (injected as { reason?: unknown } | null)?.reason;
    const bucket = this._round_review_events[thread_id] ?? [];
    bucket.push({
      kind,
      detail: {
        key,
        ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
      },
    });
    this._round_review_events[thread_id] = bucket;
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
}
