/**
 * entities.snapshot 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/entities.ts
 * 迁入，语义零改）。实体注册表只读快照（无注册表 = 结构化空态，不报错）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 实体注册表结构面（runtime 装配产物，结构即契约）。 */
interface EntityRegistryLike {
  maxEntities: number;
  specs(): Array<Record<string, unknown>>;
}

export default function createEntitiesSnapshot(deps: HostBridgeDeps): BridgeHandler {
  /** entities.snapshot：实体清单 + 配额态（无注册表 = 空态）。 */
  const snapshot: BridgeHandler = (): Record<string, unknown> => {
    const registry = deps.runtime.entity_registry;
    if (registry === null) {
      return { available: false, version: 0, count: 0, max: null, entities: [], degraded: true };
    }
    const like = registry as unknown as EntityRegistryLike;
    const specs = like.specs();
    const entities = specs.map((spec) => {
      const entity: Record<string, unknown> = {
        id: String(spec['id'] ?? ''),
        label: typeof spec['label'] === 'string' ? spec['label'] : '',
      };
      if (isRecord(spec['model'])) {
        entity['model'] = { ...(spec['model'] as Record<string, string>) };
      } else if (spec['model'] !== null && spec['model'] !== undefined) {
        entity['model'] = null;
      }
      return entity;
    });
    return {
      available: true,
      version: specs.length,
      count: specs.length,
      max: like.maxEntities,
      entities,
      degraded: false,
    };
  };

  return snapshot;
}
