/**
 * Entity registry governance write target unit tests (R3 decision A):
 * - list/archive/evict/merge semantics (authority preserved, idempotent,
 *   missing object = no-op);
 * - archived rows (meta.archived/merged_into/evicted) do not resurrect
 *   through EntityRegistry.load;
 * - evict goes through the guarded channel: EvolutionWriter (GuardedStorage
 *   mechanism exemption) persists the row and writes set_audit; direct
 *   bypass writes are rejected by the guard.
 */

import { describe, expect, it } from 'vitest';

import { GuardedStorage } from '../../../src/kernel/self_application/guarded_storage.js';
import { DefaultEvolutionWriter, entity_writer } from '../../../src/kernel/evolution_writer/evolution_writer.js';
import { MemoryStorage } from '../../../src/adapters/storage/memory.js';
import { EntityRegistry, EntitySpec } from '../../../src/core/entities/entities.js';
import { entity_registry_governance_target } from '../../../src/core/entities/governance_target.js';

const COLLECTION = 'entities:default';

function spec(id: string, extra: Record<string, unknown> = {}): EntitySpec {
  const base: Record<string, unknown> = { id, label: `entity-${id}`, persona: 'p' };
  Object.assign(base, extra);
  return EntitySpec.from_dict(base);
}

/** Records surface (EntityRecordsStore shape; governance persist writes same). */
class FakeRecordsStore {
  rows = new Map<string, Record<string, unknown>>();
  async list_records(_collection: string): Promise<Record<string, unknown>[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  set(id: string, data: Record<string, unknown>): void {
    this.rows.set(id, { ...data });
  }
}

function makeRegistry(rows?: FakeRecordsStore): {
  registry: EntityRegistry;
  rows: FakeRecordsStore;
  calls: Array<[string, Record<string, unknown>, string]>;
  target: ReturnType<typeof entity_registry_governance_target>;
} {
  const rowsStore = rows ?? new FakeRecordsStore();
  const registry = new EntityRegistry({
    recordsStore: rowsStore,
    set_id: 'default',
  });
  const calls: Array<[string, Record<string, unknown>, string]> = [];
  const persist = async (
    id: string,
    data: Record<string, unknown>,
    note: string,
  ): Promise<void> => {
    calls.push([id, data, note]);
    rowsStore.set(id, data);
  };
  const target = entity_registry_governance_target(registry, persist);
  return { registry, rows: rowsStore, calls, target };
}

describe('entity_registry_governance_target semantics', () => {
  it('list() = active entity ids; archived objects leave the visible list', async () => {
    const { registry, target } = makeRegistry();
    registry.register(spec('a'));
    registry.register(spec('b'));
    await expect(target.list()).resolves.toEqual(['a', 'b']);
    await target.archive('a', { domain: 'code', reason: 'dead-node eviction' });
    await expect(target.list()).resolves.toEqual(['b']);
    expect(registry.get('a')).toBeNull();
  });

  it('archive/evict idempotent: missing object = no-op (no throw, no write)', async () => {
    const { registry, calls, target } = makeRegistry();
    registry.register(spec('a'));
    await target.archive('ghost', { domain: 'code', reason: 'r' });
    await target.evict('ghost', { domain: 'code', reason: 'r' });
    await target.merge('ghost', ['a'], { domain: 'code', reason: 'r' });
    expect(calls.length).toBe(0);
    expect(registry.get('a')).not.toBeNull();
  });

  it('merge keeps authority: keep untouched, drops archived with merged_into', async () => {
    const { registry, calls, rows, target } = makeRegistry();
    registry.register(spec('keep', { meta: { rank: 1 } }));
    registry.register(spec('dup_a'));
    registry.register(spec('dup_b'));
    await target.merge('keep', ['dup_a', 'dup_b'], {
      domain: 'code',
      reason: 'field near-duplicate',
    });
    expect(registry.names()).toEqual(['keep']);
    expect(registry.get('keep')!.meta['rank']).toBe(1);
    expect(rows.rows.get('dup_a')!['meta']).toMatchObject({
      archived: true,
      merged_into: 'keep',
    });
    expect(rows.rows.get('dup_b')).toBeTruthy();
    expect(calls.map((c) => c[0])).toEqual(['dup_a', 'dup_b']);
  });

  it('evict writes evicted trace and leaves the active table', async () => {
    const { registry, rows, target } = makeRegistry();
    registry.register(spec('dead'));
    await target.evict('dead', { domain: 'code', reason: 'remove' });
    expect(registry.get('dead')).toBeNull();
    expect(rows.rows.get('dead')!['meta']).toMatchObject({
      archived: true,
      evicted: true,
    });
  });

  it('archived rows do not resurrect through EntityRegistry.load (durable archive)', async () => {
    const rows = new FakeRecordsStore();
    rows.set('gone', spec('gone', { meta: { archived: true } }).to_dict());
    rows.set('live', spec('live').to_dict());
    const registry = new EntityRegistry({ recordsStore: rows, set_id: 'default' });
    const loaded = await registry.load();
    expect(loaded).toBe(1);
    expect(registry.names()).toEqual(['live']);
  });
});

describe('entity_registry_governance_target guarded write channel', () => {
  it('evict persists through EvolutionWriter + set_audit; bypass writes rejected', async () => {
    const inner = new MemoryStorage();
    const guarded = new GuardedStorage(inner, { guard_token: 'tok' });
    const writer = new DefaultEvolutionWriter(guarded);
    const persist = async (
      id: string,
      data: Record<string, unknown>,
      note: string,
    ): Promise<void> => {
      await entity_writer(writer, COLLECTION, id, data, { note });
    };
    const registry = new EntityRegistry({
      recordsStore: inner,
      writer,
      set_id: 'default',
    });
    registry.register(spec('victim'));
    const target = entity_registry_governance_target(registry, persist);
    // Guarded: direct write without token/mechanism exemption = rejected
    await expect(
      guarded.put_record(COLLECTION, 'victim', { id: 'victim' }),
    ).rejects.toThrow();
    // Seam write (mechanism exemption + audit): row persisted + set_audit
    await target.evict('victim', { domain: 'code', reason: 'remove test' });
    const row = await inner.get_record(COLLECTION, 'victim');
    expect(row!['meta']).toMatchObject({ archived: true, evicted: true });
    const audits = await inner.list_records('set_audit');
    expect(audits.some((a) => a['evolution_kind'] === 'entity' && a['asset_id'] === 'victim')).toBe(
      true,
    );
    await guarded.close();
  });
});
