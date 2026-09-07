/**
 * 池治理状态持久化 store（周预算/去重集合落 records 通道）。
 *
 * 决策 4（状态持久化）：周预算窗口计数（判定记录行）、已合并/失效去重集合、
 * 推荐晋升与策略边复审去重签名——全部持久落 records（集合如
 * `pool_governance:<set>`），重启恢复，消除「重启后重复判定/重复晋升」。
 *
 * 语义边界：本 store 是引擎机制簿记持久化（与 edge_evidence/ledger 同类，
 * 非集状态演化资产）——集合不属受守卫集合，写走普通 records 通道；判定记录
 * 的审计仍经 set_audit（append-only 历史不撒谎）。判定行键按
 * `domain/round/trace/候选` 复合，跨重启不互相覆盖。
 */

import type { Storage } from '../storage/storage.js';

/** 池治理状态读/写 seam（review/promotion 钩子注入的持久化面）。 */
export interface PoolGovernanceStateStore {
  /** 持久判定记录行（周预算窗口计数的已用口径来源）。 */
  decisions(): Promise<readonly Record<string, unknown>[]>;
  append_decision(record: Record<string, unknown>): Promise<void>;
  /** 已合并去重的候选键（domain\u001fnode_type；跨重启不重复提请）。 */
  merged_keys(): Promise<ReadonlySet<string>>;
  mark_merged(key: string): Promise<void>;
  /** 已登记失效的池成员键（node_type；不重复失效登记）。 */
  invalidated_keys(): Promise<ReadonlySet<string>>;
  mark_invalidated(key: string): Promise<void>;
  /** 已晋升路径签名去重键（JSON 签名）。 */
  promoted_signatures(): Promise<ReadonlySet<string>>;
  mark_promoted(signature_key: string): Promise<void>;
  /** 已降级策略边去重键（边主键字符串编码）。 */
  downgraded_keys(): Promise<ReadonlySet<string>>;
  mark_downgraded(key: string): Promise<void>;
}

/** 状态 store 构造选项（时间戳为副作用，注入 clock 可测）。 */
export interface RecordsPoolGovernanceStateStoreOptions {
  now?: (() => number) | null;
}

/** 状态集合前缀行键分类（record key 内嵌类别）。 */
const ROW_DECISION = 'decision:';
const ROW_MERGED = 'merged:';
const ROW_INVALIDATED = 'invalidated:';
const ROW_PROMOTED = 'promoted:';
const ROW_DOWNGRADED = 'downgraded:';

type _Cache = { value: Set<string> | null };

/**
 * records 通道的池治理状态 store：Set 面（merged/invalidated/promoted/
 * downgraded）与判定记录行 append-only 落 storage records。Set 首次读取后
 * 内存缓存（进程内连续；重启经 storage 重新加载）。
 */
export class RecordsPoolGovernanceStateStore implements PoolGovernanceStateStore {
  readonly collection: string;
  readonly #storage: Storage;
  readonly #now: () => number;
  readonly #merged: _Cache = { value: null };
  readonly #invalidated: _Cache = { value: null };
  readonly #promoted: _Cache = { value: null };
  readonly #downgraded: _Cache = { value: null };

  constructor(
    storage: Storage,
    collection: string,
    options: RecordsPoolGovernanceStateStoreOptions = {},
  ) {
    this.#storage = storage;
    this.collection = collection;
    this.#now = options.now ?? (() => 0);
  }

  /** 判定记录行键（domain/round/trace/候选复合，跨重启不互相覆盖）。 */
  #decision_key(record: Record<string, unknown>): string {
    const parts = [
      String(record['domain'] ?? ''),
      String(record['round_id'] ?? ''),
      String(record['trace_id'] ?? ''),
      String(record['candidate'] ?? ''),
    ];
    return `${ROW_DECISION}${parts.join('\u001f')}`;
  }

  async #load_keys(): Promise<void> {
    const buckets: Array<{ prefix: string; cache: _Cache }> = [
      { prefix: ROW_MERGED, cache: this.#merged },
      { prefix: ROW_INVALIDATED, cache: this.#invalidated },
      { prefix: ROW_PROMOTED, cache: this.#promoted },
      { prefix: ROW_DOWNGRADED, cache: this.#downgraded },
    ];
    const sets = new Map<string, Set<string>>();
    for (const bucket of buckets) sets.set(bucket.prefix, new Set<string>());
    for (const row of await this.#storage.list_records(this.collection)) {
      const key = row['key'];
      if (typeof key !== 'string') continue;
      for (const bucket of buckets) {
        if (key.startsWith(bucket.prefix)) {
          sets.get(bucket.prefix)!.add(key.slice(bucket.prefix.length));
        }
      }
    }
    for (const bucket of buckets) bucket.cache.value = sets.get(bucket.prefix)!;
  }

  async #keys(cache: _Cache): Promise<ReadonlySet<string>> {
    if (cache.value === null) await this.#load_keys();
    return cache.value as ReadonlySet<string>;
  }

  async #mark(cache: _Cache, prefix: string, key: string): Promise<void> {
    if (cache.value === null) {
      await this.#load_keys();
    }
    cache.value!.add(key);
    await this.#storage.put_record(this.collection, `${prefix}${key}`, {
      key: `${prefix}${key}`,
      ts: this.#now(),
    });
  }

  async decisions(): Promise<readonly Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const row of await this.#storage.list_records(this.collection)) {
      if (String(row['row'] ?? '') === 'decision') {
        out.push(row['record'] as Record<string, unknown>);
      }
    }
    return out;
  }

  async append_decision(record: Record<string, unknown>): Promise<void> {
    await this.#storage.put_record(this.collection, this.#decision_key(record), {
      row: 'decision',
      record: { ...record },
      ts: this.#now(),
    });
  }

  async merged_keys(): Promise<ReadonlySet<string>> {
    return this.#keys(this.#merged);
  }

  async mark_merged(key: string): Promise<void> {
    await this.#mark(this.#merged, ROW_MERGED, key);
  }

  async invalidated_keys(): Promise<ReadonlySet<string>> {
    return this.#keys(this.#invalidated);
  }

  async mark_invalidated(key: string): Promise<void> {
    await this.#mark(this.#invalidated, ROW_INVALIDATED, key);
  }

  async promoted_signatures(): Promise<ReadonlySet<string>> {
    return this.#keys(this.#promoted);
  }

  async mark_promoted(signature_key: string): Promise<void> {
    await this.#mark(this.#promoted, ROW_PROMOTED, signature_key);
  }

  async downgraded_keys(): Promise<ReadonlySet<string>> {
    return this.#keys(this.#downgraded);
  }

  async mark_downgraded(key: string): Promise<void> {
    await this.#mark(this.#downgraded, ROW_DOWNGRADED, key);
  }
}

/** 无持久化回落 store（纯内存；未装配持久化 store 时的进程内语义）。 */
export function memory_pool_governance_state(): PoolGovernanceStateStore {
  const merged = new Set<string>();
  const invalidated = new Set<string>();
  const promoted = new Set<string>();
  const downgraded = new Set<string>();
  const decisions: Record<string, unknown>[] = [];
  return {
    async decisions(): Promise<readonly Record<string, unknown>[]> {
      return [...decisions];
    },
    async append_decision(record: Record<string, unknown>): Promise<void> {
      decisions.push({ ...record });
    },
    async merged_keys(): Promise<ReadonlySet<string>> {
      return new Set(merged);
    },
    async mark_merged(key: string): Promise<void> {
      merged.add(key);
    },
    async invalidated_keys(): Promise<ReadonlySet<string>> {
      return new Set(invalidated);
    },
    async mark_invalidated(key: string): Promise<void> {
      invalidated.add(key);
    },
    async promoted_signatures(): Promise<ReadonlySet<string>> {
      return new Set(promoted);
    },
    async mark_promoted(key: string): Promise<void> {
      promoted.add(key);
    },
    async downgraded_keys(): Promise<ReadonlySet<string>> {
      return new Set(downgraded);
    },
    async mark_downgraded(key: string): Promise<void> {
      downgraded.add(key);
    },
  };
}

export function pool_governance_collection(set_id: string): string {
  return `pool_governance:${set_id}`;
}
