/**
 * 自学习族运行时接线集成测试（EC2 全量接线上班）：
 * - metrics 注入 + 普通回合收尾自动调参（非仅 resume_run）；
 * - 回合记忆抽取（意图/结论 + resume 决议确认类事件入账本）；
 * - 技能结晶 settle 链（指纹缓存达标 → 知识集 path 技能）；
 * - evolution 离线调度入口（失败率候选 → 变异 → 闸门防退化落库）。
 *
 * 复现 runtime.test 的 boot 夹具（最小配方 + 假存储/宿主）。
 */

import { describe, expect, it } from 'vitest';

import { Graph } from '../../../src/core/graph/graph.js';
import { DefaultInterruptPolicy } from '../../../src/core/approval/approval.js';
import type { Host, GraphRecipeContext } from '../../../src/core/runtime/index.js';
import { AssemblyRecipe, Runtime } from '../../../src/core/runtime/index.js';
import { ROUND_LEDGER_COLLECTION } from '../../../src/core/runtime/_settle.js';
import {
  KIND_PATH,
  KnowledgeEntry,
} from '../../../src/core/knowledge_set/index.js';
import { GENERAL_WEIGHTS_SEED_ID } from '../../../src/core/seeds/seeds.js';
import { TunableParams } from '../../../src/core/tuning/index.js';
import { DEFAULT_NAMESPACE } from '../../../src/core/memory_extract/index.js';
import { MemoryStorage } from '../executor/helpers.js';
import type { EvolutionGate } from '../../../src/core/evolution/index.js';

/** 假 LLM（引擎重建/stop 关停路径可复用）。 */
class ClosableLLM {
  async ainvoke(): Promise<unknown> {
    return null;
  }
  async aclose(): Promise<void> {
    return;
  }
}

/** Host 五件套 mock（最小可 boot 形态）。 */
class FakeHost {
  llm: ClosableLLM | null = null;
  policy = new DefaultInterruptPolicy();
  storage: MemoryStorage | null = null;
  async create_storage(): Promise<MemoryStorage> {
    this.storage = new MemoryStorage();
    return this.storage;
  }
  async resolve_llm(): Promise<ClosableLLM | null> {
    return this.llm;
  }
  interrupt_policy(): unknown {
    return this.policy;
  }
  build_transport(): { send(): Promise<void> } {
    return { send: async () => undefined };
  }
  async close(): Promise<void> {
    return;
  }
}

function toHost(host: FakeHost): Host {
  return host as unknown as Host;
}

function echoGraph(_ctx: GraphRecipeContext): Graph {
  const agent = async (): Promise<Record<string, unknown>> => ({ reply: 'ok' });
  const g = new Graph({ name: 'echo', entry: 'agent' });
  g.add_node('agent', agent as never);
  g.add_exit('agent');
  return g;
}

function failingGraph(_ctx: GraphRecipeContext): Graph {
  const boom = async (): Promise<never> => {
    throw new Error('节点失败');
  };
  const g = new Graph({ name: 'fail', entry: 'boom' });
  g.add_node('boom', boom as never);
  g.add_exit('boom');
  return g;
}

function gateGraph(_ctx: GraphRecipeContext): Graph {
  const agent = async (ctx: unknown): Promise<Record<string, unknown>> => {
    const anyCtx = ctx as { interrupt(key: string, payload: unknown): Promise<unknown> };
    const decision = await anyCtx.interrupt('approval', { review_type: 'gate' });
    return { decision, done: true };
  };
  const g = new Graph({ name: 'gate', entry: 'gate' });
  g.add_node('gate', agent as never);
  g.add_exit('gate');
  return g;
}

function minimalRecipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'default',
    harness_definitions: [],
    event_type_specs: [],
    ui_spec: null,
    ui_allowed_components: [],
    ui_allowed_theme_tokens: [],
    tool_wiring: {
      self_specs: () => [],
      self_executor_factory: () => (): Promise<unknown> => Promise.resolve(null),
      self_operation_of: () => ['read', '*'] as [string, string],
    },
    approval_levels: {},
    graph_recipe: echoGraph,
  });
  return Object.assign(base, overrides);
}

/** 读取存储某集合全量记录。 */
async function recordsOf(runtime: Runtime, collection: string): Promise<Record<string, unknown>[]> {
  if (runtime.storage === null) return [];
  return runtime.storage.list_records(collection);
}

describe('runtime 自学习族接线', () => {
  it('回合指标注入：engine.options.metrics = runtime.turn_metrics', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), minimalRecipe());
    expect(runtime.engine!.options.metrics).toBe(runtime.turn_metrics);
    expect(runtime.turn_metrics).not.toBeNull();
    await runtime.engine!.ainvoke({ input: '回合A' }, { thread_id: 't-m', round_id: 'r1' });
    expect(runtime.turn_metrics!.turns).toBe(1);
    expect(runtime.turn_metrics!.failure_rate).toBe(0);
    await runtime.stop();
  });

  it('普通回合收尾自动调参：失败回合指标聚合 → 参数回写知识集', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      minimalRecipe({ graph_recipe: failingGraph }),
    );
    await runtime.engine!.ainvoke({ input: '失败回合' }, { thread_id: 't-f', round_id: 'r1' });
    expect(runtime.turn_metrics!.turns).toBe(1);
    expect(runtime.turn_metrics!.failures).toBe(1);
    const entry = runtime.knowledge_set!.get(GENERAL_WEIGHTS_SEED_ID);
    expect(entry).not.toBeNull();
    const params = TunableParams.from_dict(entry!.data as never);
    expect(params.retry_budget).toBeGreaterThanOrEqual(2);
    expect(params.web_verify_threshold).toBeLessThan(0.5);
    await runtime.stop();
  });

  it('回合记忆抽取接线：intent/conclusion 落 memory 域（跨回合积累）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), minimalRecipe());
    expect(runtime.memory_store).not.toBeNull();
    await runtime.engine!.ainvoke({ input: '意图甲' }, { thread_id: 't-mem', round_id: 'r1' });
    await runtime.engine!.ainvoke(
      { input: '意图乙' },
      { thread_id: 't-mem', round_id: 'r2', continue_chain: true },
    );
    const intents = await runtime.memory_store!.query({
      namespace: DEFAULT_NAMESPACE,
      kind: 'intent',
    });
    expect(intents.map((e) => e.content).sort()).toEqual(['意图乙', '意图甲']);
    await runtime.stop();
  });

  it('resume 决议事件入账本：确认类事件驱动确认记忆条目 + 边界清理', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      minimalRecipe({ graph_recipe: gateGraph }),
    );
    const first = await runtime.engine!.ainvoke(
      { input: '待审批' },
      { thread_id: 't-g', round_id: 'r1' },
    );
    expect(first.interrupt).not.toBeNull();
    await runtime.resume_run('t-g', { decision: 'accept' });
    // 账本事实含 accept 决议事件（ledger 事实事件集合修正口径）
    const ledgers = await recordsOf(runtime, ROUND_LEDGER_COLLECTION);
    const allEvents = ledgers.flatMap(
      (r) => (r['events'] as Array<Record<string, unknown>> | undefined) ?? [],
    );
    expect(allEvents.some((ev) => ev['kind'] === 'accept')).toBe(true);
    // 确认类记忆条目已抽取
    const confirmations = await runtime.memory_store!.query({
      namespace: DEFAULT_NAMESPACE,
      kind: 'confirmation',
    });
    expect(confirmations.length).toBeGreaterThan(0);
    expect(runtime._round_review_events['t-g']).toBeUndefined();
    await runtime.stop();
  });

  it('技能结晶 settle 链接线：缓存达标条目结晶为知识集 path 技能', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), minimalRecipe());
    const cache = runtime.fingerprint_cache_store!;
    const fp = 'fp-crystal-1';
    await cache.upsert(fp, {
      path: { decision: { action: 'resolve' } },
      evidence_snapshot: [],
      model_id: 'm1',
      gate_passed: true,
      path_fingerprint: 'path-fp-1',
      domain: 'default',
    });
    for (let i = 0; i < 5; i += 1) await cache.report(fp, { ok: true });
    await runtime.engine!.ainvoke({ input: 'x' }, { thread_id: 't-c', round_id: 'r1' });
    const skills = runtime
      .knowledge_set!.entries()
      .filter((e) => e.kind === KIND_PATH && e.id.startsWith('skill:'));
    expect(skills.length).toBe(1);
    expect(skills[0]!.title.length).toBeGreaterThan(0);
    // 计数未变再次结晶 = 去重跳过（版本不递增）
    await runtime.engine!.ainvoke(
      { input: 'y' },
      { thread_id: 't-c', round_id: 'r2', continue_chain: true },
    );
    expect(runtime.knowledge_set!.entries().filter((e) => e.kind === KIND_PATH).length).toBe(1);
    await runtime.stop();
  });

  it('evolve_offline 调度入口：失败率候选 → 变异 → 闸门保留落库', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), minimalRecipe());
    runtime.knowledge_set!.add(
      new KnowledgeEntry({
        id: 'rule-evo',
        level: 'work',
        kind: 'rule',
        data: { rule: { message: '规则A' } },
        source: 'model',
        credibility: 0.6,
        usage_count: 6,
        fail_count: 4,
        failure_logs: ['日志1', '日志2'],
        title: '进化目标',
        tags: ['evo'],
      }),
    );
    const gate: EvolutionGate = {
      check: async () =>
        [
          { passed: true, errors: [] },
          { passed: true, note: '' },
          { passed: true, reason: 'ok' },
        ] as never,
    };
    const result = await runtime.evolve_offline({ gate, batch: 3 });
    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.kept).toBeGreaterThanOrEqual(1);
    expect(runtime.knowledge_set!.get('rule-evo:v1')).not.toBeNull();
    await runtime.stop();
  });
});
