/**
 * 作用域目录资产层单测（scope_directory.ts：目录资产映射 + 出厂素材）。
 *
 * 覆盖：
 * - build_scope_asset 构造（role/声明块合一；空 role 显式拒绝）；
 * - scope_decl_of / is_scope_asset（实体 vs 作用域资产判定）；
 * - 出厂素材完整性：8 行目录、role 词汇对齐、全部经实体字典 round-trip；
 * - 素材深度隔离：就地改写一次调用的素材不影响后续调用（声明块深拷贝）；
 * - 实体注册表随集持久化 round-trip（EvolutionWriter seam 注入）保持 scope
 *   声明块——作用域资产与实体共用同一注册/持久化通道（不另建平行目录）；
 * - 目录资产 replace（演化）后 scope 声明块仍在。
 */

import { describe, expect, it } from 'vitest';

import { EntityRegistry, EntitySpec } from '../../../src/core/entities/entities.js';
import type { EvolutionRecord } from '../../../src/kernel/evolution_writer/_types.js';
import {
  build_scope_asset,
  default_scope_directory_seeds,
  is_scope_asset,
  scope_decl_of,
} from '../../../src/core/scopes/scope_directory.js';
import {
  FACTORY_SCOPE_ROLES,
  SCOPE_GUARD_DEFAULT,
  SCOPE_ROLE_MAIN,
  type ScopeCapability,
} from '../../../src/core/scopes/scope_spec.js';

interface MemoryEvolutionStore {
  list_records(collection: string): Promise<Record<string, unknown>[]>;
  put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void>;
  write(
    collection: string,
    key: string,
    data: EvolutionRecord,
    _options: { note?: string },
  ): Promise<void>;
}

function memoryStore(): MemoryEvolutionStore {
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
      byCol.get(collection)!.set(key, data);
    },
  };
}

describe('scope_directory 资产构造', () => {
  it('build_scope_asset 产出携带 scope 声明块的实体（role + 块并存）', () => {
    const asset = build_scope_asset({ id: 'planner', role: 'planner', persona: '规划器' });
    expect(asset.role).toBe('planner');
    expect(asset.scope).not.toBeNull();
    // 未显式给档 = 出厂默认 L1（受控登记审批档随资产登记）
    expect(asset.scope?.guard_level).toBe(SCOPE_GUARD_DEFAULT);
  });

  it('空 role 显式拒绝（目录身份是必要维度）', () => {
    expect(() => build_scope_asset({ id: 'x', role: '  ' })).toThrow(/缺目录身份/);
  });

  it('scope_decl_of / is_scope_asset 区分作用域资产与普通实体', () => {
    const asset = build_scope_asset({ id: 'planner', role: 'planner', persona: '规划器' });
    expect(scope_decl_of(asset)).not.toBeNull();
    expect(is_scope_asset(asset)).toBe(true);
    const plain = new EntitySpec({ id: 'security_reviewer' });
    expect(scope_decl_of(plain)).toBeNull();
    expect(is_scope_asset(plain)).toBe(false);
  });

  it('普通实体即使 role 命中出厂目录身份也不算作用域资产（缺声明块）', () => {
    const asset = new EntitySpec({ id: 'main', role: SCOPE_ROLE_MAIN });
    expect(is_scope_asset(asset)).toBe(false);
    // 经 build_scope_asset 归一后（守卫档恒落）才是目录资产
    expect(is_scope_asset(build_scope_asset({ id: 'main', role: SCOPE_ROLE_MAIN }))).toBe(true);
  });
});

describe('scope_directory 出厂素材', () => {
  it('出厂目录 = 8 行，role 词汇与 FACTORY_SCOPE_ROLES 一一对应', () => {
    const seeds = default_scope_directory_seeds();
    expect(seeds).toHaveLength(FACTORY_SCOPE_ROLES.length);
    const roles = seeds.map((s) => s.role).sort();
    expect(roles).toEqual([...FACTORY_SCOPE_ROLES].sort());
  });

  it('每次调用返回新鲜数据（防调用方就地改写污染素材）', () => {
    const a = default_scope_directory_seeds();
    const b = default_scope_directory_seeds();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });

  it('素材深度隔离：就地改写一次调用的素材不影响后续调用', () => {
    const a = default_scope_directory_seeds();
    const before = default_scope_directory_seeds();
    const mainA = a.find((s) => s.id === 'main')!;
    const plannerA = a.find((s) => s.id === 'planner')!;
    const mainBefore = before.find((s) => s.id === 'main')!;
    const plannerBefore = before.find((s) => s.id === 'planner')!;
    // main 行 capability 数组跨调用共享同一模块级 const（改写会经深拷贝隔绝）
    (mainA.scope!.capabilities as ScopeCapability[]).push({
      id: 'mutated',
      class: 'organization',
    });
    plannerA.scope!.capabilities![0]!.id = 'mutated_plan';
    const after = default_scope_directory_seeds();
    const mainAfter = after.find((s) => s.id === 'main')!;
    const plannerAfter = after.find((s) => s.id === 'planner')!;
    expect(mainAfter.scope!.capabilities).toEqual(mainBefore.scope!.capabilities);
    expect(plannerAfter.scope!.capabilities).toEqual(plannerBefore.scope!.capabilities);
  });

  it('全部素材可经实体字典 round-trip 且声明块保持', () => {
    for (const seed of default_scope_directory_seeds()) {
      const restored = EntitySpec.from_dict(seed.to_dict());
      expect(restored.id).toBe(seed.id);
      expect(restored.role).toBe(seed.role);
      expect(restored.persona).toBe(seed.persona);
      expect(restored.scope).toEqual(seed.scope);
    }
  });

  it('main 素材带组织类能力与登记守卫档（声明面数据在场）', () => {
    const main = default_scope_directory_seeds().find((s) => s.id === 'main')!;
    expect(main.scope?.guard_level).toBe(SCOPE_GUARD_DEFAULT);
    const orgCaps = (main.scope?.capabilities ?? []).filter(
      (c) => c.class === 'organization',
    );
    expect(orgCaps.length).toBeGreaterThan(0);
  });
});

describe('scope_directory 受控注册通道复用（实体注册表 + EvolutionWriter）', () => {
  it('作用域资产随实体注册表 save/load 保持（scope 字段不丢）', async () => {
    const store = memoryStore();
    const registry = new EntityRegistry({
      recordsStore: store,
      writer: store as never,
      set_id: 'default',
    });
    const planner = default_scope_directory_seeds().find((s) => s.id === 'planner')!;
    registry.register(planner);
    await registry.save();

    const restored = new EntityRegistry({ recordsStore: store, set_id: 'default' });
    expect(await restored.load()).toBe(1);
    const loaded = restored.get('planner')!;
    expect(loaded.scope).toEqual(planner.scope);
    expect(loaded.scope?.guard_level).toBe(SCOPE_GUARD_DEFAULT);
  });

  it('replace（演化更新）后 scope 声明块仍在（不因 replace 丢维度）', () => {
    const registry = new EntityRegistry();
    registry.register(
      build_scope_asset({
        id: 'planner',
        role: 'planner',
        persona: 'v1',
        contract: {
          consumes: [{ shape: 'message' }],
          produces: [{ shape: 'field', key: 'plan' }],
        },
      }),
    );
    registry.replace(
      build_scope_asset({
        id: 'planner',
        role: 'planner',
        persona: 'v2',
        capabilities: [{ id: 'plan', class: 'function' }],
      }),
    );
    const current = registry.get('planner')!;
    expect(current.persona).toBe('v2');
    expect(current.scope?.capabilities?.[0]?.id).toBe('plan');
    expect(current.scope?.guard_level).toBe(SCOPE_GUARD_DEFAULT);
  });
});
