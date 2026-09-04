/**
 * 引擎默认记忆存储：基于通用存储服务 records 通道
 * （memory/sqlite/postgres 共用），全部记录写入经 EvolutionWriter
 * （补丁链 + 实时写 + 审计）落链。
 *
 * 引擎零反向依赖：复用者无需关系型数据库即可获得可换后端、可持久化的
 * 记忆能力。删除走非破坏性语义（标记失效而非物理擦除），与引擎 Event
 * Sourcing 哲学一致——forget = 失效，记录仍可追溯。
 *
 * 并发：update/delete 为读-改-写两段操作，本实现以进程内 per-key 互斥
 * 串行化（AsyncLock 镜像 Python asyncio.Lock 语义，单进程内安全）；跨
 * 进程并发写仍需宿主在业务层串行化（存储抽象不提供跨进程事务级合并）。
 *
 * 查询语义：过滤（namespace/kind/source/时效）与召回排序（priority
 * 降序 + created_at 降序 + limit 截断）统一在存储边界完成——调用方取回
 * 即终态，不再二次 recall 排序；召回策略可注入（recall_policy，默认
 * PriorityRecallPolicy），策略判据单点维护（存储层与协议层不重复实现
 * 同一排序）。过滤仍在内存执行，by-design：list_records 只有全量原语，
 * 无字段级下推（下推会引入跨后端差异，反而让「取回即终态」契约漂移）。
 *
 * time/uuid 属副作用，由调用方经 now/id_gen 注入（缺省确定值），保证
 * 纯函数可复现；get_logger 可观测性副作用省略。
 */

import type { EvolutionWriter } from '../evolution_writer/_types.js';
import {
  DefaultEvolutionWriter,
  memory_writer,
} from '../evolution_writer/evolution_writer.js';
import {
  DEFAULT_ID_GEN,
  DEFAULT_NOW,
  MemoryEntry,
  PriorityRecallPolicy,
  _entry_to_record,
  _make_id,
  _record_to_entry,
} from './memory.js';
import type {
  IdGenFn,
  MemoryQuery,
  MemoryRecallPolicy,
  NowFn,
} from './memory.js';
import type { MemoryStorage, MemoryStore } from './storage_seam.js';

/** per-key 锁表上限（修复锁字典随 entry_id 无限增长的内存泄漏——超限时
 *  先驱逐空闲锁（未持有者），仍超限则放弃缓存直接新建）。 */
const _MAX_LOCK_ENTRIES = 4096;

/** 不可变身份字段：更新忽略（整体覆盖会破坏身份与失效语义）。 */
const _PROTECTED_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'namespace',
  'created_at',
  '_deleted',
]);

/**
 * 进程内互斥（镜像 Python asyncio.Lock：acquire 串行化、release 唤醒
 * 下一位等待者；锁在等待者间转移时不落空，等待中的锁不算空闲——驱逐
 * 判定只挑完全空闲者，不破坏并发串行化）。
 */
class AsyncLock {
  #held = false;
  #waiters: Array<() => void> = [];

  locked(): boolean {
    return this.#held;
  }

  async acquire(): Promise<void> {
    if (!this.#held) {
      this.#held = true;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) next();
    else this.#held = false;
  }

  /** 镜像 Python `async with lock`：整体持锁执行，finally 释放。 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** StorageBackedMemoryStore 命名选项（Python kw-only 参数的 TS 映射）。 */
export interface StorageBackedMemoryStoreOptions {
  /** 召回策略（缺省 PriorityRecallPolicy；判据单点维护）。 */
  recall_policy?: MemoryRecallPolicy | null;
  /** 时间源 seam（等价 Python time.time）；缺省确定值 0。 */
  now?: NowFn;
  /** id 源 seam（等价 Python uuid.uuid4().hex）；缺省固定串。 */
  id_gen?: IdGenFn;
}

/**
 * 引擎默认记忆存储：基于通用存储服务（memory/sqlite/postgres 共用）。
 * save/update/delete 均经 EvolutionWriter 落链（补丁链 + 审计），
 * 记忆条目属可演化资产的受控写入。
 */
export class StorageBackedMemoryStore implements MemoryStore {
  readonly _storage: MemoryStorage;
  readonly _collection: string;
  readonly _locks: Map<string, AsyncLock> = new Map();
  readonly _recall: MemoryRecallPolicy;
  readonly _writer: EvolutionWriter;
  readonly #now: NowFn;
  readonly #idGen: IdGenFn;

  constructor(
    storage: MemoryStorage,
    collection = 'memory',
    options: StorageBackedMemoryStoreOptions = {},
  ) {
    const now = options.now ?? DEFAULT_NOW;
    this._storage = storage;
    this._collection = collection;
    this._recall = options.recall_policy ?? new PriorityRecallPolicy({ now });
    this._writer = new DefaultEvolutionWriter(storage);
    this.#now = now;
    this.#idGen = options.id_gen ?? DEFAULT_ID_GEN;
  }

  _lock_for(entry_id: string): AsyncLock {
    const lock = this._locks.get(entry_id);
    if (lock === undefined) {
      if (this._locks.size >= _MAX_LOCK_ENTRIES) {
        // 有界防护：超限先驱逐空闲锁（未持有者）——持有/等待中的锁
        // 驱逐会破坏并发串行化，不驱逐
        const idle: string[] = [];
        for (const [eid, existing] of this._locks) {
          if (!existing.locked()) idle.push(eid);
        }
        for (const eid of idle.slice(0, _MAX_LOCK_ENTRIES / 2)) {
          this._locks.delete(eid);
        }
      }
      const fresh = new AsyncLock();
      this._locks.set(entry_id, fresh);
      return fresh;
    }
    return lock;
  }

  async save(entry: MemoryEntry): Promise<string> {
    // 已带 id 的条目沿用（Python `or` 语义：空串也重新生成）
    const entry_id = entry.id || _make_id(entry, this.#idGen);
    await memory_writer(
      this._writer,
      this._collection,
      entry_id,
      _entry_to_record(entry, entry_id),
      { note: 'save' },
    );
    return entry_id;
  }

  async get(entry_id: string): Promise<MemoryEntry | null> {
    const rec = await this._storage.get_record(this._collection, entry_id);
    if (rec == null || rec['_deleted']) return null;
    return _record_to_entry(rec, this.#now);
  }

  async update(entry_id: string, data: Record<string, unknown>): Promise<boolean> {
    // 读-改-写整体持锁：并发 update 同 key 不互相覆盖（丢更新）
    return this._lock_for(entry_id).run(async () => {
      const rec = await this._storage.get_record(this._collection, entry_id);
      if (rec == null || rec['_deleted']) return false;
      // id/namespace/created_at 为不可变身份字段，更新忽略
      const new_rec: Record<string, unknown> = { ...rec };
      for (const [key, value] of Object.entries(data)) {
        if (!_PROTECTED_FIELDS.has(key)) new_rec[key] = value;
      }
      await memory_writer(
        this._writer,
        this._collection,
        entry_id,
        new_rec,
        { note: 'update' },
      );
      return true;
    });
  }

  async delete(entry_id: string): Promise<boolean> {
    return this._lock_for(entry_id).run(async () => {
      const rec = await this._storage.get_record(this._collection, entry_id);
      if (rec == null) return false;
      // 非破坏性删除：标记失效而非物理擦除（与 Event Sourcing 哲学一致）
      const new_rec: Record<string, unknown> = { ...rec, _deleted: true };
      await memory_writer(
        this._writer,
        this._collection,
        entry_id,
        new_rec,
        { note: 'delete' },
      );
      // 删除后 per-key 锁移除（锁字典不随失效条目无限增长）
      this._locks.delete(entry_id);
      return true;
    });
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    // 过滤（namespace/kind/source/时效）+ 召回排序统一在存储边界完成：
    // 取回即终态，调用方不再二次 recall 排序——排序判据单点维护在
    // recall_policy（与协议层同判据不重复）。过滤仍在内存执行，
    // by-design：list_records 只有全量原语，无字段级下推，保证所有
    // 后端返回前都经过统一过滤 + 排序，调用方零关心。
    const recs = await this._storage.list_records(this._collection);
    const now = this.#now();
    const alive: MemoryEntry[] = [];
    for (const rec of recs) {
      if (rec['_deleted']) continue;
      const entry = _record_to_entry(rec, this.#now);
      if (query.namespace != null && entry.namespace !== query.namespace) continue;
      if (query.kind != null && entry.kind !== query.kind) continue;
      if (query.source != null && entry.source !== query.source) continue;
      if (!entry.is_expired(now)) alive.push(entry);
    }
    return this._recall.recall(alive, { limit: query.limit });
  }
}