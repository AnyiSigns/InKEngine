/**
 * 内存存储 checkpoint 版本链方法层（storage_memory.py 版本链移植）。
 *
 * 与 sqlite/postgres 后端同口径的写入不变量：
 * - 序列化契约：写入前 to_dict 严格 JSON 判定 + from_dict 精确还原；
 * - 新节点（checkpoint_id=0）走守卫式续链：悬挂/跨线程父指针与
 *   event_seq 回退在写入期拒绝（链一致性不变量），链尾已前进拒绝
 *   （并发写保护）；fork 分叉豁免上述校验（编辑重放锚点历史链）；
 * - 显式更新（checkpoint_id!=0）：不存在抛 StorageError（杜绝静默插入
 *   任意 id），乐观锁 expected_version 不匹配抛 CheckpointConflictError，
 *   父指针不可变（改写是链级 rebase 专属操作 set_checkpoint_parent）；
 * - 全部读取返回深拷贝副本（调用方修改返回记录不得污染存储内快照）。
 */

import { CheckpointConflictError, StorageError } from '../../core/errors.js';
import {
  DEFAULT_LIST_CHECKPOINTS_LIMIT,
} from '../../core/storage/storage_constants.js';
import { ChainLink, CheckpointRecord } from '../../core/storage/storage_records.js';

import { MemoryStorageBase } from './_base.js';
import {
  copyCheckpointRecord,
  normalizeCheckpointRecord,
} from './_serialize.js';

/** checkpoint 版本链方法层（MemoryStorage 的中间基类，状态在基座）。 */
export class MemoryStorageCheckpoints extends MemoryStorageBase {
  async get_checkpoint(checkpoint_id: number): Promise<CheckpointRecord | null> {
    return this.lock.run(() => {
      const record = this.checkpoints.get(checkpoint_id);
      return record !== undefined ? copyCheckpointRecord(record) : null;
    });
  }

  async get_latest_checkpoint(thread_id: string): Promise<CheckpointRecord | null> {
    return this.lock.run(() => {
      const latest_id = this.latest_checkpoint_by_thread.get(thread_id);
      if (latest_id === undefined) return null;
      const record = this.checkpoints.get(latest_id);
      return record !== undefined ? copyCheckpointRecord(record) : null;
    });
  }

  async put_checkpoint(
    record: CheckpointRecord,
    opts: { expected_version?: number | null; fork?: boolean } = {},
  ): Promise<CheckpointRecord> {
    return this.lock.run(() => {
      const expected_version = opts.expected_version ?? null;
      const fork = opts.fork ?? false;
      const rec = normalizeCheckpointRecord(record);
      if (rec.checkpoint_id === 0) {
        return this._insert(rec, fork);
      }
      // 显式更新路径（checkpoint_id != 0）：与 sqlite/postgres 同口径
      const existing = this.checkpoints.get(rec.checkpoint_id);
      if (existing === undefined) {
        throw new StorageError(`checkpoint 不存在: ${rec.checkpoint_id}`);
      }
      // expected_version=None = 自动读当前版本
      const expected = expected_version ?? existing.version;
      if (existing.version !== expected) {
        throw new CheckpointConflictError(
          `checkpoint ${rec.checkpoint_id} 并发写冲突: `
            + `expected version=${expected}, actual=${existing.version}`,
        );
      }
      // 更新经 to_dict/from_dict 规范化；父指针不可变（保留链上原有父指针）
      const updated = CheckpointRecord.from_dict({
        ...rec.to_dict(),
        version: existing.version + 1,
        parent_id: existing.parent_id,
      });
      this.checkpoints.set(rec.checkpoint_id, updated);
      this.advance_tail(rec.thread_id, rec.checkpoint_id);
      return copyCheckpointRecord(updated);
    });
  }

  /** 新节点（checkpoint_id=0）守卫式续链插入 + 自增 id 分配。 */
  private _insert(rec: CheckpointRecord, fork: boolean): CheckpointRecord {
    if (!fork && rec.parent_id !== null) {
      // 链一致性不变量（与 sqlite/postgres 同语义，锁内原子判定）：
      // 父指针必须存在且属于同一 thread、event_seq 不高于新节点
      const parent = this.checkpoints.get(rec.parent_id);
      if (
        parent === undefined
        || parent.thread_id !== rec.thread_id
        || parent.event_seq > rec.event_seq
      ) {
        throw new CheckpointConflictError(
          `checkpoint 写入被拒绝（父指针不存在/跨线程/event_seq 回退）: `
            + `thread=${rec.thread_id} parent=#${rec.parent_id}`,
        );
      }
      // 并发写保护（与 sqlite/postgres 同语义，锁内校验原子）：
      // 链尾仍是 parent_id 才插入；链已前进（并发写）→ 冲突
      const latest_id = this.latest_checkpoint_by_thread.get(rec.thread_id);
      if (latest_id !== undefined && latest_id > rec.parent_id) {
        throw new CheckpointConflictError(
          `checkpoint 并发写冲突（链尾已前进）: thread=${rec.thread_id}`,
        );
      }
    }
    const checkpoint_id = this.next_checkpoint_id;
    this.next_checkpoint_id += 1;
    const created = new CheckpointRecord({
      checkpoint_id,
      thread_id: rec.thread_id,
      node: rec.node,
      graph_path: rec.graph_path,
      state: rec.state,
      parent_id: rec.parent_id,
      reason: rec.reason,
      created_at: rec.created_at,
      version: 1, // 与 sqlite/postgres 同口径：新节点 version 恒 1
      event_seq: rec.event_seq,
      error: rec.error,
      interrupt: rec.interrupt,
      graph_version: rec.graph_version,
      plan: rec.plan,
    });
    this.checkpoints.set(checkpoint_id, created);
    this.advance_tail(rec.thread_id, checkpoint_id);
    return copyCheckpointRecord(created);
  }

  async list_checkpoints(
    thread_id: string,
    opts: { limit?: number } = {},
  ): Promise<CheckpointRecord[]> {
    return this.lock.run(() => {
      const limit = opts.limit ?? DEFAULT_LIST_CHECKPOINTS_LIMIT;
      const candidates: CheckpointRecord[] = [];
      for (const c of this.checkpoints.values()) {
        if (c.thread_id === thread_id) candidates.push(c);
      }
      candidates.sort((a, b) => b.checkpoint_id - a.checkpoint_id);
      return candidates.slice(0, limit).map((c) => copyCheckpointRecord(c));
    });
  }

  async chain_index(thread_id: string): Promise<ChainLink[]> {
    return this.lock.run(() => {
      const links: ChainLink[] = [];
      for (const c of this.checkpoints.values()) {
        if (c.thread_id !== thread_id) continue;
        links.push(
          new ChainLink({
            checkpoint_id: c.checkpoint_id,
            parent_id: c.parent_id,
            event_seq: c.event_seq,
            graph_path: c.graph_path,
            reason: c.reason,
          }),
        );
      }
      links.sort((a, b) => b.checkpoint_id - a.checkpoint_id);
      return links;
    });
  }

  async delete_checkpoints(thread_id: string, ids: readonly number[]): Promise<number> {
    return this.lock.run(() => {
      const target = new Set(ids);
      let removed = 0;
      for (const cid of target) {
        // 先校验归属再删除（与 SQL 后端 WHERE thread_id=? 过滤同口径）：
        // 跨线程 id 不得被静默删除
        const record = this.checkpoints.get(cid);
        if (record === undefined || record.thread_id !== thread_id) continue;
        this.checkpoints.delete(cid);
        removed += 1;
        // 链尾指针防退：删除行恰为链尾时重算为剩余最大 id（误用兜底）
        if (this.latest_checkpoint_by_thread.get(thread_id) === cid) {
          let remaining = -1;
          for (const c of this.checkpoints.values()) {
            if (c.thread_id === thread_id && c.checkpoint_id > remaining) {
              remaining = c.checkpoint_id;
            }
          }
          if (remaining === -1) {
            this.latest_checkpoint_by_thread.delete(thread_id);
          } else {
            this.latest_checkpoint_by_thread.set(thread_id, remaining);
          }
        }
      }
      return removed;
    });
  }

  async set_checkpoint_parent(
    thread_id: string,
    checkpoint_id: number,
    parent_id: number | null,
  ): Promise<number> {
    return this.lock.run(() => {
      const existing = this.checkpoints.get(checkpoint_id);
      if (existing === undefined || existing.thread_id !== thread_id) {
        return 0; // 与 SQL 后端同口径：无匹配行静默无操作（幂等）
      }
      this.checkpoints.set(
        checkpoint_id,
        CheckpointRecord.from_dict({ ...existing.to_dict(), parent_id }),
      );
      return 1;
    });
  }
}
