/**
 * checkpoint 通道语句与行转换（storage_sqlite.py 的版本链切片移植）。
 *
 * 行 → CheckpointRecord（_row_to_record 同口径：JSON 列解析 + marker 经
 * fromJsonable 还原 + InterruptState 还原）；写入侧数据收窄为 CheckpointData
 * （to_dict 的 Json 宽类型 → 参数绑定的窄类型）。
 *
 * 插入语义与 Python 一致：条件插入（链尾 NOT EXISTS + 父存在/同线程/
 * event_seq 单调 EXISTS，单条语句原子判定防 TOCTOU）0 行 = 冲突；已存在
 * 节点走乐观锁 UPDATE（WHERE version = ?，父指针不可变——SET 不含
 * parent_id），返回库中真值（回读）。
 */

import { DatabaseSync } from 'node:sqlite';

import { CheckpointConflictError, StorageError } from '../../core/errors.js';
import type { JsonRecord } from '../../core/json.js';
import { InterruptState } from '../../core/interrupt/interrupt_types.js';
import { CheckpointRecord, fromJsonable } from '../../core/storage/storage_records.js';
import { strictDumps } from './sqlite_json.js';

/** sqlite 行（宽松形态：列值可为任意驱动返回值）。 */
export interface SqliteRow {
  [column: string]: unknown;
}

/** Python `dict.get(k) or 缺省` 布尔口径的 TEXT 兜底（空串/null → 缺省文本）。 */
function jsonTextOr(value: unknown, fallback: string): string {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

/** checkpoint 行 → 记录（JSON 列解析 + fromJsonable 内联 marker 还原）。 */
export function rowToCheckpointRecord(row: SqliteRow): CheckpointRecord {
  const graphPath = JSON.parse(jsonTextOr(row['graph_path'], '[]')) as string[];
  const rawState = JSON.parse(jsonTextOr(row['state'], '{}'));
  const rawInterrupt = row['interrupt'];
  const rawPlan = row['plan'];
  return new CheckpointRecord({
    checkpoint_id: Number(row['checkpoint_id']),
    thread_id: String(row['thread_id']),
    node: (row['node'] as string | null) ?? null,
    graph_path: graphPath,
    state: fromJsonable(rawState) as JsonRecord,
    parent_id: (row['parent_id'] as number | null) ?? null,
    reason: (row['reason'] as string | null) ?? null,
    created_at: Number(row['created_at']),
    version: Number(row['version']),
    event_seq: Number(row['event_seq']),
    error: (row['error'] as string | null) ?? null,
    interrupt:
      rawInterrupt === null || rawInterrupt === undefined || rawInterrupt === ''
        ? null
        : InterruptState.from_dict(fromJsonable(JSON.parse(String(rawInterrupt)))),
    graph_version: (row['graph_version'] as string | null) ?? null,
    plan:
      rawPlan === null || rawPlan === undefined || rawPlan === ''
        ? null
        : (JSON.parse(String(rawPlan)) as JsonRecord | null),
  });
}

/** checkpoint 写入侧数据（列绑定窄类型；to_dict 宽 Json 收窄一次）。 */
export interface CheckpointData {
  thread_id: string;
  node: string | null;
  graph_path: readonly string[];
  state: unknown;
  parent_id: number | null;
  reason: string | null;
  created_at: number;
  event_seq: number;
  error: string | null;
  interrupt: unknown;
  graph_version: string | null;
  plan: unknown;
}

/** record.to_dict() → CheckpointData（类型收窄 + 数值/可空归一）。 */
export function checkpointData(record: CheckpointRecord): CheckpointData {
  const d = record.to_dict();
  return {
    thread_id: d['thread_id'] as string,
    node: (d['node'] as string | null) ?? null,
    graph_path: d['graph_path'] as string[],
    state: d['state'],
    parent_id: (d['parent_id'] as number | null) ?? null,
    reason: (d['reason'] as string | null) ?? null,
    created_at: Number(d['created_at']),
    event_seq: Number(d['event_seq']),
    error: (d['error'] as string | null) ?? null,
    interrupt: d['interrupt'],
    graph_version: (d['graph_version'] as string | null) ?? null,
    plan: d['plan'],
  };
}

/** 可空 JSON 列文本（None → SQL NULL；否则严格序列化）。 */
function jsonColumn(value: unknown): string | null {
  return value === null || value === undefined ? null : strictDumps(value);
}

/** 链尾续链守卫 INSERT（单条语句原子判定；与 Python SQL 同构）。 */
export const GUARDED_INSERT_SQL = `
INSERT INTO checkpoints (thread_id, node, graph_path, state, parent_id, reason,
  created_at, version, event_seq, error, interrupt, graph_version, plan)
  SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
  WHERE NOT EXISTS (SELECT 1 FROM checkpoints WHERE thread_id = ? AND checkpoint_id > ?)
  AND EXISTS (SELECT 1 FROM checkpoints
    WHERE checkpoint_id = ? AND thread_id = ? AND event_seq <= ?)`;

/** 普通插入（链头/fork 分支，无守卫）。 */
export const PLAIN_INSERT_SQL = `
INSERT INTO checkpoints (thread_id, node, graph_path, state, parent_id, reason,
  created_at, version, event_seq, error, interrupt, graph_version, plan)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** 乐观锁更新（父指针不可变；version 期望校验，冲突 0 行）。 */
export const UPDATE_CHECKPOINT_SQL = `
UPDATE checkpoints SET state = ?, node = ?, graph_path = ?, reason = ?,
  event_seq = ?, error = ?, interrupt = ?, graph_version = ?, plan = ?,
  version = version + 1
  WHERE checkpoint_id = ? AND version = ?`;

/**
 * 插入新链节点（checkpoint_id=0）。guarded=true 走链尾守卫条件插入；
 * false = 链头/fork 普通插入。返回规范化记录（同读取路径口径）。
 */
export function insertCheckpoint(
  db: DatabaseSync,
  data: CheckpointData,
  guarded: boolean,
): CheckpointRecord {
  const interrupt = jsonColumn(data['interrupt']);
  const plan = jsonColumn(data['plan']);
  const values = [
    data['thread_id'],
    data['node'],
    strictDumps(data['graph_path']),
    strictDumps(data['state']),
    data['parent_id'],
    data['reason'],
    data['created_at'],
    1,
    data['event_seq'],
    data['error'],
    interrupt,
    data['graph_version'],
    plan,
  ];
  const res = guarded
    ? db.prepare(GUARDED_INSERT_SQL).run(
        ...values,
        data['thread_id'],
        data['parent_id'],
        data['parent_id'],
        data['thread_id'],
        data['event_seq'],
      )
    : db.prepare(PLAIN_INSERT_SQL).run(...values);
  const updated = Number(res.changes);
  const checkpointId = res.lastInsertRowid === null ? null : Number(res.lastInsertRowid);
  if (updated === 0 || checkpointId === null) {
    throw new CheckpointConflictError(
      `checkpoint 写入被拒绝（链尾已前进/父指针不存在/跨线程/event_seq 回退）: thread=${data['thread_id']}`,
    );
  }
  return rowToCheckpointRecord({
    checkpoint_id: checkpointId,
    thread_id: data['thread_id'],
    node: data['node'],
    graph_path: strictDumps(data['graph_path']),
    state: strictDumps(data['state']),
    parent_id: data['parent_id'],
    reason: data['reason'],
    created_at: data['created_at'],
    version: 1,
    event_seq: data['event_seq'],
    error: data['error'],
    interrupt,
    graph_version: data['graph_version'],
    plan,
  });
}

/**
 * 乐观锁更新已存在节点；expected=null 时自动读当前版本。返回库中真值
 * （父指针不可变，忽略调用方传入 parent_id——防下游按返回值续链用错锚点）。
 */
export function updateCheckpoint(
  db: DatabaseSync,
  data: CheckpointData,
  checkpointId: number,
  expected: number | null,
): CheckpointRecord {
  if (expected === null || expected === undefined) {
    const row = db
      .prepare('SELECT version FROM checkpoints WHERE checkpoint_id = ?')
      .get(checkpointId);
    if (row === undefined) throw new StorageError(`checkpoint 不存在: ${checkpointId}`);
    expected = Number(row['version']);
  }
  const interrupt = jsonColumn(data['interrupt']);
  const plan = jsonColumn(data['plan']);
  const res = db.prepare(UPDATE_CHECKPOINT_SQL).run(
    strictDumps(data['state']),
    data['node'],
    strictDumps(data['graph_path']),
    data['reason'],
    data['event_seq'],
    data['error'],
    interrupt,
    data['graph_version'],
    plan,
    checkpointId,
    expected,
  );
  if (Number(res.changes) === 0) {
    throw new CheckpointConflictError(
      `checkpoint ${checkpointId} 并发写冲突: expected version=${expected}`,
    );
  }
  const row = db
    .prepare('SELECT * FROM checkpoints WHERE checkpoint_id = ?')
    .get(checkpointId);
  return rowToCheckpointRecord(row as SqliteRow);
}
