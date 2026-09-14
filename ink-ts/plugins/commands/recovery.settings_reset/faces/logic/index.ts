/**
 * recovery.settings_reset 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/recovery.ts
 * 迁入，语义零改）。恢复设置默认（B6 逃生）：恢复出厂档位/管理设置，不动会话链/
 * 知识/审计。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { SETTINGS_RESET_MARKER, writeResetAudit } from '../../../_shared/recovery.js';

export default function createRecoverySettingsReset(deps: HostBridgeDeps): BridgeHandler {
  /** 恢复设置默认（B6 逃生）：恢复出厂档位/管理设置，不动会话链/知识/审计。
   *
   * 范围 = 常驻必带回出厂集、UI 组件停用清空、MCP 工具型插件全停用并清台账
   * （含指定安装额外配置）、capability 台账回缺省（auto 审批/tier/max rounds
   * 一并清）。会话级/事件级 factory reset 语义不受影响。 */
  const settingsReset: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { confirm?: unknown } | null;
    if (typeof params !== 'object' || params === null) {
      throw new BridgeError('recovery.settings_reset 需 params（含 confirm）', 'invalid_params');
    }
    if (params.confirm !== SETTINGS_RESET_MARKER) {
      throw new BridgeError(
        `recovery.settings_reset 需 confirm='${SETTINGS_RESET_MARKER}'（危险操作标记缺失）`,
        'invalid_params',
      );
    }
    const disabledMcp: string[] = [];
    const mcp = deps.mcpPlugins;
    if (mcp !== null && mcp !== undefined) {
      for (const row of mcp.list()) {
        if (!row.enabled) continue;
        const outcome = await mcp.disable(row.id);
        if (outcome.ok) disabledMcp.push(row.id);
      }
    }
    const baseline = await deps.runtime.reset_baseline_names();
    const uiDisabled = await deps.runtime.set_ui_components_disabled([]);
    const capability = deps.capability?.reset?.() ?? null;
    const storage = deps.runtime.storage;
    if (storage !== null) {
      await writeResetAudit(storage, {
        kind: 'recovery_reset_settings',
        ts: Date.now() / 1000,
        baseline_reset: baseline,
        ui_disabled: uiDisabled,
        mcp_disabled: disabledMcp,
        capability_reset: capability !== null,
        audit_kept: true,
      });
    }
    return {
      mode: 'settings',
      baseline_reset: baseline,
      ui_disabled: uiDisabled,
      mcp_disabled: disabledMcp,
      capability_reset: capability !== null,
      audit_kept: true,
      reset: true,
    };
  };

  return settingsReset;
}
