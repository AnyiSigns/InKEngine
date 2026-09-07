// gate: 超限(381 行) - A4 自学习回灌闭环 round 级多断言单测（技能/记忆/调参/续聊双态单文件成组，便于对照 pytest 参数化）
/**
 * A4 自学习回灌闭环 round 级测试（决策5）：
 * - 技能先验接入组装：知识集 kind=path 技能成为组装候选源（source=skill）；
 * - 记忆自动回灌：user:default recall 注入回合上下文源（开关/上限/截断）；
 * - 调参权重真实消费点：divergence_width → 候选数 top_k、retry_budget →
 *   本轮引擎 max_node_retries；失败回合调参写回后下一轮旋钮可观测（round_tuning
 *   审计记录）；
 * - 多轮续聊消息链：普通新回合把当轮 user input 追加进既有消息链；分支/重入
 *   （resume_from 非空）不追加。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { Runtime, AssemblyRecipe } from '../../../src/core/runtime/index.js';
import type { Host } from '../../../src/core/runtime/index.js';
import type { RunResult } from '../../../src/core/run_result/run_result.js';
import { set_default_assembly_runtime } from '../../../src/core/path_assembler/index.js';
import { CollectorTransport } from '../../../src/core/events/events.js';
import { DefaultInterruptPolicy } from '../../../src/core/approval/approval.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { EventTypeSpec } from '../../../src/core/event_types/eventTypeSpec.js';
import {
  KnowledgeEntry,
  KIND_RULE,
} from '../../../src/core/knowledge_set/index.js';
import { skill_to_knowledge_entry, SkillEntry } from '../../../src/core/skill_crystal/index.js';
import { GENERAL_WEIGHTS_SEED_ID } from '../../../src/core/seeds/seeds.js';
import { TunableParams } from '../../../src/core/tuning/index.js';
import { MemoryEntry } from '../../../src/core/memory/index.js';
import { DEFAULT_NAMESPACE } from '../../../src/core/memory_extract/index.js';
import {
  ENGINE_STUB_REPLY,
  TYPE_LLM_DECIDER,
  TYPE_TOOL_PIPELINE,
} from '../../../src/core/nodes/index.js';
import type { AsyncLLM, LLMChunk } from '../../../src/core/llm/_guard_types.js';
import type { Message } from '../../../src/core/llm/messages.js';
import { self_tool_specs, make_self_executor, operation_of } from '../../../src/core/self_tools/index.js';
import type { SelfToolContext } from '../../../src/core/self_tools/index.js';
import { MemoryStorage } from '../executor/helpers.js';

/** boot 领域种子（最小：知识集基线条目）。 */
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

/** 共享存储宿主（同一 MemoryStorage 多次 boot：重启恢复回灌一致性断言）。 */
class SharedStorageHost extends FakeHost {
  readonly storage: MemoryStorage = new MemoryStorage();
  override async create_storage(): Promise<MemoryStorage> {
    return this.storage;
  }
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
    graph_recipe: null,
    emit_timeline_events: true,
  });
  return Object.assign(base, overrides);
}

/** 聊天数据图（llm_decider → terminal；技能 path 与池种子同构形态）。 */
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

/** 回合组装事件（assemble_candidate 源清单读取）。 */
function candidateSources(events: CollectorTransport): string[] {
  return events.events
    .filter((e) => e.type === 'assembly_candidate')
    .map((e) => String((e.payload as Record<string, unknown>)['source'] ?? ''));
}

/** 消息数应答 stub 模型（token = 当前 user 消息计数；多轮续聊可断言）。 */
class UserCountingLLM implements AsyncLLM {
  readonly adapter = 'stub';
  readonly config = { adapter: 'stub', model_id: 'stub', base_url: '' };

  async ainvoke(): Promise<never> {
    throw new Error('stub 仅流式（astream）');
  }

  async *astream(messages: readonly Message[]): AsyncIterable<LLMChunk> {
    const users = messages.filter((message) => message.role === 'user').length;
    yield { token: `#${users}`, tool_calls_delta: null };
  }

  async aclose(): Promise<void> {}
}

/** 取存储 set_audit 的 round_tuning 记录。 */
async function tuningAudits(runtime: Runtime): Promise<Record<string, unknown>[]> {
  if (runtime.storage === null) return [];
  const records = await runtime.storage.list_records('set_audit');
  return records.filter((record) => record['type'] === 'round_tuning');
}

describe('A4 自学习回灌闭环（round 级）', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('技能先验接入组装：kind=path 技能成为组装候选源并可执行', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), roundRecipe());
    runtime.knowledge_set!.add(
      skill_to_knowledge_entry(
        new SkillEntry({
          name: 'path.general.round',
          version: 1,
          domain: 'general',
          kind: 'path',
          fingerprint: 'fp-skill-round',
          path: chat_graph_data(),
          contract_snapshot: [],
          evidence_snapshot: [],
          model_id: 'm1',
          hit_count: 5,
          fail_count: 0,
          source_path: 'fp-skill-round',
          created_at: 1,
          updated_at: 1,
        }),
        { now: 1 },
      ),
    );
    const events = new CollectorTransport();
    const result = (await runtime.assemble_round({
      state: { input: '用技能' },
      thread_id: 't-skill',
      round_id: 'r1',
      transports: [events],
    })) as RunResult;
    expect(result.reason).toBe('reply');
    expect(result.state['reply']).toBe(ENGINE_STUB_REPLY);
    expect(candidateSources(events)).toContain('skill');
    await runtime.stop();
  });

  it('记忆自动回灌：user:default 条目入回合上下文源（默认开 + cap/截断）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), roundRecipe());
    expect(runtime.memory_store).not.toBeNull();
    for (let i = 0; i < 8; i += 1) {
      await runtime.memory_store!.save(
        new MemoryEntry({
          namespace: DEFAULT_NAMESPACE,
          kind: 'intent',
          content: `用户记忆要点 ${i}`,
          source: 'round_ledger',
          priority: 6,
        }),
      );
    }
    const provider = runtime._assembly_sources();
    const sources = (await provider({ state: { input: '请记得我' } })) as Array<{
      meta?: Record<string, unknown>;
    }>;
    const memory = sources.filter((source) => source.meta?.['source'] === 'memory');
    expect(memory.length).toBeGreaterThan(0);
    expect(memory.length).toBeLessThanOrEqual(5);
    // 超长条目单条截断生效
    await runtime.memory_store!.save(
      new MemoryEntry({
        namespace: DEFAULT_NAMESPACE,
        kind: 'intent',
        content: 'x'.repeat(1200),
        source: 'round_ledger',
        priority: 7,
      }),
    );
    const capped = (await provider({ state: { input: '长记忆' } })) as Array<{
      content: string;
    }>;
    const longContent = capped.find((s) => String(s.content).length > 400);
    expect(longContent).toBeUndefined();
    await runtime.stop();
  });

  it('记忆回灌开关：memory_recall_enabled=false 不注入记忆', async () => {
    const recipe = roundRecipe();
    recipe.memory_recall_enabled = false;
    const runtime = await new Runtime().boot(toHost(new FakeHost()), recipe);
    await runtime.memory_store!.save(
      new MemoryEntry({
        namespace: DEFAULT_NAMESPACE,
        kind: 'intent',
        content: '关闭档记忆',
        source: 'round_ledger',
        priority: 6,
      }),
    );
    const provider = runtime._assembly_sources();
    const sources = (await provider({ state: { input: '查询' } })) as Array<{
      meta?: Record<string, unknown>;
    }>;
    const memory = sources.filter((source) => source.meta?.['source'] === 'memory');
    expect(memory.length).toBe(0);
    await runtime.stop();
  });

  it('记忆回灌一致：跨线程共享 + 两次 boot 同一 storage 结果一致', async () => {
    const host = new SharedStorageHost();
    const first = await new Runtime().boot(toHost(host), roundRecipe());
    await first.memory_store!.save(
      new MemoryEntry({
        namespace: DEFAULT_NAMESPACE,
        kind: 'intent',
        content: '跨线程共享记忆',
        source: 'round_ledger',
        priority: 6,
      }),
    );
    const providerA = first._assembly_sources();
    const threadA = (await providerA({ state: { input: '线程甲' } })) as Array<{
      meta?: Record<string, unknown>;
      content: string;
    }>;
    const threadB = (await providerA({ state: { input: '线程乙' } })) as Array<{
      meta?: Record<string, unknown>;
      content: string;
    }>;
    expect(
      threadA.filter((source) => source.meta?.['source'] === 'memory').map((s) => s.content),
    ).toEqual(
      threadB.filter((source) => source.meta?.['source'] === 'memory').map((s) => s.content),
    );
    await first.stop();
    // 重启（第二次 boot 同一 storage）：记忆条目回灌一致（store 持久化在 storage）
    const second = await new Runtime().boot(toHost(host), roundRecipe());
    const providerB = second._assembly_sources();
    const reboot = (await providerB({ state: { input: '重启后' } })) as Array<{
      meta?: Record<string, unknown>;
      content: string;
    }>;
    const memoryB = reboot.filter((source) => source.meta?.['source'] === 'memory');
    expect(memoryB.some((s) => s.content === '跨线程共享记忆')).toBe(true);
    await second.stop();
  });

  it('调参权重真实消费：失败 metrics → 回写 → 下一轮旋钮生效（round_tuning 留痕）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), roundRecipe());
    // 注入一轮失败 metrics → 收尾调参回写（retry_budget 1→2, web 阈值下调）
    runtime.tune_after_round({ failed: true, error: '模拟失败回合' });
    const entry = runtime.knowledge_set!.get(GENERAL_WEIGHTS_SEED_ID);
    expect(entry).not.toBeNull();
    const params = TunableParams.from_dict(entry!.data as never);
    expect(params.retry_budget).toBeGreaterThanOrEqual(2);
    // 模拟人工/后续调参收敛 divergence_width（候选数维度）
    runtime.knowledge_set!.update(GENERAL_WEIGHTS_SEED_ID, {
      data: { ...params.to_dict(), divergence_width: 6 },
    });
    await runtime.assemble_round({
      state: { input: '下一轮' },
      thread_id: 't-tune',
      round_id: 'r2',
    });
    const audits = await tuningAudits(runtime);
    const last = audits[audits.length - 1];
    expect(last).toBeTruthy();
    expect(Number(last!['top_k'])).toBe(6); // divergence_width → 候选数
    expect(Number(last!['retry_budget'])).toBeGreaterThanOrEqual(2);
    expect(Number(last!['max_node_retries'])).toBe(Number(last!['retry_budget']) - 1);
    // 未失败回合（缺省预算）旋钮 = 0 重试（引擎缺省常量）
    await runtime.stop();
  });

  it('多轮续聊：普通新回合 user input 追加进消息链（首轮/多轮双态）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), roundRecipe());
    const llm = new UserCountingLLM();
    const first = (await runtime.assemble_round({
      state: { input: 'a' },
      thread_id: 't-chat',
      round_id: 'r1',
      llm,
    })) as RunResult;
    expect(first.state['reply']).toBe('#1');
    const second = (await runtime.assemble_round({
      state: { input: 'b' },
      thread_id: 't-chat',
      round_id: 'r2',
      llm,
    })) as RunResult;
    expect(second.state['reply']).toBe('#2');
    const messages = (second.state['messages'] ?? []) as Array<{
      role: string;
      content: string;
    }>;
    expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      'user:a',
      'assistant:#1',
      'user:b',
      'assistant:#2',
    ]);
    await runtime.stop();
  });

  it('分支/重入（resume_from 非空）：不追加 user input（消息链随 checkpoint）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), roundRecipe());
    const llm = new UserCountingLLM();
    await runtime.assemble_round({
      state: { input: 'a' },
      thread_id: 't-resume',
      round_id: 'r1',
      llm,
    });
    const chain = await runtime.storage!.chain_index('t-resume');
    const leaf = Math.max(...chain.map((link) => link.checkpoint_id));
    const branched = (await runtime.resume_round({
      thread_id: 't-resume',
      leaf,
      state: { input: '分支输入' },
      round_id: 'r-b',
      llm,
    })) as RunResult;
    const messages = (branched.state['messages'] ?? []) as Array<{ role: string }>;
    const userTexts = messages
      .filter((message) => message.role === 'user')
      .map(() => 'user');
    expect(userTexts.length).toBe(1); // 仅首轮 user：分支输入未追加
    expect(messages.filter((message) => message.role === 'assistant').length).toBe(1);
    await runtime.stop();
  });
});
