/**
 * 产品配方默认表单测（D14：机制开关默认全开 true；关闭只走显式产品配置）。
 */

import { describe, expect, it } from 'vitest';

import {
  PRODUCT_SWITCH_DEFAULTS,
  assert_product_switches_all_on,
  build_product_recipe,
} from '../src/recipe.js';
import { echoGraphRecipe } from './_graphs.js';

describe('产品配方默认表（D14 全开）', () => {
  it('默认表所有开关全 true（PathAssemblyFlags 七位 + canary + 多域窗口 + 时间线）', () => {
    assert_product_switches_all_on();
    const entries = Object.entries(PRODUCT_SWITCH_DEFAULTS);
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const [, value] of entries) {
      expect(value).toBe(true);
    }
    expect(PRODUCT_SWITCH_DEFAULTS.contract_enabled).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.multipath_enabled).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.canary_verification).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.context_window_multidomain).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.emit_timeline_events).toBe(true);
  });

  it('build_product_recipe：boot 种子直接引用 engine，graph_recipe 注入位缺省 null', () => {
    const recipe = build_product_recipe();
    expect(recipe.set_id).toBe('default');
    expect(recipe.seeds.length).toBe(1);
    expect(recipe.seeds[0]![0]).toBe('boot');
    expect(recipe.harness_definitions.length).toBeGreaterThan(0);
    expect(recipe.event_type_specs.length).toBeGreaterThan(0);
    expect(recipe.tool_wiring).not.toBeNull();
    expect(recipe.graph_recipe).toBeNull();
    // 执行域选项经引擎 run_options 通道消费（多径 + 时间线默认开）
    const runOptions = recipe.run_options as { multipath_enabled: boolean } | null;
    expect(runOptions).not.toBeNull();
    expect(runOptions!.multipath_enabled).toBe(true);
  });

  it('显式产品配置可关闭开关（false → run_options 关）', () => {
    const recipe = build_product_recipe({
      switches: { multipath_enabled: false, emit_timeline_events: false },
    });
    const runOptions = recipe.run_options as {
      multipath_enabled: boolean;
      emit_timeline_events: boolean;
    } | null;
    expect(runOptions!.multipath_enabled).toBe(false);
    expect(runOptions!.emit_timeline_events).toBe(false);
  });

  it('注入 graph_recipe 后 recipe.graph_recipe 生效', () => {
    const recipe = build_product_recipe({ graph_recipe: echoGraphRecipe });
    expect(recipe.graph_recipe).toBeTypeOf('function');
  });
});
