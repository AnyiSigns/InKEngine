/**
 * 检索源宿主域服务（向量/FTS 文档库；数据落 data_dir，不落引擎）。
 *
 * 引擎只认 seam：宿主经 AssemblyRecipe.retrieval_sources 把 Retriever 注册进
 * Runtime.retriever_registry（知识集之外的多源汇入）。文档库（index.json
 * 持久化于 data_dir/retrieval）与嵌入（EmbeddingAdapter 三态计划）均属
 * 宿主领域层。降级可观测：chunk.meta.note 携带嵌入来源（确定性保底注记
 * 不静默），store.describe() 暴露当前计划与文档/向量计数。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { EmbeddingAdapter } from '../embedder/adapter.js';
import type { EmbeddingAdapterOptions } from '../embedder/adapter.js';
import type { EmbeddingSourceName } from '../embedder/resolve_plan.js';

/** 检索源名（引擎注册表内的源标识）。 */
export const SOURCE_VECTOR = 'vector';
export const SOURCE_FTS = 'fts';

/** 检索 chunk 宿主形态（与引擎 RetrievedChunk 消费面结构一致）。 */
export interface RetrievalChunk {
  source: string;
  doc_id: string;
  text: string;
  relevance: number;
  level: string;
  meta: Record<string, unknown>;
}

/** 文档条目（向量随文本嵌入；level 为来源可信度分级）。 */
export interface RetrievalDoc {
  doc_id: string;
  text: string;
  level: string;
  meta: Record<string, unknown>;
  vector: number[] | null;
}

/** 文档写入输入。 */
export interface RetrievalDocInput {
  doc_id: string;
  text: string;
  level?: string;
  meta?: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 简易分词（ASCII 词 + 中文逐字）。 */
function tokenize(text: string): Set<string> {
  const lowered = text.toLowerCase();
  const tokens = new Set<string>();
  const ascii = lowered.match(/[a-z0-9]+/g);
  if (ascii !== null) for (const word of ascii) tokens.add(word);
  for (const ch of lowered) {
    if (ch >= '\u4e00' && ch <= '\u9fff') tokens.add(ch);
  }
  return tokens;
}

/** FTS 关键词打分（子串命中 + token 覆盖率）。 */
function ftsScore(queryTokens: ReadonlySet<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const textTokens = tokenize(text);
  if (textTokens.size === 0) return 0;
  const substring = text.toLowerCase().includes([...queryTokens].join(' ').toLowerCase()) ? 0.5 : 0;
  let hits = 0;
  for (const token of queryTokens) if (textTokens.has(token)) hits += 1;
  return substring + hits / queryTokens.size;
}

/** 检索库形状（index.json 持久化形态）。 */
interface StoreFile {
  version: number;
  docs: Record<string, RetrievalDoc>;
}

/**
 * 文档库（doc_id 唯一；upsert 全量落盘——数据面小，单文件读写足够）。
 */
export class RetrievalStore {
  private readonly file: string;
  private docs: Record<string, RetrievalDoc> = {};

  constructor(
    dataDir: string,
    private readonly adapter: EmbeddingAdapter,
  ) {
    const dir = path.join(dataDir, 'retrieval');
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'index.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (isRecord(raw) && isRecord(raw['docs'])) {
        const docs = raw['docs'] as Record<string, unknown>;
        for (const [doc_id, entry] of Object.entries(docs)) {
          if (!isRecord(entry) || typeof entry['text'] !== 'string') continue;
          this.docs[doc_id] = {
            doc_id,
            text: entry['text'],
            level: typeof entry['level'] === 'string' ? entry['level'] : 'model',
            meta: isRecord(entry['meta']) ? entry['meta'] : {},
            vector: Array.isArray(entry['vector'])
              ? (entry['vector'] as unknown[]).map(Number)
              : null,
          };
        }
      }
    } catch {
      // 索引文件缺失/损坏 = 空库（不阻断启动）
    }
  }

  private persist(): void {
    const payload: StoreFile = { version: 1, docs: this.docs };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, this.file);
  }

  /** 批量写入文档（同批一次嵌入 + 一次落盘）。 */
  async upsertMany(entries: readonly RetrievalDocInput[]): Promise<void> {
    if (entries.length === 0) return;
    const texts = entries.map((entry) => entry.text);
    const output = await this.adapter.embed(texts);
    entries.forEach((entry, index) => {
      const vector = output.vectors[index];
      this.docs[entry.doc_id] = {
        doc_id: entry.doc_id,
        text: entry.text,
        level: entry.level ?? 'model',
        meta: { ...(entry.meta ?? {}) },
        vector: vector !== undefined && vector.length > 0 ? vector : null,
      };
    });
    this.persist();
  }

  /** 单条写入（doc_id 已存在 = 覆盖；文本为空拒绝）。 */
  async upsert(
    doc_id: string,
    text: string,
    opts: { level?: string; meta?: Record<string, unknown> | null } = {},
  ): Promise<void> {
    if (text.trim() === '') throw new Error(`检索文档文本不能为空: ${doc_id}`);
    await this.upsertMany([{ doc_id, text, ...opts }]);
  }

  /** 删除文档（缺失静默）。 */
  async remove(doc_id: string): Promise<void> {
    if (this.docs[doc_id] === undefined) return;
    delete this.docs[doc_id];
    this.persist();
  }

  /** 全部文档（doc_id 升序）。 */
  rows(): RetrievalDoc[] {
    return Object.keys(this.docs)
      .sort()
      .map((doc_id) => this.docs[doc_id]!)
      .filter((doc) => doc !== undefined);
  }

  /** 文档数。 */
  size(): number {
    return Object.keys(this.docs).length;
  }

  /** 嵌入来源观测（source/note/dim；降级不静默）。 */
  describe(): { source: EmbeddingSourceName; dim: number; note: string | null; docs: number; vectors: number } {
    const rows = this.rows();
    return {
      source: this.adapter.source,
      dim: this.adapter.dim,
      note: this.adapter.note,
      docs: rows.length,
      vectors: rows.filter((doc) => doc.vector !== null).length,
    };
  }

  /** FTS 检索（关键词打分降序截断）。 */
  async searchFts(query: string, limit: number): Promise<RetrievalChunk[]> {
    const tokens = tokenize(query);
    const rows = this.rows();
    const scored = rows
      .map((doc) => ({ doc, score: ftsScore(tokens, doc.text) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((entry) => this.chunk(entry.doc, entry.score));
  }

  /** 向量检索（query 经适配器嵌入 + 余弦降序）。 */
  async searchVector(query: string, limit: number): Promise<RetrievalChunk[]> {
    const rows = this.rows().filter((doc) => doc.vector !== null && doc.vector!.length > 0);
    if (rows.length === 0) return [];
    const queryVector = await this.adapter.embedQuery(query);
    if (queryVector.length === 0) return [];
    const scored = rows
      .map((doc) => ({ doc, score: cosine(queryVector, doc.vector!) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((entry) => this.chunk(entry.doc, entry.score));
  }

  private chunk(doc: RetrievalDoc, relevance: number): RetrievalChunk {
    return {
      source: SOURCE_VECTOR,
      doc_id: doc.doc_id,
      text: doc.text,
      relevance: relevance > 1 ? 1 : relevance,
      level: doc.level,
      meta: {
        ...doc.meta,
        note: this.adapter.note,
      },
    };
  }
}

/** 检索源（引擎 Retriever seam 结构；name 唯一、retrieve 相关度降序）。 */
export interface HostRetriever {
  readonly name: string;
  retrieve(query: string, options: { limit: number }): Promise<RetrievalChunk[]>;
}

/** 向量检索源（RetrievalStore 适配；engine registry 注册名 = vector）。 */
export class VectorRetriever implements HostRetriever {
  readonly name = SOURCE_VECTOR;
  constructor(private readonly store: RetrievalStore) {}

  async retrieve(query: string, options: { limit: number }): Promise<RetrievalChunk[]> {
    return this.store.searchVector(query, options.limit);
  }
}

/** FTS 检索源（关键词基线；engine registry 注册名 = fts）。 */
export class FtsRetriever implements HostRetriever {
  readonly name = SOURCE_FTS;
  constructor(private readonly store: RetrievalStore) {}

  async retrieve(query: string, options: { limit: number }): Promise<RetrievalChunk[]> {
    return this.store.searchFts(query, options.limit);
  }
}

/** 检索域装配产物（createHost 持有 + dispose 关停）。 */
export interface HostRetrievalDomain {
  store: RetrievalStore;
  vector: VectorRetriever;
  fts: FtsRetriever;
  adapter: EmbeddingAdapter;
  /** 检索源工厂（AssemblyRecipe.retrieval_sources 直注；runtime 参数不消费）。 */
  sourceFactories(): Array<() => HostRetriever>;
  describe(): ReturnType<RetrievalStore['describe']>;
  close(): Promise<void>;
}

/** 装配宿主检索域（嵌入计划缺省按 env 解析；data_dir 落索引库）。 */
export function buildHostRetrieval(
  dataDir: string,
  options: EmbeddingAdapterOptions = {},
): HostRetrievalDomain {
  const adapter = new EmbeddingAdapter(options);
  const store = new RetrievalStore(dataDir, adapter);
  const vector = new VectorRetriever(store);
  const fts = new FtsRetriever(store);
  return {
    store,
    vector,
    fts,
    adapter,
    sourceFactories: () => [() => vector, () => fts],
    describe: () => store.describe(),
    close: async () => {
      await adapter.close();
    },
  };
}
