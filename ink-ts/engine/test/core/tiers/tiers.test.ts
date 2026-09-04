/**
 * core/tiers.ts 测试：挡位配置解析、按挡位建链、调用统计钩子与挡位声明
 * 装配注入——对标 pytest test_tiers.py + test_tiers_config.py。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  TIER_NAMES,
  TierCallStats,
  build_tier_chain,
  current_tier_names,
  resolve_tier_config,
  set_tier_names,
  tier_key,
} from '../../../src/core/tiers/tiers.js';
import type { Json } from '../../../src/core/json.js';

const AUDIT_NAMES = ['main', 'router', 'audit'];

function model_config(extra: Record<string, Json> = {}): Record<string, Json> {
  return {
    main_config: { adapter: 'openai_compat', model_id: 'main', base_url: 'http://m' },
    router_config: { adapter: 'openai_compat', model_id: 'router', base_url: 'http://r' },
    ...extra,
  };
}

afterEach(() => {
  set_tier_names(TIER_NAMES);
});

describe('tier_key / 挡位常量', () => {
  it('test_known_tiers_passthrough：已知挡位名直通', () => {
    for (const tier of ['main', 'router']) {
      expect(tier_key(tier)).toBe(tier);
    }
  });

  it('test_unknown_and_none_fall_back_to_main：未知/None 回落 main', () => {
    expect(tier_key('bogus')).toBe('main');
    expect(tier_key(null)).toBe('main');
  });

  it('test_tier_names：出厂声明为双挡', () => {
    expect(TIER_NAMES).toEqual(['main', 'router']);
  });
});

describe('resolve_tier_config 挡位配置解析', () => {
  it('test_uses_tier_config：按挡位取配置', () => {
    const tc = resolve_tier_config(model_config(), 'router');
    expect(tc.tier).toBe('router');
    expect(tc.config).toEqual(model_config()['router_config']);
  });

  it('test_falls_back_to_main_when_tier_missing：缺挡位回落主挡配置', () => {
    const tc = resolve_tier_config(model_config(), 'router_typo');
    expect(tc.config).toEqual(model_config()['main_config']);
  });

  it('test_unknown_tier_resolves_to_main：未知挡位归 main', () => {
    const tc = resolve_tier_config(model_config(), 'bogus');
    expect(tc.tier).toBe('main');
  });

  it('test_top_level_fallbacks：顶层备用列表', () => {
    const cfg = model_config({ router_fallback_configs: [{ model_id: 'fb1' }] });
    const tc = resolve_tier_config(cfg, 'router');
    expect(tc.fallbacks).toEqual([{ model_id: 'fb1' }]);
  });

  it('test_legacy_nested_fallbacks：历史嵌套形态兼容', () => {
    const cfg = model_config({
      router_config: {
        adapter: 'openai_compat',
        model_id: 'router',
        base_url: 'http://t',
        fallback_configs: [{ model_id: 'fb1' }],
      },
    });
    const tc = resolve_tier_config(cfg, 'router');
    expect(tc.config).toEqual(expect.objectContaining({ model_id: 'router' }));
    expect(tc.fallbacks).toEqual([{ model_id: 'fb1' }]);
  });

  it('test_no_config_returns_none：无配置 config=None', () => {
    const tc = resolve_tier_config({}, 'main');
    expect(tc.config).toBeNull();
    expect(tc.fallbacks).toEqual([]);
    expect(resolve_tier_config(null, 'main').config).toBeNull();
  });
});

describe('build_tier_chain 按挡位建链', () => {
  it('test_builds_chain_from_config：有配置建成链', () => {
    const chain = build_tier_chain(model_config(), 'router', { create: () => ({}) });
    expect(chain).not.toBeNull();
  });

  it('test_missing_config_returns_none：无配置返回 null', () => {
    expect(build_tier_chain({}, 'main')).toBeNull();
    expect(build_tier_chain(null, 'main')).toBeNull();
  });
});

describe('TierCallStats 挡位调用统计', () => {
  it('test_records_by_tier：按挡位累加', () => {
    const stats = new TierCallStats();
    stats.record('router');
    stats.record('main', 3);
    stats.record('router');
    expect(stats.snapshot()).toEqual({ router: 2, main: 3 });
  });

  it('test_unknown_tier_normalized：未知挡位归一 main', () => {
    const stats = new TierCallStats();
    stats.record('bogus');
    expect(stats.snapshot()).toEqual({ main: 1 });
  });

  it('test_non_positive_count_ignored：非正计数忽略', () => {
    const stats = new TierCallStats();
    stats.record('main', 0);
    stats.record('main', -1);
    expect(stats.snapshot()).toEqual({});
  });

  it('test_reset：清零', () => {
    const stats = new TierCallStats();
    stats.record('main');
    stats.reset();
    expect(stats.snapshot()).toEqual({});
  });

  it('test_merge：合并另一实例计数', () => {
    const a = new TierCallStats();
    const b = new TierCallStats();
    a.record('main', 2);
    b.record('router', 1);
    b.record('main', 1);
    a.merge(b);
    expect(a.snapshot()).toEqual({ main: 3, router: 1 });
  });
});

describe('ENG3-11 显式空配置与缺失键区分', () => {
  it('test_explicit_empty_tier_config_not_fallback：显式空不回落主挡', () => {
    const cfg = {
      main_config: { adapter: 'openai_compat', model_id: 'main' },
      router_config: {},
    };
    const tc = resolve_tier_config(cfg, 'router');
    expect(tc.config).toBeNull();
    expect(tc.tier).toBe('router');

    const cfgMissing = { main_config: { adapter: 'openai_compat', model_id: 'main' } };
    const tcMissing = resolve_tier_config(cfgMissing, 'router');
    expect(tcMissing.config).toEqual(cfgMissing['main_config']);

    const cfg2 = {
      main_config: { adapter: 'openai_compat', model_id: 'main' },
      router_config: { adapter: 'openai_compat', model_id: 'router' },
      router_fallback_configs: [],
    };
    expect(resolve_tier_config(cfg2, 'router').fallbacks).toEqual([]);
  });
});

describe('默认声明 / 装配注入', () => {
  it('test_factory_default_double_tier：出厂双挡', () => {
    expect(TIER_NAMES).toEqual(['main', 'router']);
    expect(current_tier_names()).toEqual(['main', 'router']);
  });

  it('test_unknown_falls_back_to_main：未知回落 main', () => {
    expect(tier_key('bogus')).toBe('main');
    expect(tier_key(null)).toBe('main');
  });

  it('test_audit_tier_declared_and_used：注入 audit 后生效', () => {
    set_tier_names(AUDIT_NAMES);
    expect(current_tier_names()).toEqual(AUDIT_NAMES);
    expect(tier_key('audit')).toBe('audit');
    expect(tier_key('bogus')).toBe('main');
  });

  it('test_resolve_tier_config_follows_declaration：解析随声明生效', () => {
    set_tier_names(AUDIT_NAMES);
    const cfg = {
      main_config: { model_id: 'main' },
      router_config: { model_id: 'router' },
      audit_config: { model_id: 'audit' },
      audit_fallback_configs: [{ model_id: 'fb' }],
    };
    const resolved = resolve_tier_config(cfg, 'audit');
    expect(resolved.tier).toBe('audit');
    expect(resolved.config).toEqual({ model_id: 'audit' });
    expect(resolved.fallbacks).toEqual([{ model_id: 'fb' }]);
  });

  it('test_build_tier_chain_follows_declaration：建链随声明生效', () => {
    set_tier_names(AUDIT_NAMES);
    const chain = build_tier_chain(
      {
        audit_config: {
          adapter: 'openai_compat',
          model_id: 'audit',
          base_url: 'http://audit',
        },
      },
      'audit',
      { create: () => ({}) },
    );
    expect(chain).not.toBeNull();
    expect(chain!.configs[0]!['model_id']).toBe('audit');
  });

  it('test_tier_call_stats_follows_declaration：统计随声明生效', () => {
    set_tier_names(AUDIT_NAMES);
    const stats = new TierCallStats();
    stats.record('audit');
    stats.record('bogus');
    expect(stats.snapshot()).toEqual({ audit: 1, main: 1 });
  });

  it('test_declaration_is_authoritative_replace：声明即权威整组替换', () => {
    set_tier_names(AUDIT_NAMES);
    set_tier_names(TIER_NAMES);
    expect(current_tier_names()).toEqual(['main', 'router']);
    expect(tier_key('audit')).toBe('main');
  });
});

describe('声明校验显式拒绝', () => {
  it('test_empty_rejected：空声明拒绝', () => {
    expect(() => set_tier_names([])).toThrow(/不能为空/);
    expect(() => set_tier_names([])).toThrow(/不能为空/);
  });

  it('test_duplicates_rejected：重复项拒绝', () => {
    expect(() => set_tier_names(['main', 'router', 'main'])).toThrow(/重复/);
  });

  it('test_missing_main_rejected：缺 main 拒绝', () => {
    expect(() => set_tier_names(['router', 'audit'])).toThrow(/回落锚点/);
  });

  it('test_empty_string_rejected：空字符串拒绝', () => {
    expect(() => set_tier_names(['main', ''])).toThrow(/不能为空字符串/);
  });

  it('test_invalid_declaration_keeps_previous_active：非法声明不改当前', () => {
    set_tier_names(AUDIT_NAMES);
    expect(() => set_tier_names([])).toThrow();
    expect(current_tier_names()).toEqual(AUDIT_NAMES);
  });
});
