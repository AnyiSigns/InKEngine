/**
 * 内存存储执行事件日志 + structured records 方法层
 * （storage_memory.py 事件/记录段移植）。
 *
 * 事件日志 append-only：seq 在锁内自增分配（跨实例唯一单调，ENG2-4/16
 * 存储级原子性），写回事件副本（重放/续流拿得到序号）。负载落库前
 * strip 敏感键 + 宽松 JSON 往返（叶值 default=str 字符串化，与 sqlite
 * strip → to_json(default=str) 同口径）。读取返回深拷贝。
 *
 * structured records：宿主结构化数据共用通道（回合记录/记忆/审计等），
 * 落库前 strip 敏感键 + 严格 JSON 判定（非 JSON 对象抛 StorageError 而
 * 非静默降级，与 sqlite json.dumps 失败行为一致）；round trip 兼作深拷
 * 贝，杜绝消费方存活引用污染存储。
 */

import { EngineEvent } from '../../core/events/events.js';
import { StorageError } from '../../core/errors.js';
import { deepCopy, type JsonRecord } from '../../core/json.js';
import { strip_sensitive } from '../../core/security/security.js';

import { MemoryStorageCheckpoints } from './_checkpoints.js';
import { assertStrictJson, copyEngineEvent, errMsg, toLenientJson } from './_serialize.js';

/** 事件 + records 方法层（MemoryStorage 的中间基类，状态在基座）。 */
export class MemoryStorageEventsRecords extends MemoryStorageCheckpoints {
  // ── 执行事件日志（append-only） ──

  async append_event(thread_id: string, event: EngineEvent): Promise<number> {
    return this.lock.run(() => {
      const seq = this.next_event_seq;
      this.next_event_seq += 1;
      // 安全 + 序列化契约：敏感键剥离后宽松 JSON 往返（非 JSON 叶值
      // default=str 字符串化，与 sqlite to_json(default=str) 同口径）
      const payload = toLenientJson(strip_sensitive(event.payload)) as JsonRecord;
      const stored = new EngineEvent({
        type: event.type,
        version: event.version,
        payload,
        step_id: event.step_id,
        parent_step_id: event.parent_step_id,
        round_id: event.round_id,
        node: event.node,
        graph_path: event.graph_path,
        seq,
        trace_id: event.trace_id,
        thread_id: event.thread_id,
      });
      let events = this.events.get(thread_id);
      if (events === undefined) {
        events = [];
        this.events.set(thread_id, events);
      }
      events.push(stored);
      return seq;
    });
  }

  async events_after(thread_id: string, seq: number): Promise<EngineEvent[]> {
    return this.lock.run(() => {
      const events = this.events.get(thread_id) ?? [];
      return events.filter((e) => (e.seq ?? 0) > seq).map((e) => copyEngineEvent(e));
    });
  }

  async truncate_events(thread_id: string, after_seq: number): Promise<void> {
    await this.lock.run(() => {
      const events = this.events.get(thread_id);
      if (events !== undefined) {
        this.events.set(
          thread_id,
          events.filter((e) => (e.seq ?? 0) <= after_seq),
        );
      }
    });
  }

  async trim_events(thread_id: string, before_seq: number): Promise<number> {
    return this.lock.run(() => {
      const events = this.events.get(thread_id) ?? [];
      const kept = events.filter((e) => (e.seq ?? 0) > before_seq);
      this.events.set(thread_id, kept);
      return events.length - kept.length;
    });
  }

  async latest_event_seq(thread_id: string): Promise<number> {
    return this.lock.run(() => {
      const events = this.events.get(thread_id);
      if (events === undefined || events.length === 0) return 0;
      const last = events[events.length - 1];
      return last?.seq ?? 0;
    });
  }

  // ── structured records ──

  async put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> {
    return this.lock.run(() => {
      // 安全 + 序列化契约：敏感键剥离后严格 JSON 判定；round trip 兼作
      // 深拷贝（与 sqlite json.dumps 失败行为一致：非 JSON 对象抛错）
      const stripped = strip_sensitive(data);
      let normalized: JsonRecord;
      try {
        assertStrictJson(stripped);
        normalized = JSON.parse(JSON.stringify(stripped)) as JsonRecord;
      } catch (exc) {
        throw new StorageError(`records 写入失败: ${errMsg(exc)}`);
      }
      let store = this.records.get(collection);
      if (store === undefined) {
        store = new Map<string, JsonRecord>();
        this.records.set(collection, store);
      }
      store.set(key, normalized);
    });
  }

  async get_record(collection: string, key: string): Promise<JsonRecord | null> {
    return this.lock.run(() => {
      const record = this.records.get(collection)?.get(key);
      return record !== undefined ? (deepCopy(record) as JsonRecord) : null;
    });
  }

  async list_records(collection: string): Promise<JsonRecord[]> {
    return this.lock.run(() => {
      const store = this.records.get(collection);
      if (store === undefined) return [];
      const out: JsonRecord[] = [];
      for (const record of store.values()) {
        out.push(deepCopy(record) as JsonRecord);
      }
      return out;
    });
  }

  async delete_collection(collection: string): Promise<number> {
    return this.lock.run(() => {
      const store = this.records.get(collection);
      if (store === undefined) return 0;
      const count = store.size;
      this.records.delete(collection);
      return count;
    });
  }
}
