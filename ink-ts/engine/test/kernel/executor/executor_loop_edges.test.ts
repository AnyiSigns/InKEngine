/**
 * P4.2a-2 loop 回边执行语义（显式 kind=loop 边）：
 *
 * 执行推进现状核对结论：executor 沿边推进只按「条件存在性」判定（_internals
 * _select_next_node：无 condition 的边 = 静态直取；条件边 = 按声明序首个为真
 * 生效），边 kind（standard/conditional/loop）是数据层标注，不参与走向决策；
 * loop 回边（目标为祖先/自身）因此天然复用同一推进机制——重复执行上游节点，
 * 由既有节点访问护栏（RunOptions.max_cycle，缺省 64，逐节点计数）防失控死循环。
 *
 * 本批测试固化该语义：
 * - 声明式数据图（含 kind:'loop' 回边）装载后 kind 保留、沿回边重复执行上游至
 *   退出条件 → 走退出边收口（reply），护栏不误伤预算内的合法回环；
 * - 回边到祖先的失控回路（无退出条件）由 max_cycle 按节点访问上限截止（reason
 *   =error，不无限循环）；
 * - 单节点自环 kind=loop（条件驱动）同样受既有护栏约束、退出条件满足即走退出边。
 */
import { describe, expect, it } from 'vitest';
import { Graph } from '../../../src/model/graph/graph.js';
import { GraphRegistries } from '../../../src/core/registry/registry.js';
import { Engine } from '../../../src/kernel/executor/index.js';
import { RunOptions } from '../../../src/core/run_result/run_result.js';
import { TerminateReason } from '../../../src/model/graph/graph_types.js';
import type { EdgeCondition, NodeFactory } from '../../../src/core/registry/registry_types.js';
import { MemoryStorage } from './helpers.js';

// ── 测试用节点类型工厂（数据图按类型名引用；配置 field/value 区分实例）──

/** 计数节点：把 state[field]+1 写回（记录该节点的真实执行次数）。 */
const counterFactory: NodeFactory = (config) => {
  const field = String(config['field'] ?? 'count');
  return async (ctx: any): Promise<Record<string, unknown>> => ({
    [field]: ((ctx.state?.[field] ?? 0) as number) + 1,
  });
};

/** 写值节点：把固定值写入 state[field]（出口/终态产物）。 */
const writerFactory: NodeFactory = (config) => {
  const field = String(config['field'] ?? 'reply');
  const value = config['value'];
  return async (): Promise<Record<string, unknown>> => ({ [field]: value });
};

/** 空操作节点（仅占位/走过，不产出增量）。 */
const noopFactory: NodeFactory = () => async (): Promise<Record<string, unknown>> => ({});

/** 装配含测试节点的注册表（fresh：每个用例独立，条件名互不串扰）。 */
function testRegistries(conditions: Record<string, EdgeCondition>): GraphRegistries {
  const reg = new GraphRegistries();
  reg.nodes.register('test.counter', counterFactory);
  reg.nodes.register('test.writer', writerFactory);
  reg.nodes.register('test.noop', noopFactory);
  for (const [name, cond] of Object.entries(conditions)) reg.edges.register(name, cond);
  return reg;
}

/** 按注册表装载数据图并执行；max_cycle 缺省 = RunOptions 引擎缺省。 */
async function runLoopGraph(
  data: Record<string, unknown>,
  reg: GraphRegistries,
  init: { max_cycle?: number | null; state?: Record<string, unknown> | null } = {},
): Promise<{ state: Record<string, unknown>; reason: string; error: string | null }> {
  const graph = Graph.from_dict(data, {
    registry: reg.nodes,
    edge_registry: reg.edges,
    validate: true,
  });
  const options = new RunOptions({ storage: new MemoryStorage(), registries: reg });
  if (init.max_cycle !== null && init.max_cycle !== undefined) options.max_cycle = init.max_cycle;
  const engine = new Engine(graph, options);
  const result = await engine.ainvoke({ ...(init.state ?? {}) }, { thread_id: 't-loop', round_id: 'r1' });
  return { state: { ...result.state }, reason: result.reason, error: result.error };
}

describe('P4.2a-2 loop 回边执行语义', () => {
  it('kind=loop 回边到祖先：重复执行上游至退出条件，走退出边收口（护栏预算内不误伤）', async () => {
    // 链 a→b→c；c 有两条条件出边：kind=loop 回 a（条件 again）+ 前进到出口 e
    // （条件 done）。断言：c 每轮沿 loop 回边重复执行祖先 a/b，直至计数到上限
    // 命中 done → 走退出边 e → reply；max_cycle=3 不误伤恰好 3 次的合法回环。
    const data = {
      name: 'loop.ancestor',
      entry: 'a',
      nodes: {
        a: { type: 'test.counter', config: { field: 'a_visits' } },
        b: { type: 'test.counter', config: { field: 'b_visits' } },
        c: { type: 'test.noop', config: {} },
        e: { type: 'test.writer', config: { field: 'reply', value: 'done' } },
      },
      edges: {
        a: [{ target: 'b' }],
        b: [{ target: 'c' }],
        c: [
          { target: 'a', condition: 'again', kind: 'loop' },
          { target: 'e', condition: 'done' },
        ],
      },
      exits: ['e'],
      subgraphs: {},
      schema: null,
    };
    const limit = 3;
    const reg = testRegistries({
      again: (ctx: any) => (ctx.state?.a_visits ?? 0) < limit,
      done: (ctx: any) => (ctx.state?.a_visits ?? 0) >= limit,
    });
    const graph = Graph.from_dict(data, {
      registry: reg.nodes,
      edge_registry: reg.edges,
      validate: true,
    });
    // 数据层断言：dict 里的显式回边装载后 kind='loop'（P1 序列化口径贯通执行）
    expect(graph.edges['c']![0]!.kind).toBe('loop');
    expect(graph.edges['c']![0]!.condition_name).toBe('again');
    expect(graph.edges['c']![1]!.kind).toBe('conditional');
    const { state, reason, error } = await runLoopGraph(data, reg, { max_cycle: limit });
    expect(reason).toBe(TerminateReason.REPLY);
    expect(error).toBeNull();
    // 祖先 a/b 各自被重复执行 3 次（loop 回边重入上游生效），退出边 e 产出 reply
    expect(state['a_visits']).toBe(limit);
    expect(state['b_visits']).toBe(limit);
    expect(state['reply']).toBe('done');
  });

  it('kind=loop 回边到祖先的失控回路：max_cycle 按节点访问上限截止（reason=error，不无限循环）', async () => {
    // 同一结构但 again 恒真（上限 1000 远超护栏）：纯回边回路无退出条件。
    // max_cycle=5 → 节点 a 第 6 次重入即截止（reason=error + 回路超限消息），
    // 执行总量有界，绝不挂死。
    const data = {
      name: 'loop.runaway-ancestor',
      entry: 'a',
      nodes: {
        a: { type: 'test.counter', config: { field: 'a_visits' } },
        b: { type: 'test.counter', config: { field: 'b_visits' } },
        c: { type: 'test.noop', config: {} },
        e: { type: 'test.writer', config: { field: 'reply', value: 'done' } },
      },
      edges: {
        a: [{ target: 'b' }],
        b: [{ target: 'c' }],
        c: [
          { target: 'a', condition: 'again', kind: 'loop' },
          { target: 'e', condition: 'done' },
        ],
      },
      exits: ['e'],
      subgraphs: {},
      schema: null,
    };
    const reg = testRegistries({
      again: () => true,
      done: () => false,
    });
    const { state, reason, error } = await runLoopGraph(data, reg, { max_cycle: 5 });
    expect(reason).toBe(TerminateReason.ERROR);
    expect(error).toContain('回路超限');
    // 节点 a 第 6 次重入触发护栏：a/b 实际各完整执行 5 次（有界），e 未走
    expect(state['a_visits']).toBe(5);
    expect(state['b_visits']).toBe(5);
    expect(state['reply']).toBeUndefined();
  });

  it('单节点自环 kind=loop（声明式数据图）：条件驱动重复直至退出边', async () => {
    // 节点 c 条件自环（kind=loop 回自身，条件 again）+ 条件退出边到出口 e：
    // 与 llm_decider 自环条件边的图级形态同构（loop 回边目标 = 自身）。
    const data = {
      name: 'loop.self',
      entry: 'c',
      nodes: {
        c: { type: 'test.counter', config: { field: 'c_visits' } },
        e: { type: 'test.writer', config: { field: 'reply', value: 'done' } },
      },
      edges: {
        c: [
          { target: 'c', condition: 'again', kind: 'loop' },
          { target: 'e', condition: 'done' },
        ],
      },
      exits: ['e'],
      subgraphs: {},
      schema: null,
    };
    const limit = 4;
    const reg = testRegistries({
      again: (ctx: any) => (ctx.state?.c_visits ?? 0) < limit,
      done: (ctx: any) => (ctx.state?.c_visits ?? 0) >= limit,
    });
    const graph = Graph.from_dict(data, {
      registry: reg.nodes,
      edge_registry: reg.edges,
      validate: true,
    });
    expect(graph.edges['c']![0]!.kind).toBe('loop');
    const { state, reason } = await runLoopGraph(data, reg, { max_cycle: limit });
    expect(reason).toBe(TerminateReason.REPLY);
    expect(state['c_visits']).toBe(limit);
    expect(state['reply']).toBe('done');
  });
});
