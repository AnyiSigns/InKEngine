/**
 * 演化资产统一写入协议（EvolutionWriter：补丁链 + 实时写 + 审计留痕三重闸门）。
 *
 * 机制是引擎、知识是数据、变化是补丁、汇入靠调配：集内可演化资产
 * （harness / 事件类型 / 记忆 / 边信任档 / 运行时配置）曾直接落 records
 * 通道（不经补丁链 + 审计），绕过集演化可追溯性。本模块把这类直写统一收口
 * 到一条管线契约：
 *
 *   write(collection, key, data, { kind, asset_id, note, meta })
 *     → ① 补丁链 append（演化补丁链 evolution_patch_chain，内容型 PatchChain，
 *         落点路径按 kind 分段，value = 演化后整条记录）
 *     → ② 实时数据写（目标集合原样落库，供引擎读取；受守卫存储经
 *         allow_mechanism 机制豁免上下文放行，fail-closed 闸门仍由
 *         GuardedStorage 兜住——非守卫存储直接写，测试态无守卫亦兼容）
 *     → ③ 审计留痕（emit_audit 写入 set_audit，append-only 历史不撒谎）
 *
 * 演化补丁链独立于自指应用管线的集补丁链（set_patch_chain）：引擎机制内部
 * 写入（装配/记忆/降级/配置落地）与用户提案落链（SelfApplicationPipeline）
 * 是两条语义不同的演化通道，互不污染版本与回退。演化补丁链集合名
 * evolution_patch_chain 非受守卫集合（无旁路写风险——它只是审计留痕，
 * 唯一写入路径即本管线），受守卫的是 ② 的实时数据写。
 *
 * 双层互补：GuardedStorage（fail-closed 令牌 + allow_mechanism 双通道）
 * 是底层闸门，EvolutionWriter 是上层管线契约——直写必须经本管线，机制
 * 通道写入由本管线内部豁免上下文放行。
 */

import { emit_audit } from '../audit_log/audit_log.js';
import { PatchChain } from '../patch/patchChain.js';
import type { Json, JsonRecord, Patch } from '../patch/types.js';

import type {
  EvolutionRecord,
  EvolutionStorage,
  EvolutionWriter,
  EvolutionWriteOptions,
  GuardedEvolutionStorage,
} from './_types.js';

export type {
  EvolutionRecord,
  EvolutionStorage,
  EvolutionWriter,
  EvolutionWriteOptions,
  GuardedEvolutionStorage,
} from './_types.js';

/** 演化补丁链持久化集合（独立于集补丁链 set_patch_chain；非受守卫集合，
 *  仅作机制写入的审计留痕，唯一写入路径即 EvolutionWriter）。 */
export const _EVOLUTION_CHAIN_COLLECTION = 'evolution_patch_chain';

/** 演化补丁链在自身集合内的记录键。 */
export const _EVOLUTION_CHAIN_KEY = 'chain';

/** 演化审计记录类型（set_audit 集合；与干预审计同集合、append-only）。 */
export const EVOLUTION_AUDIT_TYPE = 'evolution_write';

/** 演化资产类型 → 集补丁链落点路径段（与集补丁链路径段同源哲学：同名键
 *  整体替换，组装结果即该资产最新态；前缀集合按资产隔离，不串数据）。 */
export const _KIND_PATH: { readonly [kind: string]: string } = {
  harness: 'harness',
  event_type: 'event_types',
  entity: 'entities',
  memory: 'memory',
  edge_tier: 'edge_tier_overrides',
  runtime_config: 'runtime_config',
};

/** 检测存储是否实现 allow_mechanism（duck-check，结构等价 GuardedStorage）。
 *  self_application.GuardedStorage 是宿主侧密封类，未迁入 core；以 duck-check
 *  镜像 audit_log 模块的等价判定，core 不引入宿主层依赖。 */
function isGuarded(storage: EvolutionStorage): storage is GuardedEvolutionStorage {
  return typeof (storage as GuardedEvolutionStorage).allow_mechanism === 'function';
}

/**
 * EvolutionWriter 默认实现（内容型补丁链 + 实时写 + 审计）。
 *
 * 构造接受 storage（可为 GuardedStorage 或非守卫存储）。目标集合为受守卫
 * 集合时，实时写经 allow_mechanism 机制豁免上下文放行（引擎机制内部写入
 * 语义）——fail-closed 闸门仍兜住非本管线的直写；非守卫存储直接写，
 * 测试态无守卫亦兼容。
 */
export class DefaultEvolutionWriter {
  readonly #storage: EvolutionStorage;

  constructor(storage: EvolutionStorage) {
    this.#storage = storage;
  }

  async #loadChain(): Promise<PatchChain> {
    const record = await this.#storage.get_record(
      _EVOLUTION_CHAIN_COLLECTION,
      _EVOLUTION_CHAIN_KEY,
    );
    if (record === null || record === undefined) return new PatchChain();
    return PatchChain.from_dict(
      record as unknown as { base?: JsonRecord; patches?: Array<{ op: 'append' | 'replace' | 'delete'; path: (string | number)[]; value: Json }> },
    );
  }

  async #putLive(collection: string, key: string, data: EvolutionRecord): Promise<void> {
    if (isGuarded(this.#storage)) {
      const scope = this.#storage.allow_mechanism(collection);
      await scope.enter();
      try {
        await this.#storage.put_record(collection, key, data);
      } finally {
        await scope.exit();
      }
    } else {
      await this.#storage.put_record(collection, key, data);
    }
  }

  async write(
    collection: string,
    key: string,
    data: EvolutionRecord,
    options: EvolutionWriteOptions,
  ): Promise<void> {
    const { kind, asset_id, note = '', meta = null } = options;
    const path = _KIND_PATH[kind] ?? kind;
    const chain = await this.#loadChain();
    const patch: Patch = {
      op: 'replace',
      path: [path, asset_id],
      value: data as unknown as Patch['value'],
    };
    chain.apply(patch);
    await this.#storage.put_record(
      _EVOLUTION_CHAIN_COLLECTION,
      _EVOLUTION_CHAIN_KEY,
      chain.to_dict() as unknown as EvolutionRecord,
    );
    await this.#putLive(collection, key, data);
    await emit_audit(this.#storage, {
      type: EVOLUTION_AUDIT_TYPE,
      evolution_kind: kind,
      asset_id,
      collection,
      key,
      note,
      meta: meta === null ? {} : { ...meta },
    });
  }
}

/** harness 仓库写入（chain:<name> 链记录直写改经本管线）。 */
export async function harness_writer(
  writer: EvolutionWriter,
  collection: string,
  chain_key: string,
  chain_dict: EvolutionRecord,
  options: { asset_id: string; note?: string | null },
): Promise<void> {
  await writer.write(collection, chain_key, chain_dict, {
    kind: 'harness',
    asset_id: options.asset_id,
    note: options.note ?? '',
  });
}

/** 事件类型注册表写入（按集集合 spec 记录直写改经本管线）。 */
export async function event_type_writer(
  writer: EvolutionWriter,
  collection: string,
  name: string,
  spec_dict: EvolutionRecord,
  options: { note?: string | null },
): Promise<void> {
  await writer.write(collection, name, spec_dict, {
    kind: 'event_type',
    asset_id: name,
    note: options.note ?? '',
  });
}

/** 实体注册表写入（按集集合 spec 记录直写改经本管线）。 */
export async function entity_writer(
  writer: EvolutionWriter,
  collection: string,
  entity_id: string,
  spec_dict: EvolutionRecord,
  options: { note?: string | null },
): Promise<void> {
  await writer.write(collection, entity_id, spec_dict, {
    kind: 'entity',
    asset_id: entity_id,
    note: options.note ?? '',
  });
}

/** 记忆条目写入（save/update/delete 落链改经本管线）。 */
export async function memory_writer(
  writer: EvolutionWriter,
  collection: string,
  entry_id: string,
  record: EvolutionRecord,
  options: { note?: string | null },
): Promise<void> {
  await writer.write(collection, entry_id, record, {
    kind: 'memory',
    asset_id: entry_id,
    note: options.note ?? '',
  });
}

/** 边信任档降级快照写入（edge_tier_overrides 直写改经本管线）。 */
export async function edge_tier_writer(
  writer: EvolutionWriter,
  collection: string,
  key_str: string,
  snapshot_dict: EvolutionRecord,
  options: { note?: string | null },
): Promise<void> {
  await writer.write(collection, key_str, snapshot_dict, {
    kind: 'edge_tier',
    asset_id: key_str,
    note: options.note ?? '',
  });
}

/** 运行时配置写入（runtime_config/* 直写改经本管线）。 */
export async function runtime_config_writer(
  writer: EvolutionWriter,
  collection: string,
  key: string,
  record: EvolutionRecord,
  options: { asset_id: string; note?: string | null },
): Promise<void> {
  await writer.write(collection, key, record, {
    kind: 'runtime_config',
    asset_id: options.asset_id,
    note: options.note ?? '',
  });
}
