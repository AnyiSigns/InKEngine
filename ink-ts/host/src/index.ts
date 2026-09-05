/**
 * @ink-ts/host 装配入口（createHost）：composition root。
 *
 * 读配置（config.ts）→ 实现 Host 五件套（host.ts）→ 构建产品配方
 * （recipe.ts：机制开关默认全开 + 产品默认 chat 图）→ 装配宿主检索域
 * （retrieval/domain.ts：向量/FTS 检索源 + data_dir 文档库）→
 * Runtime.boot 装配 → buildBridge 出宿主命令面。机制语义全在 engine；
 * 本包只装配不复制。
 *
 * graph_recipe 缺省 = 产品默认 chat 图；调用方可经 recipe 覆写。检索源
 * 属宿主领域层：装配时直注 recipe.retrieval_sources（引擎注册表消费）。
 */

import { mkdirSync } from 'node:fs';

import { Runtime } from '@ink-ts/engine';
import type { Host } from '@ink-ts/engine';

import type { BridgeHandler } from './bridge/_types.js';
import { buildBridge } from './bridge/index.js';
import { HostConfigError, resolve_host_config } from './config.js';
import type { HostConfigInput, ResolvedHostConfig } from './config.js';
import { DocService } from './doc/service.js';
import { InkHost } from './host.js';
import { buildHostSearch } from './search/wiring.js';
import { build_product_recipe } from './recipe.js';
import type { ProductRecipeInit } from './recipe.js';
import { buildHostRetrieval } from './retrieval/domain.js';
import type { HostRetrievalDomain } from './retrieval/domain.js';

/** createHost 装配产物（cli/web/vitest 消费面）。 */
export interface HostHandle {
  runtime: Runtime;
  bridge: ReadonlyMap<string, BridgeHandler>;
  config: ResolvedHostConfig;
  /** 宿主检索域（向量/FTS 文档库 + 嵌入适配器；数据落 config.data_dir）。 */
  retrieval: HostRetrievalDomain;
  /** 幂等关停：Runtime.stop（拒新 → 等在途 → 关 MCP/LLM/存储 → host 关停钩子）
   *   → 检索域适配器收口。 */
  dispose(): Promise<void>;
}

/**
 * 装配 host：配置解析 → 五件套 + 配方 → 检索域 → Runtime.boot → bridge。
 *
 * @param config 运行配置（storage uri / 角色槽模型端点 / autoApprove 等；
 *   缺省 memory:// + fail-closed，见 config.ts）。
 * @param recipe 配方覆写（graph_recipe 缺省 = 产品默认 chat 图）。
 */
export async function createHost(
  config: HostConfigInput | null | undefined = null,
  recipe: ProductRecipeInit | null | undefined = null,
): Promise<HostHandle> {
  const resolved = resolve_host_config(config);
  mkdirSync(resolved.events_dir, { recursive: true });
  mkdirSync(resolved.data_dir, { recursive: true });
  const retrieval = buildHostRetrieval(resolved.data_dir);
  const inkHost = new InkHost(resolved);
  const assemblyRecipe = build_product_recipe(recipe ?? undefined);
  for (const factory of retrieval.sourceFactories()) {
    assemblyRecipe.retrieval_sources.push(factory as never);
  }
  const runtime = new Runtime();
  await runtime.boot(inkHost as unknown as Host, assemblyRecipe);
  mkdirSync(resolved.attachment_dir, { recursive: true });
  const docService = new DocService({ maxChars: resolved.round_doc_text_cap ?? undefined });
  const search = buildHostSearch();
  const declarative = runtime.harness_registry?.declarative;
  if (declarative !== null && declarative !== undefined) {
    search.register(declarative as never);
  }
  const bridge = buildBridge({
    runtime,
    host: inkHost,
    autoApprove: resolved.autoApprove,
    attachment_dir: resolved.attachment_dir,
    docTextCap: resolved.round_doc_text_cap,
    docParse: docService,
    searchKeys: search.keys,
  });
  const handle: HostHandle = {
    runtime,
    bridge,
    config: resolved,
    retrieval,
    dispose: async (): Promise<void> => {
      await runtime.stop();
      await retrieval.close();
    },
  };
  return handle;
}

export type { BridgeContext, BridgeError, BridgeHandler, HostBridgeDeps } from './bridge/_types.js';
export { BRIDGE_METHODS, buildBridge } from './bridge/index.js';
export type { BridgeMethod } from './bridge/index.js';
export { FileEventsTransport } from './transport.js';
export { InkHost } from './host.js';
export {
  ENV_KEYS,
  HostConfigError,
  LLM_PROTOCOLS,
  resolve_host_config,
} from './config.js';
export type {
  HostConfigInput,
  ModelConfigInput,
  ResolvedHostConfig,
  RoleEndpointConfig,
} from './config.js';
export { PRODUCT_SWITCH_DEFAULTS, build_product_recipe } from './recipe.js';
export type { ProductRecipeInit, ProductSwitchName, RecipeGraph } from './recipe.js';
export { productChatGraphRecipe, STUB_REPLY } from './graph.js';

// ── 会话宿主薄服务 ──
export { HostSessionStore, SessionServiceError } from './sessions/store.js';
export type { SessionTouchInput } from './sessions/store.js';
export {
  HOST_SESSIONS_COLLECTION,
  SESSION_TITLE_MAX,
  branch_tree_from_chain,
  fallback_title,
  normalize_title,
  parse_session_record,
  session_record_to_json,
} from './sessions/model.js';
export type {
  HostSessionRecord,
  SessionBranchNode,
  SessionBranchTree,
} from './sessions/model.js';

// ── 宿主检索域（向量/FTS 检索源 + AsyncEmbedder seam）──
export { buildHostRetrieval, FtsRetriever, RetrievalStore, VectorRetriever, SOURCE_FTS, SOURCE_VECTOR } from './retrieval/domain.js';
export type { HostRetriever, HostRetrievalDomain, RetrievalChunk, RetrievalDoc } from './retrieval/domain.js';
export { SyncEmbedderSeam, attachToolIndexEmbedder } from './retrieval/sync_seam.js';

// ── 受控 OS 执行器域 ──
export { HostOsRunner, OsError, writeOsAudit } from './os/runner.js';
export type { OsApproval, OsToolRequest } from './os/runner.js';

// ── 文档解析执行体域（exec doc.parse 消费面；rounds/material 注入）──
export { DEFAULT_DOC_TEXT_CAP, DocService } from './doc/service.js';
export type { DocParser, DocParseResult } from './doc/_types.js';
export {
  normalizeAttachment,
  prepareRoundInput,
} from './bridge/round_attachments.js';
export type { AttachmentPayload, PreparedRound } from './bridge/round_attachments.js';

// ── 既有资料导入域（material.import 消费面）──
export { MaterialError, scanMaterial } from './material/scan.js';
export {
  DEFAULT_MATERIAL_MAX_BYTES,
  DEFAULT_MATERIAL_MAX_DEPTH,
  DEFAULT_MATERIAL_MAX_FILES,
  MATERIAL_DOC_EXTS,
  MATERIAL_TEXT_EXTS,
} from './material/scan.js';
export type {
  MaterialFile,
  MaterialScanOptions,
  MaterialScanOutcome,
  MaterialSkipped,
} from './material/scan.js';

// ── 检索域（web_search 执行体注入 + 密钥内存存取）──
export { SearchKeysStore, maskKey } from './search/keys.js';
export {
  SEARCH_PROVIDERS,
  WebSearchError,
  makeWebSearchExecutor,
  normalizeResults,
  renderSearchResults,
} from './search/executor.js';
export type {
  SearchFetch,
  SearchProviderDef,
  SearchResultItem,
  WebSearchExecutorDeps,
} from './search/executor.js';
export { buildHostSearch, webSearchSeedDefinition } from './search/wiring.js';
export type { HostSearch } from './search/wiring.js';

// ── 原生机制件 client / 嵌入适配器（exec + infer + AsyncEmbedder）──
export { locateNativeBinary } from './exec/binary.js';
export type { NativeBinaryKind } from './exec/_types.js';
export {
  buildSignedExecEnvelope,
  hmacHex,
  hostAllowed,
  isPathWithinRoots,
  parseUrlHost,
  pathHasDotdot,
  randomSessionKey,
  verifySignature,
} from './exec/envelope.js';
export type { AdjudicatedDecision, ExecRequest } from './exec/envelope.js';
export { ExecClient, EXEC_SESSION_KEY_ENV } from './exec/client.js';
export { SupervisedNativeSession } from './exec/session.js';
export type { SessionOpener } from './exec/session.js';
export { StdioProcessSession } from './exec/transport.js';
export type { NativeSpawnOptions } from './exec/transport.js';
export {
  DEFAULT_RESTART_POLICY,
  ExecRefusedError,
  RpcError,
  SessionLostError,
} from './exec/_types.js';
export type {
  ExecDecision,
  ExecEnvelope,
  ExecOp,
  ExecOutcome,
  RestartPolicy,
} from './exec/_types.js';
export { EmbeddingAdapter } from './embedder/adapter.js';
export type { EmbedOutput, EmbeddingAdapterOptions } from './embedder/adapter.js';
export { deterministicVector, l2Normalize } from './embedder/deterministic.js';
export { InferClient } from './embedder/infer_client.js';
export type { InferEmbedWire, InferPlanWire } from './embedder/infer_client.js';
export { remoteEmbed } from './embedder/remote.js';
export { GRANITE_97M_DIM, GRANITE_MODEL_DIR_DEFAULT, resolveEmbeddingPlan } from './embedder/resolve_plan.js';
export type {
  EmbeddingPlan,
  EmbeddingSourceName,
  RemoteEmbeddingEndpoint,
} from './embedder/resolve_plan.js';
