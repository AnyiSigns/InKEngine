/**
 * ui_components 命令面（出厂界面组件启停）。
 *
 * 数据源 = runtime 出厂组件机制（RuntimeUiComponents：ui_factory_components
 * 未过滤全集 / ui_components_disabled 停用集 / ui_allowed_components 活跃面），
 * 与引擎校验器/界面校验同源。host 只透传，不维护第二份组件清单。
 *
 * - get：factory/disabled/active 三清单（组件 tab 数据源；factory = 配方
 *   ui_allowed_components 未过滤全集，active = factory - disabled）；
 * - set_disabled：整集替换停用集（未登记名由引擎结构化拒绝 → 业务错误）。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** 停用集入参读取（{ disabled: string[] }；非数组显式报错）。 */
function disabledParam(raw: unknown): string[] {
  const params =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const disabled = params['disabled'];
  if (!Array.isArray(disabled) || !disabled.every((name) => typeof name === 'string')) {
    throw new BridgeError('ui_components.set_disabled 需 { disabled: string[] }', 'invalid_params');
  }
  return disabled as string[];
}

/** ui_components 命令声明（方法名唯一真源；装配由 index 聚合此表）。 */
export const UI_COMPONENTS_COMMANDS = [
  'ui_components.get',
  'ui_components.set_disabled',
] as const;

export type UiComponentsCommand = (typeof UI_COMPONENTS_COMMANDS)[number];

export function buildUiComponentsCommands(deps: HostBridgeDeps): Readonly<Record<UiComponentsCommand, BridgeHandler>> {
  const get: BridgeHandler = (): unknown => {
    const runtime = deps.runtime;
    return {
      factory: runtime.ui_factory_components,
      disabled: runtime.ui_components_disabled,
      active: runtime.ui_allowed_components,
    };
  };

  const setDisabled: BridgeHandler = async (raw): Promise<unknown> => {
    const disabled = disabledParam(raw);
    try {
      const applied = await deps.runtime.set_ui_components_disabled(disabled);
      return { disabled: applied };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BridgeError(message, 'invalid_params');
    }
  };

  return {
    'ui_components.get': get,
    'ui_components.set_disabled': setDisabled,
  };
}
