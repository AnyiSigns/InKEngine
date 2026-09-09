/**
 * runtime 机制装配段单测（D01/D02/D08 接线面）：边证据/指纹缓存的 records
 * 通道持久化、沉淀钩子触发与开关关断、组装默认运行期挂载与卸载、环境声明
 * 装配与 install fail-closed。
 *
 * 覆盖最小接线断言（开关默认全开；false = 对应块零参与）；模块级默认组装
 * 运行期为全局态，用后即清（afterEach set_default_assembly_runtime(null)）。
 * 回合引擎形态（B3）：无常驻静态引擎——跑机制回合用数据图经 _build_graph_engine
 * 构造本轮引擎（settle 钩子/edge 证据/观察传输与组装路径同源）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Runtime, AssemblyRecipe } from '../../../src/kernel/runtime/index.js';
import type { Host } from '../../../src/kernel/runtime/index.js';
import { set_default_assembly_runtime, get_default_assembly_runtime } from '../../../src/kernel/path_assembler/index.js';
import { EDGE_EVIDENCE_COLLECTION } from '../../../src/core/edge_evidence/index.js';
import { FINGERPRINT_CACHE_COLLECTION } from '../../../src/core/fingerprint_cache/index.js';
import { EnvironmentSpec, RuntimeKind } from '../../../src/core/environments/index.js';
import { DefaultInterruptPolicy } from '../../../src/kernel/approval/approval.js';
import { self_tool_specs, make_self_executor, operation_of } from '../../../src/kernel/self_tools/index.js';
import type { SelfToolContext } from '../../../src/kernel/self_tools/index.js';
import { MemoryStorage } from '../executor/helpers.js';
import type { NodeFactory } from '../../../src/core/registry/registry_types.js';
import {
  dataGraph,
  registerNodeType,
  runRoundEngine,
} from './_round_graphs.js';

/** Host 五件套 mock（最小装配面：内存存储 + 直过审批策略）。 */
class FakeHost {
  policy: unknown = new DefaultInterruptPolicy();
  async create_storage(): Promise<MemoryStorage> {
    return new MemoryStorage();
  }
  async resolve_llm(): Promise<unknown> {
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

// ── 数据图测试节点（无常驻静态引擎：机制回合用数据图驱动）────────────────
const T_OK = 'mech.ok';
const T_START = 'mech.start';
const T_BOOM = 'mech.boom';

function ok_factory(): NodeFactory {
  return () => async (): Promise<Record<string, unknown>> => ({ reply: 'ok' });
}

function fail_factory(): { start: NodeFactory; boom: NodeFactory } {
  return {
    start: () => async (): Promise<Record<string, unknown>> => ({ started: true }),
    boom: () => async (): Promise<never> => {
      throw new Error('节点失败');
    },
  };
}

function install_data_nodes(runtime: Runtime): void {
  registerNodeType(runtime, T_OK, ok_factory());
  const failing = fail_factory();
  registerNodeType(runtime, T_START, failing.start);
  registerNodeType(runtime, T_BOOM, failing.boom);
}

/** 成功回合数据图（正常 reply 收尾）。 */
function ok_graph(): Record<string, unknown> {
  return dataGraph({ name: 'mech-ok', entry: 'agent', nodes: [{ id: 'agent', type: T_OK }], exits: ['agent'] });
}

/** 失败回合数据图（start → boom 抛错 → 归因写失败边证据）。 */
function failing_graph(): Record<string, unknown> {
  return dataGraph({
    name: 'mech-fail',
    entry: 'start',
    nodes: [
      { id: 'start', type: T_START },
      { id: 'boom', type: T_BOOM },
    ],
    edges: [{ from: 'start', to: 'boom' }],
    exits: ['boom'],
  });
}

/** 最小装配配方（机制开关默认全开；overrides 逐字段覆写）。 */
function _recipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'default',
    tool_wiring: {
      self_specs: () => self_tool_specs(),
      self_executor_factory: (pipeline, context_getter) =>
        make_self_executor(pipeline, context_getter as unknown as () => SelfToolContext),
      self_operation_of: (spec) => operation_of(spec),
    },
    approval_levels: {},
  });
  return Object.assign(base, overrides);
}

/** 记录读取（records 通道透传内存存储）。 */
async function _recordsOf(runtime: Runtime, collection: string): Promise<Record<string, unknown>[]> {
  if (runtime.storage === null) return [];
  return runtime.storage.list_records(collection);
}

describe('runtime 只读状态面（V3-8）', () => {
  it('restore_diag / skill_crystallizer 经只读 getter 暴露（宿主 assemble 状态读取用）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _recipe());
    install_data_nodes(runtime);
    // 集补丁链缺装配：恢复诊断记录回落原因（只读数组形态）
    expect(Array.isArray(runtime.restore_diag)).toBe(true);
    // 技能结晶默认装配：回合引擎构建（settle 链装配）后结晶器实例可见
    expect(runtime.skill_crystallizer).toBeNull(); // 无常驻静态引擎：settle 链随回合引擎装配
    await runRoundEngine(runtime, ok_graph(), { input: 'ok' }, { thread_id: 't-ro', round_id: 'r1' });
    const crystallizer = runtime.skill_crystallizer;
    expect(crystallizer).not.toBeNull();
    expect(Array.isArray(crystallizer!.crystallized)).toBe(true);
    // 内部可写字段仍为引擎装配通道（只读 getter 不替代内部写面）
    expect(runtime._restore_diag).toBe(runtime.restore_diag);
    await runtime.stop();
  });
});

describe('runtime 机制开关（D02）', () => {
  it('默认全开：边证据/指纹缓存 store 装配且默认组装运行期挂载', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _recipe());
    expect(runtime.edge_evidence_store).not.toBeNull();
    expect(runtime.fingerprint_cache_store).not.toBeNull();
    expect(runtime.assembly_flags).not.toBeNull();
    expect(runtime.assembly_runtime).not.toBeNull();
    expect(get_default_assembly_runtime()).toBe(runtime.assembly_runtime);
    expect(runtime.assembly_runtime!.contract_enabled).toBe(true);
    await runtime.stop();
  });

  it('assembler_enabled=false：默认组装运行期卸载（零挂载零生效）', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      _recipe({ assembler_enabled: false }),
    );
    expect(runtime.assembly_runtime).toBeNull();
    expect(get_default_assembly_runtime()).toBeNull();
    await runtime.stop();
  });

  it('fingerprint_cache_enabled=false：指纹缓存 store 不装配（零参与）', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      _recipe({ fingerprint_cache_enabled: false }),
    );
    expect(runtime.fingerprint_cache_store).toBeNull();
    await runtime.stop();
  });

  it('contract_enabled=false：组装运行期携带契约关闭语义位', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      _recipe({ contract_enabled: false }),
    );
    expect(runtime.assembly_flags!.contract_enabled).toBe(false);
    expect(runtime.assembly_runtime!.contract_enabled).toBe(false);
    await runtime.stop();
  });

  it('P4.1 候选层探索预算：引擎默认不携带（零漂移）；配方开启随运行期挂载并透传参数', async () => {
    const off = await new Runtime().boot(toHost(new FakeHost()), _recipe());
    expect(off.assembly_runtime!.exploration_budget).toBeNull();
    await off.stop();
    const on = await new Runtime().boot(
      toHost(new FakeHost()),
      _recipe({
        candidate_trial_enabled: true,
        candidate_trial_epsilon: 0.03,
        anti_monopoly_enabled: true,
        anti_monopoly_window: 8,
      }),
    );
    expect(on.assembly_runtime!.exploration_budget).toEqual({
      candidate_trial_enabled: true,
      candidate_trial_epsilon: 0.03,
      anti_monopoly_enabled: true,
      anti_monopoly_window: 8,
    });
    await on.stop();
  });

  it('P4.1 探索预算非法参数覆写钳制（负 epsilon 截 0；窗口截 >=1）', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      _recipe({
        candidate_trial_enabled: true,
        candidate_trial_epsilon: -1,
        anti_monopoly_enabled: true,
        anti_monopoly_window: 0,
      }),
    );
    expect(runtime.assembly_runtime!.exploration_budget).toEqual({
      candidate_trial_enabled: true,
      candidate_trial_epsilon: 0,
      anti_monopoly_enabled: true,
      anti_monopoly_window: 1,
    });
    await runtime.stop();
  });
});

describe('runtime 边证据持久化与钩子触发（D01）', () => {
  it('失败回合经 EdgeEvidenceSettleHook 写证据并落 records 集合（持久化 seam）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _recipe());
    install_data_nodes(runtime);
    const result = await runRoundEngine(runtime, failing_graph(), { input: 'x' }, { thread_id: 't-ev', round_id: 'r1' });
    expect(result.reason).toBe('error');
    // 归因钩子已触发：records 集合存在失败边证据行
    const rows = await _recordsOf(runtime, EDGE_EVIDENCE_COLLECTION);
    expect(rows.length).toBeGreaterThan(0);
    const edgeRows = rows.filter((r) => r['success_count'] === 0 && Number(r['fail_count']) >= 1);
    expect(edgeRows.length).toBeGreaterThan(0);
    // store 读取侧同源可见（非纯内存空壳）
    const storeRows = await runtime.edge_evidence_store!.list_edges();
    expect(storeRows.length).toBe(rows.length);
    await runtime.stop();
  });

  it('edge_evidence_enabled=false：不登记归因钩子，失败回合零证据写', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      _recipe({ edge_evidence_enabled: false }),
    );
    install_data_nodes(runtime);
    const result = await runRoundEngine(runtime, failing_graph(), { input: 'x' }, { thread_id: 't-ev-off', round_id: 'r1' });
    expect(result.reason).toBe('error');
    expect(await _recordsOf(runtime, EDGE_EVIDENCE_COLLECTION)).toEqual([]);
    expect(await runtime.edge_evidence_store!.evidence_count()).toBe(0);
    await runtime.stop();
  });

  it('指纹缓存集合可经运行时 store 写入读取（records seam 落库）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _recipe());
    const store = runtime.fingerprint_cache_store!;
    const ok = await store.upsert('fp-key-1', {
      path: { graph: { name: 'g' } },
      evidence_snapshot: [],
      model_id: 'm',
      gate_passed: true,
    });
    expect(ok).toBe(true);
    const cached = await store.lookup('fp-key-1');
    expect(cached).not.toBeNull();
    const rows = await _recordsOf(runtime, FINGERPRINT_CACHE_COLLECTION);
    expect(rows.some((r) => r['context_fingerprint'] === 'fp-key-1')).toBe(true);
    await runtime.stop();
  });
});

describe('runtime 环境装配（D08）', () => {
  const envSpec = new EnvironmentSpec({
    name: 'sandbox',
    runtime: RuntimeKind.LOCAL,
    tools: ['python'],
  });

  it('配方环境声明登记：environment_names 可见，提供器注册表装配', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      _recipe({ environment_specs: [envSpec] }),
    );
    expect(runtime.environment_providers).not.toBeNull();
    expect(runtime.environment_names()).toEqual(['sandbox']);
    await runtime.stop();
  });

  it('install fail-closed：未声明环境显式报错，不静默回落', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _recipe());
    await expect(runtime.install_environment('missing')).rejects.toThrow(/环境未声明/);
    await runtime.stop();
  });
});

afterEach(() => {
  set_default_assembly_runtime(null);
});
