/**
 * 实体注册表单测（协作者目录：声明形态 + 注册表 + 集内持久化 + 内省快照）。
 *
 * 覆盖：
 * - EntitySpec 声明往返 + 形态校验（缺 id / 命名非法 / model/meta 类型）；
 * - EntityRegistry 注册/查询/废弃/替换 + 重复/配额拒绝；
 * - load/save 集内持久化（内存存储往返）；
 * - entity_collection 集合名按集隔离。
 *
 *  deferred（待 ink-ts 对应模块落地后补测）：
 * - TestIntrospectionEntities：依赖 IntrospectionService / IntrospectionSources
 *   （ink_engine.core.introspection 尚未迁入 ink-ts）；
 * - TestCollabEndpointDerivation：依赖 EndpointType / endpoint_operation
 *   （ink_engine.core.declarative_tools 尚未迁入 ink-ts）；
 * - TestEntityPatchLifecycle：依赖 patch_path / PatchKind
 *   （ink_engine.core.self_application / self_proposal 尚未迁入 ink-ts）。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import type { EvolutionRecord, EvolutionWriter } from '../../../src/core/evolution_writer/_types.js';
import {
  type EntityRecordsStore,
  EntityRegistry,
  EntitySpec,
  entity_collection,
} from '../../../src/core/entities/entities.js';

function spec(
  entity_id = 'security_reviewer',
  kw: Record<string, unknown> = {},
): EntitySpec {
  const base: Record<string, unknown> = {
    id: entity_id,
    label: '安全评审',
    persona: '你是安全评审专家…',
    model: { provider: 'moonshotai-cn', model_id: 'kimi-k2' },
  };
  Object.assign(base, kw);
  return EntitySpec.from_dict(base);
}

describe('EntitySpec 声明形态', () => {
  it('round-trip 保持全字段', () => {
    const s = spec();
    const restored = EntitySpec.from_dict(s.to_dict());
    expect(restored).toEqual(s);
    expect(restored.model).toEqual({ provider: 'moonshotai-cn', model_id: 'kimi-k2' });
  });

  it('极简声明（无 label/persona/model/meta）', () => {
    const s = EntitySpec.from_dict({ id: 'analyst' });
    expect(s.label).toBe('');
    expect(s.persona).toBe('');
    expect(s.model).toBeNull();
    expect(s.meta).toEqual({});
  });

  it('缺 id 显式拒绝', () => {
    expect(() => EntitySpec.from_dict({ label: 'x' })).toThrow(/实体声明缺 id/);
    expect(() => EntitySpec.from_dict({ id: 123 })).toThrow(/实体声明缺 id/);
  });

  it('非法 id 命名拒绝（空白/控制字符/超长；下划线形态放行）', () => {
    expect(() => spec('security reviewer')).toThrow(/实体 id 命名非法/);
    expect(() => spec('bad\tid')).toThrow(/实体 id 命名非法/);
    expect(() => spec('x'.repeat(60))).toThrow(/实体 id 命名非法/);
    spec('security_reviewer');
  });

  it('字段类型非法拒绝', () => {
    expect(() => spec('a', { label: { nested: true } })).toThrow(/label 须为字符串/);
    expect(() => spec('a', { model: 'kimi-k2' })).toThrow(/model 须为 dict/);
    expect(() => spec('a', { meta: ['not-a-dict'] })).toThrow(/meta 须为 dict/);
  });

  it('model 空值归一为 null', () => {
    const s = EntitySpec.from_dict({
      id: 'analyst',
      model: { provider: '', model_id: 'm1' },
    });
    expect(s.model).toEqual({ model_id: 'm1' });
    const s2 = EntitySpec.from_dict({ id: 'analyst', model: {} });
    expect(s2.model).toBeNull();
  });
});

describe('EntityRegistry 注册门禁', () => {
  it('register/get/names/specs 按注册序稳定', () => {
    const registry = new EntityRegistry();
    registry.register(spec('a'));
    registry.register(spec('b'));
    expect(registry.get('a')?.label).toBe('安全评审');
    expect(registry.get('missing')).toBeNull();
    expect(registry.names()).toEqual(['a', 'b']);
    expect(registry.specs()).toHaveLength(2);
  });

  it('重复注册显式拒绝', () => {
    const registry = new EntityRegistry();
    registry.register(spec('a'));
    expect(() => registry.register(spec('a'))).toThrow(/实体重复注册/);
  });

  it('unregister 未注册显式拒绝', () => {
    const registry = new EntityRegistry();
    registry.register(spec('a'));
    registry.unregister('a');
    expect(registry.get('a')).toBeNull();
    expect(() => registry.unregister('a')).toThrow(/实体未注册/);
  });

  it('replace 未注册显式拒绝（演化不代创建）', () => {
    const registry = new EntityRegistry();
    expect(() => registry.replace(spec('a'))).toThrow(/实体未注册（演化不代创建）/);
    registry.register(spec('a'));
    registry.replace(spec('a', { label: '新标签' }));
    expect(registry.get('a')?.label).toBe('新标签');
  });

  it('配额超限拒绝', () => {
    const registry = new EntityRegistry({ max_entities: 1 });
    registry.register(spec('a'));
    expect(() => registry.register(spec('b'))).toThrow(/配额上限/);
  });

  it('collection 按集隔离', () => {
    expect(entity_collection('default')).toBe('entities:default');
  });
});

describe('EntityRegistry 随集持久化（seam）', () => {
  function memoryStore(): EntityRecordsStore &
    EvolutionWriter & { put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> } {
    const byCol = new Map<string, Map<string, Record<string, unknown>>>();
    return {
      async list_records(collection: string) {
        return [...(byCol.get(collection)?.values() ?? [])];
      },
      async put_record(collection: string, key: string, data: Record<string, unknown>) {
        if (!byCol.has(collection)) byCol.set(collection, new Map());
        byCol.get(collection)!.set(key, data);
      },
      async write(collection: string, key: string, data: EvolutionRecord, _options: { note?: string }) {
        if (!byCol.has(collection)) byCol.set(collection, new Map());
        byCol.get(collection)!.set(key, data as Record<string, unknown>);
      },
    };
  }

  it('round-trip：save → load 恢复注册表', async () => {
    const store = memoryStore();
    const registry = new EntityRegistry({
      recordsStore: store,
      writer: store,
      set_id: 'default',
    });
    registry.register(spec('a'));
    registry.register(spec('b'));
    await registry.save();

    const restored = new EntityRegistry({ recordsStore: store, set_id: 'default' });
    expect(await restored.load()).toBe(2);
    expect(restored.names()).toEqual(['a', 'b']);
    expect(restored.get('a')?.persona).toBe('你是安全评审专家…');
  });

  it('load 跳过脏记录不阻断启动', async () => {
    const store = memoryStore();
    await store.put_record('entities:default', 'bad', { id: 'bad', label: 1 });
    const registry = new EntityRegistry({ recordsStore: store, set_id: 'default' });
    expect(await registry.load()).toBe(0);
  });

  it('无存储 load/save 静默跳过', async () => {
    const registry = new EntityRegistry();
    registry.register(spec('a'));
    expect(await registry.load()).toBe(0);
    await registry.save();
    expect(registry.names()).toEqual(['a']);
  });
});
