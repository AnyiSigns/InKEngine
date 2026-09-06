/**
 * Entity-registry-backed governance write target (R3 decision A).
 *
 * The entity registry is the engine's guarded write channel for real objects:
 * each entity row is persisted through EvolutionWriter (patch chain + audit,
 * see runtime assembly); the persist callback carries the write (entity
 * collection writer, mechanism exemption inside GuardedStorage). This module
 * implements only the seam semantics:
 *
 * - list(): active registered entity ids (visible list; archived/evicted
 *   objects are no longer visible);
 * - archive(id): soft archive -- persists an archived-meta row then removes
 *   the object from the active table (EntityRegistry.load skips archived
 *   rows, so an archive does not resurrect after restart);
 * - evict(id): hard remove -- persists an evicted+archived row then removes
 *   the object from the active table;
 * - merge(keep_id, drop_ids): near-duplicate merge keeps the authoritative
 *   entry (keep_id must exist and is left untouched); every drop is archived
 *   with a merged_into trace and removed from the active table.
 *
 * All writes are idempotent: a missing object is a no-op (the pool governance
 * settle side already records registration + audit; this seam does not
 * duplicate those records).
 */

import type { EntityRegistry } from './entities.js';
import { EntitySpec } from './entities.js';
import type { GovernanceWriteTarget } from '../settle/review.js';

/** Guarded entity-row persist callback (runtime assembly injects the entity
 *  writer; receives an entity id and its row dict). */
export type RegistryGovernancePersist = (
  entity_id: string,
  spec_dict: Record<string, unknown>,
  note: string,
) => Promise<void>;

/** Entity registry surface (structural contract: only governance methods). */
export interface GovernableEntityRegistry {
  names(): string[];
  get(entity_id: string): EntitySpec | null;
  unregister(entity_id: string): void;
}

/** Meta key written on archive/evict/merge (load-skip key, see entities.ts). */
const ARCHIVED_META_KEY = 'archived';

/** Entity row dict with archive trace meta merged in. */
function archivedSpec(
  spec: EntitySpec,
  extra: { archived_reason: string; archived_domain: string; merged_into?: string; evicted?: boolean },
): Record<string, unknown> {
  const data = spec.to_dict();
  const meta: Record<string, unknown> = {
    ...(spec.meta ?? {}),
    [ARCHIVED_META_KEY]: true,
    archived_reason: extra.archived_reason,
    archived_domain: extra.archived_domain,
  };
  if (extra.merged_into !== undefined) meta['merged_into'] = extra.merged_into;
  if (extra.evicted === true) meta['evicted'] = true;
  data['meta'] = meta;
  return data;
}

/**
 * Pool governance write target over the entity registry (R3 seam impl).
 * Writes go through the persist callback (GuardedStorage + audit); the live
 * active table is kept in sync through registry public methods; missing
 * objects are idempotent no-ops (no "not registered" errors surface).
 */
export function entity_registry_governance_target(
  registry: GovernableEntityRegistry,
  persist: RegistryGovernancePersist,
): GovernanceWriteTarget {
  return {
    async list(): Promise<string[]> {
      const names = registry.names();
      const visible: string[] = [];
      for (const name of names) {
        const spec = registry.get(name);
        if (spec !== null && spec.meta[ARCHIVED_META_KEY] !== true) visible.push(name);
      }
      return visible;
    },

    async archive(id, opts): Promise<void> {
      const spec = registry.get(id);
      if (spec === null || spec.meta[ARCHIVED_META_KEY] === true) return;
      await persist(
        id,
        archivedSpec(spec, {
          archived_reason: opts.reason,
          archived_domain: opts.domain,
        }),
        `pool_governance_archive`,
      );
      registry.unregister(id);
    },

    async evict(id, opts): Promise<void> {
      const spec = registry.get(id);
      if (spec === null || spec.meta[ARCHIVED_META_KEY] === true) return;
      await persist(
        id,
        archivedSpec(spec, {
          archived_reason: opts.reason,
          archived_domain: opts.domain,
          evicted: true,
        }),
        `pool_governance_evict`,
      );
      registry.unregister(id);
    },

    async merge(keep_id, drop_ids, opts): Promise<void> {
      const keep = registry.get(keep_id);
      if (keep === null) return; // authority missing = no-op (do not merge)
      for (const drop of drop_ids) {
        const spec = registry.get(drop);
        if (spec === null || spec.meta[ARCHIVED_META_KEY] === true) continue;
        await persist(
          drop,
          archivedSpec(spec, {
            archived_reason: opts.reason,
            archived_domain: opts.domain,
            merged_into: keep_id,
          }),
          `pool_governance_merge`,
        );
        registry.unregister(drop);
      }
    },
  };
}
