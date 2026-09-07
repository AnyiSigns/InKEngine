/**
 * Pool governance runtime seam tests (A3 R3 landing over node type registry):
 * - after boot the node registry store is bound as governance write target
 *   (list() reflects active node type registrations);
 * - governance disable/archive writes registration data through the controlled
 *   channel (direct put_record to node_registry:<set> is rejected); audit
 *   recorded;
 * - governance judgment decision rows accumulate in pool_governance:<set>
 *   across runtime restarts on the same storage (weekly budget not reset);
 * - host/agent-registered node type enters the registry + pool and executes;
 *   a restart on the same storage restores it through recipe node_executors.
 */

import { describe, expect, it } from 'vitest';

import { AssemblyRecipe, Runtime } from '../../../src/kernel/runtime/index.js';
import type { Host } from '../../../src/kernel/runtime/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { Engine, RunOptions } from '../../../src/kernel/executor/index.js';
import { DefaultInterruptPolicy } from '../../../src/kernel/approval/approval.js';
import { NodeContract } from '../../../src/core/contracts/contracts.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../../src/core/schema/schemaValidator.js';
import { node_registry_collection } from '../../../src/core/node_registry/index.js';
import { pool_governance_collection } from '../../../src/kernel/pool_governance/state_store.js';
import type { NodeFactory } from '../../../src/core/registry/registry_types.js';
import { MemoryStorage } from '../executor/helpers.js';
import { dataGraph, registerNodeType, runRoundEngine } from './_round_graphs.js';

/** 可复用同一存储实例的 Host（跨 runtime 重启模拟）。 */
class SharedStorageHost {
  readonly storage = new MemoryStorage();
  policy: unknown = new DefaultInterruptPolicy();
  node_executors: Record<string, NodeFactory> | null = null;

  async create_storage(): Promise<MemoryStorage> {
    return this.storage;
  }
  async resolve_llm(): Promise<unknown> {
    return null;
  }
  interrupt_policy(): unknown {
    return this.policy;
  }
  build_transport(): { send(): Promise<void> } {
    return { send: async () => undefined };
  }
  async close(): Promise<void> {}
}

function toHost(host: SharedStorageHost): Host {
  return host as unknown as Host;
}

// 失败回合数据图：start（原始节点类型）→ mid（抛错）；mid 不落声明式登记
// （登记 store 查不到 = 治理判定候选非注册类型的 seam no-op 场景）。
const T_START = 'pgw.start';
const T_MID = 'mid';

function boom_factory(): NodeFactory {
  return () => async (): Promise<never> => {
    throw new Error('node failed');
  };
}

function start_factory(): NodeFactory {
  return () => async (): Promise<Record<string, unknown>> => ({ started: true });
}

function install_failing_nodes(runtime: Runtime): void {
  registerNodeType(runtime, T_START, start_factory());
  registerNodeType(runtime, T_MID, boom_factory());
}

function failingGraphData(): Record<string, unknown> {
  return dataGraph({
    name: 'pgw-fail',
    entry: 'start',
    nodes: [
      { id: 'start', type: T_START },
      { id: 'mid', type: T_MID },
    ],
    edges: [{ from: 'start', to: 'mid' }],
    exits: ['mid'],
  });
}

function recipe(
  host: SharedStorageHost,
  overrides: Partial<AssemblyRecipe> = {},
): AssemblyRecipe {
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
    node_executors: host.node_executors,
  });
  return Object.assign(base, overrides);
}

/** 宿主注入测试执行体：config.msg → reply。 */
const echo_factory: NodeFactory = (config) => async (): Promise<Record<string, unknown>> => ({
  reply: `echo:${String(config['msg'] ?? '')}`,
});

const echo_contract = (): NodeContract =>
  new NodeContract({
    version: 1,
    safety_tier: 0,
    output_schema: new SchemaSpec({
      name: 'custom.echo.out',
      fields: [new SchemaField({ name: 'reply', required: true, kind: FIELD_STRING })],
    }),
  });

function echo_graph_data(): Record<string, unknown> {
  return {
    name: 'host.echo',
    entry: 'echo_custom',
    nodes: { echo_custom: { type: 'echo_custom', config: { msg: 'hi' } } },
    edges: {},
    exits: ['echo_custom'],
    subgraphs: {},
    schema: null,
  };
}

async function failing_round(runtime: Runtime, round_id: string): Promise<void> {
  await runRoundEngine(
    runtime,
    failingGraphData(),
    { input: 'fail' },
    { thread_id: 't-pg', round_id },
  );
}

describe('runtime pool governance write seam assembly (A3)', () => {
  it('boot binds node registry store as writable; list reflects active node types', async () => {
    const host = new SharedStorageHost();
    const runtime = await new Runtime().boot(toHost(host), recipe(host));
    expect(runtime.node_registry_store).not.toBeNull();
    expect(runtime.pool_governance_writable).not.toBeNull();
    await expect(runtime.pool_governance_writable!.list()).resolves.toEqual([
      'llm_decider',
      'tool_pipeline',
    ]);
    await runtime.stop();
  });

  it('failing-round candidate not a registered node type -> seam no-op, registration + audit remain', async () => {
    const host = new SharedStorageHost();
    const runtime = await new Runtime().boot(toHost(host), recipe(host));
    const gov = runtime.pool_governance!;
    install_failing_nodes(runtime);
    await failing_round(runtime, 'r1');
    expect(runtime.node_registry_store!.get('mid')).toBeNull();
    expect(gov.log.length).toBeGreaterThanOrEqual(1);
    const audits = await runtime.storage!.list_records('set_audit');
    expect(audits.some((r) => r['type'] === 'pool_governance_audit')).toBe(true);
    await runtime.stop();
  });

  it('governance disable/archive writes registration data (controlled) + audit; direct write rejected', async () => {
    const host = new SharedStorageHost();
    const runtime = await new Runtime().boot(toHost(host), recipe(host));
    const collection = node_registry_collection('default');
    // 直写受守卫集合被拒（唯一写入路径 = 受控通道）
    await expect(
      runtime.storage!.put_record(collection, 'llm_decider', { type_name: 'llm_decider' }),
    ).rejects.toThrow(/旁路写拦截/);
    // 治理 archive（经可写 seam 受控回写登记 + 执行体卸载）
    await runtime.pool_governance_writable!.archive('llm_decider', {
      domain: 'default',
      reason: 'test archive',
    });
    expect(runtime.node_registry_store!.get('llm_decider')!.status).toBe('disabled');
    expect(runtime.node_registry_store!.get('llm_decider')!.archived_reason).toBe('test archive');
    expect(runtime.graph_registries!.nodes.has('llm_decider')).toBe(false);
    // 契约池视图 = 运行时注册（登记 active 过滤后），disable 后不再入池
    expect(runtime.graph_registries!.nodes.contract_for('llm_decider')).toBeUndefined();
    expect(runtime.graph_registries!.nodes.contract_for('tool_pipeline')).toBeTruthy();
    // 受控写审计留痕（evolution_write kind=node_registry）
    const audits = await runtime.storage!.list_records('set_audit');
    expect(
      audits.some(
        (r) =>
          r['type'] === 'evolution_write'
          && r['evolution_kind'] === 'node_registry'
          && r['asset_id'] === 'llm_decider',
      ),
    ).toBe(true);
    await runtime.stop();
  });

  it('registry data persists across restart: disabled type not restored; active types back', async () => {
    const host = new SharedStorageHost();
    const first = await new Runtime().boot(toHost(host), recipe(host));
    await first.disable_node_type('tool_pipeline', 'test disable');
    expect(first.graph_registries!.nodes.has('tool_pipeline')).toBe(false);
    await first.stop();
    const second = await new Runtime().boot(toHost(host), recipe(host));
    // active 引擎类型回位，disabled 过滤生效（契约池视图同步）
    expect(second.graph_registries!.nodes.has('llm_decider')).toBe(true);
    expect(second.graph_registries!.nodes.contract_for('llm_decider')).toBeTruthy();
    expect(second.graph_registries!.nodes.has('tool_pipeline')).toBe(false);
    expect(second.graph_registries!.nodes.contract_for('tool_pipeline')).toBeUndefined();
    expect(second.node_registry_store!.get('tool_pipeline')!.status).toBe('disabled');
    await second.stop();
  });

  it('governance decisions accumulate across restart (weekly budget source not reset)', async () => {
    const host = new SharedStorageHost();
    const first = await new Runtime().boot(toHost(host), recipe(host));
    install_failing_nodes(first);
    await failing_round(first, 'r1');
    await failing_round(first, 'r2');
    const rows1 = (await first.storage!.list_records(pool_governance_collection('default')))
      .filter((row) => row['row'] === 'decision');
    expect(rows1.length).toBe(2);
    await first.stop();
    const second = await new Runtime().boot(toHost(host), recipe(host));
    install_failing_nodes(second);
    await failing_round(second, 'r3');
    const rows2 = (await second.storage!.list_records(pool_governance_collection('default')))
      .filter((row) => row['row'] === 'decision');
    expect(rows2.length).toBe(3);
    await second.stop();
  });

  it('host/agent registered node type enters registry/pool and executes; restored after restart', async () => {
    const host = new SharedStorageHost();
    const first = await new Runtime().boot(toHost(host), recipe(host));
    await first.register_node_type(
      {
        type_name: 'echo_custom',
        contract: echo_contract(),
        config_defaults: {},
        executor: 'host:echo_custom',
        provenance: 'agent',
        note: 'agent register',
      },
      echo_factory,
    );
    expect(first.graph_registries!.nodes.has('echo_custom')).toBe(true);
    await expect(first.pool_governance_writable!.list()).resolves.toContain('echo_custom');
    const graph = Graph.from_dict(echo_graph_data(), {
      registry: first.graph_registries!.nodes,
      edge_registry: first.graph_registries!.edges,
      validate: true,
    });
    const engine = new Engine(
      graph,
      new RunOptions({ storage: first.storage, registries: first.graph_registries }),
    );
    const result = await engine.ainvoke(
      {},
      { thread_id: 't-host', round_id: 'r-host' },
    );
    expect((result.state as Record<string, unknown>)['reply']).toBe('echo:hi');
    await first.stop();
    // 重启恢复：host 类型经配方 node_executors 重建执行体注册
    host.node_executors = { 'host:echo_custom': echo_factory };
    const second = await new Runtime().boot(toHost(host), recipe(host));
    expect(second.node_registry_store!.get('echo_custom')!.status).toBe('active');
    expect(second.graph_registries!.nodes.has('echo_custom')).toBe(true);
    await second.stop();
  });
});
