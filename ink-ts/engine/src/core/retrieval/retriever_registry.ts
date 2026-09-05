/**
 * 检索源注册表（多源统一汇入：合并排序 + 分级标记 + 限流截断）。
 *
 * 语义：
 * - 同名注册覆盖（配置驱动）；配额超限显式拒绝（GraphDefinitionError）；
 * - retrieve = 各源取回 → 按 (relevance 降序, 分级权重降序) 稳定合并 →
 *   limit 截断（钳制注入上下文体积）；
 * - 注入防线：可信度分级按 levels 过滤（只放行允许分级）；检索文本检出
 *   指令型措辞 = 剔除（检索结果不可信——web/外部来源可能携带恶意指令，
 *   命中不入上下文），扫描经 scanner seam 注入（缺省 = scan_text_injection
 *   真实检出；宿主可注入等价实现覆盖）；
 * - 单源失败静默跳过（检索是增强不是收紧），空结果 = 空清单。
 */

import { GraphDefinitionError } from '../errors.js';
import {
  DEFAULT_INJECTION_SCANNER,
  DEFAULT_LIMIT,
  DEFAULT_MAX_RETRIEVERS,
  MAX_LIMIT,
  _LEVEL_RANK,
} from './_types.js';
import type { InjectionScanner, Retriever, RetrievedChunk } from './_types.js';

/** RetrieverRegistry 构造选项（Python kw-only args 的 TS 映射）。 */
export interface RetrieverRegistryOptions {
  /** 注册配额上限（超限显式拒绝；缺省 DEFAULT_MAX_RETRIEVERS）。 */
  max_retrievers?: number;
  /** 指令注入扫描器（缺省 = scan_text_injection 真实检出，见 _types）。 */
  scanner?: InjectionScanner | null;
}

/** 检索源注册表（多源统一汇入：合并排序 + 分级标记 + 限流截断）。 */
export class RetrieverRegistry {
  private readonly _retrievers: Map<string, Retriever> = new Map();
  private readonly _max_retrievers: number;
  private readonly _scanner: InjectionScanner;

  constructor(options: RetrieverRegistryOptions = {}) {
    this._max_retrievers = options.max_retrievers ?? DEFAULT_MAX_RETRIEVERS;
    this._scanner = options.scanner ?? DEFAULT_INJECTION_SCANNER;
  }

  /** 注册检索源（同名覆盖 = 配置驱动；超限且非同名 = 显式拒绝）。 */
  register(retriever: Retriever): void {
    if (
      this._retrievers.size >= this._max_retrievers &&
      !this._retrievers.has(retriever.name)
    ) {
      throw new GraphDefinitionError(
        `检索源数量已达配额上限（${this._max_retrievers}）`,
      );
    }
    this._retrievers.set(retriever.name, retriever);
  }

  /** 按名取检索源（未注册返回 null）。 */
  get(name: string): Retriever | null {
    return this._retrievers.get(name) ?? null;
  }

  /** 已注册检索源名清单（注册序稳定）。 */
  names(): string[] {
    return [...this._retrievers.keys()];
  }

  /**
   * 多源合并检索：按相关度/分级合并排序 + 限流截断。
   *
   * limit: 返回条数上限（钳制 [1, MAX_LIMIT]）；levels: 允许的可信度分级
   * （null = 全部分级放行；注入防线可只放行 model/user 级来源，拦截
   * web/dialog 检索注入）。
   *
   * 每源配额语义：limit 是每源取回上限——各源均以该上限取回
   * （retriever.retrieve(query, { limit: capped })），合并后仍以同一上限
   * 全局截断。即单源配额 = 全局上限（不是 limit/源数）：多源场景下低相关
   * 源不会因高相关源占满全局配额而整体挤出，但全局截断仍保证注入体积
   * 有界（每源取回可能多于实际消费，由全局截断兜底）。
   */
  async retrieve(
    query: string,
    options: { limit?: number; levels?: readonly string[] | null } = {},
  ): Promise<RetrievedChunk[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const levels = options.levels ?? null;
    const capped = Math.max(1, Math.min(Math.trunc(limit || 1), MAX_LIMIT));
    const merged: RetrievedChunk[] = [];
    for (const retriever of this._retrievers.values()) {
      let chunks: RetrievedChunk[];
      try {
        chunks = await retriever.retrieve(query, { limit: capped });
      } catch {
        continue; // 单源失败静默跳过（检索是增强不是收紧）
      }
      for (const chunk of chunks) {
        if (levels !== null && !levels.includes(chunk.level)) {
          continue;
        }
        // 注入防线：检索文本检出指令型措辞 = 剔除（命中不入上下文）
        const hits = this._scanner(chunk.text);
        if (hits.length > 0) {
          continue;
        }
        merged.push(chunk);
      }
    }
    merged.sort(
      (a, b) =>
        b.relevance - a.relevance ||
        (_LEVEL_RANK[b.level] ?? -1) - (_LEVEL_RANK[a.level] ?? -1),
    );
    return merged.slice(0, capped);
  }
}