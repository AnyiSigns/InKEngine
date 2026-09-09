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

import type { EdgeEvidenceStore } from '../../core/edge_evidence/store.js';
import { edge_evidence_to_dict } from '../../core/edge_evidence/store.js';
import { GraphDefinitionError } from '../../core/errors.js';
import type { Graph } from '../../core/graph/graph.js';
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
  /** upsert 结果 = 是否真实落位（gate 拒绝/存储拒绝 = false）。 */
  upsert(fingerprint: string, opts: FingerprintCacheUpsertOpts): Promise<boolean>;
  /**
   * 变更探测（可选）：实现支持时 settle 在写前先按 key 比对既有行
   * （path_digest/快照摘要/模型），内容未变 = 跳过写（R7-3 少 IO）。
   * 未实现 = 缺省每次 upsert（旧全量写语义，向后兼容）。
   */
  has_unchanged?(
    fingerprint: string,
    opts: FingerprintCacheUpsertOpts,
  ): Promise<boolean> | boolean;
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
  /** P4.1 兜底零强化：单节点终态兜底成功不固化指纹缓存（缺省开启）。
   *  单节点图 = 无组合路径（组装兜底形态，「成功仅因无更好」不是「这条路
   *  好」）——固化只会让后续组装必中缓存、堵死探索。 */
  readonly #skipSingleNode: boolean;
  /** 本次 run 是否尝试了入库（供测试断言 fail-closed 语义）。 */
  readonly attempts: Record<string, unknown>[] = [];

  constructor(
    cache: FingerprintCache | null = null,
    gate: GateLike | null = null,
    store: EdgeEvidenceStore | null = null,
    opts: {
      model_id?: string;
      context_fingerprint?: ContextFingerprint;
      skip_single_node?: boolean;
    } = {},
  ) {
    this.#cache = cache;
    this.#gate = gate;
    this.#store = store;
    this.#modelId = opts.model_id ?? '';
    this.#contextFingerprint = opts.context_fingerprint ?? null;
    this.#skipSingleNode = opts.skip_single_node ?? true;
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
    // P4.1 兜底零强化：单节点终态兜底成功（0 边单节点图 = 组装兜底形态）不得
    // 固化指纹缓存条目——成功仅因「无更好」，固化会形成确认偏误/探索死锁。
    // 尝试仍留痕（attempts + skipped_reason）供审计，但不产生强化。
    if (this.#skipSingleNode && _is_fallback_single_node(top)) {
      this.attempts[this.attempts.length - 1]![
        'skipped_reason'
      ] = 'terminal_fallback_no_reinforce';
      return;
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
    let snapshot: unknown[] = [];
    if (this.#store !== null) {
      // 域边列表单次读取（同回合 settle 链共享预读点），快照随用随建
      snapshot = (await this.#store.list_edges(ctx.domain)).map((e) =>
        edge_evidence_to_dict(e),
      );
    }
    // 变更检测（R7-3）：缓存实现支持时先按 key 读行比对（path 数据 + 边计数
    // 快照摘要 + 模型），内容未变 = 跳过写与容量淘汰扫描（快照只在变化时
    // 重建；缓存体仍保留旧命中计数，不被冗余顶替清零）
    if (this.#cache.has_unchanged !== undefined) {
      const unchanged = await this.#cache.has_unchanged(key, {
        path: pathData,
        evidence_snapshot: snapshot,
        model_id: this.#modelId,
        gate_passed: true,
        path_fingerprint: top.digest(),
        domain: ctx.domain,
      });
      if (unchanged) {
        return;
      }
    }
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

/** P4.1 组装兜底形态判定：顶层图为 0 边单节点（唯一结点 = entry=exit）。
 *  单节点图 = 无组合路径（组装器从池选 flags.terminal 候选出的最小可行回合
 *  形态，或等价的算法单节点解）——成功仅因无更好，固化无学习价值。函数直挂
 *  结点/声明式绑定/子图三种节点形态都计入；任何边（含回边）即非兜底形态。 */
function _is_fallback_single_node(graph: Graph): boolean {
  const names = new Set<string>([
    ...Object.keys(graph.nodes),
    ...Object.keys(graph.node_bindings),
    ...Object.keys(graph.subgraphs),
  ]);
  if (names.size !== 1) return false;
  let edgeCount = 0;
  for (const list of Object.values(graph.edges)) {
    edgeCount += list.length;
  }
  return edgeCount === 0;
}
