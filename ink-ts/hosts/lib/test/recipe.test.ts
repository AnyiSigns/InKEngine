/**
 * 产品配方默认表单测（机制开关默认全开 true；关闭只走显式产品配置）。
 *
 * 组装链开关（contract/pool_governance/assembler/fingerprint_cache/
 * candidate_trial/anti_monopoly/canary_verification/context_window_multidomain）
 * 与会话级骨架/自续跑（thread_skeleton/
 * auto_continue）已随组装链路退役（W7-B）；本表只收敛保留位
 * （edge_evidence/settle/memory/skill_crystal + 执行域双位）。
 */

import { describe, expect, it } from 'vitest';
import { BOOT_SYSTEM_PROMPT, ToolGateConfig } from '@ink-ts/engine';

import {
  PRODUCT_SWITCH_DEFAULTS,
  assert_product_switches_all_on,
  build_product_recipe,
  merge_capability_tier_gate,
} from '../src/recipe.js';

describe('产品配方默认表（保留机制开关全开）', () => {
  it('默认表所有开关全 true（保留位 + 执行域位）', () => {
    assert_product_switches_all_on();
    const entries = Object.entries(PRODUCT_SWITCH_DEFAULTS);
    expect(entries.length).toBe(7);
    for (const [, value] of entries) {
      expect(value).toBe(true);
    }
    // W7-B 收口：无消费方的组装时代开关位不入表
    expect('canary_verification' in PRODUCT_SWITCH_DEFAULTS).toBe(false);
    expect('context_window_multidomain' in PRODUCT_SWITCH_DEFAULTS).toBe(false);
    expect(PRODUCT_SWITCH_DEFAULTS.edge_evidence_enabled).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.settle_hooks_enabled).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.memory_extract_enabled).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.skill_crystal_enabled).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.multipath_enabled).toBe(true);
    expect(PRODUCT_SWITCH_DEFAULTS.emit_timeline_events).toBe(true);
  });

  it('build_product_recipe：boot 系统提示词注入装配 seam；不产任何图', () => {
    const recipe = build_product_recipe();
    expect(recipe.set_id).toBe('default');
    // P4.2b：boot 走 AssemblyRecipe.boot_system_prompt（llm 结点 system 合成
    // 只读基线）；boot_prompt 知识条目种子不再由产品宿主注入（seeds 空）
    expect(recipe.boot_system_prompt).toBe(BOOT_SYSTEM_PROMPT);
    expect(recipe.seeds.length).toBe(0);
    expect(recipe.harness_definitions.length).toBeGreaterThan(0);
    expect(recipe.event_type_specs.length).toBeGreaterThan(0);
    expect(recipe.tool_wiring).not.toBeNull();
    // 图 = 数据（引擎池种子/执行产物）：配方不存在任何静态图装配位（通道已删）
    // 保留开关位逐位落入 AssemblyRecipe 机制开关字段 / run_options（引擎消费面）
    const flags = recipe as unknown as Record<string, boolean>;
    for (const name of [
      'edge_evidence_enabled',
      'settle_hooks_enabled',
      'memory_extract_enabled',
      'skill_crystal_enabled',
      'memory_recall_enabled',
    ]) {
      expect(flags[name]).toBe(true);
    }
    expect(flags['seed_edges_enabled']).toBe(false);
    const runOptions = recipe.run_options as { multipath_enabled: boolean } | null;
    expect(runOptions).not.toBeNull();
    expect(runOptions!.multipath_enabled).toBe(true);
  });

  it('显式产品配置可关闭开关（false → 机制开关字段 / run_options 关）', () => {
    const recipe = build_product_recipe({
      switches: {
        multipath_enabled: false,
        emit_timeline_events: false,
        edge_evidence_enabled: false,
        memory_extract_enabled: false,
      },
    });
    expect(recipe.edge_evidence_enabled).toBe(false);
    expect(recipe.memory_extract_enabled).toBe(false);
    const runOptions = recipe.run_options as {
      multipath_enabled: boolean;
      emit_timeline_events: boolean;
    } | null;
    expect(runOptions!.multipath_enabled).toBe(false);
    expect(runOptions!.emit_timeline_events).toBe(false);
  });

  it('显式关闭不动其它位（逐位覆写语义）', () => {
    const recipe = build_product_recipe({ switches: { settle_hooks_enabled: false } });
    expect(recipe.settle_hooks_enabled).toBe(false);
    expect(recipe.edge_evidence_enabled).toBe(true);
    expect(recipe.skill_crystal_enabled).toBe(true);
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