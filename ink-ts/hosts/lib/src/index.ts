// gate: 超限(366 行) - @ink-ts/host 公共面导出聚合 + createHost composition root（导出再分行属装配面清单，不拆子文件）
/**
 * @ink-ts/host 装配入口（createHost）：composition root。
 *
 * 读配置（config.ts）→ 持久件（docService/search 密钥域/workspace/capability
 * 台账，跨装配复用）→ assembleHostParts（boot.ts：产品配方 + Runtime.boot +
 * 检索域 + 工具嵌入 seam + MCP）→ buildBridge 出宿主命令面。
 * 机制语义全在 engine；本包只装配不复制。backup.restore 复用同一装配做
 * 「停 → 换 → 重新装配」（boot.ts 每 boot 产物可整体替换，宿主命令面不重建）。
 *
 * 回合 = run 级组装出本轮数据图再执行；本包不再有静态/默认图配方，亦不再
 * 导出任何产品图（原 graph.ts 已删）。检索源属宿主领域层：装配时直注
 * recipe.retrieval_sources（引擎注册表消费）。
 */

import { mkdirSync } from 'node:fs';

import type { Runtime, McpClientManager } from '@ink-ts/engine';
import type { HostSurface } from './host_spec.js';

import { createRestoreRunner } from './backup/restore_runtime.js';
import { assembleHostParts } from './boot.js';
import type { HostBootParts } from './boot.js';
import type { BridgeHandler, HostBridgeDeps, ModelConfigHandles } from './bridge/_types.js';
import { buildBridge } from './bridge/index.js';
import { createHostOpGate } from './bridge/op_gate.js';
import { resolve_host_config } from './config.js';
import type { HostConfigInput, ResolvedHostConfig } from './config.js';
import { loadHostLogicFaces } from './face/loader.js';
import type { DocParser } from './doc/_types.js';
import { createCapabilityStore } from './capability/store.js';
import { buildHostSearch } from './search/wiring.js';
import type { InkHost } from './host.js';
import { createWorkspaceStore } from './workspace/store.js';
import type { ProductRecipeInit } from './recipe.js';
import type { HostRetrievalDomain } from './retrieval/domain.js';
import type { SyncEmbedderSeam } from './retrieval/sync_seam.js';
import type { McpConnectStatus } from './mcp/assembly.js';

export type {
  HostFaces,
  HostSpec,
  HostSurface,
  HostTransport,
  HostApproval,
  HostPortKey,
  HostRendererRef,
  HostRuntimeDefaults,
} from './host_spec.js';
export {
  HOST_APPROVALS,
  HOST_PORT_KEYS,
  HOST_SURFACES,
  HOST_TRANSPORTS,
  findHostsRoot,
  hostPortHas,
  loadHostSpec,
  validateHostSpec,
} from './host_spec.js';

/** createHost 装配产物（cli/web/vitest 消费面）。 */
export interface HostHandle {
  runtime: Runtime;
  bridge: ReadonlyMap<string, BridgeHandler>;
  config: ResolvedHostConfig;
  /** 宿主面（config.host_spec?.host.surface；未 spec 化装配 = null）。 */
  surface: HostSurface | null;
  /** 宿主检索域（向量/FTS 文档库 + 嵌入适配器；数据落 config.data_dir）。 */
  retrieval: HostRetrievalDomain;
  /** tool_index 语义检索同步 seam（createHost 已把检索域嵌入器接入工具索引）。 */
  toolEmbedder: SyncEmbedderSeam | null;
  /** MCP 管理器（声明式执行器已注册；工具导入/备份桥经此取用）。 */
  mcpManager: McpClientManager | null;
  /** MCP 内置 server 连接结果（连接失败只记诊断，fail-closed 不击穿 boot）。 */
  mcpStatus: McpConnectStatus[];
  /** 幂等关停：Runtime.stop（拒新 → 等在途 → 关 MCP/LLM/存储 → host 关停钩子）
   *   → 检索域适配器收口。 */
  dispose(): Promise<void>;
}

/** 模型运行配置句柄（models.config.* 消费面；闭包绑定 InkHost 运行态）。 */
function modelConfigHandles(host: InkHost): ModelConfigHandles {
  return {
    apply: (input) => host.apply_model_config(input),
    persist: () => host.persist_model_config(),
    reload: () => host.reload_model_config(),
  };
}

/**
 * 装配 host（composition root）：解析配置 → 持久件（docService/search 密钥
 * 域/workspace/capability 台账，跨装配复用）→ assembleHostParts（runtime/
 * 引擎/检索域/MCP，restore 后可整体替换）→ bridge（deps 字段为活引用，restore
 * 重装后原位更新——CLI/长驻进程持有的方法表无需重建）。
 *
 * @param config 运行配置（storage uri / 角色槽模型端点 / autoApprove 等；
 *   缺省 sqlite 落 data_dir + fail-closed，见 config.ts）。
 * @param recipe 配方覆写（机制开关/ui 白名单/approval_levels；无图配方位）。
 */
export async function createHost(
  config: HostConfigInput | null | undefined = null,
  recipe: ProductRecipeInit | null | undefined = null,
): Promise<HostHandle> {
  const resolved = resolve_host_config(config);
  mkdirSync(resolved.events_dir, { recursive: true });
  mkdirSync(resolved.data_dir, { recursive: true });
  mkdirSync(resolved.attachment_dir, { recursive: true });

  // 阶段 7a：doc_parse 文档解析执行体 = 插件 logic face（物理单目录 + 装配期
  // 按声明装载）。插件源缺 = docParse 缺省（rounds/material 仅文件名引用降级）；
  // face 声明存在但装载/契约不符 = fail-closed（装配期抛错，不静默降级）。
  const logicFaces = await loadHostLogicFaces(resolved.seed_dir);
  const docModule = logicFaces['doc_parse'];
  let docService: DocParser | undefined;
  if (docModule !== undefined && docModule !== null) {
    const factory = (docModule as { default?: unknown })['default'];
    if (typeof factory !== 'function') {
      throw new Error('doc_parse host logic face 缺默认工厂（faces/logic 契约 = default(init) => DocParser）');
    }
    docService = (factory as (init: { maxChars?: number | null }) => DocParser)({
      maxChars: resolved.round_doc_text_cap ?? undefined,
    });
  }
  const search = buildHostSearch();
  const workspaceStore = createWorkspaceStore(resolved.data_dir);
  const capabilityStore = createCapabilityStore(resolved.data_dir);
  const gate = createHostOpGate();
  const bootInput = {
    resolved,
    recipe: recipe ?? null,
    capability: capabilityStore,
    search,
  };

  let parts: HostBootParts = await assembleHostParts(bootInput);
  const deps: HostBridgeDeps = {
    runtime: parts.runtime,
    host: parts.inkHost,
    autoApprove: resolved.autoApprove,
    modelConfig: modelConfigHandles(parts.inkHost),
    attachment_dir: resolved.attachment_dir,
    docTextCap: resolved.round_doc_text_cap,
    docParse: docService,
    searchKeys: search.keys,
    workspace: workspaceStore,
    capability: capabilityStore,
    data_dir: resolved.data_dir,
    seed_dir: resolved.seed_dir,
    mcpManager: parts.mcpManager,
    gate,
  };

  /** 活引用切换：reboot/restore 后把桥 deps 指向新装配件（原方法表复用）。 */
  const applyParts = (next: HostBootParts): void => {
    deps.runtime = next.runtime;
    deps.host = next.inkHost;
    deps.modelConfig = modelConfigHandles(next.inkHost);
    deps.mcpManager = next.mcpManager;
  };

  /** 重装配（restore 目录替换后调用）：台账重读 + 新装配 + 活引用切换。 */
  const reboot = async (): Promise<void> => {
    workspaceStore.reload();
    capabilityStore.reload();
    parts = await assembleHostParts(bootInput);
    applyParts(parts);
  };

  /** restore 编排：先停 runtime（中止在途 run/引擎/存储写通道）→ 快照 →
   *  目录替换 → reboot；失败回滚到可诊断态（restore_runtime.ts）。 */
  const restore = createRestoreRunner({
    data_dir: resolved.data_dir,
    halt: async (): Promise<void> => {
      const current = parts;
      try {
        await current.runtime.abort_current_run();
      } catch {
        // 中止在途 run 失败：继续关停（stop 会排空/收口）
      }
      await current.runtime.stop();
      await current.retrieval.close();
    },
    reboot,
  });
  deps.restore = restore;

  const bridge = buildBridge(deps);
  const handle: HostHandle = {
    get runtime(): Runtime {
      return parts.runtime;
    },
    bridge,
    config: resolved,
    surface: resolved.surface,
    get retrieval(): HostRetrievalDomain {
      return parts.retrieval;
    },
    get toolEmbedder(): SyncEmbedderSeam | null {
      return parts.toolEmbedder;
    },
    get mcpManager(): McpClientManager | null {
      return parts.mcpManager;
    },
    get mcpStatus(): McpConnectStatus[] {
      return parts.mcpStatus;
    },
    dispose: async (): Promise<void> => {
      await parts.runtime.stop();
      await parts.retrieval.close();
    },
  };
  return handle;
}

export type { HostMcpConfig, McpConnectStatus } from './mcp/assembly.js';
export { assembleHostMcp } from './mcp/assembly.js';

export type { BridgeContext, BridgeError, BridgeHandler, HostBridgeDeps, ModelConfigHandles } from './bridge/_types.js';
export { BRIDGE_METHODS, buildBridge } from './bridge/index.js';
export type { BridgeMethod } from './bridge/index.js';
export { FileEventsTransport } from './transport.js';
export { InkHost } from './host.js';

// ── 运行模型配置管理（config.json 持久化/掩码回显；cli 冷启装配消费）──
export {
  RUNTIME_CONFIG_FILE,
  load_persisted_model_config,
  masked_model_config,
  merge_model_config,
  runtime_config_path,
  write_runtime_model_config,
} from './model_config_runtime.js';
export type { ModelConfigState } from './model_config_runtime.js';
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
export type { ProductRecipeInit, ProductSwitchName } from './recipe.js';

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

// ── 文档解析执行体域（doc_parse 插件 logic face 消费面；rounds/material 注入）──
// 执行体实现随插件同住（plugins/tools/doc_parse/faces/logic，阶段 7a），
// host 经 face loader 装配期按声明装载；此处只导出数据形态 seam。
export type { DocParser, DocParseResult } from './doc/_types.js';
export {
  normalizeAttachment,
  prepareRoundInput,
} from './bridge/round_attachments.js';
export type { AttachmentPayload, PreparedRound } from './bridge/round_attachments.js';

// ── host logic face 装配期装载（阶段 7a：物理单目录 + 按声明装载）──
export { listHostLogicFaces, loadHostLogicFaces } from './face/loader.js';
export type { HostLogicFaceRow } from './face/loader.js';
export { findPluginsManifest, pluginsRootOf } from './plugins_fs.js';

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

// ── 工作区授权域（data_dir/workspace.json 持久化）──
export { WorkspaceStoreError, createWorkspaceStore } from './workspace/store.js';
export type { WorkspaceState, WorkspaceStore } from './workspace/store.js';

// ── 能力记录域（data_dir/capability.json 持久化）──
export {
  CapabilityError,
  createCapabilityStore,
  defaultCapabilityRecord,
} from './capability/store.js';
export type { CapabilityRecord, CapabilityStore } from './capability/store.js';
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

// ── data_dir 快照域（backup.export/preview/restore 消费的宿主领域层）──
export {
  BackupError,
  applyRestore,
  collectDirFiles,
  exportDataDir,
  readBackupFile,
  snapshotDataDir,
} from './backup/snapshot.js';
export type { BackupManifest, DirFile } from './backup/snapshot.js';
export { crc32, packStoreZip, unpackStoreZip } from './backup/zip_codec.js';
export type { ZipEntryInput, ZipEntryOutput } from './backup/zip_codec.js';
