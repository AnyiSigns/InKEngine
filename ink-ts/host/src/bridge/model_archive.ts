/**
 * model_archive 命令面（模型档案快照）。
 *
 * Rust 壳侧读 model_archive.sqlite（探测补录档案库）；TS host 无该存储，
 * 快照从**运行 model_config 聚合**（agent/router 主槽 + 备用链端点），与
 * config.json 同源、不引入探测/补录。各端点 model_id 去重按字典序输出；
 * context_window/multimodal 属探测产物，TS 侧未知字段从略（web 消费端
 * 容缺省）。
 *
 * 档案语义说明：web 输入胶囊/模型设置消费 archives（model_id 选择面），
 * 空配置 = 空清单（ok:true, archives:[]），不误报。
 */

import type { BridgeHandler, HostBridgeDeps } from './_types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 端点记录是否含有效 model_id（角色槽主配置与备用链同一形态）。 */
function endpointModelId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const modelId = value['model_id'];
  return typeof modelId === 'string' && modelId !== '' ? modelId : null;
}

/** 从 model_config 记录聚合全部已配置模型（主槽 + 备用链；保持字典序）。 */
export function collectArchiveRows(modelConfig: Record<string, unknown>): Array<{ model_id: string }> {
  const seen = new Set<string>();
  const rows: Array<{ model_id: string }> = [];
  for (const value of Object.values(modelConfig)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const modelId = endpointModelId(entry);
        if (modelId !== null && !seen.has(modelId)) {
          seen.add(modelId);
          rows.push({ model_id: modelId });
        }
      }
    } else {
      const modelId = endpointModelId(value);
      if (modelId !== null && !seen.has(modelId)) {
        seen.add(modelId);
        rows.push({ model_id: modelId });
      }
    }
  }
  rows.sort((a, b) => a.model_id.localeCompare(b.model_id));
  return rows;
}

export function buildModelArchiveHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  const snapshot: BridgeHandler = (): unknown => {
    const state = deps.host.model_config_state();
    const modelConfig = isRecord(state['model_config']) ? state['model_config'] : {};
    return { ok: true, archives: collectArchiveRows(modelConfig) };
  };

  return new Map<string, BridgeHandler>([['model_archive.snapshot', snapshot]]);
}
