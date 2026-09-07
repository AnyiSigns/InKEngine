/**
 * 产品配方默认表单测（机制开关默认全开 true；关闭只走显式产品配置）。
 */

import { describe, expect, it } from 'vitest';
import { ToolGateConfig } from '@ink-ts/engine';

import {
  PRODUCT_SWITCH_DEFAULTS,
  assert_product_switches_all_on,
  build_product_recipe,
  merge_capability_tier_gate,
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

  it('build_product_recipe：boot 种子直接引用 engine；不产任何图', () => {
    const recipe = build_product_recipe();
    expect(recipe.set_id).toBe('default');
    expect(recipe.seeds.length).toBe(1);
    expect(recipe.seeds[0]![0]).toBe('boot');
    expect(recipe.harness_definitions.length).toBeGreaterThan(0);
    expect(recipe.event_type_specs.length).toBeGreaterThan(0);
    expect(recipe.tool_wiring).not.toBeNull();
    // 图 = 数据（池种子/组装产物）：配方不存在任何静态图装配位（通道已删）
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

  it('tool_gate 缺省 null（引擎默认 DENY 兜底）；显式装配透传入配方', () => {
    expect(build_product_recipe().tool_gate).toBeNull();
    const gate = new ToolGateConfig({ review_tools: ['shell_exec'] });
    const recipe = build_product_recipe({ tool_gate: gate });
    expect(recipe.tool_gate).toBe(gate);
    expect([...recipe.tool_gate!.review_tools]).toEqual(['shell_exec']);
  });

  it('能力档位并入门禁：review 档工具并入 review_tools（allow 档无门禁动作）', () => {
    const base = new ToolGateConfig({ review_tools: ['write_file'] });
    const merged = merge_capability_tier_gate(base, {
      write_file: 'allow',
      shell_exec: 'review',
      demo: 'allow',
    });
    expect(merged).not.toBeNull();
    expect([...merged!.review_tools].sort()).toEqual(['shell_exec', 'write_file']);
    // 无 review 档 = 原样返回（不新建）
    expect(merge_capability_tier_gate(base, { write_file: 'allow' })).toBe(base);
    expect([...merge_capability_tier_gate(null, { shell_exec: 'review' })!.review_tools]).toEqual(
      ['shell_exec'],
    );
    expect(merge_capability_tier_gate(null, {})).toBeNull();
    expect(merge_capability_tier_gate(null, null)).toBeNull();
  });
});
