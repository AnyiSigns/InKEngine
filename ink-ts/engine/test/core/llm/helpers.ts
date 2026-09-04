/**
 * LLM 缓存单测共用装置（对标 ink_engine/tests/test_llm_cache.py 的
 * CountingLLM / make_cached / 假时钟；Python create_storage("memory://")
 * 由内存假存储驱动）。
 *
 * 引擎 core 零 IO：Storage seam 以注入内存假存储（records 通道全量实现、
 * checkpoint/事件/快照惰性空实现）驱动纯机制语义。records 写路径镜像
 * Python 存储后端契约：strip_sensitive 敏感键剥离 + JSON 往返（usage 的
 * *_tokens 计费键被置空——缓存内容不依赖计费值），使往返断言与 Python
 * 参考实现同口径。
 */

import type { EngineEvent } from '../../../src/core/events/events.js';
import { AsyncLLM, LLMChunk, LLMConfig, LLMResult } from '../../../src/core/llm/base.js';
import type { LLMParams } from '../../../src/core/llm/base.js';
import type { Message } from '../../../src/core/llm/messages.js';
import { CachingLLM } from '../../../src/core/llm/cache.js';
import type { CachingLLMOptions } from '../../../src/core/llm/cache.js';
import type { ToolSpec } from '../../../src/core/llm/tools.js';
import { strip_sensitive } from '../../../src/core/security/security.js';
import type {
  ChainLink,
  CheckpointRecord,
} from '../../../src/core/storage/storage_records.js';
import type { Storage } from '../../../src/core/storage/storage.js';

/** 内存假存储：records 通道全量实现，其余通道惰性空实现。 */
export class MemStorage implements Storage {
  readonly snapshot_capable = false;
  private readonly _records = new Map<string, Map<string, Record<string, unknown>>>();

  private _clone(record: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  }

  async get_record(collection: string, key: string): Promise<Record<string, unknown> | null> {
    const record = this._records.get(collection)?.get(key);
    return record ? this._clone(record) : null;
  }

  async put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> {
    // 镜像 Python records 契约：敏感键剥离 + JSON 序列化往返
    const normalized = JSON.parse(JSON.stringify(strip_sensitive(data))) as Record<string, unknown>;
    if (!this._records.has(collection)) this._records.set(collection, new Map());
    this._records.get(collection)!.set(key, normalized);
  }

  async list_records(collection: string): Promise<Record<string, unknown>[]> {
    return [...(this._records.get(collection)?.values() ?? [])].map((r) => this._clone(r));
  }

  async delete_collection(collection: string): Promise<number> {
    const table = this._records.get(collection);
    if (!table) return 0;
    this._records.delete(collection);
    return table.size;
  }

  record(collection: string, key: string): Record<string, unknown> | null {
    return this._records.get(collection)?.get(key) ?? null;
  }

  // ── 其余通道惰性空实现（cache 只用 records 四原语）──

  async get_checkpoint(): Promise<CheckpointRecord | null> {
    return null;
  }
  async get_latest_checkpoint(): Promise<CheckpointRecord | null> {
    return null;
  }
  async put_checkpoint(record: CheckpointRecord): Promise<CheckpointRecord> {
    return record;
  }
  async list_checkpoints(): Promise<CheckpointRecord[]> {
    return [];
  }
  async chain_index(): Promise<ChainLink[]> {
    return [];
  }
  async delete_checkpoints(): Promise<number> {
    return 0;
  }
  async set_checkpoint_parent(): Promise<number> {
    return 0;
  }
  async append_event(): Promise<number> {
    return 0;
  }
  async events_after(): Promise<EngineEvent[]> {
    return [];
  }
  async truncate_events(): Promise<void> {}
  async trim_events(): Promise<number> {
    return 0;
  }
  async latest_event_seq(): Promise<number> {
    return 0;
  }
  async snapshot(): Promise<void> {}
  async restore(): Promise<void> {}
  async close(): Promise<void> {}
}

/** 计数假模型：ainvoke/astream 调用计数 + 可注入结果（aclsose 留痕）。 */
export class CountingLLM extends AsyncLLM {
  readonly adapter = 'counting';
  ainvoke_calls = 0;
  astream_calls = 0;
  aclosed = false;
  private readonly _result: LLMResult;

  constructor(result?: LLMResult) {
    super(
      new LLMConfig({
        adapter: 'counting',
        model_id: 'counting-model',
        base_url: 'http://local',
      }),
    );
    this._result = result ?? new LLMResult({ content: 'default-answer' });
  }

  async ainvoke(
    messages: readonly Message[],
    opts: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): Promise<LLMResult> {
    this.ainvoke_calls += 1;
    return this._result;
  }

  async *astream(
    messages: readonly Message[],
    opts: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): AsyncIterable<LLMChunk> {
    this.astream_calls += 1;
    yield new LLMChunk({ token: `chunk-${this.astream_calls}` });
  }

  async aclose(): Promise<void> {
    this.aclosed = true;
  }
}

/** 链形内层（config.model_id 为空占位，真实标签在 configs[0]——镜像 Python
 *  ModelChain 无 config 语义，CachingLLM 取链首标签）。 */
export class ChainCountingLLM extends AsyncLLM {
  readonly adapter = 'chain';
  readonly configs: readonly LLMConfig[];
  head_calls = 0;

  constructor(head_model_id: string) {
    super(
      new LLMConfig({
        adapter: 'chain',
        model_id: '',
        base_url: 'http://chain.local',
      }),
    );
    this.configs = [
      new LLMConfig({
        adapter: 'counting',
        model_id: head_model_id,
        base_url: 'http://local',
      }),
    ];
  }

  async ainvoke(): Promise<LLMResult> {
    this.head_calls += 1;
    return new LLMResult({ content: 'chain-answer' });
  }

  async *astream(): AsyncIterable<LLMChunk> {}
}

/** 构造缓存包装（缺省新计数内层）；返回 cached/inner 对。 */
export function makeCached(
  storage: Storage | null,
  options: CachingLLMOptions = {},
): { cached: CachingLLM; inner: CountingLLM } {
  const inner = new CountingLLM();
  const cached = new CachingLLM(inner, { storage, ...options });
  return { cached, inner };
}

/** 可推进假时钟（epoch 秒；起始 1000，镜像 Python clock_current 闭包）。 */
export function makeClock(): { now: () => number; set: (value: number) => void } {
  let current = 1000;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}
