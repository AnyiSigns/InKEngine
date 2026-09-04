/**
 * 引擎统一 checkpoint 写入面（executor.py Engine._write_checkpoint 移植）。
 *
 * 链写入不变量单点维护：
 * - 恢复锚点权威来源 = 事件日志本身（跨实例/跨 run/子图事件全部自然包含，
 *   无内存态依赖；恢复 = 快照 + 该 seq 之后的增量重放），seq 取内存态
 *   （_publish 已维护），避免每节点一次 latest_event_seq 查询；
 * - 链尾跟随：嵌套子图/spawn 实例推进过链尾（或恢复续跑）时 parent 跟随
 *   当前链尾（版本链严格线性，跨引擎连续），查一次后复位；
 * - 编辑重放分叉（fork_write=True）首写跳过链尾校验（锚点指向历史链）。
 *
 * 失败回滚：事件已落库但 checkpoint 快照未提交时，本节点之后的孤立事件若
 * 被后续恢复重放 + 节点重执行会双重发射——回滚父快照之后的孤立事件（标记
 * 该段不可恢复），并向上抛出明确错误（存储失败不静默吞掉）。
 */
import { CheckpointRecord } from '../storage/storage_records.js';
import type { Storage } from '../storage/storage.js';
import type { JsonRecord } from '../json.js';
import type { InterruptState } from '../interrupt/interrupt_types.js';
import { tail_checkpoint } from '../recovery/index.js';
import { EngineInstance } from './_engine_instance.js';
import type { NodeContext } from './_internals.js';
import { _error } from './_internals.js';

/** _write_checkpoint 选项（镜像 Python 关键字参）。 */
export interface WriteCheckpointOptions {
  storage: Storage;
  thread_id: string;
  chain_thread: string;
  ctx: NodeContext;
  node: string;
  state: Record<string, unknown>;
  parent_id: number | null;
  fork_write: boolean;
  reason?: string | null;
  error?: string | null;
  interrupt?: InterruptState | null;
  plan?: JsonRecord | null;
}

/** checkpoint 写入分层段（Engine 方法群）。 */
export abstract class EngineCheckpoint extends EngineInstance {
  /**
   * 统一 checkpoint 写入（主循环/计划步共用，链写入不变量单点维护）。
   *
   * @returns [落库记录, 新的 fork_write 值]——fork 仅在首次写生效，
   *   返回 False。
   */
  async _write_checkpoint(opts: WriteCheckpointOptions): Promise<[CheckpointRecord, boolean]> {
    let { parent_id, fork_write } = opts;
    const event_seq =
      this._latest_event_seq !== null
        ? this._latest_event_seq
        : await opts.storage.latest_event_seq(opts.thread_id);
    if (this._chain_advanced) {
      const tail = await tail_checkpoint(opts.storage, opts.chain_thread);
      if (tail !== null) {
        parent_id = tail.checkpoint_id;
      }
      this._chain_advanced = false;
    }
    let record: CheckpointRecord;
    try {
      record = await opts.storage.put_checkpoint(
        new CheckpointRecord({
          checkpoint_id: 0,
          thread_id: opts.chain_thread,
          node: opts.node,
          graph_path: opts.ctx.graph_path,
          state: opts.state as JsonRecord,
          parent_id,
          reason: opts.reason ?? null,
          event_seq,
          error: opts.error ?? null,
          interrupt: opts.interrupt ?? null,
          graph_version: this._graph_digest,
          plan: opts.plan ?? null,
        }),
        { fork: fork_write },
      );
    } catch (exc) {
      // 事件已落库但 checkpoint 快照未提交：本节点之后的孤立事件若被后续
      // 恢复重放 + 节点重执行会双重发射。此处回滚父快照之后的孤立事件
      // （标记该段不可恢复），并向上抛出明确错误（存储失败不静默吞掉）
      _error(
        `checkpoint 写入失败（事件已落库但快照未提交，尝试回滚孤立事件）: ` +
          `thread=${opts.chain_thread} node=${opts.node} event_seq=${event_seq}: ${String(exc)}`,
      );
      try {
        if (parent_id !== null) {
          const parentCp = await opts.storage.get_checkpoint(parent_id);
          const parentSeq = parentCp !== null ? parentCp.event_seq : -1;
          // 删除父快照之后的孤立事件（seq > parent_seq），使恢复重放不会
          // 与重执行叠加造成事件双重发射
          await opts.storage.truncate_events(opts.chain_thread, parentSeq);
        }
      } catch (truncExc) {
        _error(`孤立事件回滚失败（恢复可能重复发射）: ${String(truncExc)}`);
      }
      throw exc;
    }
    return [record, false];
  }
}
