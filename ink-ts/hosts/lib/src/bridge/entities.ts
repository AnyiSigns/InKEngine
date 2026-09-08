/**
 * entities 命令面（snapshot）——实体注册表只读快照。
 *
 * 数据源 = runtime.entity_registry（引擎实体注册表：实体 = 数据
 * EntitySpec id/label/persona/model/meta，随补丁链版本化落位）。
 * host 只投影目录形态（id/label/model 引用 + 配额态），不含 persona
 * 全文（与引擎 introspection.snapshot_entities 同源同裁剪）。无注册
 * 表 = 结构化空态（degraded:true + 空清单，不报错）。
 */

import type { EntitiesCommand } from './commands.generated.js';
export { ENTITIES_COMMANDS, type EntitiesCommand } from './commands.generated.js';
import { type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 实体注册表结构面（runtime 装配产物，结构即契约）。 */
interface EntityRegistryLike {
  maxEntities: number;
  specs(): Array<Record<string, unknown>>;
}


export function buildEntitiesCommands(deps: HostBridgeDeps): Readonly<Record<EntitiesCommand, BridgeHandler>> {
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

  return { 'entities.snapshot': snapshot };
}
