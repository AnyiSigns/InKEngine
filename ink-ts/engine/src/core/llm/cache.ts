/**
 * LLM 调用缓存包装器（AsyncLLM 协议；Storage records 通道持久化）——Python
 * core/llm/cache.py 移植（TS core 机制层，1:1 语义）。
 *
 * 用途：同一「问句集合 + 工具表 + 模型」的重复调用直接复用上次结果
 * （路由决策/批处理重试等高频同参场景省 token 与延迟；非确定性对话
 * 场景由宿主决定是否挂缓存）。
 *
 * 设计要点：
 * - **协议形态**：实现 AsyncLLM（与 fallback.ModelChain 同族包装），宿主
 *   在模型链外层套一层即可（CachingLLM(ModelChain(...), storage=...)）；
 * - **指纹**：sha256(messages + tools + model + tier + params)——messages
 *   取 to_openai_dict 形态（不含自动生成的 id，重构造消息指纹稳定）；
 *   params 纳入指纹（温度/最大长度改变生成分布，宁可多 miss）；
 * - **持久化**：走 Storage records 通道（collection 名 llm_cache，记录
 *   fingerprint/response/tier/created_at/patch_version 五字段）；敏感键剥
 *   离属存储后端契约，缓存侧原样透传；
 * - **失效**：记录携带 patch_version（外部版本提供者或本地失效代际），
 *   读取时与当前版本比对，不一致 = miss（逻辑清空）；clear() 经
 *   delete_collection 物理删除落库记录并归零计数（TTL 出局兜底有界性）；
 * - **TTL**：默认 DEFAULT_CACHE_TTL（24h，常量）；clock 可注入（测试用
 *   假时钟，配 ttl=0 恒过期）；
 * - **流式不缓存**：astream 直通（缓存收集会破坏流式前进步履）；
 * - **seam 语义**：storage/clock 均由宿主注入；storage=None = 直通不缓存
 *   （语义不改）；缓存读写失败一律静默按 miss 处理（fail-open：缓存是
 *   增强不是依赖，绝不阻断调用）。
 *
 * core 零 IO：不落任何存储实现；sha256 用纯 TS 实现（builder/_sha256，
 * core 禁 node:crypto）。时钟缺省 Date.now 秒（运行期默认），测试经
 * clock 注入面获得确定性。序列化助手拆入 _cache_serialize.ts（≤350 行纪律）。
 */

import { sha256_hex } from '../builder/_sha256.js';
import type { Storage } from '../storage/storage.js';

import type { LLMParams, LLMResult } from './base.js';
import { AsyncLLM, LLMChunk, LLMConfig } from './base.js';
import { _result_from_dict, _result_to_dict, _stable_json } from './_cache_serialize.js';
import type { Message } from './messages.js';
import { to_openai_tools } from './tools.js';
import type { ToolSpec } from './tools.js';

/** 默认 TTL：24 小时（秒，常量——缓存命中与出局的节奏参数）。 */
export const DEFAULT_CACHE_TTL = 24 * 3600.0;

/** 缓存记录的集合名（Storage records 通道；随集导出/落库同通道）。 */
export const CACHE_COLLECTION = 'llm_cache';

/** 版本值：可比较的版本标识（null = 不校验）。 */
export type CacheVersion = number | string | null;

/** 版本提供者签名：() -> 可比较版本值（number/string/null；null = 不校验）。
 *  同步/异步皆可（宿主版本源可能为 async 链版本）。 */
export type PatchVersionProvider = () => CacheVersion | Promise<CacheVersion>;

/** 时钟签名（epoch 秒；缺省 Date.now()/1000，注入面保证测试确定性）。 */
export type CacheClock = () => number;

/** 缺省时钟：运行期真实时间（epoch 秒）。 */
const _default_clock: CacheClock = (): number => Date.now() / 1000;

/** 被包装对象的模型标签（指纹 model 分量）。
 *
 * 适配器（AsyncLLM 子类）持 config.model_id；组合包装（如 ModelChain）无
 * config 语义，取链首模型的标签——链配置变化由宿主层重建包装器（包装器
 * 生命周期 = 配置生命周期），陈旧标签随引用一起失效。
 */
function _inner_model_label(inner: AsyncLLM): string {
  const config = (inner as { config?: { model_id?: unknown } }).config;
  const model_id = config?.model_id;
  if (model_id) return String(model_id);
  const configs = (inner as { configs?: readonly { model_id?: unknown }[] }).configs;
  if (configs && configs.length > 0) {
    const first = configs[0]?.model_id;
    if (first) return String(first);
  }
  return 'unknown';
}

/** CachingLLM 构造选项（storage 缺省 = 直通不缓存）。 */
export interface CachingLLMOptions {
  /** 缓存记录后端（null = 直通不缓存——包装器可挂任意地方而不改变语义）。 */
  storage?: Storage | null;
  /** 记录保质期（秒；0 = 恒过期，仅诊断用途；负值拒绝）。 */
  ttl?: number;
  /** 挡位标签（随记录落库，审计/命中率按挡位统计用）。 */
  tier?: string;
  /** 版本提供者（补丁链等外部版本源；返回值随记录落库、读取时比对）。 */
  patch_version?: PatchVersionProvider | null;
  /** 时钟注入（epoch 秒；测试用假时钟推进 TTL；缺省 Date.now 秒）。 */
  clock?: CacheClock;
}

/** LLM 调用缓存包装器（内层任意外部模型/链；缓存失效经版本比对）。 */
export class CachingLLM extends AsyncLLM {
  readonly adapter: string;
  private readonly _inner: AsyncLLM;
  private readonly _model_label: string;
  private readonly _storage: Storage | null;
  private readonly _ttl: number;
  private readonly _tier: string;
  private readonly _patch_version_provider: PatchVersionProvider | null;
  private readonly _clock: CacheClock;
  /** 本地失效代际：无外部版本提供者时作为记录的 patch_version 语义。 */
  private _epoch = 0;
  /** 命中率统计计数（进程内累计；stats() 导出、clear() 重置）。 */
  private _hits = 0;
  private _misses = 0;

  constructor(inner: AsyncLLM, options: CachingLLMOptions = {}) {
    const {
      storage = null,
      ttl = DEFAULT_CACHE_TTL,
      tier = '',
      patch_version = null,
      clock = _default_clock,
    } = options;
    if (ttl < 0) {
      throw new RangeError(`TTL 不能为负: ${ttl}`);
    }
    const model_label = _inner_model_label(inner);
    super(
      new LLMConfig({
        adapter: 'cache',
        model_id: model_label,
        // 占位根地址：缓存包装器不发网络调用，config 仅是协议形态
        base_url: 'http://cache.local',
      }),
    );
    this.adapter = 'cache';
    this._inner = inner;
    this._model_label = model_label;
    this._storage = storage;
    this._ttl = ttl;
    this._tier = tier;
    this._patch_version_provider = patch_version;
    this._clock = clock;
  }

  // ── 失效与版本 ──

  /** 显式失效（宿主可挂到补丁链 on_change）。
   *
   * 版本没变过的东西不必清：代际 +1 使既有记录（旧代际）全部视为 miss；
   * 有外部版本提供者时（宿主以链版本为准），失效语义由提供者返回值驱动，
   * 本代际只作兜底。
   */
  invalidate(): void {
    this._epoch += 1;
  }

  /** 当前版本标识（外部提供者优先，缺省 = 本地代际；异步提供者亦可）。 */
  private async _patch_version(): Promise<CacheVersion> {
    const provider = this._patch_version_provider;
    if (provider === null) return this._epoch;
    return await provider();
  }

  // ── 指纹 ──

  private _fingerprint(
    messages: readonly Message[],
    tools: readonly ToolSpec[] | null,
    params: LLMParams | null,
  ): string {
    const payload: Record<string, unknown> = {
      messages: messages.map((m) => m.to_openai_dict()),
      tools: tools && tools.length > 0 ? to_openai_tools(tools) : null,
      model: this._model_label,
      tier: this._tier,
    };
    if (params !== null && params !== undefined) {
      const picked: Record<string, unknown> = {};
      if (params.temperature !== null) picked['temperature'] = params.temperature;
      if (params.max_tokens !== null) picked['max_tokens'] = params.max_tokens;
      if (params.extra_body !== null) picked['extra_body'] = params.extra_body;
      if (params.enable_thinking !== null) picked['enable_thinking'] = params.enable_thinking;
      if (params.reasoning_effort !== null) picked['reasoning_effort'] = params.reasoning_effort;
      payload['params'] = picked;
    }
    const raw = _stable_json(payload);
    return sha256_hex(new TextEncoder().encode(raw));
  }

  // ── 缓存读写 ──

  /** 缓存读取：版本不一致/超 TTL/无记录均按 miss；读失败静默降级 miss。 */
  private async _get_cached(
    fingerprint: string,
    patch_version: CacheVersion,
  ): Promise<LLMResult | null> {
    if (this._storage === null) return null;
    let record: Record<string, unknown> | null;
    try {
      record = await this._storage.get_record(CACHE_COLLECTION, fingerprint);
    } catch {
      return null; // 缓存读取失败不影响调用：缓存是增强不是依赖
    }
    if (record === null) return null;
    if (String(record['patch_version'] ?? null) !== String(patch_version)) {
      return null; // 版本变化（补丁链演化等）→ 逻辑失效
    }
    const created = Number(record['created_at'] ?? 0);
    if (this._clock() - created > this._ttl) {
      return null; // 超出保质期
    }
    const response = record['response'];
    return _result_from_dict(
      response !== null && typeof response === 'object' && !Array.isArray(response)
        ? (response as Record<string, unknown>)
        : {},
    );
  }

  /** 缓存写入：落库失败静默忽略，不影响调用结果。 */
  private async _store(
    fingerprint: string,
    result: LLMResult,
    patch_version: CacheVersion,
  ): Promise<void> {
    if (this._storage === null) return;
    const data: Record<string, unknown> = {
      fingerprint,
      response: _result_to_dict(result),
      tier: this._tier,
      created_at: this._clock(),
      patch_version: String(patch_version),
    };
    try {
      await this._storage.put_record(CACHE_COLLECTION, fingerprint, data);
    } catch {
      // 缓存写入失败不影响调用结果
    }
  }

  // ── AsyncLLM 协议 ──

  async ainvoke(
    messages: readonly Message[],
    opts: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): Promise<LLMResult> {
    const tools = opts.tools ?? null;
    const params = opts.params ?? null;
    const patch_version = await this._patch_version();
    const fingerprint = this._fingerprint(messages, tools, params);
    const cached = await this._get_cached(fingerprint, patch_version);
    if (cached !== null) {
      this._hits += 1;
      return cached;
    }
    this._misses += 1;
    const result = await this._inner.ainvoke(messages, { tools, params });
    await this._store(fingerprint, result, patch_version);
    return result;
  }

  // ── 统计与清理（命中率导出 + 缓存清空）──

  /** 缓存统计：条目量 + 命中/未命中计数 + 命中率。
   *
   * 条目量经存储后端实时读取（缺存储 = 0）；命中率 = hits/(hits+misses)
   * （无调用 = 0.0）。计数为进程内累计，与存储条目量口径不同（计数含
   * 历史已失效记录，条目量仅当前有效）。
   */
  async stats(): Promise<{ entries: number; hits: number; misses: number; hit_rate: number }> {
    let entries = 0;
    if (this._storage !== null) {
      try {
        entries = (await this._storage.list_records(CACHE_COLLECTION)).length;
      } catch {
        entries = 0;
      }
    }
    const denom = this._hits + this._misses;
    const hit_rate = denom > 0 ? this._hits / denom : 0.0;
    return { entries, hits: this._hits, misses: this._misses, hit_rate };
  }

  /** 清空缓存：删除全部落库记录并重置命中计数，返回删除条数。
   *
   * 计数归零与记录清理一致（缓存语义整体清零）；无存储 = 仅计数归零、
   * 返回 0。清库失败不阻断（计数仍归零）。
   */
  async clear(): Promise<number> {
    let count = 0;
    if (this._storage !== null) {
      try {
        count = await this._storage.delete_collection(CACHE_COLLECTION);
      } catch {
        count = 0;
      }
    }
    this._hits = 0;
    this._misses = 0;
    return count;
  }

  /** 流式直通（不缓存）：缓存化要求收集完整流才能复用——首块延迟与流式
   *  前进步履是流式语义本身，此路径无可缓存性。
   */
  async *astream(
    messages: readonly Message[],
    opts: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): AsyncIterable<LLMChunk> {
    const tools = opts.tools ?? null;
    const params = opts.params ?? null;
    yield* this._inner.astream(messages, { tools, params });
  }

  async aclose(): Promise<void> {
    await this._inner.aclose();
  }
}
