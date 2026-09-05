/**
 * 内存存储后端公共基座（状态 + 锁 + 快照/恢复）。三通道存储形态与
 * sqlite/postgres 后端的同口径见 _checkpoints/_events_records 分层。
 *
 * 快照/恢复 = JSON 文件序列化往返：快照形态即存储契约形态
 * （checkpoint to_dict / 事件 to_json / records 原样），可被任意后端恢复
 * 语义消费（对 sqlite 而言是迁移引子，不是同构恢复——后端形态不同）。
 * 落盘原子：临时文件 + rename 替换；失败清理临时文件并抛 StorageError。
 * 恢复逐字段校验（含 checkpoint 重复 id 拒绝），损坏数据显式拒绝。
 *
 * 分层结构（继承链共享同一实例状态，镜像 core executor 分层模式）：
 * MemoryStorageBase（本文件，状态+快照）→ _checkpoints（版本链方法）→
 * _events_records（事件/records 方法）→ memory.ts 汇出 MemoryStorage。
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { EngineEvent } from '../../core/events/events.js';
import type { Json, JsonRecord } from '../../core/json.js';
import { StorageError } from '../../core/errors.js';
import { CheckpointRecord } from '../../core/storage/storage_records.js';

import { AsyncLock } from './_mutex.js';
import { errMsg, normalizeCheckpointRecord } from './_serialize.js';

/** 快照落盘暂存文件命名计数（同目录原子替换前先写临时文件）。 */
let snapshot_counter = 0;

/** 快照 JSON 形态（checkpoints to_dict / 事件 to_json / records 原样）。 */
export interface SnapshotPayload {
  checkpoints: Json[];
  events: Record<string, string[]>;
  records: Record<string, JsonRecord>;
  next_checkpoint_id: number;
  next_event_seq: number;
  latest_checkpoint_by_thread: Record<string, number>;
}

/** 原子落盘：临时文件 + 替换；失败清理临时文件并抛 StorageError。 */
async function atomicWriteJson(dest: string, payload: unknown): Promise<void> {
  const directory = dirname(resolve(dest));
  const tmpPath = join(
    directory,
    `.snapshot-${process.pid}-${Date.now()}-${snapshot_counter++}.json`,
  );
  try {
    await fs.writeFile(tmpPath, JSON.stringify(payload), 'utf8');
    await fs.rename(tmpPath, dest);
  } catch (exc) {
    await fs.unlink(tmpPath).catch(() => {});
    throw new StorageError(`内存存储快照失败: ${errMsg(exc)}`);
  }
}

/**
 * 存储公共基座：并发锁 + 三通道容器 + 自增计数 + 链尾指针 + 快照能力。
 * 字段 protected 供分层子类（checkpoint/events/records 方法群）共享。
 */
export class MemoryStorageBase {
  protected readonly lock = new AsyncLock();
  protected readonly checkpoints = new Map<number, CheckpointRecord>();
  protected readonly events = new Map<string, EngineEvent[]>();
  protected readonly records = new Map<string, Map<string, JsonRecord>>();
  protected next_checkpoint_id = 1;
  protected next_event_seq = 1;
  // per-thread 最新锚点指针（链尾校验/恢复定位 O(1)，避免全量扫描）
  protected readonly latest_checkpoint_by_thread = new Map<string, number>();

  /** 链尾指针只前进（与 sqlite/postgres MAX(checkpoint_id) 语义一致）。 */
  protected advance_tail(thread_id: string, checkpoint_id: number): void {
    const current = this.latest_checkpoint_by_thread.get(thread_id);
    if (current === undefined || checkpoint_id > current) {
      this.latest_checkpoint_by_thread.set(thread_id, checkpoint_id);
    }
  }

  /** 能力声明：文件级快照/恢复能力（内存端走序列化往返，支持）。 */
  get snapshot_capable(): boolean {
    return true;
  }

  async snapshot(dest: string): Promise<void> {
    const payload = await this.lock.run<SnapshotPayload>(() => {
      const events: Record<string, string[]> = {};
      for (const [thread, list] of this.events) {
        events[thread] = list.map((e) => e.to_json());
      }
      const records: Record<string, JsonRecord> = {};
      for (const [collection, store] of this.records) {
        const plain: JsonRecord = {};
        for (const [key, data] of store) plain[key] = data as Json;
        records[collection] = plain;
      }
      const latest: Record<string, number> = {};
      for (const [thread, id] of this.latest_checkpoint_by_thread) {
        latest[thread] = id;
      }
      return {
        checkpoints: [...this.checkpoints.values()].map((c) => c.to_dict()),
        events,
        records,
        next_checkpoint_id: this.next_checkpoint_id,
        next_event_seq: this.next_event_seq,
        latest_checkpoint_by_thread: latest,
      };
    });
    await atomicWriteJson(dest, payload);
  }

  async restore(src: string): Promise<void> {
    let payload: SnapshotPayload;
    try {
      const raw = await fs.readFile(src, 'utf8');
      const parsed = JSON.parse(raw) as SnapshotPayload;
      if (!Array.isArray(parsed.checkpoints)) throw new Error('缺 checkpoints');
      if (parsed.events === null || typeof parsed.events !== 'object') {
        throw new Error('缺 events');
      }
      if (parsed.records === null || typeof parsed.records !== 'object') {
        throw new Error('缺 records');
      }
      // 计数器缺省 1（旧快照无此字段）；在则须为正整数（NaN/负数/非整即损坏）
      const nextCheckpointId = Number(parsed.next_checkpoint_id ?? 1);
      const nextEventSeq = Number(parsed.next_event_seq ?? 1);
      if (!Number.isInteger(nextCheckpointId) || nextCheckpointId < 1) {
        throw new Error(`next_checkpoint_id 非法: ${JSON.stringify(parsed.next_checkpoint_id)}`);
      }
      if (!Number.isInteger(nextEventSeq) || nextEventSeq < 1) {
        throw new Error(`next_event_seq 非法: ${JSON.stringify(parsed.next_event_seq)}`);
      }
      payload = {
        checkpoints: parsed.checkpoints,
        events: parsed.events,
        records: parsed.records,
        next_checkpoint_id: nextCheckpointId,
        next_event_seq: nextEventSeq,
        latest_checkpoint_by_thread:
          (parsed.latest_checkpoint_by_thread as Record<string, number> | undefined) ?? {},
      };
    } catch (exc) {
      throw new StorageError(`内存存储恢复失败（快照损坏/非法）: ${errMsg(exc)}`);
    }
    // 快照校验在锁外完成（逐字段规范化 + 重复 id 拒绝），损坏数据显式拒绝
    const normalized = new Map<number, CheckpointRecord>();
    for (const data of payload.checkpoints) {
      const record = normalizeCheckpointRecord(CheckpointRecord.from_dict(data));
      if (normalized.has(record.checkpoint_id)) {
        throw new StorageError(`快照含重复 checkpoint id: ${record.checkpoint_id}`);
      }
      normalized.set(record.checkpoint_id, record);
    }
    const restoredEvents = new Map<string, EngineEvent[]>();
    for (const [thread, rawList] of Object.entries(payload.events)) {
      restoredEvents.set(
        thread,
        rawList.map((raw) => EngineEvent.from_dict(JSON.parse(raw) as JsonRecord)),
      );
    }
    await this.lock.run(() => {
      this.checkpoints.clear();
      for (const [id, record] of normalized) this.checkpoints.set(id, record);
      this.events.clear();
      for (const [thread, list] of restoredEvents) this.events.set(thread, list);
      this.records.clear();
      for (const [collection, plain] of Object.entries(payload.records)) {
        const store = new Map<string, JsonRecord>();
        for (const [key, data] of Object.entries(plain)) {
          store.set(key, data as JsonRecord);
        }
        this.records.set(collection, store);
      }
      this.next_checkpoint_id = payload.next_checkpoint_id;
      this.next_event_seq = payload.next_event_seq;
      this.latest_checkpoint_by_thread.clear();
      for (const [thread, id] of Object.entries(payload.latest_checkpoint_by_thread)) {
        this.latest_checkpoint_by_thread.set(thread, Number(id));
      }
    });
  }

  async close(): Promise<void> {
    // 幂等无操作：内存后端无资源需释放（与 Python MemoryStorage.close 一致）
  }
}
