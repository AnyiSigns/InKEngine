/**
 * host 运行时装配（composition root 的可替换装配面）。
 *
 * backup.restore 需要「停 → 换 → 重新装配恢复」：目录替换后 host 的运行时
 * 装配件（runtime/引擎/检索域/MCP）必须整体重建，持久件（docService/
 * search 密钥域/workspace/capability 台账）由 createHost 持有跨装配复用。
 * 本文件 = 每 boot 一次的装配函数：createHost 冷启与 restore 后重装共用
 * 同一装配，产物落在 HostBootParts（可整体替换，不会在宿主域残留旧态）。
 */

import { Runtime } from '@ink-ts/engine';
import type { Host, McpClientManager } from '@ink-ts/engine';

import type { CapabilityStore } from './capability/store.js';
import type { ResolvedHostConfig } from './config.js';
import { InkHost } from './host.js';
import type { HostSearch } from './search/wiring.js';
import { assembleHostMcp } from './mcp/assembly.js';
import type { McpConnectStatus } from './mcp/assembly.js';
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
}

/** 装配 host 运行时（boot 装配 + restore 后重装配共用同一路径）。 */
export async function assembleHostParts(input: HostBootInput): Promise<HostBootParts> {
  const retrieval = buildHostRetrieval(input.resolved.data_dir);
  const inkHost = new InkHost(input.resolved, () => input.capability.get());
  const assemblyRecipe = build_product_recipe(input.recipe ?? {});
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
  return {
    runtime,
    inkHost,
    retrieval,
    toolEmbedder,
    mcpManager: mcp.manager,
    mcpStatus: mcp.status,
  };
}
