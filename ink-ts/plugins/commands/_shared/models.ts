/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/models.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * models.config.get/put/reload/role_pick 四命令共享校验/错误归一/引擎重建。
 */

import { HostConfigError } from '@ink-ts/host';
import { BridgeError, asProvider, providerModelIds, samePick } from '@ink-ts/host';
import type { HostBridgeDeps, ModelConfigHandles, ProviderPick } from '@ink-ts/host';

export const ROLE_SLOT_PICK_KEY: Record<string, string> = {
  agent: 'agent_pick',
  router: 'router_pick',
};

export function requireRole(raw: Record<string, unknown>): string {
  const role = raw['role'];
  if (role !== 'agent' && role !== 'router') {
    throw new BridgeError('models.config.role_pick 需 params.role ∈ {agent, router}', 'invalid_params');
  }
  return role;
}

export function requirePick(raw: Record<string, unknown>, where: string): ProviderPick {
  const provider_id = raw['provider_id'];
  const model_id = raw['model_id'];
  if (typeof provider_id !== 'string' || provider_id === '') {
    throw new BridgeError(`${where} 需 params.provider_id`, 'invalid_params');
  }
  if (typeof model_id !== 'string' || model_id === '') {
    throw new BridgeError(`${where} 需 params.model_id`, 'invalid_params');
  }
  return { provider_id, model_id };
}

export function requireModelConfig(deps: HostBridgeDeps): ModelConfigHandles {
  if (deps.modelConfig === undefined) {
    throw new BridgeError('模型配置域未装配（host 未接线运行配置）', 'model_config_unavailable');
  }
  return deps.modelConfig;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireObject(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new BridgeError('需 params 对象', 'invalid_params');
  }
  return raw;
}

/** 句柄错误归一：配置形状错误回可读 message，其余显式归类（信封仍只回通用）。 */
export function asBridgeError(error: unknown, prefix: string): BridgeError {
  if (error instanceof BridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HostConfigError) return new BridgeError(message, 'invalid_config');
  return new BridgeError(`${prefix}: ${message}`, 'model_config_error');
}

/** 引擎重建（配置变更运行生效；失败显式报错，不静默沿用旧模型）。 */
export async function refreshEngine(deps: HostBridgeDeps): Promise<void> {
  try {
    await deps.runtime.rebuild_engine();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BridgeError(`引擎重建失败: ${message}`, 'engine_reload_failed');
  }
}

export { asProvider, providerModelIds, samePick };
export type { ProviderPick };
