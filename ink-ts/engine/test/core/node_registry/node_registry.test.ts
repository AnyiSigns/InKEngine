/**
 * 声明式结点类型注册表数据（node_registry）单元测试。
 *
 * - NodeRegistration 序列化往返（契约 schema 内联/状态/建议字段）；
 * - NodeRegistryStore：boot 种子补登记幂等、register 重复拒绝、disable/
 *   archive/suggest 受控写 + 内存视图同步；模拟重启（同 records 源二次 load）
 *   后状态回位；
 * - registration_output_fields 从契约产出 schema 解析字段面。
 */

import { describe, expect, it } from 'vitest';

import { NodeContract } from '../../../src/core/contracts/contracts.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../../src/core/schema/schemaValidator.js';
import {
  NodeRegistration,
  NodeRegistryStore,
  node_registry_collection,
  registration_output_fields,
} from '../../../src/core/node_registry/index.js';
import { MemoryStorage } from '../../kernel/executor/helpers.js';

function output_contract(fields: string[], version = 1): NodeContract {
  return new NodeContract({
    version,
    safety_tier: 0,
    output_schema: new SchemaSpec({
      name: 'n.contract.out',
      fields: fields.map(
        (name) => new SchemaField({ name, required: true, kind: FIELD_STRING }),
      ),
    }),
  });
}

/** store 装配：共享 MemoryStorage 上建 store（records 源 = 同一 storage）。 */
function make_store(
  storage: MemoryStorage,
  writes: Array<{ collection: string; type_name: string; note: string }>,
): NodeRegistryStore {
  return new NodeRegistryStore({
    collection: node_registry_collection('default'),
    records: storage,
    write: async (collection, type_name, data, note) => {
      writes.push({ collection, type_name, note });
      await storage.put_record(collection, type_name, data);
    },
    now: () => 100,
  });
}

describe('NodeRegistration 序列化往返', () => {
  it('契约/配置/来源/状态/建议字段往返一致', () => {
    const reg = new NodeRegistration({
      type_name: 'llm_decider',
      contract: output_contract(['reply']),
      config_defaults: { max_tool_rounds: 3 },
      executor: 'engine:llm_decider',
      provenance: 'seed',
      status: 'active',
      registered_at: 10,
      updated_at: 20,
    });
    const round = NodeRegistration.from_dict(reg.to_dict());
    expect(round.type_name).toBe('llm_decider');
    expect(round.contract?.version).toBe(1);
    expect(round.config_defaults).toEqual({ max_tool_rounds: 3 });
    expect(round.executor).toBe('engine:llm_decider');
    expect(round.provenance).toBe('seed');
    expect(round.status).toBe('active');
    expect(round.is_active()).toBe(true);
  });

  it('畸形行/非法状态反序列化抛错', () => {
    expect(() => NodeRegistration.from_dict({})).toThrow(/type_name/);
    expect(() =>
      NodeRegistration.from_dict({ type_name: 'x', status: 'weird' }),
    ).toThrow(/status/);
  });
});

describe('NodeRegistryStore 受控登记与恢复', () => {
  it('boot 种子补登记幂等 + register 重复拒绝', async () => {
    const storage = new MemoryStorage();
    const writes: Array<{ collection: string; type_name: string; note: string }> = [];
    const store = make_store(storage, writes);
    await store.load();
    const created = await store.ensure_seed({
      type_name: 'llm_decider',
      contract: output_contract(['reply']),
      config_defaults: { max_tool_rounds: 3 },
      executor: 'engine:llm_decider',
      provenance: 'seed',
      status: 'active',
    }, 'boot seed');
    expect(created).toBe(true);
    expect(await store.ensure_seed({
      type_name: 'llm_decider',
      contract: output_contract(['reply']),
      executor: 'engine:llm_decider',
      provenance: 'seed',
      status: 'active',
    }, 'again')).toBe(false);
    await expect(
      store.register({ type_name: 'llm_decider', executor: 'engine:llm_decider' }),
    ).rejects.toThrow(/重复登记/);
    expect(store.size).toBe(1);
    expect(writes.length).toBe(1);
  });

  it('disable/archive/suggest 持久写 + 重启（同 records 二次 load）状态回位', async () => {
    const storage = new MemoryStorage();
    const writes: Array<{ collection: string; type_name: string; note: string }> = [];
    const store = make_store(storage, writes);
    await store.load();
    await store.ensure_seed({
      type_name: 'llm_decider',
      contract: output_contract(['reply']),
      executor: 'engine:llm_decider',
      provenance: 'seed',
      status: 'active',
    }, 'seed');
    await store.register({
      type_name: 'tool_pipeline',
      contract: output_contract(['done']),
      executor: 'engine:tool_pipeline',
      provenance: 'host',
      status: 'active',
    }, 'host register');
    await store.disable('llm_decider', '治理 disable');
    await store.suggest('tool_pipeline', { kind: 'merge', merge_into: 'llm_decider' }, '建议');
    // 模拟重启：同一 records 源新 store
    const revived = make_store(storage, []);
    await revived.load();
    expect(revived.active_type_names()).toEqual(['tool_pipeline']);
    expect(revived.get('llm_decider')!.status).toBe('disabled');
    expect(revived.get('llm_decider')!.archived_reason).toBe('治理 disable');
    expect(revived.get('tool_pipeline')!.suggestion?.merge_into).toBe('llm_decider');
    expect(writes.length).toBe(4);
  });

  it('registration_output_fields 从契约产出 schema 解析字段面', () => {
    const reg = new NodeRegistration({
      type_name: 'llm_decider',
      contract: output_contract(['reply', 'message']),
      executor: 'engine:llm_decider',
    });
    expect(registration_output_fields(reg)).toEqual(['message', 'reply']);
    const noContract = new NodeRegistration({ type_name: 'bare' });
    expect(registration_output_fields(noContract)).toEqual([]);
  });
});
