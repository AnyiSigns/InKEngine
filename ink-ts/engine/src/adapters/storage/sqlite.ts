/**
 * SQLite 存储实现（SqliteStorage，node:sqlite DatabaseSync，单机/测试默认
 * 持久后端）。三表：checkpoints（版本链 + 乐观锁）、event_log（append-only
 * 执行日志）、records（结构化记录，JSON 列）。schema DDL 与 Python
 * storage_sqlite.py 1:1 同构，对外是 core Storage async seam 的宿主实现。
 *
 * 本文件 = 无状态编排面：连接生命周期/串行互斥/快照恢复来自 sqlite_base.ts，
 * checkpoint 写入语句与行转换来自 sqlite_checkpoints.ts；错误映射与 Python
 * 一致（CheckpointConflictError 透传，其余统一包成带 sqlite 前缀的
 * StorageError）。
 *
 * 驱动选型：Node 22+ 内置 node:sqlite（DatabaseSync）同步驱动，零第三方
 * 依赖；`@types/node` 24 自带 node:sqlite 类型声明。
 */

import { EngineEvent, parse_event_lenient } from '../../core/events/events.js';
import { CheckpointConflictError, StorageError } from '../../core/errors.js';
import type { JsonRecord } from '../../core/json.js';
import { strip_sensitive } from '../../core/security/security.js';
import type { Storage } from '../../core/storage/storage.js';
import { DEFAULT_LIST_CHECKPOINTS_LIMIT } from '../../core/storage/storage_constants.js';
import { ChainLink, CheckpointRecord } from '../../core/storage/storage_records.js';
import { SqliteBaseStorage } from './sqlite_base.js';
import { strictDumps } from './sqlite_json.js';
import {
  checkpointData,
  insertCheckpoint,
  rowToCheckpointRecord,
  updateCheckpoint,
} from './sqlite_checkpoints.js';
import type { SqliteRow } from './sqlite_checkpoints.js';

/** 错误消息提取（python `str(exc)` 同口径）。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Python `dict.get(k) or 缺省` 布尔口径的 TEXT 兜底（空串/null → 缺省文本）。 */
function jsonTextOr(value: unknown, fallback: string): string {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

export class SqliteStorage extends SqliteBaseStorage implements Storage {
  // ── checkpoint 版本链 ──
  async get_checkpoint(checkpoint_id: number): Promise<CheckpointRecord | null> {
    return this._serial(async () => {
      await this._connect();
      try {
        const row = this.db.prepare('SELECT * FROM checkpoints WHERE checkpoint_id = ?').get(checkpoint_id);
        return row === undefined ? null : rowToCheckpointRecord(row);
      } catch (err) {
        throw new StorageError(`sqlite 读取 checkpoint 失败: ${errMsg(err)}`);
      }
    });
  }

  async get_latest_checkpoint(thread_id: string): Promise<CheckpointRecord | null> {
    return this._serial(async () => {
      await this._connect();
      try {
        const row = this.db
          .prepare('SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC LIMIT 1')
          .get(thread_id);
        return row === undefined ? null : rowToCheckpointRecord(row);
      } catch (err) {
        throw new StorageError(`sqlite 读取最新 checkpoint 失败: ${errMsg(err)}`);
      }
    });
  }

  async put_checkpoint(
    record: CheckpointRecord,
    opts: { expected_version?: number | null; fork?: boolean } = {},
  ): Promise<CheckpointRecord> {
    return this._serial(async () => {
      await this._connect();
      try {
        if (record.checkpoint_id === 0) {
          // 新链节点：插入后返回自增 id（fork/链头普通插入；续链守卫插入）
          const guarded = opts.fork !== true && record.parent_id !== null;
          return insertCheckpoint(this.db, checkpointData(record), guarded);
        }
        // 已存在：乐观锁更新（expected_version 期望校验，冲突抛异常）
        return updateCheckpoint(
          this.db,
          checkpointData(record),
          record.checkpoint_id,
          opts.expected_version ?? null,
        );
      } catch (err) {
        if (err instanceof CheckpointConflictError) throw err;
        throw new StorageError(`sqlite checkpoint 写入失败: ${errMsg(err)}`);
      }
    });
  }

  async list_checkpoints(thread_id: string, opts: { limit?: number } = {}): Promise<CheckpointRecord[]> {
    return this._serial(async () => {
      await this._connect();
      const limit = opts.limit ?? DEFAULT_LIST_CHECKPOINTS_LIMIT;
      try {
        const rows = this.db
          .prepare('SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC LIMIT ?')
          .all(thread_id, limit);
        return rows.map((r) => rowToCheckpointRecord(r));
      } catch (err) {
        throw new StorageError(`sqlite 列出 checkpoints 失败: ${errMsg(err)}`);
      }
    });
  }

  async chain_index(thread_id: string): Promise<ChainLink[]> {
    return this._serial(async () => {
      await this._connect();
      try {
        const rows = this.db
          .prepare(
            'SELECT checkpoint_id, parent_id, event_seq, graph_path, reason' +
              ' FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC',
          )
          .all(thread_id);
        return rows.map(
          (row) =>
            new ChainLink({
              checkpoint_id: Number(row['checkpoint_id']),
              parent_id: (row['parent_id'] as number | null) ?? null,
              event_seq: Number(row['event_seq']),
              graph_path: JSON.parse(jsonTextOr(row['graph_path'], '[]')) as string[],
              reason: (row['reason'] as string | null) ?? null,
            }),
        );
      } catch (err) {
        throw new StorageError(`sqlite 读取链索引失败: ${errMsg(err)}`);
      }
    });
  }

  async delete_checkpoints(thread_id: string, ids: readonly number[]): Promise<number> {
    return this._serial(async () => {
      await this._connect();
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => '?').join(',');
      try {
        const res = this.db
          .prepare(`DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id IN (${placeholders})`)
          .run(thread_id, ...(ids as number[]));
        return Number(res.changes);
      } catch (err) {
        throw new StorageError(`sqlite 删除 checkpoints 失败: ${errMsg(err)}`);
      }
    });
  }

  async set_checkpoint_parent(thread_id: string, checkpoint_id: number, parent_id: number | null): Promise<number> {
    return this._serial(async () => {
      await this._connect();
      try {
        const res = this.db
          .prepare('UPDATE checkpoints SET parent_id = ? WHERE thread_id = ? AND checkpoint_id = ?')
          .run(parent_id, thread_id, checkpoint_id);
        return Number(res.changes) || 0;
      } catch (err) {
        throw new StorageError(`sqlite 改写 checkpoint 父指针失败: ${errMsg(err)}`);
      }
    });
  }

  // ── 执行事件日志（append-only）──
  async append_event(thread_id: string, event: EngineEvent): Promise<number> {
    return this._serial(async () => {
      await this._connect();
      try {
        // 安全：事件负载落库前剥离敏感键 + seq 归零（与 checkpoint 同口径）
        const stripped = new EngineEvent({
          type: event.type,
          payload: strip_sensitive(event.payload) as JsonRecord,
          step_id: event.step_id,
          parent_step_id: event.parent_step_id,
          round_id: event.round_id,
          node: event.node,
          graph_path: event.graph_path,
          seq: 0,
          trace_id: event.trace_id,
          thread_id: event.thread_id,
          version: event.version,
        });
        const res = this.db
          .prepare('INSERT INTO event_log (thread_id, event) VALUES (?, ?)')
          .run(thread_id, stripped.to_json());
        return Number(res.lastInsertRowid);
      } catch (err) {
        // 高频路径不在此记日志（与 Python 同：由上层统一降频记录）
        throw new StorageError(`sqlite 事件日志写入失败: ${errMsg(err)}`);
      }
    });
  }

  async events_after(thread_id: string, seq: number): Promise<EngineEvent[]> {
    return this._serial(async () => {
      await this._connect();
      let rows: SqliteRow[];
      try {
        rows = this.db
          .prepare('SELECT seq, event FROM event_log WHERE thread_id = ? AND seq > ? ORDER BY seq')
          .all(thread_id, seq);
      } catch (err) {
        throw new StorageError(`sqlite 事件日志读取失败: ${errMsg(err)}`);
      }
      // 逐条容错解析（ENG5-4）：单条旧版本/损坏事件跳过，不中断整段重放
      const events: EngineEvent[] = [];
      for (const row of rows) {
        let raw: unknown;
        try {
          raw = JSON.parse(String(row['event']));
        } catch {
          continue; // 事件行 JSON 损坏，跳过（回放容错）
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const event = parse_event_lenient({ ...(raw as Record<string, unknown>), seq: row['seq'] });
        if (event !== null) events.push(event);
      }
      return events;
    });
  }

  async truncate_events(thread_id: string, after_seq: number): Promise<void> {
    return this._serial(async () => {
      await this._connect();
      try {
        this.db.prepare('DELETE FROM event_log WHERE thread_id = ? AND seq > ?').run(thread_id, after_seq);
      } catch (err) {
        throw new StorageError(`sqlite 事件日志截断失败: ${errMsg(err)}`);
      }
    });
  }

  async trim_events(thread_id: string, before_seq: number): Promise<number> {
    return this._serial(async () => {
      await this._connect();
      try {
        const res = this.db
          .prepare('DELETE FROM event_log WHERE thread_id = ? AND seq <= ?')
          .run(thread_id, before_seq);
        return Number(res.changes);
      } catch (err) {
        throw new StorageError(`sqlite 事件日志裁剪失败: ${errMsg(err)}`);
      }
    });
  }

  async latest_event_seq(thread_id: string): Promise<number> {
    return this._serial(async () => {
      await this._connect();
      try {
        const row = this.db
          .prepare('SELECT seq FROM event_log WHERE thread_id = ? ORDER BY seq DESC LIMIT 1')
          .get(thread_id);
        return row === undefined ? 0 : Number(row['seq']);
      } catch (err) {
        throw new StorageError(`sqlite 读取最新事件 seq 失败: ${errMsg(err)}`);
      }
    });
  }

  // ── structured records ──
  async put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> {
    return this._serial(async () => {
      await this._connect();
      try {
        // 安全：records（记忆等宿主结构化数据）落库前剥离敏感键
        this.db
          .prepare(
            'INSERT INTO records (collection, key, data) VALUES (?,?,?)' +
              ' ON CONFLICT(collection, key) DO UPDATE SET data = excluded.data',
          )
          .run(collection, key, strictDumps(strip_sensitive(data)));
      } catch (err) {
        throw new StorageError(`sqlite records 写入失败: ${errMsg(err)}`);
      }
    });
  }

  async get_record(collection: string, key: string): Promise<Record<string, unknown> | null> {
    return this._serial(async () => {
      await this._connect();
      try {
        const row = this.db
          .prepare('SELECT data FROM records WHERE collection = ? AND key = ?')
          .get(collection, key);
        return row === undefined ? null : (JSON.parse(String(row['data'])) as Record<string, unknown>);
      } catch (err) {
        throw new StorageError(`sqlite records 读取失败: ${errMsg(err)}`);
      }
    });
  }

  async list_records(collection: string): Promise<Record<string, unknown>[]> {
    return this._serial(async () => {
      await this._connect();
      try {
        const rows = this.db
          .prepare('SELECT data FROM records WHERE collection = ?')
          .all(collection);
        return rows.map((r) => JSON.parse(String(r['data'])) as Record<string, unknown>);
      } catch (err) {
        throw new StorageError(`sqlite records 列出失败: ${errMsg(err)}`);
      }
    });
  }

  async delete_collection(collection: string): Promise<number> {
    return this._serial(async () => {
      await this._connect();
      try {
        const res = this.db.prepare('DELETE FROM records WHERE collection = ?').run(collection);
        return Number(res.changes) || 0;
      } catch (err) {
        throw new StorageError(`sqlite records 删除失败: ${errMsg(err)}`);
      }
    });
  }
}
