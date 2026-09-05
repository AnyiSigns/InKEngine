/**
 * models 命令面（模型运行配置：models.config.*）。
 *
 * - get：掩码态 + 角色槽已配置态（明文不出进程，规则见 model_config_runtime）；
 * - put：{ config: <角色槽/备用链端点形状> } → 校验 + apply（关停 _llm 并
 *   合并写回 host config）→ 原子落盘 → 引擎重建（下轮回合按新槽重解析）；
 * - reload：从 data_dir/config.json 重读 → apply → 引擎重建（外部/冷启态
 *   再装配语义，运行中生效）。
 *
 * 引擎重建：Runtime.rebuild_engine 缓存键含模型实例身份（is 比较），host
 * 关停 _llm 后重解析即换新链；失败以 BridgeError 显式报（不静默沿用旧模型）。
 */

import { HostConfigError } from '../config.js';
import {
  BridgeError,
  type BridgeHandler,
  type HostBridgeDeps,
  type ModelConfigHandles,
} from './_types.js';

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

export function buildModelsHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
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

  return new Map<string, BridgeHandler>([
    ['models.config.get', get],
    ['models.config.put', put],
    ['models.config.reload', reload],
  ]);
}
