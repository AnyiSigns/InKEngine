/**
 * runtime 机制装配段单测（D01/D08 接线面）：边证据 store 的 records 通道
 * 装配与开关关断、环境声明装配与 install fail-closed、只读状态面。
 *
 * 覆盖最小接线断言（开关默认全开；false = 对应块零参与）。
 * 组装运行期/指纹缓存/候选层探索预算已随组装链路退役（相关用例随退删除）；
 * 边证据持久化的 settle 钩子触发链由 test/kernel/settle 族覆盖
 * （本文件只断言 runtime 装配面）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Runtime, AssemblyRecipe } from '../../../src/loop/runtime/index.js';
import type { Host } from '../../../src/loop/runtime/index.js';
import { EDGE_EVIDENCE_COLLECTION } from '../../../src/evolve/observe/usage_evidence/index.js';
import type { EdgeKey } from '../../../src/evolve/observe/usage_evidence/_types.js';
import { EnvironmentSpec, RuntimeKind } from '../../../src/core/environments/index.js';
import { DefaultInterruptPolicy } from '../../../src/gate/approval/approval.js';
import { self_tool_specs, make_self_executor, operation_of } from '../../../src/evolve/proposal/self_edit_tools/index.js';
import type { SelfToolContext } from '../../../src/evolve/proposal/self_edit_tools/index.js';
import { MemoryStorage } from '../../graph/executor/helpers.js';

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

/** 边键夹具（EdgeKey 无缺省值，测试逐字段提供）。 */
function edgeKeyFixture(src: string, dst: string): EdgeKey {
  return {
    src_type: src,
    dst_type: dst,
    src_contract_version: '1',
    dst_contract_version: '1',
    context_domain: 'default',
    variant_hash: '',
  };
}

/** 记录读取（records 通道透传内存存储）。 */
async function _recordsOf(runtime: Runtime, collection: string): Promise<Record<string, unknown>[]> {
  if (runtime.storage === null) return [];
  return runtime.storage.list_records(collection);
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

describe('runtime 只读状态面（V3-8）', () => {
  it('restore_diag / skill_crystallizer 经只读 getter 暴露（宿主 assemble 状态读取用）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _recipe());
    // 集补丁链缺装配：恢复诊断记录回落原因（只读数组形态）
    expect(Array.isArray(runtime.restore_diag)).toBe(true);
    // 技能结晶观察面 getter 存在（恒 null 常态：结晶自动触发源已随组装退役，
    // 容器互转经 KnowledgeSkillStore 外部读写，skill_crystal 族覆盖见
    // test/kernel/skill_crystal）
    expect(runtime.skill_crystallizer).toBeNull();
    // 内部可写字段仍为引擎装配通道（只读 getter 不替代内部写面）
    expect(runtime._restore_diag).toBe(runtime.restore_diag);
    await runtime.stop();
  });
});

describe('runtime 机制开关（D02 保留面）', () => {
  it('默认全开：边证据 store 装配进 records 通道', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _recipe());
    expect(runtime.edge_evidence_store).not.toBeNull();
    // records 集合名与引擎边证据持久化通道同源（settle 钩子落库面）
    expect(EDGE_EVIDENCE_COLLECTION).toBe('edge_evidence');
    await runtime.stop();
  });

  it('edge_evidence_enabled=false：内存 store 零持久化（records 不落库）', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      _recipe({ edge_evidence_enabled: false }),
    );
    // 关闭 = 内存 store（判定机制可用，持久化 seam 不接线）
    expect(runtime.edge_evidence_store).not.toBeNull();
    const store = runtime.edge_evidence_store!;
    await store.put({
      key: edgeKeyFixture('s1', 't1'),
      success_count: 1,
      fail_count: 0,
      avg_cost: 0,
      policy: false,
      origin: 'test',
      last_used_at: 0,
      created_at: 0,
    });
    const rows = await _recordsOf(runtime, EDGE_EVIDENCE_COLLECTION);
    expect(rows).toEqual([]);
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
  // 无全局组装运行期残留（已随组装链路退役）
});