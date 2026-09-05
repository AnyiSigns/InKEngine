/**
 * @ink-ts/host 装配入口（createHost）：composition root。
 *
 * 读配置（config.ts）→ 实现 Host 五件套（host.ts）→ 构建产品配方
 * （recipe.ts，机制开关默认全开）→ Runtime.boot 装配 → buildBridge 出
 * 宿主命令面。机制语义全在 engine；本包只装配不复制。
 *
 * graph_recipe 为产品配方注入位：产品图未内置，由调用方/测试注入演示
 * 图；未注入时给出明确错误，不静默装配空图。
 */

import { mkdirSync } from 'node:fs';

import { Runtime } from '@ink-ts/engine';
import type { Host } from '@ink-ts/engine';

import type { BridgeHandler } from './bridge/_types.js';
import { buildBridge } from './bridge/index.js';
import { HostConfigError, resolve_host_config } from './config.js';
import type { HostConfigInput, ResolvedHostConfig } from './config.js';
import { InkHost } from './host.js';
import { build_product_recipe } from './recipe.js';
import type { ProductRecipeInit } from './recipe.js';

/** createHost 装配产物（cli/web/vitest 消费面）。 */
export interface HostHandle {
  runtime: Runtime;
  bridge: ReadonlyMap<string, BridgeHandler>;
  config: ResolvedHostConfig;
  /** 幂等关停：Runtime.stop（拒新 → 等在途 → 关 MCP/LLM/存储 → host 关停钩子）。 */
  dispose(): Promise<void>;
}

/**
 * 装配 host：配置解析 → 五件套 + 配方 → Runtime.boot → bridge 命令面。
 *
 * @param config 运行配置（storage uri / 角色槽模型端点 / autoApprove 等；
 *   缺省 memory:// + fail-closed，见 config.ts）。
 * @param recipe 配方覆写（graph_recipe 注入位必需——产品图由调用方提供）。
 */
export async function createHost(
  config: HostConfigInput | null | undefined = null,
  recipe: ProductRecipeInit | null | undefined = null,
): Promise<HostHandle> {
  const resolved = resolve_host_config(config);
  mkdirSync(resolved.events_dir, { recursive: true });
  mkdirSync(resolved.data_dir, { recursive: true });
  if ((recipe?.graph_recipe ?? null) === null) {
    throw new HostConfigError(
      'createHost 需注入 graph_recipe（产品图配方在 host 域服务阶段定稿前，'
        + '由调用方/测试注入演示图；结构化空位不静默装配）',
    );
  }
  const inkHost = new InkHost(resolved);
  const assemblyRecipe = build_product_recipe(recipe ?? undefined);
  const runtime = new Runtime();
  await runtime.boot(inkHost as unknown as Host, assemblyRecipe);
  const bridge = buildBridge({
    runtime,
    host: inkHost,
    autoApprove: resolved.autoApprove,
  });
  const handle: HostHandle = {
    runtime,
    bridge,
    config: resolved,
    dispose: async (): Promise<void> => {
      await runtime.stop();
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
