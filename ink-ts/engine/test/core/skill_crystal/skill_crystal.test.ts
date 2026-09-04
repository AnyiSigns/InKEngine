/**
 * 技能结晶单测（对标 test_skill_crystal.py 的可回迁段）：存储往返与域过滤 /
 * 视觉技能分类（image 输入 → visual）/ 自动结晶双阈值 / 去重版本递增 /
 * 沉淀钩子 / 测试报告与导出结构 / 默认阈值。纯算法、零 LLM、零网络；
 * 存储用默认内存 seam（now 缺省确定值 0），判定确定性。
 *
 * 暂缓用例（header note，属 real-storage / executor）：
 * - real-storage：test_skill_store_fails_fast_without_aiosqlite——TS core 零
 *   IO，SkillStore 为注入 seam（默认内存实现），aiosqlite 依赖探测归宿主
 *   sqlite seam 装配侧（ENG1-11 纪律在宿主面承接），sqlite 真实落库语义
 *   由宿主实现承载；test_export_skill_format_and_file 的 dest 落盘段——
 *   core export_skill 零 IO 只产结构，落盘为宿主职责；
 * - executor：test_build_assembly_skill_entry / test_assembly_skill_evidence_
 *   pending_note——组装候选/裁决/边证据 + Graph node_bindings 由组装器接线，
 *   待组装器迁移后按 build_assembly_skill_entry 的 duck 面形状补测
 *   （源码已回迁：build_assembly_skill_entry/_assembly_skill_name）。
 */

import { describe, expect, it } from 'vitest';

import {
  SKILL_HIT_MIN_DEFAULT,
  SKILL_SUCCESS_RATE_DEFAULT,
  SkillCrystallizeHook,
  SkillEntry,
  SkillStore,
  build_test_report,
  classify_skill_kind,
  crystallize_from_cache,
  export_skill,
} from '../../../src/core/skill_crystal/index.js';
import type {
  CacheEntryLike,
  CacheEntrySource,
} from '../../../src/core/skill_crystal/index.js';

// ── 假缓存（duck 指纹缓存条目面，镜像 Python SimpleNamespace 形态）──

function fake_cache_entry(
  overrides: Partial<CacheEntryLike> = {},
): CacheEntryLike {
  return {
    invalid: false,
    hit_count: 0,
    fail_count: 0,
    path_fingerprint: 'fp.default',
    domain: 'default',
    path: { nodes: {} },
    contract_snapshot: [],
    evidence_snapshot: [],
    model_id: 'm1',
    ...overrides,
  };
}

function fake_cache(...entries: CacheEntryLike[]): CacheEntrySource {
  return {
    async entries(domain: string | null = null): Promise<readonly CacheEntryLike[]> {
      if (domain === null || domain === undefined) return entries;
      return entries.filter((entry) => entry.domain === domain);
    },
  };
}

// ── 技能条目构建 helper（镜 Python 测试关键字构造）──

function make_entry(overrides: Partial<ConstructorParameters<typeof SkillEntry>[0]> = {}): SkillEntry {
  const base: ConstructorParameters<typeof SkillEntry>[0] = {
    name: 'path.default.x',
    version: 1,
    domain: 'default',
    fingerprint: 'fp.x',
    kind: 'path',
    path: { nodes: {} },
    model_id: 'm',
    hit_count: 1,
    fail_count: 0,
    source_path: 'fp.x',
    created_at: 1.0,
    updated_at: 1.0,
  };
  return new SkillEntry({ ...base, ...overrides });
}

function make_store(): SkillStore {
  return new SkillStore();
}

describe('SkillStore（内存 seam）存储往返', () => {
  it('upsert/get 往返 + 计数 + 删除（复杂字段随条目落）', async () => {
    const store = make_store();
    const entry = new SkillEntry({
      name: 'path.default.abc1234567',
      version: 1,
      domain: 'default',
      fingerprint: 'fp.abc',
      kind: 'path',
      path: { nodes: {} },
      contract_snapshot: [['a', '1']],
      evidence_snapshot: [
        { src_type: 'a', dst_type: 'b', success_count: 3, fail_count: 0 },
      ],
      model_id: 'm1',
      hit_count: 10,
      fail_count: 0,
      test_report: { success_rate: 1.0 },
      source_path: 'fp.abc',
      created_at: 1.0,
      updated_at: 1.0,
    });
    await store.upsert(entry);
    const got = await store.get(entry.name);
    expect(got).not.toBeNull();
    expect(got!.fingerprint).toBe('fp.abc');
    expect(got!.hit_count).toBe(10);
    expect(got!.contract_snapshot).toEqual([['a', '1']]);
    expect(await store.count()).toBe(1);
    expect(await store.delete(entry.name)).toBe(true);
    expect(await store.get(entry.name)).toBeNull();
    await store.close();
  });

  it('list 按域过滤（全域 vs 指定域）', async () => {
    const store = make_store();
    await store.upsert(
      new SkillEntry({
        name: 'path.default.x1',
        version: 1,
        domain: 'default',
        fingerprint: 'f1',
        kind: 'path',
        path: { nodes: {} },
        contract_snapshot: [],
        evidence_snapshot: [],
        model_id: 'm',
        hit_count: 1,
        fail_count: 0,
        test_report: {},
        source_path: 'f1',
        created_at: 1.0,
        updated_at: 1.0,
      }),
    );
    await store.upsert(
      new SkillEntry({
        name: 'path.vision.y1',
        version: 1,
        domain: 'vision',
        fingerprint: 'f2',
        kind: 'visual',
        path: { nodes: {} },
        contract_snapshot: [],
        evidence_snapshot: [],
        model_id: 'm',
        hit_count: 1,
        fail_count: 0,
        test_report: {},
        source_path: 'f2',
        created_at: 1.0,
        updated_at: 1.0,
      }),
    );
    const allSkills = await store.list();
    expect(allSkills).toHaveLength(2);
    const visionOnly = await store.list('vision');
    expect(visionOnly).toHaveLength(1);
    expect(visionOnly[0]!.domain).toBe('vision');
    await store.close();
  });
});

describe('技能分类（视觉 vs 通用路径）', () => {
  it('路径首结点消费 image 输入 = visual；否则 = path', () => {
    const visualPath = {
      nodes: {
        perceive: {
          type: 'vision.perceive',
          contract: {
            version: '1',
            input_schema: {
              name: 'in',
              fields: [{ name: 'image', required: true, kind: 'string' }],
            },
          },
        },
        extract: { type: 'data.extract' },
      },
    };
    expect(classify_skill_kind(visualPath)).toBe('visual');
    expect(classify_skill_kind({ nodes: { a: { type: 'plain' } } })).toBe('path');
  });
});

describe('自动结晶（双阈值 + 去重版本递增）', () => {
  it('命中数与命中率双阈值 AND（任一不达标不结晶）', async () => {
    const cache = fake_cache(
      fake_cache_entry({ hit_count: 10, fail_count: 0, path_fingerprint: 'fp.good' }),
      fake_cache_entry({ hit_count: 2, fail_count: 0, path_fingerprint: 'fp.lowhit' }),
      fake_cache_entry({ hit_count: 10, fail_count: 10, path_fingerprint: 'fp.lowrate' }),
    );
    const store = make_store();
    const created = await crystallize_from_cache(cache, store);
    expect(created).toEqual(['path.default.fp.good']);
    expect(await store.count()).toBe(1);
    await store.close();
  });

  it('视觉路径结晶标记 kind=visual（标签与通用同构）', async () => {
    const visualPath = {
      nodes: {
        perceive: {
          type: 'vision.perceive',
          contract: {
            version: '1',
            input_schema: {
              name: 'in',
              fields: [{ name: 'image', required: true, kind: 'string' }],
            },
          },
        },
      },
    };
    const cache = fake_cache(
      fake_cache_entry({
        hit_count: 9,
        fail_count: 1,
        path_fingerprint: 'fp.vis',
        path: visualPath,
      }),
    );
    const store = make_store();
    const created = await crystallize_from_cache(cache, store);
    expect(created).toEqual(['visual.default.fp.vis']);
    const entry = await store.get('visual.default.fp.vis');
    expect(entry!.kind).toBe('visual');
    await store.close();
  });

  it('同指纹同计数去重；计数变化 = 版本递增', async () => {
    const cache = fake_cache(
      fake_cache_entry({ hit_count: 10, fail_count: 0, path_fingerprint: 'fp.dup' }),
    );
    const store = make_store();
    await crystallize_from_cache(cache, store);
    const again = await crystallize_from_cache(cache, store);
    expect(again).toEqual([]);
    expect(await store.count()).toBe(1);
    const cache2 = fake_cache(
      fake_cache_entry({ hit_count: 20, fail_count: 0, path_fingerprint: 'fp.dup' }),
    );
    const bumped = await crystallize_from_cache(cache2, store);
    expect(bumped).toEqual(['path.default.fp.dup']);
    const entry = await store.get('path.default.fp.dup');
    expect(entry!.version).toBe(2);
    expect(entry!.hit_count).toBe(20);
    await store.close();
  });

  it('存储缺失 = fail-closed 不结晶', async () => {
    const store = make_store();
    expect(await crystallize_from_cache(null, store)).toEqual([]);
    expect(await crystallize_from_cache(fake_cache(), null)).toEqual([]);
    await store.close();
  });

  it('失效条目跳过 + 阈值可配置生效', async () => {
    const cache = fake_cache(
      fake_cache_entry({ hit_count: 4, fail_count: 0, path_fingerprint: 'fp.b', invalid: true }),
    );
    const store = make_store();
    const created = await crystallize_from_cache(cache, store, {
      hit_min: 8,
      success_rate: 0.9,
    });
    expect(created).toEqual([]);
    await store.close();
  });
});

describe('SkillCrystallizeHook 沉淀后处理', () => {
  it('settle 后结晶清单 + 落库（未注入 = fail-closed）', async () => {
    const cache = fake_cache(
      fake_cache_entry({ hit_count: 10, fail_count: 0, path_fingerprint: 'fp.h' }),
    );
    const store = make_store();
    const hook = new SkillCrystallizeHook(cache, store);
    await hook.settle(null);
    expect(hook.crystallized).toEqual(['path.default.fp.h']);
    expect(await store.count()).toBe(1);
    const empty = new SkillCrystallizeHook(null, store);
    await empty.settle(null);
    expect(empty.crystallized).toEqual([]);
    await store.close();
  });
});

describe('测试报告与导出结构', () => {
  it('build_test_report 报告形状（成功率/样本边）', () => {
    const report = build_test_report({
      name: 'path.default.x',
      version: 1,
      domain: 'default',
      model_id: 'm',
      hit_count: 9,
      fail_count: 1,
      success_rate: 0.9,
      evidence_snapshot: [
        { src_type: 'a', dst_type: 'b', success_count: 9, fail_count: 1 },
      ],
      kind: 'path',
      now: 123.0,
    });
    expect(report['skill_name']).toBe('path.default.x');
    expect(report['success_rate']).toBe(0.9);
    const sampleEdges = report['sample_edges'] as Array<Record<string, unknown>>;
    expect(sampleEdges[0]!['src_type']).toBe('a');
  });

  it('export_skill 导出结构（inkling.skill/v1 元数据 + 报告随行）', () => {
    const entry = make_entry({
      name: 'path.default.exp',
      fingerprint: 'fp.e',
      source_path: 'fp.e',
      hit_count: 5,
      test_report: { success_rate: 1.0 },
    });
    const payload = export_skill(entry);
    expect(payload['format']).toBe('inkling.skill/v1');
    expect(payload['name']).toBe('path.default.exp');
    expect(payload['kind']).toBe('path');
    const report = payload['test_report'] as Record<string, unknown>;
    expect(report['success_rate']).toBe(1.0);
  });
});

describe('默认阈值导出', () => {
  it('默认阈值已导出且数值合理', () => {
    expect(SKILL_HIT_MIN_DEFAULT).toBeGreaterThanOrEqual(1);
    expect(SKILL_SUCCESS_RATE_DEFAULT).toBeGreaterThan(0);
    expect(SKILL_SUCCESS_RATE_DEFAULT).toBeLessThanOrEqual(1);
  });
});
