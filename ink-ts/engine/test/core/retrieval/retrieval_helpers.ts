/**
 * 检索测试共享设施（Python test_retrieval.py 的 _chunk/_knowledge_entry/
 * FakeRetriever 的 TS 对应物）：chunk 工厂 + 假检索源 + 知识条目工厂。
 */

import { KnowledgeEntry } from '../../../src/core/knowledge_set/knowledge_entry.js';
import { KIND_RULE, LEVEL_WORK } from '../../../src/core/knowledge_set/_types.js';
import { RetrievedChunk, SOURCE_WEB } from '../../../src/core/retrieval/_types.js';
import type { Retriever } from '../../../src/core/retrieval/_types.js';

/** 检索块工厂（text = <source>:<doc_id> 形态；level 缺省 web 级）。 */
export function chunk(
  source: string,
  doc_id: string,
  relevance: number,
  level: string = SOURCE_WEB,
): RetrievedChunk {
  return new RetrievedChunk({
    source,
    doc_id,
    text: `${source}:${doc_id}`,
    relevance,
    level,
  });
}

/** 测试检索源（预设结果清单；broken = 检索时抛错）。 */
export class FakeRetriever implements Retriever {
  readonly name: string;
  private readonly _chunks: readonly RetrievedChunk[];
  private readonly _broken: boolean;

  constructor(
    name: string,
    chunks: readonly RetrievedChunk[],
    options: { broken?: boolean } = {},
  ) {
    this.name = name;
    this._chunks = chunks;
    this._broken = options.broken ?? false;
  }

  async retrieve(
    query: string,
    options: { limit: number },
  ): Promise<RetrievedChunk[]> {
    void query;
    if (this._broken) {
      throw new Error('检索源故障');
    }
    return this._chunks.slice(0, options.limit);
  }
}

/** 知识条目工厂（rule 形态；credibility/source 可调，tags 固定「知识」）。 */
export function knowledge_entry(
  entry_id: string,
  credibility: number,
  source: string,
): KnowledgeEntry {
  return new KnowledgeEntry({
    id: entry_id,
    level: LEVEL_WORK,
    kind: KIND_RULE,
    data: { rule: { message: `规则 ${entry_id}` } },
    source,
    credibility,
    title: `条目 ${entry_id}`,
    tags: ['知识'],
  });
}