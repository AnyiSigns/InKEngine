/**
 * tool_index 语义检索的 AsyncEmbedder seam 收口（消费方接通）。
 *
 * 引擎 seam = 同步直返（core 零 IO 同步路径，不轮询 Promise）。宿主接入真
 * 异步嵌入器时先 await 收口：文档向量在 refresh 前批量预热进同步缓存；
 * 未预热查询（运行时才出现的任意 query）无法同步求值 = 抛出并让引擎降级
 * 关键词基线（degraded_reason 可观测，不静默假语义）。预热经 embedder 三态
 * 计划（本地 infer/远端/确定性保底），note/来源随 adapter 可观测。
 */

import type { Runtime } from '@ink-ts/engine';

import type { EmbeddingAdapter } from '../embedder/adapter.js';
import type { EmbedOutput } from '../embedder/adapter.js';

/** 同步嵌入 seam（引擎 AsyncEmbedder 形态；缓存命中直返、缺失抛错降级）。 */
export class SyncEmbedderSeam {
  private readonly docCache = new Map<string, number[]>();
  private readonly queryCache = new Map<string, number[]>();
  private embedOutput: EmbedOutput | null = null;

  constructor(private readonly adapter: EmbeddingAdapter) {}

  /** 最近一次批量嵌入输出（来源/维度/note 观测）。 */
  lastOutput(): EmbedOutput | null {
    return this.embedOutput;
  }

  /** 预热文档向量（refresh/build 前调用；返回来源观测）。 */
  async warmDocuments(texts: readonly string[]): Promise<EmbedOutput> {
    const output = await this.adapter.embed(texts);
    this.embedOutput = output;
    texts.forEach((text, index) => {
      const vector = output.vectors[index];
      if (vector !== undefined && vector.length > 0) this.docCache.set(text, vector);
    });
    return output;
  }

  /** 预热 query 向量（可为检索前已知的查询串做收口）。 */
  async warmQuery(text: string): Promise<number[]> {
    const vector = await this.adapter.embedQuery(text);
    this.queryCache.set(text, vector);
    return vector;
  }

  /** 批量嵌入（同步直返；未预热文本抛错 → 引擎降级并上报原因）。 */
  aembed_documents(texts: readonly string[]): readonly (readonly number[])[] {
    return texts.map((text) => {
      const vector = this.docCache.get(text);
      if (vector === undefined) {
        throw new Error('文档未预热（同步 seam 需先 await warmDocuments）');
      }
      return vector;
    });
  }

  /** query 嵌入（同步直返；未预热抛错 → 引擎降级关键词基线）。 */
  aembed_query(text: string): readonly number[] {
    const vector = this.queryCache.get(text);
    if (vector === undefined) {
      throw new Error('query 未预热（异步嵌入需宿主先行收口；已降级关键词基线）');
    }
    return vector;
  }
}

/**
 * 把同步 seam 接入运行时工具索引并重建向量（消费方 = tool_index 语义检索）。
 *
 * 流程：按 runtime 当前 merged_specs 用同一嵌入文本预热 → 设置
 * tool_index.embedder → refresh_tool_index（引擎增量重建：keyword 条目
 * vector=null 会重新嵌入）。返回 seam 供后续 query 预热与观测。
 */
export async function attachToolIndexEmbedder(
  runtime: Runtime,
  adapter: EmbeddingAdapter,
): Promise<SyncEmbedderSeam> {
  const index = runtime.tool_index;
  if (index === null) throw new Error('tool_index 未装配（runtime 未 boot）');
  const seam = new SyncEmbedderSeam(adapter);
  const specs = runtime.merged_specs();
  const texts = specs.map((spec) => index.embed_text(spec));
  await seam.warmDocuments(texts);
  index.embedder = seam;
  runtime.refresh_tool_index();
  return seam;
}
