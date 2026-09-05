/**
 * AsyncEmbedder 适配器（引擎 tool_index/retrieval seam 的宿主实现前身）。
 *
 * 三态路由按 env 解析（resolve_plan.ts 镜像 infer embedder.rs resolve_plan）：
 * - remote：远端 openai_compat /embeddings（remote.ts，纯协议 HTTP）；
 * - deterministic：确定性保底（deterministic.ts，FNV-1a + sin + L2）；
 * - local_infer：拉起 infer 子进程（InferClient）做本地 ONNX 推理；
 *   模型缺失/内核不满足时 infer 进程内落确定性保底（来源 note 可观测）。
 *
 * 本对象为**异步面**（aembed_* 返回 Promise）；引擎 seam 同步直返形态由
 * 接线层（语义检索接线，波 3）await 收口后注入——本模块不提供进程侧等待。
 */

import type { RestartPolicy } from '../exec/_types.js';
import { deterministicVector, l2Normalize } from './deterministic.js';
import { InferClient } from './infer_client.js';
import { remoteEmbed } from './remote.js';
import type { FetchLike } from './remote.js';
import type { EmbeddingPlan, EmbeddingSourceName } from './resolve_plan.js';
import { resolveEmbeddingPlan } from './resolve_plan.js';

/** 单次嵌入输出（来源 note 随结果可观测——降级不静默）。 */
export interface EmbedOutput {
  vectors: number[][];
  source: EmbeddingSourceName;
  dim: number;
  note: string | null;
}

/** 适配器选项。 */
export interface EmbeddingAdapterOptions {
  /** 计划解析环境（缺省 process.env）。 */
  env?: NodeJS.ProcessEnv;
  /** 模型目录显式覆盖（env INK_EMBEDDING_MODEL_DIR 优先）。 */
  modelDir?: string;
  /** infer 二进制路径（local_infer 必需；binary.ts 定位产物）。 */
  inferBinary?: string | null;
  /** infer spawn 附加环境（如按 host 部署显式传模型目录给子进程）。 */
  inferEnv?: Record<string, string> | null;
  inferPolicy?: Partial<RestartPolicy>;
  /** 远端 fetch 注入（测试）。 */
  fetchImpl?: FetchLike | null;
}

/** 嵌入结果（降级原因可观测；远端失败抛错由调用方按关键词基线降级）。 */
export class EmbeddingAdapter {
  private readonly options: EmbeddingAdapterOptions;
  private cachedPlan: EmbeddingPlan | null = null;
  private inferClient: InferClient | null = null;

  constructor(options: EmbeddingAdapterOptions = {}) {
    this.options = options;
  }

  /** 计划（懒解析一次；镜像 embedder.rs OnceLock 语义）。 */
  plan(): EmbeddingPlan {
    if (this.cachedPlan === null) {
      this.cachedPlan = resolveEmbeddingPlan(this.options.env ?? process.env, {
        modelDir: this.options.modelDir,
      });
    }
    return this.cachedPlan;
  }

  get source(): EmbeddingSourceName {
    return this.plan().source;
  }

  get dim(): number {
    return this.plan().dim;
  }

  /** 降级原因（计划 note）。 */
  get note(): string | null {
    return this.plan().note;
  }

  /** 批量嵌入（三态路由；输出含来源/维度/note）。 */
  async embed(texts: readonly string[]): Promise<EmbedOutput> {
    const plan = this.plan();
    if (texts.length === 0) {
      return { vectors: [], source: plan.source, dim: plan.dim, note: plan.note };
    }
    if (plan.source === 'remote' && plan.remote !== null) {
      const vectors = await remoteEmbed(
        plan.remote,
        texts,
        this.options.fetchImpl ?? undefined,
      );
      return { vectors, source: 'remote', dim: plan.dim, note: null };
    }
    if (plan.source === 'local_infer') {
      const wire = await this.infer().embed(texts);
      return {
        vectors: wire.vectors,
        source: wire.source,
        dim: wire.dim,
        note: wire.note,
      };
    }
    const vectors = [...texts].map((text) => deterministicVector(text, plan.dim));
    return { vectors, source: 'deterministic', dim: plan.dim, note: plan.note };
  }

  /** 单条 query 嵌入。 */
  async embedQuery(text: string): Promise<number[]> {
    const output = await this.embed([text]);
    return output.vectors[0] ?? [];
  }

  private infer(): InferClient {
    if (this.inferClient === null) {
      const binary = this.options.inferBinary ?? null;
      if (binary === null || binary === '') {
        throw new Error('本地嵌入计划需要 infer 二进制（未定位 inferBinary）');
      }
      this.inferClient = new InferClient({
        binary,
        env: this.options.inferEnv ?? null,
        policy: this.options.inferPolicy,
      });
    }
    return this.inferClient;
  }

  /** 关停（幂等；本地会话关闭，远端/保底无资源）。 */
  async close(): Promise<void> {
    const client = this.inferClient;
    this.inferClient = null;
    if (client !== null) await client.close();
  }
}

export { deterministicVector, l2Normalize };
