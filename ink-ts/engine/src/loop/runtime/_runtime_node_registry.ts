/**
 * Runtime 声明式结点类型注册表面（A3 决策 4）。
 *
 * - boot 种子登记：池种子声明（provenance=seed）落 `node_registry:<set>`
 *   登记数据（已存在 = 跳过，治理 disable 状态跨重启保留）；
 * - 重启恢复：从集合恢复登记行，active + 可解析执行体绑定才重建运行时
 *   NodeTypeRegistry（引擎内置 `engine:<type>` 由内置执行体构建器解析；
 *   宿主绑定类型经配方 node_executors 解析）；绑定缺失 = 登记不注册 + diag；
 * - 数据化注册入口：register_node_type（宿主/agent 注入新类型，须提供执行体
 *   闭包，装配期由配方 node_executors 提供恢复绑定）、disable/archive。
 *
 * 契约池读取面（组装/治理）沿用 NodeTypeRegistry（内存执行体注册 = 装配产物，
 * 与登记数据 active 过滤一致）；登记数据写一律经 NodeRegistryStore 受控写
 * 通道（守卫 + EvolutionWriter 补丁链 + set_audit 审计）。
 */

import { NodeContract } from '../../model/contracts/contracts.js';
import { GraphDefinitionError } from '../../model/errors.js';
import type { NodeFactory } from '../../graph/registry/registry_types.js';
import {
  has_engine_executor,
  register_engine_edge_conditions,
  register_engine_node_type,
} from '../../graph/nodes/index.js';
import { derive_instance_contract } from '../../graph/nodes/instance_contract.js';
import type { EnginePoolSeed } from '../../graph/nodes/index.js';
import {
  NodeRegistryStore,
  node_registry_collection,
  type NodeRegistration,
  type NodeRegistrationInit,
  type NodeRegistrationProvenance,
} from '../../graph/node_registry/index.js';
import type { Storage } from '../../dock/ports/storage.js';
import type { AssemblyRecipe } from './_types.js';
import { RuntimeSelfLearning } from './_runtime_self_learning.js';

/** 种子声明 → 登记行数据（executor 绑定 = `engine:<executor>`，缺省 executor =
 *  type 自身——实例键与执行体解耦；实例契约随 config_defaults 派生，缺省 =
 *  类型契约零漂移）。 */
function _seed_registration(
  seed: EnginePoolSeed['node_types'][number],
): NodeRegistrationInit {
  return {
    type_name: seed.type,
    contract: derive_instance_contract(seed.contract, seed.default_config),
    config_defaults: seed.default_config,
    executor: `engine:${seed.executor ?? seed.type}`,
    provenance: 'seed',
    status: 'active',
    kind: seed.kind ?? null,
    label: seed.label ?? null,
    description: seed.description ?? null,
    flags: seed.flags ?? null,
  };
}

/** 声明式注册表面基座（RuntimeAssemble 之下；字段/恢复/写入口同文件）。 */
export abstract class RuntimeNodeRegistrar extends RuntimeSelfLearning {
  /**
   * 声明式结点类型注册表装配（boot 调用；mechanism writer 就绪后）：
   * 恢复持久登记行 + 缺省种子补登记 + active 登记重建运行时执行体注册表。
   * 恢复/登记失败只跳过（diag 留痕，不击穿启动）；执行体绑定缺失的类型
   * 登记保留、运行时不注册。
   */
  protected async _assemble_node_registry(
    guarded: Storage,
    recipe: AssemblyRecipe,
    poolSeed: EnginePoolSeed,
  ): Promise<void> {
    const writer = this._mechanism_writer;
    const diag: string[] = [];
    const collection = node_registry_collection(recipe.set_id);
    const store = new NodeRegistryStore({
      collection,
      records: guarded,
      write:
        writer !== null
          ? async (coll, type_name, data, note) => {
              await writer.write(coll, type_name, data as never, {
                kind: 'node_registry',
                asset_id: type_name,
                note,
              });
            }
          : null,
      now: () => this._r_now(),
      on_skip: (type_name, reason) => diag.push(`结点类型登记跳过: ${type_name ?? ''} ${reason}`),
    });
    this.node_registry_store = store;
    await store.load();
    if (poolSeed.enabled) {
      for (const seed of poolSeed.node_types) {
        try {
          await store.ensure_seed(_seed_registration(seed), 'boot_seed');
        } catch (exc) {
          diag.push(`结点类型种子登记失败（跳过）: ${seed.type} ${String(exc)}`);
        }
      }
    }
    if (poolSeed.enabled) {
      register_engine_edge_conditions(this.graph_registries!);
    }
    for (const reg of store.active()) {
      const ok = this._register_registration_executor(reg);
      if (!ok) diag.push(`结点类型执行体绑定缺失（登记保留不注册）: ${reg.type_name} (${reg.executor})`);
    }
    this._restore_diag = [...this._restore_diag, ...diag];
  }

  /** 按登记行重建运行时执行体注册（引擎内置 / 配方绑定；成功 = true）。
   *  引擎内置绑定：executor `engine:<内核名>` 解析执行体构建器，实例键 =
   *  登记 type_name（两者可解耦——多实例指向同一内核）；配方绑定经
   *  recipe.node_executors 按 executor 名解析。 */
  private _register_registration_executor(reg: NodeRegistration): boolean {
    const registries = this.graph_registries;
    const recipe = this._recipe;
    if (registries === null) return false;
    if (reg.executor.startsWith('engine:')) {
      const executor = reg.executor.slice('engine:'.length);
      if (!has_engine_executor(executor)) return false;
      return register_engine_node_type(registries, reg.type_name, reg.contract, null, executor);
    }
    const factory = recipe?.node_executors?.[reg.executor] ?? null;
    if (factory === null) return false;
    if (registries.nodes.has(reg.type_name)) return true;
    registries.nodes.register(
      reg.type_name,
      factory,
      reg.contract === null ? undefined : reg.contract,
    );
    return true;
  }

  /**
   * 结点类型注册登记（宿主/agent 注入：数据落库 + 执行体装入注册表）。
   * 类型元数据（kind/label/description/flags）可选缺省回落 null——宿主/agent
   * 注入类型也可声明 kind/flags（如 flags.terminal=true 供组装终态兜底），
   * 语义与种子登记（_seed_registration 元数据透传）一致。
   */
  async register_node_type(
    input: {
      type_name: string;
      contract?: NodeContract | null;
      config_defaults?: Record<string, unknown>;
      kind?: string | null;
      label?: string | null;
      description?: string | null;
      flags?: NodeRegistrationInit['flags'];
      executor?: string | null;
      provenance?: NodeRegistrationProvenance;
      note?: string | null;
    },
    factory: NodeFactory,
  ): Promise<void> {
    const store = this.node_registry_store;
    const registries = this.graph_registries;
    if (store === null || registries === null) {
      throw new GraphDefinitionError('结点类型注册表未装配（register_node_type 须在 boot 之后）');
    }
    if (store.has(input.type_name)) {
      throw new GraphDefinitionError(`结点类型重复登记: ${input.type_name}`);
    }
    const executor = input.executor ?? `host:${input.type_name}`;
    // 实例契约随 config 派生（config 无字段分化 = 传入契约零变化；派生是
    // 运行时视图，登记行只落派生后的契约数据——装配面与组装器同源可见）。
    const derivedContract =
      input.contract === null || input.contract === undefined
        ? null
        : derive_instance_contract(input.contract, input.config_defaults ?? {});
    const reg = await store.register(
      {
        type_name: input.type_name,
        contract: derivedContract,
        config_defaults: input.config_defaults,
        kind: input.kind ?? null,
        label: input.label ?? null,
        description: input.description ?? null,
        flags: input.flags ?? null,
        executor,
        provenance: input.provenance ?? 'host',
        status: 'active',
      },
      input.note ?? 'host/agent register',
    );
    if (!registries.nodes.has(reg.type_name)) {
      registries.nodes.register(reg.type_name, factory, reg.contract as never);
    }
  }

  /** disable 结点类型（受控回写登记 + 执行体卸载；数据保留可审计）。 */
  async disable_node_type(type_name: string, reason = 'runtime disable'): Promise<void> {
    const store = this.node_registry_store;
    if (store === null) {
      throw new GraphDefinitionError('结点类型注册表未装配（disable_node_type 须在 boot 之后）');
    }
    const reg = store.get(type_name);
    if (reg === null) {
      throw new GraphDefinitionError(`结点类型未登记: ${type_name}`);
    }
    await store.disable(type_name, reason, 'runtime disable');
    this.graph_registries?.nodes.unregister(type_name);
  }

  /** archive 结点类型（受控回写登记 + 执行体卸载；登记行保留可追溯）。 */
  async archive_node_type(type_name: string, reason = 'runtime archive'): Promise<void> {
    const store = this.node_registry_store;
    if (store === null) {
      throw new GraphDefinitionError('结点类型注册表未装配（archive_node_type 须在 boot 之后）');
    }
    const reg = store.get(type_name);
    if (reg === null) {
      throw new GraphDefinitionError(`结点类型未登记: ${type_name}`);
    }
    await store.archive(type_name, reason, 'runtime archive');
    this.graph_registries?.nodes.unregister(type_name);
  }

  /** 结点类型注册数据面（观察/治理消费；未装配 = 空视图）。 */
  node_registrations(): readonly NodeRegistration[] {
    const store = this.node_registry_store;
    return store === null ? [] : store.list();
  }
}
