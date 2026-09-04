/**
 * 旁路写防护（core/self_application.py GuardedStorage 移植）：storage 包装
 * （演化资产集合的直写/整集删除被拒绝）。
 *
 * 判定语义：collection ∈ 演化资产集合（界面/工具注册/事件类型/环境/
 * 产物/补丁链/审计）AND 不在显式豁免中 = 拒绝（fail-closed）。受守卫的
 * 写通道 = put_record（单记录写）与 delete_collection（整集删除，最强
 * 旁路写）；restore（整库替换）为宿主运维通道，放行。
 *
 * 放行路径（二选一）：
 * - 守卫令牌（guard_token）：应用管线内部写入携带与包装一致的令牌——
 *   补丁链/审计的自身写入经令牌放行（唯一写入路径的机制侧）；
 * - 机制豁免上下文（allow_mechanism）：启动装配与引擎机制内部写入使用
 *   （退出上下文即收回）。
 *
 * TS seam 差异：allow_mechanism 返回豁免作用域对象（enter/exit 镜像
 * Python with/async with 语义，写入夹在两者之间）。restore 的
 * logging.warning 留痕属可观测性副作用，core 不落。
 */

import type { EngineEvent } from '../events/events.js';
import type { ChainLink, CheckpointRecord } from '../storage/storage_records.js';
import type { Storage } from '../storage/storage.js';
import { GraphDefinitionError } from '../errors.js';

import {
  _GUARDED_COLLECTIONS,
  _GUARDED_PREFIXES,
} from './constants.js';

/** 豁免作用域：镜像 Python AbstractContextManager（enter 后写、finally exit）。 */
export interface MechanismExemptionScope {
  enter(): void;
  exit(): void;
}

/** GuardedStorage 构造选项。 */
export interface GuardedStorageInit {
  /** 守卫开关（false = 完全透传，机制/调试用）。 */
  guarded?: boolean;
  /** 守卫令牌（与应用管线持有令牌一致时放行机制侧自身写入）。 */
  guard_token?: string | null;
}

/** 写通道的可选入参（guard_token 随调用透传；Storage 接口不含该形参）。 */
export interface GuardedWriteOpts {
  guard_token?: string | null;
}

export class GuardedStorage implements Storage {
  private readonly _inner: Storage;
  private readonly _guarded: boolean;
  private readonly _guard_token: string | null;
  private readonly _mechanism_allows: Set<string>;

  constructor(inner: Storage, init: GuardedStorageInit = {}) {
    this._inner = inner;
    this._guarded = init.guarded ?? true;
    this._guard_token = init.guard_token ?? null;
    this._mechanism_allows = new Set<string>();
  }

  /** 被包装的存储（观察侧透传入口）。 */
  get inner(): Storage {
    return this._inner;
  }

  /**
   * 启动装配/引擎机制的显式豁免上下文（离开上下文即收回）。
   * 用法：``const scope = guarded.allow_mechanism('harness'); scope.enter(); ... scope.exit();``
   * 未指定集合 = 全豁免（启动装配一次性用）；上下文退出后恢复拦截。
   */
  allow_mechanism(collection?: string | null): MechanismExemptionScope {
    return {
      enter: (): void => {
        if (collection === null || collection === undefined) {
          this._mechanism_allows.add('*');
        } else {
          this._mechanism_allows.add(collection);
        }
      },
      exit: (): void => {
        if (collection === null || collection === undefined) {
          this._mechanism_allows.delete('*');
        } else {
          this._mechanism_allows.delete(collection);
        }
      },
    };
  }

  /** 演化资产集合判定：精确命中或前缀命中（knowledge:<id> 动态集合）。 */
  private static _is_guarded(collection: string): boolean {
    if (_GUARDED_COLLECTIONS.has(collection)) return true;
    return _GUARDED_PREFIXES.some((prefix) => collection.startsWith(prefix));
  }

  /**
   * 写入判定（put_record / delete_collection 共用；拒绝即抛）。
   * 放行条件：非守卫集合 / 令牌匹配 / 命中豁免上下文（全豁免或该集合
   * 豁免）；其余 fail-closed 拒绝。
   */
  private _guard_write(collection: string, guard_token: string | null): void {
    const tokenOk =
      guard_token !== null
      && this._guard_token !== null
      && guard_token === this._guard_token;
    if (
      this._guarded
      && GuardedStorage._is_guarded(collection)
      && !tokenOk
      && !this._mechanism_allows.has('*')
      && !this._mechanism_allows.has(collection)
    ) {
      throw new GraphDefinitionError(
        `旁路写拦截: 集合 ${collection} 为集内可演化资产，`
          + '唯一写入路径 = 自指应用管线（self_application）',
      );
    }
  }

  /** 写拦截判定：演化资产集合直写拒绝（携带守卫令牌/豁免上下文除外）。 */
  async put_record(
    collection: string,
    key: string,
    data: Record<string, unknown>,
    opts: GuardedWriteOpts = {},
  ): Promise<void> {
    this._guard_write(collection, opts.guard_token ?? null);
    await this._inner.put_record(collection, key, data);
  }

  /**
   * 删除集合判定：演化资产集合整集删除与直写同规则（fail-closed）。
   * 整集删除是最强的旁路写（一次抹掉补丁链/审计/知识集全部记录）——
   * 原实现全透传 = 守卫只拦 put_record，删除通道无闸门。机制通道
   * （llm_cache 维持等非演化资产集合）照常放行。
   */
  async delete_collection(
    collection: string,
    opts: GuardedWriteOpts = {},
  ): Promise<number> {
    this._guard_write(collection, opts.guard_token ?? null);
    return this._inner.delete_collection(collection);
  }

  // ── 其余 Storage 方法透传（checkpoint/事件日志/读取/快照全放行——
  //    这些非演化资产直写路径；快照/还原是宿主运维通道）──

  get snapshot_capable(): boolean {
    return this._inner.snapshot_capable;
  }

  async snapshot(dest: string): Promise<void> {
    await this._inner.snapshot(dest);
  }

  async restore(src: string): Promise<void> {
    // 全量还原 = 整库替换（含全部演化资产集合）：宿主显式运维通道，放行
    await this._inner.restore(src);
  }

  async get_checkpoint(checkpoint_id: number): Promise<CheckpointRecord | null> {
    return this._inner.get_checkpoint(checkpoint_id);
  }

  async get_latest_checkpoint(thread_id: string): Promise<CheckpointRecord | null> {
    return this._inner.get_latest_checkpoint(thread_id);
  }

  async put_checkpoint(
    record: CheckpointRecord,
    opts?: { expected_version?: number | null; fork?: boolean },
  ): Promise<CheckpointRecord> {
    return this._inner.put_checkpoint(record, opts);
  }

  async list_checkpoints(
    thread_id: string,
    opts?: { limit?: number },
  ): Promise<CheckpointRecord[]> {
    return this._inner.list_checkpoints(thread_id, opts);
  }

  async chain_index(thread_id: string): Promise<ChainLink[]> {
    return this._inner.chain_index(thread_id);
  }

  async delete_checkpoints(thread_id: string, ids: readonly number[]): Promise<number> {
    return this._inner.delete_checkpoints(thread_id, ids);
  }

  async set_checkpoint_parent(
    thread_id: string,
    checkpoint_id: number,
    parent_id: number | null,
  ): Promise<number> {
    return this._inner.set_checkpoint_parent(thread_id, checkpoint_id, parent_id);
  }

  async append_event(thread_id: string, event: EngineEvent): Promise<number> {
    return this._inner.append_event(thread_id, event);
  }

  async events_after(thread_id: string, seq: number): Promise<EngineEvent[]> {
    return this._inner.events_after(thread_id, seq);
  }

  async truncate_events(thread_id: string, after_seq: number): Promise<void> {
    await this._inner.truncate_events(thread_id, after_seq);
  }

  async trim_events(thread_id: string, before_seq: number): Promise<number> {
    return this._inner.trim_events(thread_id, before_seq);
  }

  async latest_event_seq(thread_id: string): Promise<number> {
    return this._inner.latest_event_seq(thread_id);
  }

  async get_record(collection: string, key: string): Promise<Record<string, unknown> | null> {
    return this._inner.get_record(collection, key);
  }

  async list_records(collection: string): Promise<Record<string, unknown>[]> {
    return this._inner.list_records(collection);
  }

  async close(): Promise<void> {
    await this._inner.close();
  }
}
