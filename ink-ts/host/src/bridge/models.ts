/**
 * models 命令面（模型运行配置：models.config.*）。
 *
 * - get：掩码态 + 角色槽已配置态（明文不出进程，规则见 model_config_runtime）；
 * - put：{ config: <角色槽/备用链端点形状> } → 校验 + apply（关停 _llm 并
 *   合并写回 host config）→ 原子落盘 → 引擎重建（下轮回合按新槽重解析）；
 * - reload：从 data_dir/config.json 重读 → apply → 引擎重建（外部/冷启态
 *   再装配语义，运行中生效）。
 *
 * 引擎重建：Runtime.rebuild_engine 刷新已解析宿主 LLM 链（is 比较换链时显式
 * 关闭旧链），host 关停 _llm 后重解析即换新链；失败以 BridgeError 显式报
 * （不静默沿用旧模型）。
 */

import { HostConfigError } from '../config.js';
import {
  BridgeError,
  type BridgeHandler,
  type HostBridgeDeps,
  type ModelConfigHandles,
} from './_types.js';
import { asProvider, providerModelIds, samePick, type ProviderPick } from '../model_providers.js';

const ROLE_SLOT_PICK_KEY: Record<string, string> = {
  agent: 'agent_pick',
  router: 'router_pick',
};

function requireRole(raw: Record<string, unknown>): string {
  const role = raw['role'];
  if (role !== 'agent' && role !== 'router') {
    throw new BridgeError('models.config.role_pick 需 params.role ∈ {agent, router}', 'invalid_params');
  }
  return role;
}

function requirePick(raw: Record<string, unknown>, where: string): ProviderPick {
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

function requireModelConfig(deps: HostBridgeDeps): ModelConfigHandles {
  if (deps.modelConfig === undefined) {
    throw new BridgeError('模型配置域未装配（host 未接线运行配置）', 'model_config_unavailable');
  }
  return deps.modelConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new BridgeError('需 params 对象', 'invalid_params');
  }
  return raw;
}

/** 句柄错误归一：配置形状错误回可读 message，其余显式归类（信封仍只回通用）。 */
function asBridgeError(error: unknown, prefix: string): BridgeError {
  if (error instanceof BridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HostConfigError) return new BridgeError(message, 'invalid_config');
  return new BridgeError(`${prefix}: ${message}`, 'model_config_error');
}

/** 引擎重建（配置变更运行生效；失败显式报错，不静默沿用旧模型）。 */
async function refreshEngine(deps: HostBridgeDeps): Promise<void> {
  try {
    await deps.runtime.rebuild_engine();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BridgeError(`引擎重建失败: ${message}`, 'engine_reload_failed');
  }
}

/** models 命令声明（方法名唯一真源；装配由 index 聚合此表）。 */
export const MODELS_COMMANDS = [
  'models.config.get',
  'models.config.put',
  'models.config.reload',
  'models.config.role_pick',
] as const;

export type ModelsCommand = (typeof MODELS_COMMANDS)[number];

export function buildModelsCommands(deps: HostBridgeDeps): Readonly<Record<ModelsCommand, BridgeHandler>> {
  const get: BridgeHandler = () => deps.host.model_config_state();

  const put: BridgeHandler = async (raw): Promise<unknown> => {
    const params = requireObject(raw);
    if (!isRecord(params['config'])) {
      throw new BridgeError('models.config.put 需 { config: {...} }', 'invalid_params');
    }
    const handles = requireModelConfig(deps);
    let applied: Record<string, unknown>;
    try {
      applied = await handles.apply(params['config']);
    } catch (error) {
      throw asBridgeError(error, '模型配置校验失败');
    }
    try {
      await handles.persist();
    } catch (error) {
      throw asBridgeError(error, '模型配置落盘失败');
    }
    await refreshEngine(deps);
    return { saved: true, model_config: applied };
  };

  const reload: BridgeHandler = async (): Promise<unknown> => {
    const handles = requireModelConfig(deps);
    let applied: Record<string, unknown>;
    try {
      applied = await handles.reload();
    } catch (error) {
      throw asBridgeError(error, '模型配置重载失败');
    }
    await refreshEngine(deps);
    return { reloaded: true, model_config: applied };
  };

  const rolePick: BridgeHandler = async (raw): Promise<unknown> => {
    const params = requireObject(raw);
    const role = requireRole(params);
    const pick = requirePick(params, `models.config.role_pick(${role})`);
    const handles = requireModelConfig(deps);
    const live = deps.host.config.model_config;
    const providers = Array.isArray(live['providers'])
      ? (live['providers'] as unknown[])
          .map(asProvider)
          .filter((p): p is NonNullable<ReturnType<typeof asProvider>> => p !== null)
      : [];
    const provider = providers.find((p) => p.provider_id === pick.provider_id);
    if (provider === undefined || !providerModelIds(provider).includes(pick.model_id)) {
      throw new BridgeError(
        `模型不在已添加清单: ${pick.provider_id}/${pick.model_id}`,
        'model_not_found',
      );
    }
    const pickKey = ROLE_SLOT_PICK_KEY[role]!;
    const current = isRecord(live[pickKey]) ? (live[pickKey] as unknown as ProviderPick) : null;
    if (samePick(current, pick)) {
      return { role, pick, saved: true, state: deps.host.model_config_state() };
    }
    let applied: Record<string, unknown>;
    try {
      applied = await handles.apply({
        providers: providers as never[],
        [pickKey]: pick,
      });
    } catch (error) {
      throw asBridgeError(error, `角色槽指派失败(${role})`);
    }
    void applied;
    try {
      await handles.persist();
    } catch (error) {
      throw asBridgeError(error, `角色槽指派落盘失败(${role})`);
    }
    await refreshEngine(deps);
    return { role, pick, saved: true, state: deps.host.model_config_state() };
  };

  return {
    'models.config.get': get,
    'models.config.put': put,
    'models.config.reload': reload,
    'models.config.role_pick': rolePick,
  };
}
