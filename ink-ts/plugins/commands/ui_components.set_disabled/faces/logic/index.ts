/**
 * ui_components.set_disabled 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/
 * ui_components.ts 迁入，语义零改）。整集替换停用集（未登记名/禁停集由引擎结构化
 * 拒绝 → 业务错误）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { disabledParam } from '../../../_shared/ui_components.js';

export default function createUiComponentsSetDisabled(deps: HostBridgeDeps): BridgeHandler {
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

  return setDisabled;
}
