/**
 * 检索域插件（S4 域组2 从 hosts/lib/src/retrieval + embedder 迁入，语义零改）。
 *
 * 域面 = 向量/FTS 文档库（data_dir/retrieval 落盘）+ 嵌入三态适配器
 * （EmbeddingAdapter，embedder/* 按用户裁决并入本域）+ tool_index 语义检索
 * 同步 seam 收口。值随插件（域逻辑唯一实现位）；装配契约（HostRetrievalDomain
 * 结构面/SyncEmbedderSeam 消费位）留宿 @ink-ts/host 装配面经跨树 type import
 * 取用。默认导出 = 域服务工厂（S0 装载契约）：init.data_dir 注入 → 返回
 * buildHostRetrieval 工厂面，createHost/boot 经 domains seam 取用。
 */

export {
  SOURCE_FTS,
  SOURCE_VECTOR,
  FtsRetriever,
  VectorRetriever,
  RetrievalStore,
  buildHostRetrieval,
} from './store.js';
export type {
  HostRetriever,
  HostRetrievalDomain,
  RetrievalChunk,
  RetrievalDoc,
  RetrievalDocInput,
} from './store.js';
export { SyncEmbedderSeam, attachToolIndexEmbedder } from './sync_seam.js';
export { EmbeddingAdapter } from './embedder/adapter.js';
export type { EmbedOutput, EmbeddingAdapterOptions } from './embedder/adapter.js';
export { deterministicVector, l2Normalize } from './embedder/deterministic.js';
export { InferClient } from './embedder/infer_client.js';
export type { InferEmbedWire, InferPlanWire } from './embedder/infer_client.js';
export { remoteEmbed } from './embedder/remote.js';
export type { FetchLike } from './embedder/remote.js';
export { GRANITE_97M_DIM, GRANITE_MODEL_DIR_DEFAULT, resolveEmbeddingPlan } from './embedder/resolve_plan.js';
export type {
  EmbeddingPlan,
  EmbeddingSourceName,
  RemoteEmbeddingEndpoint,
} from './embedder/resolve_plan.js';

import type { EmbeddingAdapterOptions } from './embedder/adapter.js';
import type { HostRetrievalDomain } from './store.js';
import { buildHostRetrieval } from './store.js';

/** 检索域服务面（createHost 经 domains seam 取用的工厂面）。 */
export interface RetrievalDomainFace {
  buildHostRetrieval(options?: EmbeddingAdapterOptions): HostRetrievalDomain;
}

/** S4 域服务工厂（S0 装载契约）：init 注入 data_dir，返回检索域工厂面。 */
export default function createRetrievalDomain(init: { data_dir: string }): RetrievalDomainFace {
  const dataDir = init.data_dir;
  if (dataDir === undefined || dataDir === '') {
    throw new Error('retrieval 域服务工厂需 init.data_dir');
  }
  return {
    buildHostRetrieval: (options?: EmbeddingAdapterOptions) => buildHostRetrieval(dataDir, options),
  };
}
