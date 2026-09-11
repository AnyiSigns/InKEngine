/**
 * host 运行时装配（composition root 的可替换装配面）。
 *
 * backup.restore 需要「停 → 换 → 重新装配恢复」：目录替换后 host 的运行时
 * 装配件（runtime/引擎/检索域/MCP）必须整体重建，持久件（docService/
 * search 密钥域/workspace/capability 台账）由 createHost 持有跨装配复用。
 * 本文件 = 每 boot 一次的装配函数：createHost 冷启与 restore 后重装共用
 * 同一装配，产物落在 HostBootParts（可整体替换，不会在宿主域残留旧态）。
 */

import {
  RETIRED_META_KEY,
  Runtime,
  default_scope_directory_seeds,
  make_engine_turn_runner,
} from '@ink-ts/engine';
import type { Host, LoadedScope, McpClientManager, Storage } from '@ink-ts/engine';
import type { CapabilityStore } from './capability/store.js';
import { configureCollabTempSightingSink } from './collab_command.js';
import type { ResolvedHostConfig } from './config.js';
import { TEMP_SIGHTINGS_COLLECTION } from './execution/convene_board.js';
import { HostExecutionService } from './execution/service.js';
import { InkHost } from './host.js';
import { asProvider, isRecord } from './model_providers.js';
import type { ProviderRecord } from './model_providers.js';
import type { HostSearch } from './search/wiring.js';
import { assembleHostMcp } from './mcp/assembly.js';
import type { McpConnectStatus } from './mcp/assembly.js';
import { McpPluginService } from './mcp/plugin.js';
import { findPluginsManifest, pluginsRootOf } from './plugins_fs.js';
import { build_product_recipe, merge_capability_tier_gate } from './recipe.js';
import type { ProductRecipeInit } from './recipe.js';
import { buildHostRetrieval } from './retrieval/domain.js';
import type { HostRetrievalDomain } from './retrieval/domain.js';
import { attachToolIndexEmbedder } from './retrieval/sync_seam.js';
import type { SyncEmbedderSeam } from './retrieval/sync_seam.js';

/** 装配输入（createHost 持久件 + 运行配置；每次装配重读 data_dir）。 */
export interface HostBootInput {
  resolved: ResolvedHostConfig;
  recipe: ProductRecipeInit | null;
  /** 台账（createHost 持有跨装配复用；InkHost 审批策略经此活读）。 */
  capability: CapabilityStore;
  /** 检索接线（createHost 持有；register 按每装配运行时执行体注册）。 */
  search: HostSearch;
}

/** 单次装配产物（restore 后整体替换的可变装配态）。 */
export interface HostBootParts {
  runtime: Runtime;
  inkHost: InkHost;
  retrieval: HostRetrievalDomain;
  toolEmbedder: SyncEmbedderSeam | null;
  mcpManager: McpClientManager | null;
  mcpStatus: McpConnectStatus[];
  /** MCP 工具型插件装载服务（null = plugins 源不可用未装配）。 */
  mcpPlugins: McpPluginService | null;
  /** 宿主执行装配（ExecutionRuntime 依赖注入面；execution.run/collab 共用）。 */
  execution: HostExecutionService;
}

/**
 * 装配 host 运行时（boot 装配 + restore 后重装配共用同一路径）。
 *
 * 执行运行时作用域装载面 = 实体注册表（受控注册产物，含 scope 声明资产与 retired
 * 标记）优先；出厂 overlay 只补缺；retired 行过滤不装载。
 *
 * 冲突序理由：注册表 = 受控注册通道产物（审批/补丁链），代表最新生效的目录资产；
 * overlay = 出厂预置素材，只在注册表未命中时补缺（保证 main/collaborator/subagent
 * 等出厂身份在注册表空时仍可装载）；retired 标记 = 下架资产，无论来源均不可装载。
 * 不直写实体注册表（避免污染 entities.snapshot 与既有池治理配额）；结晶落库由
 * 受控演化通道后续接线。
 */
type EngineTurnInit = Parameters<typeof make_engine_turn_runner>[0];

function scopeLoaderFrom(runtime: Runtime): (scope_id: string) => LoadedScope | null {
  const seedOverlay = new Map<string, LoadedScope>();
  for (const seed of default_scope_directory_seeds()) seedOverlay.set(seed.id, seed);

  // 冲突序：实体注册表（受控注册产物）优先，出厂 overlay 只补缺，retired 行过滤不装载。
  // 注册表命中 = 最新生效的目录资产（审批/补丁链产物）；overlay 补缺 = 注册表空时
  // 保证出厂身份可装载；retired 标记 = 下架资产，无论来源均不可装载。
  return (scope_id: string): LoadedScope | null => {
    const registry = runtime.entity_registry;
    if (registry !== null) {
      const spec = registry.get(scope_id);
      if (spec !== null) {
        if ((spec.meta ?? {})[RETIRED_META_KEY] === true) return null;
        return spec as unknown as LoadedScope;
      }
    }
    const overlay = seedOverlay.get(scope_id);
    if (overlay !== undefined) {
      if ((overlay.meta ?? {})[RETIRED_META_KEY] === true) return null;
      return overlay;
    }
    return null;
  };
}

/**
 * 作用域 model 引用 → 档案 context_window（白板裁切按模型 cw 的生产闭包）。
 * 解析序与 InkHost.resolve_scope_model 对齐：带 provider 限定该厂商，未带在
 * 用户列表内找首个含该 model_id 的厂商；命中模型项档案 {model_id,
 * context_window} 才取值。未指派/无档案/不在清单 = null（引擎回落 200k 兜底，
 * 绝不猜值）。
 */
function scopeContextWindow(
  modelConfig: Record<string, unknown> | null,
  model: Record<string, string> | null,
): number | null {
  if (model === null || modelConfig === null || !Array.isArray(modelConfig['providers'])) return null;
  const providerId = typeof model['provider'] === 'string' ? model['provider'] : '';
  const modelId = typeof model['model_id'] === 'string' ? model['model_id'] : '';
  if (modelId === '') return null;
  const providers = (modelConfig['providers'] as unknown[])
    .map(asProvider)
    .filter((p): p is ProviderRecord => p !== null);
  for (const provider of providers) {
    if (providerId !== '' && provider.provider_id !== providerId) continue;
    let listedButNoProfile = false;
    for (const entry of provider.models) {
      if (typeof entry === 'string') {
        if (entry === modelId) listedButNoProfile = true;
        continue;
      }
      if (isRecord(entry) && entry['model_id'] === modelId) {
        const cw = entry['context_window'];
        return typeof cw === 'number' && Number.isFinite(cw) && cw > 0 ? cw : null;
      }
    }
    if (listedButNoProfile || providerId !== '') return null;
  }
  return null;
}

/**
 * 临时协作观测存储通道（boot 构造、经 collab 装配位下发；convene 只编排不摸
 * 存储——宿主 lib 纪律：组装根持 IO）。org.temp_sightings = org.archive 的
 * 兄弟关注点（普通结构化记录通道，非演化资产）；幂等键 run_id#seat：同一子
 * 执行席位重复观测覆盖不累加（断点重跑/挂起恢复不污染证据计数）。
 */
function makeTempSightingSink(runtime: Runtime): (record: Record<string, unknown>) => Promise<void> {
  return async (record: Record<string, unknown>): Promise<void> => {
    const storage = runtime.storage as Storage | null;
    if (storage === null) {
      throw new Error('sighting 存储通道不可用（runtime 未 boot/已关停）');
    }
    const runId = typeof record['run_id'] === 'string' ? record['run_id'] : '';
    const seat = record['seat'];
    if (runId === '' || typeof seat !== 'number' || !Number.isInteger(seat)) {
      throw new Error('sighting 记录缺 run_id/seat（幂等键不可组装）');
    }
    await storage.put_record(TEMP_SIGHTINGS_COLLECTION, `${runId}#${seat}`, record);
  };
}

/** 装配 host 运行时（boot 装配 + restore 后重装配共用同一路径）。 */
export async function assembleHostParts(input: HostBootInput): Promise<HostBootParts> {
  const retrieval = buildHostRetrieval(input.resolved.data_dir);
  const inkHost = new InkHost(input.resolved, () => input.capability.get());
  // 作用域 model 引用解析接线位（执行模型 §五/§7.5：目录作用域带 model 引用
  // 时按宿主用户 model 列表取端点；引用未命中 = 引擎显式失败，不静默跑父模型）
  const assemblyRecipe = build_product_recipe({
    ...(input.recipe ?? {}),
    scope_model_llm: (model) => inkHost.resolve_scope_model(model),
  });
  // 能力记录工具档位（tier_overrides 'review'）并入门禁配置：产品设置面声明
  // 的「工具转审批」经装配生效（装配期数据 → 引擎统一流水线 gate）
  const tierRaw = input.capability.get()['tier_overrides'];
  const tierOverrides =
    tierRaw !== null &&
    tierRaw !== undefined &&
    typeof tierRaw === 'object' &&
    !Array.isArray(tierRaw)
      ? (tierRaw as Record<string, unknown>)
      : null;
  assemblyRecipe.tool_gate = merge_capability_tier_gate(
    assemblyRecipe.tool_gate,
    tierOverrides,
  );
  for (const factory of retrieval.sourceFactories()) {
    assemblyRecipe.retrieval_sources.push(factory as never);
  }
  const runtime = new Runtime();
  await runtime.boot(inkHost as unknown as Host, assemblyRecipe);
  let toolEmbedder: SyncEmbedderSeam | null = null;
  try {
    toolEmbedder = await attachToolIndexEmbedder(runtime, retrieval.adapter);
  } catch {
    toolEmbedder = null;
  }
  const mcp = await assembleHostMcp(runtime, input.resolved.mcp);
  const declarative = runtime.harness_registry?.declarative;
  if (declarative !== null && declarative !== undefined) {
    input.search.register(declarative as never);
  }
  // 宿主执行装配（执行模型主线运行时依赖注入面）：作用域装载读实体目录（受控
  // 注册同通道资产）、通道目录出厂素材、作用域轮次引擎装载执行器（会话默认
  // 模型回落 + 作用域 model 引用经 scope_model_llm 同链解析）、通道审批 seam
  // 活读宿主审批策略。每次执行现建 turn runner（工具表/流水线随装配态刷新）。
  // 组织档案宿主持有，boot 时从 runtime.storage 结构化记录加载持久快照，每次
  // 执行 settle 后 ingest 轨迹并持久化快照（走 org.archive 普通通道，非演化资产）。
  const execution = new HostExecutionService({
    loadScope: scopeLoaderFrom(runtime),
    bootSystemPrompt: assemblyRecipe.boot_system_prompt,
    approvalPolicy: () => inkHost.interrupt_policy(),
    // 公开 AsyncLLM 契约（core/llm/base）与守卫链 seam（_guard_types）结构近似
    // 不平等——经鸭子转换进入引擎装载执行器（host.ts 头注同款纪律）
    makeTurn: async () =>
      make_engine_turn_runner({
        llm: (await inkHost.resolve_llm()) as unknown as EngineTurnInit['llm'],
        resolve_scope_llm: ((model: Record<string, string>) =>
          inkHost.resolve_scope_model(model)) as unknown as EngineTurnInit['resolve_scope_llm'],
        tool_pipeline: runtime.tool_pipeline,
        tool_specs: runtime.collect_specs(),
        boot_system_prompt: assemblyRecipe.boot_system_prompt,
      }),
    storage: () => (runtime.storage ?? null) as Storage | null,
    // 白板裁切按模型 cw 的生产接线（W6 收口 A 留缝；未指派/无档案 = null
    // 兜底不猜，回落引擎 200k 缺省）
    resolveScopeContextWindow: (model) =>
      scopeContextWindow(inkHost.config.model_config as unknown as Record<string, unknown> | null, model),
  });
  // 临时协作观测通道（结晶证据流；每次装配重设，restore 后指向新 runtime 存储）
  configureCollabTempSightingSink(makeTempSightingSink(runtime));
  // MCP 工具型插件装载服务（B5）：plugins 真源可用时装配 + 重启自动拉起
  // 台账启用集（连接失败只记状态不击穿 boot，状态行经 mcp.status 可查）。
  const manifestPath = findPluginsManifest(input.resolved.seed_dir);
  let mcpPlugins: McpPluginService | null = null;
  if (manifestPath !== null && mcp.manager !== null) {
    mcpPlugins = new McpPluginService({
      pluginsRoot: pluginsRootOf(manifestPath),
      host: runtime as never,
      manager: mcp.manager,
      store: input.capability,
    });
    try {
      await mcpPlugins.restore();
    } catch {
      // 拉起失败只留状态（list/status 可查），不击穿 boot
    }
  }
  return {
    runtime,
    inkHost,
    retrieval,
    toolEmbedder,
    mcpManager: mcp.manager,
    mcpStatus: mcp.status,
    mcpPlugins,
    execution,
  };
}
