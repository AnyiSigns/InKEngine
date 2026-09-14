/**
 * ui_components.get 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/
 * ui_components.ts 迁入，语义零改）。factory/protected/disabled/active 四清单
 * （组件 tab 数据源；与引擎校验器同源，host 只透传）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';

export default function createUiComponentsGet(deps: HostBridgeDeps): BridgeHandler {
  const get: BridgeHandler = (): unknown => {
    const runtime = deps.runtime;
    return {
      factory: runtime.ui_factory_components,
      protected: runtime.ui_protected_components,
      disabled: runtime.ui_components_disabled,
      active: runtime.ui_allowed_components,
    };
  };

  return get;
}
