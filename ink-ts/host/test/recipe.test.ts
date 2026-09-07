/**
 * 产品配方默认表单测（机制开关默认全开 true；关闭只走显式产品配置）。
 */

import { describe, expect, it } from 'vitest';

import {
  PRODUCT_SWITCH_DEFAULTS,
  assert_product_switches_all_on,
  build_product_recipe,
} from '../src/recipe.js';

describe('产品配方默认表（机制开关全开）', () => {
  it('默认表所有开关全 true（AssemblyRecipe 八位 + canary + 多域窗口 + 时间线 + 多径）', () => {
    assert_product_switches_all_on();
    const entries = Object.entries(PRODUCT_SWITCH_DEFAULTS);
    expect(entries.length).toBe(10);
    for (const [, value] of entries) {
      expect(value).toBe(true);
    }
    expect(PRODUCT_SWITCH_DEFAULTS.contract_enabled).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.multipath_enabled).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.canary_verification).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.context_window_multidomain).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.emit_timeline_events).toBe(true);
  });

  it('build_product_recipe：boot 种子直接引用 engine；不产任何图配方（graph_recipe 缺省 null）', () => {
    const recipe = build_product_recipe();
    expect(recipe.set_id).toBe('default');
    expect(recipe.seeds.length).toBe(1);
    expect(recipe.seeds[0]![0]).toBe('boot');
    expect(recipe.harness_definitions.length).toBeGreaterThan(0);
    expect(recipe.event_type_specs.length).toBeGreaterThan(0);
    expect(recipe.tool_wiring).not.toBeNull();
    // 图 = 数据（池种子/组装产物）：配方不再产默认图/静态图
    expect(recipe.graph_recipe).toBeNull();
    // 十位开关逐位落入 AssemblyRecipe 机制开关字段 / run_options（引擎消费面）
    const flags = recipe as unknown as Record<string, boolean>;
    for (const name of [
      'contract_enabled',
      'edge_evidence_enabled',
      'settle_hooks_enabled',
      'pool_governance_enabled',
      'assembler_enabled',
      'fingerprint_cache_enabled',
      'canary_verification',
      'context_window_multidomain',
      'emit_timeline_events',
    ]) {
      expect(flags[name]).toBe(true);
    }
    const runOptions = recipe.run_options as { multipath_enabled: boolean } | null;
    expect(runOptions).not.toBeNull();
    expect(runOptions!.multipath_enabled).toBe(true);
  });

  it('显式产品配置可关闭开关（false → 机制开关字段 / run_options 关）', () => {
    const recipe = build_product_recipe({
      switches: {
        multipath_enabled: false,
        emit_timeline_events: false,
        contract_enabled: false,
        canary_verification: false,
        edge_evidence_enabled: false,
      },
    });
    expect(recipe.contract_enabled).toBe(false);
    expect(recipe.canary_verification).toBe(false);
    expect(recipe.edge_evidence_enabled).toBe(false);
    expect(recipe.emit_timeline_events).toBe(false);
    const runOptions = recipe.run_options as {
      multipath_enabled: boolean;
      emit_timeline_events: boolean;
    } | null;
    expect(runOptions!.multipath_enabled).toBe(false);
    expect(runOptions!.emit_timeline_events).toBe(false);
  });

  it('显式关闭不动其它位（逐位覆写语义）', () => {
    const recipe = build_product_recipe({ switches: { assembler_enabled: false } });
    expect(recipe.assembler_enabled).toBe(false);
    expect(recipe.settle_hooks_enabled).toBe(true);
    expect(recipe.pool_governance_enabled).toBe(true);
  });
});
