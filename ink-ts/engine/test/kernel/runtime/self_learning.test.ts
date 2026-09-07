/**
 * 自学习族运行时接线集成测试（EC2 全量接线上班）：
 * - metrics 注入 + 普通回合收尾自动调参（非仅 resume_run）；
 * - 回合记忆抽取（意图/结论 + resume 决议确认类事件入账本）；
 * - 技能结晶 settle 链（指纹缓存达标 → 知识集 path 技能）；
 * - evolution 离线调度入口（失败率候选 → 变异 → 闸门防退化落库）。
 *
 * 回合引擎形态（B3）：无常驻静态引擎——测试经数据图 + _build_graph_engine
 * 构造本轮引擎（与组装路径同源装配：metrics/settle/观察传输）驱动机制链路。
 *
 * 复现 runtime.test 的 boot 夹具（最小配方 + 假存储/宿主）。
 */

import { describe, expect, it } from 'vitest';

import { DefaultInterruptPolicy } from '../../../src/kernel/approval/approval.js';
import type { Host } from '../../../src/kernel/runtime/index.js';
import { AssemblyRecipe, Runtime } from '../../../src/kernel/runtime/index.js';
import { ROUND_LEDGER_COLLECTION } from '../../../src/kernel/runtime/_settle.js';
import {
  KIND_PATH,
  KnowledgeEntry,
} from '../../../src/core/knowledge_set/index.js';
import { GENERAL_WEIGHTS_SEED_ID } from '../../../src/core/seeds/seeds.js';
import { TunableParams } from '../../../src/kernel/tuning/index.js';
import { DEFAULT_NAMESPACE } from '../../../src/kernel/memory_extract/index.js';
import { MemoryStorage } from '../executor/helpers.js';
import type { EvolutionGate } from '../../../src/kernel/evolution/index.js';
import type { NodeFactory } from '../../../src/core/registry/registry_types.js';
import {
  dataGraph,
  registerNodeType,
  runRoundEngine,
} from './_round_graphs.js';

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

// ── 数据图测试节点（无常驻静态引擎：数据图按类型名装载执行）──────────────
const T_ECHO = 'sl.echo';
const T_FAIL = 'sl.fail';
const T_GATE = 'sl.gate';

function echo_factory(): NodeFactory {
  return () => async (): Promise<Record<string, unknown>> => ({ reply: 'ok' });
}

function fail_factory(): NodeFactory {
  return () => async (): Promise<never> => {
    throw new Error('节点失败');
  };
}

function gate_factory(): NodeFactory {
  return () => async (raw: unknown): Promise<Record<string, unknown>> => {
    const anyCtx = raw as { interrupt(key: string, payload: unknown): Promise<unknown> };
    const decision = await anyCtx.interrupt('approval', { review_type: 'gate' });
    return { decision, done: true };
  };
}

function install_data_nodes(runtime: Runtime): void {
  registerNodeType(runtime, T_ECHO, echo_factory());
  registerNodeType(runtime, T_FAIL, fail_factory());
  registerNodeType(runtime, T_GATE, gate_factory());
}

function echoGraphData(): Record<string, unknown> {
  return dataGraph({ name: 'echo', entry: 'agent', nodes: [{ id: 'agent', type: T_ECHO }], exits: ['agent'] });
}

function failingGraphData(): Record<string, unknown> {
  return dataGraph({ name: 'fail', entry: 'fail', nodes: [{ id: 'fail', type: T_FAIL }], exits: ['fail'] });
}

function gateGraphData(): Record<string, unknown> {
  return dataGraph({ name: 'gate', entry: 'gate', nodes: [{ id: 'gate', type: T_GATE }], exits: ['gate'] });
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
  });
  return Object.assign(base, overrides);
}

/** 读取存储某集合全量记录。 */
async function recordsOf(runtime: Runtime, collection: string): Promise<Record<string, unknown>[]> {
  if (runtime.storage === null) return [];
  return runtime.storage.list_records(collection);
}

describe('runtime 自学习族接线', () => {
  it('回合指标注入：本轮引擎 options.metrics = runtime.turn_metrics', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), minimalRecipe());
    install_data_nodes(runtime);
    expect(runtime.turn_metrics).not.toBeNull();
    await runRoundEngine(runtime, echoGraphData(), { input: '回合A' }, { thread_id: 't-m', round_id: 'r1' });
    expect(runtime.turn_metrics!.turns).toBe(1);
    expect(runtime.turn_metrics!.failure_rate).toBe(0);
    await runtime.stop();
  });

  it('普通回合收尾自动调参：失败回合指标聚合 → 参数回写知识集', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), minimalRecipe());
    install_data_nodes(runtime);
    await runRoundEngine(runtime, failingGraphData(), { input: '失败回合' }, { thread_id: 't-f', round_id: 'r1' });
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
    install_data_nodes(runtime);
    expect(runtime.memory_store).not.toBeNull();
    const graphData = echoGraphData();
    await runRoundEngine(runtime, graphData, { input: '意图甲' }, { thread_id: 't-mem', round_id: 'r1' });
    await runRoundEngine(
      runtime,
      graphData,
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
    const runtime = await new Runtime().boot(toHost(new FakeHost()), minimalRecipe());
    install_data_nodes(runtime);
    const graphData = gateGraphData();
    const first = await runRoundEngine(
      runtime,
      graphData,
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
    install_data_nodes(runtime);
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
    const graphData = echoGraphData();
    await runRoundEngine(runtime, graphData, { input: 'x' }, { thread_id: 't-c', round_id: 'r1' });
    const skills = runtime
      .knowledge_set!.entries()
      .filter((e) => e.kind === KIND_PATH && e.id.startsWith('skill:'));
    expect(skills.length).toBe(1);
    expect(skills[0]!.title.length).toBeGreaterThan(0);
    // 计数未变再次结晶 = 去重跳过（版本不递增）
    await runRoundEngine(
      runtime,
      graphData,
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
