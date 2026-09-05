/**
 * 工具向量索引（search_tools 后端检索引擎）。
 *
 * 检索语义落引擎侧：search_tools 是引擎自指工具、工具注册表在引擎，检索
 * 发生在引擎 = 索引也在引擎，保持架构一致（shell 侧 embedder.rs 是嵌入
 * 计算的实现位点；本模块仅消费 ``AsyncEmbedder`` 抽象，不依赖宿主实现）。
 *
 * 索引契约：
 * - 构建：48 工具 name+description → 向量，命名空间 ``tools``，一次构建。
 * - 增量刷新：工具增改 / MCP 挂载 hook 触发 ``refresh``，只重新嵌入变更条目
 *   （不重建全量）。
 * - 降级：嵌入层不可用（无配置 / 模型缺失 / 推理失败）= 关键词基线
 *   （子串 + 分词匹配），永不明返回空。嵌入失败**可观测**：seam 收窄为
 *   同步直返（宿主先 await 收口再注入，见 _types.ts），失败经 degraded
 *   on_degraded 回调/字段上报——不再把 Promise 轮询成「恒空向量」静默降级。
 *
 * core 零 IO / 零宿主词：日志走 console seam，副作用均由宿主注入。
 */

import {
  DEFAULT_ENDPOINT,
  MAX_RESULTS,
  NAME_REPEAT,
  SELF_TOOL_NAMES,
  type AsyncEmbedder,
  type Endpoints,
  type SearchResult,
  type Tier,
  type ToolIndexEntry,
} from './_types.js';
import { ToolSpec } from '../llm/tools.js';

/** 嵌入异常消息字符串化（Python str(exc) 口径：Error 取 message，其余兜底）。 */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** thenable 判定：async 函数/Promise 结果 = seam 契约违规（宿主未先 await）。 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** 余弦相似度（零向量防御）。 */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 简易分词：小写 + 连续 ASCII 字母数字 + 连续中文字符逐字。 */
function tokenize(text: string): Set<string> {
  const lowered = text.toLowerCase();
  const tokens = new Set<string>();
  const asciiMatches = lowered.match(/[a-z0-9]+/g);
  if (asciiMatches !== null) for (const w of asciiMatches) tokens.add(w);
  for (const ch of lowered) {
    if (ch >= '一' && ch <= '鿿') tokens.add(ch);
  }
  return tokens;
}

/** 关键词基线打分：query token 在文本中的命中密度。 */
function keyword_score(query_tokens: ReadonlySet<string>, text: string): number {
  if (query_tokens.size === 0) return 0;
  const text_tokens = tokenize(text);
  if (text_tokens.size === 0) return 0;
  let hits = 0;
  for (const t of query_tokens) if (text_tokens.has(t)) hits++;
  return hits / query_tokens.size;
}

/** 参数 schema 的一句话摘要（必填属性名 / 可选属性名前 4 个）。 */
function parameters_summary(parameters: unknown): string {
  if (parameters === null || parameters === undefined || typeof parameters !== 'object') {
    return '无参数';
  }
  const obj = parameters as Record<string, unknown>;
  const properties = obj['properties'];
  if (properties === null || properties === undefined || typeof properties !== 'object') {
    return '无参数';
  }
  const propObj = properties as Record<string, unknown>;
  const propKeys = Object.keys(propObj);
  if (propKeys.length === 0) return '无参数';
  const required = obj['required'];
  if (Array.isArray(required) && required.length > 0) {
    return '必填: ' + required.map((k) => String(k)).join('/');
  }
  return '可选: ' + propKeys.slice(0, 4).join('/');
}

/** 权限档判定：introspection/self 直过；声明式默认 review。 */
function tier_of(spec: ToolSpec): Tier {
  if (spec.name.startsWith('inspect_')) return 'allow';
  if (SELF_TOOL_NAMES.has(spec.name)) return 'allow';
  return 'review';
}

function to_result(entry: ToolIndexEntry, score: number): SearchResult {
  return {
    name: entry.spec.name,
    description: entry.spec.description ?? '',
    parameters_summary: parameters_summary(entry.spec.parameters),
    tier: entry.tier,
    endpoint: entry.endpoint,
    score,
  };
}

function empty_vector(): readonly number[] | null {
  return null;
}

/** 工具向量索引（构建一次、增量刷新、失败降级关键词基线）。 */
export class ToolVectorIndex {
  /** 引擎侧 AsyncEmbedder 实例（null = 纯关键词基线）。 */
  embedder: AsyncEmbedder | null;
  /** 命名空间（默认 ``tools``，隔离不同检索域；架构层保留字段）。 */
  readonly namespace: string;
  /** 嵌入降级上报回调（core 零日志：失败经注入面可观测，不静默）。 */
  readonly on_degraded: ((reason: string) => void) | null;
  /** 最近一次嵌入降级原因（null = 未降级；失败不静默的可观测标记）。 */
  degraded_reason: string | null;
  /** 索引条目表（name → entry）。 */
  entries: Map<string, ToolIndexEntry>;
  /** 任意条目已嵌入则 True（向量检索可用）。 */
  vectors_built: boolean;

  constructor(init: {
    embedder?: AsyncEmbedder | null;
    namespace?: string;
    on_degraded?: ((reason: string) => void) | null;
  } = {}) {
    this.embedder = init.embedder ?? null;
    this.namespace = init.namespace ?? 'tools';
    this.on_degraded = init.on_degraded ?? null;
    this.degraded_reason = null;
    this.entries = new Map();
    this.vectors_built = false;
  }

  /** 记录嵌入降级（标记 + 上报回调；失败不静默，供宿主/可观测层消费）。 */
  private _degrade(reason: string): void {
    this.degraded_reason = reason;
    if (this.on_degraded !== null) this.on_degraded(reason);
  }

  /**
   * 批量嵌入（同步契约）：嵌入器异常/返回 thenable（宿主未先 await）= 降级
   * 并上报（返回 null → 调用方回落关键词基线）；向量形态为空表 = 正常返回
   * 空表（条目级无向量由调用方置 null）。
   */
  private _embed_texts(texts: readonly string[]): readonly (readonly number[])[] | null {
    if (this.embedder === null) return null;
    let out: unknown;
    try {
      out = this.embedder.aembed_documents(texts);
    } catch (err) {
      this._degrade(`文档嵌入失败: ${errMessage(err)}`);
      return null;
    }
    if (isThenable(out)) {
      // seam 契约违规：AsyncEmbedder 已收窄为同步直返（宿主须先 await）。
      // 处理 = 降级关键词基线 + 明确原因上报（不静默吞成恒空向量）。
      this._degrade('嵌入 seam 契约违规：宿主未先 await 收口（AsyncEmbedder 为同步直返契约）');
      return null;
    }
    return out as readonly (readonly number[])[];
  }

  /** 构造嵌入文本（name 加权 + description）。 */
  embed_text(spec: ToolSpec): string {
    const name_part = Array.from({ length: NAME_REPEAT }, () => spec.name).join(' ');
    const desc = spec.description ?? '';
    return `${name_part} ${desc}`.trim();
  }

  /** 全量构建索引（首次或强制重建）。 */
  build(specs: Iterable<ToolSpec>, endpoints: Endpoints | null = null): void {
    const items = Array.from(specs);
    const epMap = endpoints ?? {};
    const texts = items.map((s) => this.embed_text(s));
    const vectors =
      items.length === 0 ? [] : this._embed_texts(texts) ?? items.map(() => empty_vector());
    this.entries.clear();
    items.forEach((spec, i) => {
      const vector = vectors[i];
      const vec =
        vector !== undefined && vector !== null && vector.length > 0 ? vector : null;
      this.entries.set(spec.name, {
        spec,
        vector: vec,
        endpoint: epMap[spec.name] ?? DEFAULT_ENDPOINT,
        tier: tier_of(spec),
      });
    });
    this.vectors_built = Array.from(this.entries.values()).some((e) => e.vector !== null);
  }

  /** 增量刷新：只重新嵌入新增/变更的条目。 */
  refresh(specs: Iterable<ToolSpec>, endpoints: Endpoints | null = null): void {
    const epMap = endpoints ?? {};
    const texts: string[] = [];
    const targets: Array<{ name: string; spec: ToolSpec }> = [];
    for (const spec of specs) {
      const entry = this.entries.get(spec.name);
      const endpoint = epMap[spec.name] ?? DEFAULT_ENDPOINT;
      if (
        entry !== undefined &&
        entry.vector !== null &&
        (spec.description ?? '') !== '' &&
        entry.endpoint === endpoint &&
        entry.tier === tier_of(spec)
      ) {
        this.entries.set(spec.name, {
          spec,
          vector: entry.vector,
          endpoint: entry.endpoint,
          tier: entry.tier,
        });
        continue;
      }
      texts.push(this.embed_text(spec));
      targets.push({ name: spec.name, spec });
    }
    if (targets.length === 0) return;
    const vectors =
      texts.length === 0 ? [] : this._embed_texts(texts) ?? targets.map(() => empty_vector());
    targets.forEach((t, i) => {
      const vector = vectors[i];
      const vec =
        vector !== undefined && vector !== null && vector.length > 0 ? vector : null;
      this.entries.set(t.name, {
        spec: t.spec,
        vector: vec,
        endpoint: epMap[t.name] ?? DEFAULT_ENDPOINT,
        tier: tier_of(t.spec),
      });
    });
    this.vectors_built = Array.from(this.entries.values()).some((e) => e.vector !== null);
  }

  /** 检索：向量相似度优先，不可用时降级关键词基线。 */
  search(query: string, limit: number = MAX_RESULTS): SearchResult[] {
    if (!query || this.entries.size === 0) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (this.vectors_built && this.embedder !== null) {
      return this.vector_search(trimmed, limit);
    }
    return this._search_keyword(trimmed, limit);
  }

  /** 向量检索（query 嵌入 + 余弦相似度排序）。 */
  vector_search(query: string, limit: number): SearchResult[] {
    let query_vector: readonly number[] | null = null;
    if (this.embedder !== null) {
      try {
        const out = this.embedder.aembed_query(query);
        if (isThenable(out)) {
          this._degrade('query 嵌入 seam 契约违规：宿主未先 await 收口（AsyncEmbedder 为同步直返契约）');
          return this._search_keyword(query, limit);
        }
        query_vector = out as readonly number[];
        if (query_vector === null || query_vector.length === 0) {
          return this._search_keyword(query, limit);
        }
      } catch (err) {
        this._degrade(`query 嵌入失败: ${errMessage(err)}`);
        query_vector = null;
      }
    }
    if (!query_vector) return this._search_keyword(query, limit);
    const scored: Array<{ score: number; entry: ToolIndexEntry }> = [];
    for (const entry of this.entries.values()) {
      if (entry.vector === null) continue;
      const score = cosine(query_vector, entry.vector);
      scored.push({ score, entry });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored
      .slice(0, limit)
      .filter((s) => s.score > 0)
      .map((s) => to_result(s.entry, s.score));
  }

  /** 检索退化路径的单一内部出口：关键词基线（子串 + 分词匹配）。 */
  private _search_keyword(query: string, limit: number): SearchResult[] {
    const query_tokens = tokenize(query);
    const query_lower = query.toLowerCase();
    const scored: Array<{ score: number; entry: ToolIndexEntry }> = [];
    for (const entry of this.entries.values()) {
      const text = this.embed_text(entry.spec);
      const substring_bonus = text.toLowerCase().includes(query_lower) ? 0.5 : 0;
      const token_score = keyword_score(query_tokens, text);
      const score = substring_bonus + token_score;
      if (score > 0) scored.push({ score, entry });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => to_result(s.entry, s.score));
  }
  /** 关键词基线检索（公开面：search/vector_search 的统一退化出口委托）。 */
  keyword_search(query: string, limit: number): SearchResult[] {
    return this._search_keyword(query, limit);
  }

  /** 索引是否含某工具名。 */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** 按名取工具描述（供 request_tool 注入用）。 */
  spec(name: string): ToolSpec | null {
    const entry = this.entries.get(name);
    return entry ? entry.spec : null;
  }

  /** 全部工具描述（供 merged_specs 全量清单）。 */
  all_specs(): ToolSpec[] {
    return Array.from(this.entries.values()).map((e) => e.spec);
  }

  /** 是否使用向量检索（false = 关键词基线降级）。 */
  uses_vectors(): boolean {
    return this.vectors_built;
  }

  /** 索引条目数。 */
  size(): number {
    return this.entries.size;
  }
}

export { ToolSpec };
export type { AsyncEmbedder as AsyncEmbedderType, Endpoints as EndpointsType };