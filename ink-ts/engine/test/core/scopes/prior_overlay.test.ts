/**
 * 组织先验覆盖资产单测（prior_overlay.ts：route/shortcut/weight 三类覆盖行）。
 *
 * 覆盖：
 * - 集合命名（org_priors_collection 按集隔离、缺省集 = -）；
 * - 三类覆盖行便捷构造（route = 整条先验覆写；shortcut = 直连沉淀；
 *   weight = 降权/加权标记）与稳定 id 编码；
 * - from/to_dict round-trip（route 全字段、shortcut 带/不带 weight、weight）；
 * - 校验 fail-closed：kind 词表外、权重取值域、shortcut 中继等于起/终点、
 *   行 id 与载荷不一致、route 先验结构非法、非 dict 拒绝。
 */

import { describe, expect, it } from 'vitest';

import {
  ORG_PRIORS_COLLECTION_PREFIX,
  OrgPriorOverlay,
  org_priors_collection,
  route_overlay,
  shortcut_overlay,
  shortcut_overlay_id,
  weight_overlay,
  weight_overlay_id,
} from '../../../src/core/scopes/prior_overlay.js';
import {
  default_scope_priors,
  scope_prior_to_dict,
  type ScopePriorPattern,
} from '../../../src/core/scopes/scope_priors.js';

function coding(): ScopePriorPattern {
  return default_scope_priors()[0]!;
}

describe('org_priors 集合命名', () => {
  it('前缀 + 集名（缺省集 = -）', () => {
    expect(ORG_PRIORS_COLLECTION_PREFIX).toBe('org_priors:');
    expect(org_priors_collection()).toBe('org_priors:-');
    expect(org_priors_collection('host')).toBe('org_priors:host');
  });
});

describe('OrgPriorOverlay route 覆写行', () => {
  it('route 构造 id = 先验模式 id；round-trip 保持全字段', () => {
    const overlay = route_overlay(coding());
    expect(overlay.kind).toBe('route');
    expect(overlay.id).toBe('coding');
    const restored = OrgPriorOverlay.from_dict(overlay.to_dict());
    expect(restored).toEqual(overlay);
    expect(restored.payload.kind).toBe('route');
    if (restored.payload.kind === 'route') {
      expect(restored.payload.pattern.entry_scope).toBe('main');
      expect(restored.payload.pattern.hops).toHaveLength(coding().hops.length);
    }
  });

  it('route 行 id 与先验模式 id 不一致 = 拒绝', () => {
    const dict = scope_prior_to_dict(coding());
    dict['id'] = 'casual';
    expect(() => OrgPriorOverlay.from_dict({ id: 'coding', kind: 'route', pattern: dict })).toThrow(
      /与行 id 一致/,
    );
  });
});

describe('OrgPriorOverlay shortcut 直连行', () => {
  it('构造 id = 三作用域稳定编码；round-trip（不带 weight）', () => {
    const overlay = shortcut_overlay('main', 'coder', 'planner');
    expect(overlay.id).toBe(shortcut_overlay_id('main', 'planner', 'coder'));
    const restored = OrgPriorOverlay.from_dict(overlay.to_dict());
    expect(restored).toEqual(overlay);
  });

  it('带 weight 的 shortcut round-trip 保持权重', () => {
    const overlay = shortcut_overlay('main', 'coder', 'planner', 0.8);
    const restored = OrgPriorOverlay.from_dict(overlay.to_dict());
    expect(restored.payload).toMatchObject({ kind: 'shortcut', weight: 0.8 });
  });

  it('skip_scope 等于起/终点 = 拒绝（跳过的是中继，非起点/终点）', () => {
    expect(() => shortcut_overlay('main', 'coder', 'main')).toThrow(/skip_scope/);
    expect(() => shortcut_overlay('main', 'coder', 'coder')).toThrow(/skip_scope/);
    expect(
      () => OrgPriorOverlay.from_dict({ id: 'x', kind: 'shortcut', from: 'a', to: 'a', skip_scope: 'b' }),
    ).toThrow(/中继作用域|skip_scope/);
  });

  it('行 id 与 from/skip_scope/to 编码不一致 = 拒绝', () => {
    const dict = shortcut_overlay('main', 'coder', 'planner').to_dict();
    dict['id'] = 'tampered';
    expect(() => OrgPriorOverlay.from_dict(dict)).toThrow(/与 from\/skip_scope\/to 编码一致/);
  });
});

describe('OrgPriorOverlay weight 权重行', () => {
  it('构造 id = ref 编码；round-trip 保持 ref/weight', () => {
    const overlay = weight_overlay('["transition","main","planner","delegate","full"]', 0.5);
    expect(overlay.id).toBe(weight_overlay_id('["transition","main","planner","delegate","full"]'));
    const restored = OrgPriorOverlay.from_dict(overlay.to_dict());
    expect(restored).toEqual(overlay);
  });

  it('权重取值域 (0,1]：0/负数/超 1/非数值 = 拒绝', () => {
    expect(() => weight_overlay('ref', 0)).toThrow(/权重非法/);
    expect(() => weight_overlay('ref', -0.5)).toThrow(/权重非法/);
    expect(() => weight_overlay('ref', 1.5)).toThrow(/权重非法/);
    expect(() => weight_overlay('ref', Number.NaN)).toThrow(/权重非法/);
    const ok = weight_overlay('ref', 1);
    if (ok.payload.kind === 'weight') expect(ok.payload.weight).toBe(1);
    expect(() => OrgPriorOverlay.from_dict({ id: 'w', kind: 'weight', ref: 'r', weight: 0 })).toThrow();
  });
});

describe('OrgPriorOverlay 解析校验（fail-closed）', () => {
  it('kind 词表外 / 缺字段 / 非 dict 拒绝', () => {
    expect(() => OrgPriorOverlay.from_dict('nope')).toThrow(/dict/);
    expect(() => OrgPriorOverlay.from_dict({ id: 'x', kind: 'bogus' })).toThrow(/route \| shortcut \| weight/);
    expect(() => OrgPriorOverlay.from_dict({ kind: 'weight', ref: 'r', weight: 0.5 })).toThrow(/id/);
    expect(() =>
      OrgPriorOverlay.from_dict({ id: 'r', kind: 'route', pattern: 'not-a-dict' }),
    ).toThrow(/route\.pattern/);
  });

  it('route 先验结构非法（缺 sink/断链等）经 scope_prior 校验拒绝', () => {
    const bad = scope_prior_to_dict(coding());
    const hops = bad['hops'] as Record<string, unknown>[];
    hops[hops.length - 1] = { from: 'coder', shape: 'delegate', to: 'main' };
    expect(() => OrgPriorOverlay.from_dict({ id: 'coding', kind: 'route', pattern: bad })).toThrow();
  });
});
