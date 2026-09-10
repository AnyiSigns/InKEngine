/**
 * 实体受控下架（retired 标记）单测：retire_entity_record 记录构造 + 加载跳过。
 *
 * 覆盖：
 * - retire_entity_record：实体声明保留 + meta 追加 retired/reason/domain；
 * - EntityRegistry.load 跳过 retired=true 记录（下架不复活、不占配额），
 *   普通记录正常装载——与池治理 archived 跳过语义并列；
 * - 旧记录无 retired 字段零漂移装载。
 */

import { describe, expect, it } from 'vitest';

import {
  type EntityRecordsStore,
  EntityRegistry,
  EntitySpec,
  RETIRED_META_KEY,
  entity_collection,
  retire_entity_record,
} from '../../../src/core/entities/entities.js';

class MemRecordsStore implements EntityRecordsStore {
  rows: Record<string, unknown>[] = [];
  async list_records(_collection: string): Promise<Record<string, unknown>[]> {
    return [...this.rows];
  }
}

function scope_spec(entity_id: string): EntitySpec {
  return new EntitySpec({
    id: entity_id,
    role: entity_id,
    scope: { guard_level: 'L1' },
    meta: { evolution: { version: 3 } },
  });
}

describe('retire_entity_record 记录构造', () => {
  it('保留实体声明并追加 retired 标记/原因/域', () => {
    const spec = scope_spec('planner');
    const record = retire_entity_record(spec, { reason: '低使用高失败', domain: 'controlled_evolution' });
    expect(record['id']).toBe('planner');
    expect(record['role']).toBe('planner');
    expect((record['scope'] as Record<string, unknown>)['guard_level']).toBe('L1');
    const meta = record['meta'] as Record<string, unknown>;
    expect(meta[RETIRED_META_KEY]).toBe(true);
    expect(meta['retired_reason']).toBe('低使用高失败');
    expect(meta['retired_domain']).toBe('controlled_evolution');
    expect(meta['evolution']).toEqual({ version: 3 });
  });

  it('缺省域 = controlled_evolution；reason 缺省 = 空串', () => {
    const record = retire_entity_record(scope_spec('tester'), {});
    const meta = record['meta'] as Record<string, unknown>;
    expect(meta['retired_domain']).toBe('controlled_evolution');
    expect(meta['retired_reason']).toBe('');
  });
});

describe('EntityRegistry.load 跳过 retired 记录', () => {
  it('retired=true 记录不装载（下架不复活/不占配额），普通记录装载', async () => {
    const store = new MemRecordsStore();
    const collection = entity_collection('-');
    store.rows = [
      { id: 'planner', role: 'planner', scope: { guard_level: 'L1' }, meta: { retired: true } },
      { id: 'coder', role: 'coder', scope: { guard_level: 'L1' } },
    ];
    const registry = new EntityRegistry({ recordsStore: store, max_entities: 1 });
    const loaded = await registry.load();
    expect(loaded).toBe(1);
    expect(registry.get('planner')).toBeNull();
    expect(registry.get('coder')?.id).toBe('coder');
  });

  it('缺 max_entities 配额时 retired 记录不计占用（可被活跃记录占满）', async () => {
    const store = new MemRecordsStore();
    store.rows = [
      { id: 'retired_a', meta: { retired: true } },
      { id: 'retired_b', meta: { retired: true } },
      { id: 'live', role: 'collaborator' },
    ];
    const registry = new EntityRegistry({ recordsStore: store, max_entities: 1 });
    await registry.load();
    expect(registry.names()).toEqual(['live']);
  });

  it('旧记录无 retired 字段装载零漂移', async () => {
    const store = new MemRecordsStore();
    store.rows = [{ id: 'main', role: 'main', scope: { guard_level: 'L1' } }];
    const registry = new EntityRegistry({ recordsStore: store });
    await registry.load();
    expect(registry.get('main')?.role).toBe('main');
  });
});
