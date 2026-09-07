/**
 * 恢复解析测试公共设施：内存 seam 双端 + checkpoint/链构造辅助。
 *
 * FakeStorage 镜像 Python conftest memory_storage 的恢复面子集（自增
 * checkpoint id / 链一致性写入校验 / 事件序跨接），与真实后端行为同口径
 * （父指针同线程且 event_seq 不高于新节点才可写）。
 */

import { EngineEvent } from '../../../src/core/events/events.js';
import { ChainLink, CheckpointRecord } from '../../../src/core/storage/storage_records.js';
import type { Storage } from '../../../src/core/storage/storage.js';
import type { JsonRecord } from '../../../src/core/json.js';

/** 内存 seam 双端（镜像 Python memory_storage 的恢复面子集）。 */
export class FakeStorage {
  private readonly checkpoints = new Map<number, CheckpointRecord>();
  private readonly events = new Map<string, EngineEvent[]>();
  private nextCheckpointId = 1;
  private nextEventSeq = 1;

  async get_checkpoint(checkpoint_id: number): Promise<CheckpointRecord | null> {
    return this.checkpoints.get(checkpoint_id) ?? null;
  }

  async get_latest_checkpoint(thread_id: string): Promise<CheckpointRecord | null> {
    let latest: CheckpointRecord | null = null;
    for (const record of this.checkpoints.values()) {
      if (record.thread_id !== thread_id) continue;
      if (latest === null || record.checkpoint_id > latest.checkpoint_id) latest = record;
    }
    return latest;
  }

  async put_checkpoint(record: CheckpointRecord): Promise<CheckpointRecord> {
    // 链一致性不变量（与后端同口径）：父指针必须存在且同线程、
    // event_seq 不高于新节点——坏链形态在写入期失败
    if (record.parent_id !== null) {
      const parent = this.checkpoints.get(record.parent_id);
      if (
        parent === undefined ||
        parent.thread_id !== record.thread_id ||
        parent.event_seq > record.event_seq
      ) {
        throw new Error('checkpoint 写入被拒绝（父指针不存在/跨线程/event_seq 回退）');
      }
    }
    // 新节点：存储分配自增 id，version 恒 1
    const stored = new CheckpointRecord({
      checkpoint_id: this.nextCheckpointId,
      thread_id: record.thread_id,
      node: record.node,
      graph_path: record.graph_path,
      state: record.state,
      parent_id: record.parent_id,
      reason: record.reason,
      created_at: record.created_at,
      version: 1,
      event_seq: record.event_seq,
      error: record.error,
      interrupt: record.interrupt,
      graph_version: record.graph_version,
      plan: record.plan,
    });
    this.nextCheckpointId += 1;
    this.checkpoints.set(stored.checkpoint_id, stored);
    return stored;
  }

  async chain_index(thread_id: string): Promise<ChainLink[]> {
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
  }

  async append_event(thread_id: string, event: EngineEvent): Promise<number> {
    const seq = this.nextEventSeq;
    this.nextEventSeq += 1;
    // seq 写回事件副本（重放/续流拿得到序号）
    const stored = new EngineEvent({
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
    const list = this.events.get(thread_id) ?? [];
    list.push(stored);
    this.events.set(thread_id, list);
    return seq;
  }

  async events_after(thread_id: string, seq: number): Promise<EngineEvent[]> {
    return (this.events.get(thread_id) ?? []).filter((e) => (e.seq ?? 0) > seq);
  }
}

/** 内存 seam 双端按 Storage 子集实现（其余成员与本模块无关）。 */
export function asStore(store: FakeStorage): Storage {
  return store as unknown as Storage;
}

/** checkpoint 构造辅助（checkpoint_id=0 = 新节点，存储分配自增 id）。 */
export function ckpt(
  threadId: string,
  init: {
    parent_id?: number | null;
    reason?: string | null;
    event_seq?: number;
    graph_path?: readonly string[];
    graph_version?: string | null;
    state?: JsonRecord;
    node?: string | null;
  } = {},
): CheckpointRecord {
  const event_seq = init.event_seq ?? 0;
  return new CheckpointRecord({
    checkpoint_id: 0,
    thread_id: threadId,
    node: init.node ?? null,
    graph_path: init.graph_path ?? [],
    state: init.state ?? {},
    parent_id: init.parent_id ?? null,
    reason: init.reason ?? null,
    created_at: event_seq === 0 ? 1 : event_seq,
    version: 1,
    event_seq,
    error: null,
    interrupt: null,
    graph_version: init.graph_version ?? null,
    plan: null,
  });
}

/** 按声明顺序落链（顺序插入返回 id 表：checkpoint_id → 记录）。 */
export async function chain(
  store: FakeStorage,
  specs: Parameters<typeof ckpt>[1][],
): Promise<Map<number, CheckpointRecord>> {
  const ids = new Map<number, CheckpointRecord>();
  for (const spec of specs) {
    const record = await store.put_checkpoint(ckpt('t1', spec));
    ids.set(record.checkpoint_id, record);
  }
  return ids;
}

/** resume_map 键编码（与核心同口径：graph_path 的 JSON 序列化）。 */
export function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}