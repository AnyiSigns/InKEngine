/**
 * contract_enabled 语义位消费测（D01/D02）：PathAssemblyFlags.contract_enabled
 * 随组装运行期进组装器——关闭 = 路径组装不携带契约语义（契约池恒空 =
 * 零候选零组装）；开启（缺省）保持既有契约池形态。
 */
import { describe, expect, it } from 'vitest';

import { NodeTypeRegistry } from '../../../src/core/registry/registry.js';
import { NodeContract, PathAssemblyConfig } from '../../../src/core/contracts/contracts.js';
import { PathAssemblyRuntime } from '../../../src/core/path_assembler/runtime.js';

/** 单类型契约注册表（write_file：消费/产出两字段，安全档 1）。 */
function makeContractRegistry(): NodeTypeRegistry {
  const registry = new NodeTypeRegistry();
  registry.register(
    'write_file',
    (() => async () => ({ written: true })) as never,
    new NodeContract({
      input_schema: null,
      output_schema: null,
      safety_tier: 1,
    }),
  );
  return registry;
}

describe('contract_enabled 语义位消费（组装器契约池）', () => {
  it('缺省开启：契约池含已登记契约类型', () => {
    const runtime = new PathAssemblyRuntime({
      registry: makeContractRegistry(),
      config: new PathAssemblyConfig({ enabled: true }),
    });
    expect(runtime.contract_enabled).toBe(true);
    const pool = runtime.bind().contract_pool();
    expect(Object.keys(pool)).toEqual(['write_file']);
  });

  it('contract_enabled=false：契约池恒空（路径组装不携带契约语义）', () => {
    const runtime = new PathAssemblyRuntime({
      registry: makeContractRegistry(),
      config: new PathAssemblyConfig({ enabled: true }),
      contract_enabled: false,
    });
    expect(runtime.contract_enabled).toBe(false);
    expect(runtime.bind().contract_pool()).toEqual({});
  });
});
