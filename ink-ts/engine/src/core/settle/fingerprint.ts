/**
 * 指纹缓存接口与成功组合入库钩子（接口先行；缓存本体后置）。
 *
 * 对标 ink_engine.core.settle 的 QualityGate / FingerprintCache /
 * FingerprintSettleHook：
 * - QualityGate：产出质量闸门（窄协议，随组装请求注入；宿主按域提供判定）。
 *   无闸门注入 = fail-closed 不入缓存（高质量归纳前提不满足）；
 * - FingerprintCache：指纹缓存接口（fingerprint = 缓存主键：注入上下文
 *   指纹时与查找侧键一致；未注入时退化为图摘要）。path_fingerprint = 路径
 *   图指纹（Graph.digest）；domain = 上下文域（容量淘汰按域分组）；
 * - FingerprintSettleHook：成功组合 → 指纹缓存 upsert。fail-closed：未注入
 *   缓存或未注入质量闸门 = 不入缓存；闸门结论只记录布尔值（闸门评估发生在
 *   执行期宿主侧，本钩子零 LLM）。
 */

import type { EdgeEvidenceStore } from '../edge_evidence/store.js';
import { edge_evidence_to_dict } from '../edge_evidence/store.js';
import { GraphDefinitionError } from '../errors.js';
import type { Graph } from '../graph/graph.js';
import { TRACE_FAILED } from './_constants.js';
import { SettleContext, path_key } from './types.js';

/** 产出质量闸门（窄协议，随组装请求注入；宿主按域提供判定）。 */
export interface QualityGate {
  evaluate(ctx: SettleContext): Promise<boolean> | boolean;
}

/** 指纹缓存 upsert 选项（对齐 Python 关键字形参）。 */
export interface FingerprintCacheUpsertOpts {
  path: Record<string, unknown>;
  evidence_snapshot: unknown[];
  model_id: string;
  gate_passed: boolean;
  path_fingerprint?: string;
  domain?: string;
}

/** 指纹缓存接口（接口先行；缓存本体与顶替机制后置）。 */
export interface FingerprintCache {
  upsert(fingerprint: string, opts: FingerprintCacheUpsertOpts): Promise<void>;
}

/** 上下文指纹提供形态：静态字符串或惰性求值 callable。 */
export type ContextFingerprint =
  | string
  | (() => string | null)
  | null
  | undefined;

/** 质量闸门评估回调协议形态（StubGate 等测试桩便捷实现）。 */
export type GateLike = { evaluate(ctx: SettleContext): Promise<boolean> | boolean };

/**
 * 成功组合 → 指纹缓存 upsert（接口先行；缓存本体后置）。
 *
 * fail-closed：未注入缓存或未注入质量闸门 = 不入缓存；闸门结论只记录布尔值。
 * 注入 context_fingerprint（组装请求侧纯函数产出）时以之为缓存主键，与组装
 * 查找侧键一致——未注入保持旧形态（图摘要作键，向后兼容）。
 */
export class FingerprintSettleHook {
  readonly #cache: FingerprintCache | null;
  readonly #gate: GateLike | null;
  readonly #store: EdgeEvidenceStore | null;
  readonly #modelId: string;
  readonly #contextFingerprint: ContextFingerprint;
  /** 本次 run 是否尝试了入库（供测试断言 fail-closed 语义）。 */
  readonly attempts: Record<string, unknown>[] = [];

  constructor(
    cache: FingerprintCache | null = null,
    gate: GateLike | null = null,
    store: EdgeEvidenceStore | null = null,
    opts: {
      model_id?: string;
      context_fingerprint?: ContextFingerprint;
    } = {},
  ) {
    this.#cache = cache;
    this.#gate = gate;
    this.#store = store;
    this.#modelId = opts.model_id ?? '';
    this.#contextFingerprint = opts.context_fingerprint ?? null;
  }

  /**
   * 解析缓存主键：静态字符串直取；callable 惰性求值（生产装配读取组装运行期
   * 最近一次请求指纹——写入键与组装查找键同空间）。解析失败 = null。
   */
  _resolve_fingerprint(): string | null {
    const value = this.#contextFingerprint;
    if (typeof value === 'function') {
      try {
        const resolved = value();
        return resolved ? String(resolved) : null;
      } catch {
        return null;
      }
    }
    return value ? String(value) : null;
  }

  async settle(ctx: SettleContext): Promise<void> {
    if (this.#cache === null || this.#gate === null) {
      return; // 无闸门/无缓存 = fail-closed 不入缓存
    }
    if (ctx.steps.some((s) => s.status === TRACE_FAILED)) {
      return;
    }
    const top: Graph | undefined = ctx.graphs.get(path_key([]));
    if (top === undefined) {
      return;
    }
    const gatePassed = Boolean(await this.#gate.evaluate(ctx));
    this.attempts.push({ fingerprint: top.digest(), gate_passed: gatePassed });
    if (!gatePassed) {
      return;
    }
    let snapshot: unknown[] = [];
    if (this.#store !== null) {
      snapshot = (await this.#store.list_edges(ctx.domain)).map((e) =>
        edge_evidence_to_dict(e),
      );
    }
    // 路径数据 = 图定义序列化；直挂函数图不可序列化时退化携带指纹
    // （缓存体只读身份，指纹即身份）
    let pathData: Record<string, unknown>;
    try {
      pathData = top.to_dict();
    } catch (exc) {
      if (exc instanceof GraphDefinitionError) {
        pathData = { fingerprint: top.digest() };
      } else {
        throw exc;
      }
    }
    // 缓存主键：注入上下文指纹（静态或 callable）时与组装查找侧一致；未注入
    // 退化为图摘要（向后兼容）。注入但解析失败 = 写入键不可得的 fail-closed——
    // 不降级图摘要（降级会写进错误键空间污染缓存）
    const resolved = this._resolve_fingerprint();
    if (this.#contextFingerprint !== null && this.#contextFingerprint !== undefined && resolved === null) {
      return;
    }
    const key = resolved ?? top.digest();
    await this.#cache.upsert(key, {
      path: pathData,
      evidence_snapshot: snapshot,
      model_id: this.#modelId,
      gate_passed: true,
      path_fingerprint: top.digest(),
      domain: ctx.domain,
    });
  }
}
