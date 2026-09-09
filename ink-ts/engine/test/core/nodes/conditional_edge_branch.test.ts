/**
 * P4.2a-2 多目标 conditional 边分支语义（同一源节点多条条件出边）：
 *
 * 执行推进现状核对结论：条件边 = 确定性 predicate（图拓扑连接，不占执行步），
 * 判定在源节点完成后逐条按声明序进行（首个为真生效 → 只走命中条件的目标）；
 * 全未命中且源节点非出口 → 显式 stop 诚实收尾（不猜走向）。本批用两条内置
 * 条件族各覆盖一例：
 * - route:<key>（P4.2a-1 路由条件族）：fanout 源节点写 `_route_to`，三条条件
 *   出边分别指向三个叶子分支——仅命中分支执行、其余分支零执行；未命中任何
 *   分支 → stop。
 * - llm.pending_nonempty / llm.pending_empty（llm_decider 回环条件族）：decide
 *   源按 state.pending 是否非空二选一——非空走消费分支（并条件自环直至清空）、
 *   空直达终态；两条条件互斥，每次只走命中的一条。
 */
import { describe, expect, it } from 'vitest';
import { Graph } from '../../../src/core/graph/graph.js';
import { GraphRegistries } from '../../../src/core/registry/registry.js';
import { Engine } from '../../../src/kernel/executor/index.js';
import { RunOptions } from '../../../src/core/run_result/run_result.js';
import { TerminateReason } from '../../../src/core/graph/graph_types.js';
import type { NodeFactory } from '../../../src/core/registry/registry_types.js';
import { MemoryStorage } from '../../kernel/executor/helpers.js';
import {
  STATE_PENDING,
  STATE_ROUTE_TO,
  register_engine_edge_conditions,
  register_route_edge_conditions,
} from '../../../src/core/nodes/index.js';

// ── 测试用节点类型工厂 ──

/** 路由决议节点：把 state.want 的走向写入 `_route_to`（route:<key> 据此判定）。 */
const routeFanFactory: NodeFactory = () => async (ctx: any): Promise<Record<string, unknown>> => ({
  [STATE_ROUTE_TO]: String(ctx.state?.['want'] ?? ''),
});

/** 空操作节点（源节点占位：本身不写走向，走向全由条件边决定）。 */
const noopFactory: NodeFactory = () => async (): Promise<Record<string, unknown>> => ({});

/** 每访问弹出一个待办工具（写回剩余 pending + 弹数）。 */
const drainFactory: NodeFactory = () => async (ctx: any): Promise<Record<string, unknown>> => {
  const pending: unknown[] = Array.isArray(ctx.state?.[STATE_PENDING])
    ? [...(ctx.state[STATE_PENDING] as unknown[])]
    : [];
  pending.shift();
  return {
    [STATE_PENDING]: pending,
    drained: ((ctx.state?.['drained'] ?? 0) as number) + 1,
  };
};

/** 写值节点（叶子/终态产物）。 */
const writerFactory: NodeFactory = (config) => {
  const field = String(config['field'] ?? 'reply');
  const value = config['value'];
  return async (): Promise<Record<string, unknown>> => ({ [field]: value });
};

/** 装配注册表 + 数据图装载 + 执行（每个用例独立注册表，条件/类型互不串扰）。 */
async function runBranchGraph(opts: {
  data: Record<string, unknown>;
  register: (reg: GraphRegistries) => void;
  state?: Record<string, unknown>;
}): Promise<{ state: Record<string, unknown>; reason: string; error: string | null }> {
  const reg = new GraphRegistries();
  reg.nodes.register('test.route_fan', routeFanFactory);
  reg.nodes.register('test.noop', noopFactory);
  reg.nodes.register('test.drain', drainFactory);
  reg.nodes.register('test.writer', writerFactory);
  opts.register(reg);
  const graph = Graph.from_dict(opts.data, {
    registry: reg.nodes,
    edge_registry: reg.edges,
    validate: true,
  });
  const engine = new Engine(graph, new RunOptions({ storage: new MemoryStorage(), registries: reg }));
  const result = await engine.ainvoke({ ...(opts.state ?? {}) }, { thread_id: 't-branch', round_id: 'r1' });
  return { state: { ...result.state }, reason: result.reason, error: result.error };
}

describe('P4.2a-2 多目标 conditional：route:<key> 条件族', () => {
  // 三出口分支图：fan → [leaf_a 条件 route:A / leaf_b 条件 route:B / leaf_c 条件 route:C]
  const routeData = {
    name: 'branch.route',
    entry: 'fan',
    nodes: {
      fan: { type: 'test.route_fan', config: {} },
      leaf_a: { type: 'test.writer', config: { field: 'leaf', value: 'A' } },
      leaf_b: { type: 'test.writer', config: { field: 'leaf', value: 'B' } },
      leaf_c: { type: 'test.writer', config: { field: 'leaf', value: 'C' } },
    },
    edges: {
      fan: [
        { target: 'leaf_a', condition: 'route:A' },
        { target: 'leaf_b', condition: 'route:B' },
        { target: 'leaf_c', condition: 'route:C' },
      ],
    },
    exits: ['leaf_a', 'leaf_b', 'leaf_c'],
    subgraphs: {},
    schema: null,
  };

  it('仅命中条件走对应目标：route:B 命中 → 只执行 leaf_b，其余分支零执行', async () => {
    const { state, reason, error } = await runBranchGraph({
      data: routeData,
      register: (reg) => register_route_edge_conditions(reg, ['A', 'B', 'C']),
      state: { want: 'B' },
    });
    expect(reason).toBe(TerminateReason.REPLY);
    expect(error).toBeNull();
    expect(state[STATE_ROUTE_TO]).toBe('B');
    expect(state['leaf']).toBe('B');
    // 非命中分支未被选：图上只有命中叶子执行并产出（leaf 唯一值 = 命中分支）
    expect(['A', 'C'].includes(state['leaf'] as string)).toBe(false);
  });

  it('未命中任何条件 → 显式 stop 收尾（不猜分支、不崩溃）', async () => {
    const { state, reason, error } = await runBranchGraph({
      data: routeData,
      register: (reg) => register_route_edge_conditions(reg, ['A', 'B', 'C']),
      state: { want: 'Z' },
    });
    expect(reason).toBe(TerminateReason.STOP);
    expect(error).toBeNull();
    expect(state[STATE_ROUTE_TO]).toBe('Z');
    expect(state['leaf']).toBeUndefined();
  });
});

describe('P4.2a-2 多目标 conditional：llm.pending_* 条件族', () => {
  // decide 按 state.pending 是否非空二选一：非空 → drain（弹出一个；仍非空则
  // 条件自环继续弹）；空 → 直达终态 finalize。drain 与 decide 同构双条件出边。
  const pendingData = {
    name: 'branch.pending',
    entry: 'decide',
    nodes: {
      decide: { type: 'test.noop', config: {} },
      drain: { type: 'test.drain', config: {} },
      finalize: { type: 'test.writer', config: { field: 'reply', value: 'fin' } },
    },
    edges: {
      decide: [
        { target: 'drain', condition: 'llm.pending_nonempty' },
        { target: 'finalize', condition: 'llm.pending_empty' },
      ],
      drain: [
        { target: 'drain', condition: 'llm.pending_nonempty', kind: 'loop' },
        { target: 'finalize', condition: 'llm.pending_empty' },
      ],
    },
    exits: ['finalize'],
    subgraphs: {},
    schema: null,
  };
  const registerPending = (reg: GraphRegistries): void => register_engine_edge_conditions(reg);

  it('pending 非空 → 仅走消费分支（逐项弹至空后条件自环退出，直达终态）', async () => {
    const { state, reason, error } = await runBranchGraph({
      data: pendingData,
      register: registerPending,
      state: { [STATE_PENDING]: ['tool_a', 'tool_b'] },
    });
    expect(reason).toBe(TerminateReason.REPLY);
    expect(error).toBeNull();
    // 两项待办 = drain 被走两次（非命中分支 finalize 在清空前零执行）
    expect(state['drained']).toBe(2);
    expect(state[STATE_PENDING]).toEqual([]);
    expect(state['reply']).toBe('fin');
  });

  it('pending 空 → 直达终态分支（消费分支零执行、reply 产出）', async () => {
    const { state, reason, error } = await runBranchGraph({
      data: pendingData,
      register: registerPending,
      state: { [STATE_PENDING]: [] },
    });
    expect(reason).toBe(TerminateReason.REPLY);
    expect(error).toBeNull();
    expect(state['drained']).toBeUndefined();
    expect(state['reply']).toBe('fin');
  });
});
