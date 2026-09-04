/**
 * 知识集 → 检索源适配（KnowledgeSet 注册为 Retriever；知识注入接线）。
 *
 * 决策「Retriever 注册路线」落点：KnowledgeSet 以本适配器形态注册进
 * RetrieverRegistry，知识内容与文档库/向量库等检索源统一汇入（合并排序 +
 * 注入防线同管）。检索执行体 = knowledge_set 的关键词基线（无语义检索时
 * 确定性可断言；语义检索为可选扩展，宿主可自行注册更强检索源）。
 *
 * 可信度分级透传（weight=credibility 注入面）：条目 credibility 按
 * knowledge_set._SOURCE_CREDIBILITY 分级档映射为 chunk.level（与来源分级
 * 同口径：web < dialog < model < user），meta 携带原始 credibility——
 * 注入侧据此设来源权重（不再恒 1.0 / 仅二元过滤），分级预算分配真正生效。
 *
 * 知识集实例或延迟提供者：运行时链恢复会替换知识集实例，提供者取用
 * 最新实例（不持旧引用——重启/会合替换后检索仍命中最新实例）。
 */

import { KnowledgeSet } from '../knowledge_set/knowledge_set.js';
import { grade_level_for_credibility } from '../source_grading/sourceGrading.js';
import { INJECTION_EXCLUDED_KINDS, MAX_LIMIT, RetrievedChunk } from './_types.js';

/** 知识集 → 检索源适配（name = 注册表内唯一标识，知识源固定名）。 */
export class KnowledgeSetRetriever {
  private readonly _set_provider: () => KnowledgeSet;
  readonly name: string;

  constructor(
    knowledge_set: KnowledgeSet | (() => KnowledgeSet),
    options: { name?: string } = {},
  ) {
    this._set_provider =
      typeof knowledge_set === 'function'
        ? (knowledge_set as () => KnowledgeSet)
        : () => knowledge_set;
    this.name = options.name ?? 'knowledge';
  }

  /** 当前知识集实例（延迟取用：运行时会合替换后仍读到最新）。 */
  get knowledge_set(): KnowledgeSet {
    return this._set_provider();
  }

  /** 知识条目检索：关键词基线命中 → 可信度分级透传的 chunk 清单。 */
  async retrieve(
    query: string,
    options: { limit: number },
  ): Promise<RetrievedChunk[]> {
    const capped = Math.max(1, Math.min(Math.trunc(options.limit || 1), MAX_LIMIT));
    const hits = this.knowledge_set
      .search(query, { limit: capped })
      .filter((entry) => !INJECTION_EXCLUDED_KINDS.has(entry.kind));
    const chunks: RetrievedChunk[] = [];
    for (const entry of hits) {
      chunks.push(
        new RetrievedChunk({
          source: this.name,
          doc_id: entry.id,
          text: entry.render_content(),
          relevance: entry.credibility,
          level: grade_level_for_credibility(entry.credibility),
          meta: {
            entry_id: entry.id,
            credibility: entry.credibility,
            kind: entry.kind,
            level: entry.level,
          },
        }),
      );
    }
    return chunks;
  }
}