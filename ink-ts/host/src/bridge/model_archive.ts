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
function endpointModelId(value: unknown): { model_id: string } | null {
  if (!isRecord(value)) return null;
  const modelId = value['model_id'];
  return typeof modelId === 'string' && modelId !== '' ? { model_id: modelId } : null;
}

/** 厂商记录（providers[] 元素：base_url + models 清单 + provider_id）。 */
function providerRecordModels(
  value: unknown,
): Array<{ model_id: string; context_window?: number }> | null {
  if (!isRecord(value)) return null;
  if (typeof value['provider_id'] !== 'string' || !Array.isArray(value['models'])) return null;
  if (typeof value['base_url'] !== 'string') return null;
  const rows: Array<{ model_id: string; context_window?: number }> = [];
  for (const entry of value['models']) {
    if (typeof entry === 'string') {
      if (entry !== '') rows.push({ model_id: entry });
    } else if (isRecord(entry)) {
      const modelId = entry['model_id'];
      if (typeof modelId === 'string' && modelId !== '') {
        const row: { model_id: string; context_window?: number } = { model_id: modelId };
        if (typeof entry['context_window'] === 'number') {
          row.context_window = entry['context_window'];
        }
        rows.push(row);
      }
    }
  }
  return rows.length > 0 ? rows : null;
}

/** 模型档案行（含归属厂商与上下文窗口，web 选择面可显示/回指）。 */
export interface ArchiveRow {
  model_id: string;
  provider_id?: string;
  context_window?: number;
}

/** 从 model_config 记录聚合全部已配置/已添加模型（角色槽主配置 + 备用链 +
 *  厂商清单；保持字典序、按 厂商+model 去重）。 */
export function collectArchiveRows(modelConfig: Record<string, unknown>): ArchiveRow[] {
  const seen = new Set<string>();
  const rows: ArchiveRow[] = [];
  const hasProviders =
    Array.isArray(modelConfig['providers']) && modelConfig['providers'].length > 0;
  const pushRow = (row: ArchiveRow): void => {
    const key = row.provider_id !== undefined
      ? `${row.provider_id}/${row.model_id}`
      : row.model_id;
    if (!seen.has(key)) {
      seen.add(key);
      rows.push(row);
    }
  };
  const visit = (value: unknown): void => {
    if (isRecord(value)) {
      const providerRows = providerRecordModels(value);
      if (providerRows !== null) {
        const providerId = typeof value['provider_id'] === 'string' ? value['provider_id'] : undefined;
        for (const entry of providerRows) {
          pushRow({ ...entry, ...(providerId !== undefined ? { provider_id: providerId } : {}) });
        }
        return;
      }
      // 角色槽端点 = 厂商清单派生（agent/router 槽模型均在 providers 内）；
      // 厂商面存在时不重复收录槽端点行（避免档案双份）。无厂商（旧直写
      // 槽/备用链配置）时保留端点行语义。
      if (hasProviders) return;
      const endpoint = endpointModelId(value);
      if (endpoint !== null) {
        const providerId = typeof value['provider_id'] === 'string' ? value['provider_id'] : undefined;
        const row: ArchiveRow = { model_id: endpoint.model_id };
        if (typeof value['context_window'] === 'number') {
          row.context_window = value['context_window'];
        }
        if (providerId !== undefined) row.provider_id = providerId;
        pushRow(row);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    }
  };
  for (const value of Object.values(modelConfig)) {
    visit(value);
  }
  rows.sort((a, b) => a.model_id.localeCompare(b.model_id));
  return rows;
}

/** model_archive 命令声明（方法名唯一真源；装配由 index 聚合此表）。 */
export const MODEL_ARCHIVE_COMMANDS = [
  'model_archive.snapshot',
] as const;

export type ModelArchiveCommand = (typeof MODEL_ARCHIVE_COMMANDS)[number];

export function buildModelArchiveCommands(deps: HostBridgeDeps): Readonly<Record<ModelArchiveCommand, BridgeHandler>> {
  const snapshot: BridgeHandler = (): unknown => {
    const state = deps.host.model_config_state();
    const modelConfig = isRecord(state['model_config']) ? state['model_config'] : {};
    return { ok: true, archives: collectArchiveRows(modelConfig) };
  };

  return { 'model_archive.snapshot': snapshot };
}
