/**
 * B5 技能先验 general 回落（Wave B 决策5）：请求域精确匹配无命中时回落到
 * general 域 kind=path 条目（独立回落上限防跨域噪声；候选来源标记区分
 * 跨域先验），组装兜底 = 从池选终态候选（单节点图，非整图模板）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { Runtime, AssemblyRecipe } from '../../../src/kernel/runtime/index.js';
import type { Host } from '../../../src/kernel/runtime/index.js';
import { set_default_assembly_runtime } from '../../../src/kernel/path_assembler/index.js';
import { AssemblyRequest } from '../../../src/kernel/path_assembler/index.js';
import { CANDIDATE_SOURCE_SKILL_FALLBACK, CANDIDATE_SOURCE_TERMINAL } from '../../../src/kernel/path_assembler/constants.js';
import { CollectorTransport } from '../../../src/core/events/events.js';
import { DefaultInterruptPolicy } from '../../../src/kernel/approval/approval.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { EventTypeSpec } from '../../../src/core/event_types/eventTypeSpec.js';
import { KnowledgeEntry, KIND_RULE } from '../../../src/core/knowledge_set/index.js';
import { skill_to_knowledge_entry, SkillEntry } from '../../../src/kernel/skill_crystal/index.js';
import { TYPE_LLM_DECIDER, TYPE_TOOL_PIPELINE } from '../../../src/core/nodes/index.js';
import { self_tool_specs, make_self_executor, operation_of } from '../../../src/kernel/self_tools/index.js';
import type { SelfToolContext } from '../../../src/kernel/self_tools/index.js';
import { MemoryStorage } from '../executor/helpers.js';

function boot_seed_entries(): KnowledgeEntry[] {
  return [
    new KnowledgeEntry({
      id: 'seed.boot.system_prompt',
      level: 'work',
      kind: KIND_RULE,
      data: { rule: { message: '系统提示基线' } },
      source: 'model',
      credibility: 0.9,
      title: '系统提示',
      tags: ['boot'],
    }),
  ];
}

class FakeHost {
  policy: unknown = new DefaultInterruptPolicy();
  async create_storage(): Promise<MemoryStorage> {
    return new MemoryStorage();
  }
  async resolve_llm(): Promise<null> {
    return null;
  }
  interrupt_policy(): unknown {
    return this.policy;
  }
  build_transport(): { send(): Promise<void> } {
    return { async send() {} };
  }
  async close(): Promise<void> {}
}

function toHost(host: FakeHost): Host {
  return host as unknown as Host;
}

function roundRecipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'a4-feedback',
    seeds: [['boot', boot_seed_entries]],
    harness_definitions: [
      new HarnessDefinition({ name: 'forge', description: '自举领域', keywords: ['自举'] }),
    ],
    event_type_specs: [new EventTypeSpec({ name: 'reply_token', renderer: 'StreamingRow' })],
    tool_wiring: {
      self_specs: () => self_tool_specs(),
      self_executor_factory: (pipeline, context_getter) =>
        make_self_executor(pipeline, context_getter as unknown as () => SelfToolContext),
      self_operation_of: (spec) => operation_of(spec),
    },
    approval_levels: {},
    emit_timeline_events: true,
  });
  return Object.assign(base, overrides);
}

function chat_graph_data(): Record<string, unknown> {
  return {
    name: 'engine.chat',
    entry: TYPE_LLM_DECIDER,
    nodes: {
      [TYPE_LLM_DECIDER]: { type: TYPE_LLM_DECIDER, config: {} },
      end: { type: TYPE_TOOL_PIPELINE, config: { role: 'terminal' } },
    },
    edges: { [TYPE_LLM_DECIDER]: [{ target: 'end' }] },
    exits: ['end'],
    subgraphs: {},
    schema: null,
  };
}

function make_skill(name: string, domain: string, hit = 5, fail = 0): SkillEntry {
  return new SkillEntry({
    name,
    version: 1,
    domain,
    kind: 'path',
    fingerprint: `fp-${name}`,
    path: chat_graph_data(),
    contract_snapshot: [],
    evidence_snapshot: [],
    model_id: 'm1',
    hit_count: hit,
    fail_count: fail,
    source_path: `fp-${name}`,
    created_at: 1,
    updated_at: 1,
  });
}

function add_skill(runtime: Runtime, skill: SkillEntry): void {
  runtime.knowledge_set!.add(skill_to_knowledge_entry(skill, { now: 1 }));
}

function candidateSources(events: CollectorTransport): string[] {
  return events.events
    .filter((e) => e.type === 'assembly_candidate')
    .map((e) => String((e.payload as Record<string, unknown>)['source'] ?? ''));
}

async function prior_rows(runtime: Runtime, domain: string): Promise<SkillEntry[]> {
  const provider = runtime._skill_prior_provider();
  expect(provider).not.toBeNull();
  return (await provider!(new AssemblyRequest({ domain }))) as SkillEntry[];
}

describe('B5 技能先验 general 回落', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('域 A 有结晶 → 精确命中不回落到 general', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), roundRecipe());
    add_skill(runtime, make_skill('skill.domain-a', 'domain-a', 10));
    add_skill(runtime, make_skill('skill.general.one', 'general'));
    add_skill(runtime, make_skill('skill.general.two', 'general'));
    const rows = await prior_rows(runtime, 'domain-a');
    expect(rows.length).toBe(1);
    expect(rows.map((row) => row.domain)).toEqual(['domain-a']);
    await runtime.stop();
  });

  it('域 A 无结晶、general 有条目 → 回落 general 且回落上限生效', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), roundRecipe());
    add_skill(runtime, make_skill('skill.general.one', 'general'));
    add_skill(runtime, make_skill('skill.general.two', 'general'));
    add_skill(runtime, make_skill('skill.general.three', 'general'));
    const rows = await prior_rows(runtime, 'domain-a');
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.domain === 'general')).toBe(true);
    await runtime.stop();
  });

  it('general 请求 → 不重复回落，精确命中上限生效', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), roundRecipe());
    for (let index = 0; index < 6; index += 1) {
      add_skill(runtime, make_skill(`skill.general.${index}`, 'general', 5, index));
    }
    const rows = await prior_rows(runtime, 'general');
    expect(rows.length).toBe(4);
    expect(rows.every((row) => row.domain === 'general')).toBe(true);
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
    await runtime.stop();
  });

  it('技能候选先于终态兜底：回落候选带 skill_fallback 来源且兜底不前置', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), roundRecipe());
    add_skill(runtime, make_skill('skill.general.round', 'general'));
    const events = new CollectorTransport();
    const result = (await runtime.assemble_round({
      state: { input: '回落执行' },
      thread_id: 't-fallback',
      round_id: 'r1',
      domain: 'domain-a',
      transports: [events],
    })) as { reason: string };
    expect(result.reason).toBe('reply');
    const sources = candidateSources(events);
    expect(sources).toContain(CANDIDATE_SOURCE_SKILL_FALLBACK);
    expect(sources).not.toContain(CANDIDATE_SOURCE_TERMINAL);
    await runtime.stop();
  });

  it('技能全空时终态候选兜底不受影响：回合仍组装成功', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), roundRecipe());
    const result = (await runtime.assemble_round({
      state: { input: '无技能回落' },
      thread_id: 't-empty',
      round_id: 'r1',
      domain: 'domain-a',
    })) as { reason: string };
    expect(result.reason).toBe('reply');
    await runtime.stop();
  });
});
