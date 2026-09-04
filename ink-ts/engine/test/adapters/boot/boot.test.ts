/**
 * boot 种子单测：提示词条目 / 元工具契约 / 界面与事件与自举 harness
 * （对标 Python test_seeds_boot.py 全量对齐）。
 *
 * 覆盖：boot 种子条目结构合法（装配配方直注用）；BOOT_METATOOLS 契约
 * 基线包含 engine-resident 的 introspection 元工具与 self_tools 契约
 * （换壳不失明：机制层新增观察/演化工具须同步进清单，单测强制）；
 * 初始界面描述 / 事件类型 / 自举 harness 定义形态正确。
 */
import { describe, expect, it } from 'vitest';

import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { introspection_tool_specs } from '../../../src/core/introspection/index.js';
import { SOURCE_MODEL } from '../../../src/core/knowledge_set/index.js';
import { SELF_TOOL_CONTRACT } from '../../../src/core/self_tools/index.js';
import {
  BOOT_EVENT_TYPES,
  BOOT_METATOOLS,
  BOOT_PROMPT_SEED_ID,
  BOOT_SYSTEM_PROMPT,
  BOOT_UI_SPEC,
  boot_harness_definition,
  build_boot_seed_entries,
} from '../../../src/adapters/boot/index.js';

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

describe('boot 种子条目', () => {
  it('提示词知识条目结构合法（id/来源/数据形态，配方直注用）', () => {
    const entries = build_boot_seed_entries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.data['prompt']).toBeTruthy();
    }
    const promptEntry = entries.find((entry) => entry.id === 'seed.boot.system_prompt');
    expect(promptEntry).toBeDefined();
    expect(promptEntry!.id).toBe(BOOT_PROMPT_SEED_ID);
    expect(promptEntry!.data['prompt']).toBe(BOOT_SYSTEM_PROMPT);
    expect(Array.isArray(promptEntry!.tags)).toBe(true);
    expect(promptEntry!.tags).toContain('boot');
    expect(promptEntry!.tags).toContain('system_prompt');
    expect(promptEntry!.level).toBe('project');
    expect(promptEntry!.kind).toBe('boot_prompt');
    expect(promptEntry!.source).toBe(SOURCE_MODEL);
    expect(promptEntry!.credibility).toBe(1.0);
    expect(promptEntry!.title).toBe('Forge 自举系统提示词');
  });
});

describe('boot 元工具契约', () => {
  it('契约基线包含全部 engine-resident 观察元工具（换壳不失明）', () => {
    const introspectionNames = introspection_tool_specs().map((spec) => spec.name);
    expect(introspectionNames.length).toBeGreaterThan(0);
    for (const name of introspectionNames) {
      expect(BOOT_METATOOLS).toContain(name);
    }
    // 演化三工具为 self_application 机制层能力，亦在基线内
    for (const name of ['propose_patch', 'apply_patch', 'revert_patch']) {
      expect(BOOT_METATOOLS).toContain(name);
    }
  });

  it('契约自指工具 ⊆ 元工具清单且 engine-resident（随机制层演化不漂移）', () => {
    for (const name of SELF_TOOL_CONTRACT) {
      expect(BOOT_METATOOLS).toContain(name);
    }
    expect(BOOT_METATOOLS).toContain('propose_domain_manifest');
  });

  it('清单固定 12 项（观察 6 + 演化 4 + 自指发现 2）', () => {
    expect(BOOT_METATOOLS).toHaveLength(12);
  });
});

describe('boot 界面描述', () => {
  it('初始界面为对话面板布局树（含绑定通道）', () => {
    expect(typeof BOOT_UI_SPEC).toBe('object');
    expect(Array.isArray(BOOT_UI_SPEC)).toBe(false);
    expect(BOOT_UI_SPEC['name']).toBe('boot.panel');
    const root = asRecord(BOOT_UI_SPEC['root']);
    expect(root['kind']).toBe('container');
    expect(root['type']).toBe('column');
    const children = root['children'];
    expect(Array.isArray(children)).toBe(true);
    const types = (children as Record<string, unknown>[]).map((child) => child['type']);
    expect(types).toContain('message_list');
    expect(types).toContain('agent_input');
    const theme = asRecord(BOOT_UI_SPEC['theme']);
    expect(theme['bg']).toBe('#09090b');
  });
});

describe('boot 事件类型登记', () => {
  it('内置建卡型事件齐全且同名渲染组件映射正确', () => {
    const names = new Set(BOOT_EVENT_TYPES.map((spec) => spec.name));
    for (const name of ['reply_token', 'review_card', 'error']) {
      expect(names.has(name)).toBe(true);
    }
    const byName = new Map(BOOT_EVENT_TYPES.map((spec) => [spec.name, spec]));
    expect(byName.get('reply_token')!.renderer).toBe('StreamingRow');
    expect(byName.get('review_card')!.renderer).toBe('ReviewCard');
    expect(byName.get('error')!.renderer).toBe('ErrorRow');
    // 逐项 meta 源登记（source=boot）与来源描述齐备
    expect(BOOT_EVENT_TYPES).toHaveLength(8);
    for (const spec of BOOT_EVENT_TYPES) {
      expect(spec.meta['source']).toBe('boot');
      expect(typeof spec.meta['description']).toBe('string');
      expect((spec.meta['description'] as string).length).toBeGreaterThan(0);
    }
  });
});

describe('boot 自举 harness 定义', () => {
  it('forge 自举领域：观察/演化元能力集', () => {
    const definition = boot_harness_definition();
    expect(definition).toBeInstanceOf(HarnessDefinition);
    expect(definition.name).toBe('forge');
    expect(definition.description).toBe('自举领域：观察/提案/应用的元能力集');
    expect(definition.keywords).toContain('自举');
    expect(definition.keywords).toContain('观察');
    expect(definition.meta).toEqual({ set_id: 'default', role: 'self' });
  });
});
