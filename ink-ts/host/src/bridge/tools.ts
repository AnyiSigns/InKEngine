/**
 * tools 命令面（snapshot）——引擎工具注册表只读快照。
 *
 * 数据源 = runtime.tool_index（ToolVectorIndex：merged_specs 建索引后自带
 * 端点/档位/向量状态）与 merged_specs（全量注册工具）；host 只透传，不
 * 复刻壳侧工具声明表。向量可用性随快照上报（降级可观测：关键词基线时
 * uses_vectors=false）。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** 单条工具快照（tool_index 端点/档位元数据 + spec 摘要）。 */
export interface ToolSnapshotRow {
  name: string;
  description: string;
  permissions: readonly string[];
  endpoint: string;
  tier: 'allow' | 'review' | 'unknown';
  vector: boolean;
}

export function buildToolsHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  const snapshot: BridgeHandler = async (): Promise<unknown> => {
    const runtime = deps.runtime;
    if (runtime.engine === null) {
      throw new BridgeError('运行时引擎未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
    }
    const index = runtime.tool_index;
    const specs = runtime.merged_specs();
    const rows: ToolSnapshotRow[] = specs.map((spec) => {
      const entry = index !== null ? index.entries.get(spec.name) : undefined;
      return {
        name: spec.name,
        description: spec.description ?? '',
        permissions: spec.permissions ?? [],
        endpoint: entry?.endpoint ?? 'unknown',
        tier: entry?.tier ?? 'unknown',
        vector: entry?.vector !== null && entry?.vector !== undefined,
      };
    });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return {
      count: rows.length,
      uses_vectors: index?.uses_vectors() ?? false,
      degraded_reason: index?.degraded_reason ?? null,
      tools: rows,
    };
  };

  return new Map<string, BridgeHandler>([['tools.snapshot', snapshot]]);
}
