/**
 * harness 仓库（harness.py 移植：定义 = 补丁链数据，版本可回退）。
 *
 * 版本语义（与 checkpoint 版本链同哲学）：
 * - 首版 = 补丁链 base，后续版本 = append 替换补丁（新版本失败可回退
 *   旧版本——回退 = 组装到指定版本，非物理删除）；
 * - 版本号自增（1 起）；历史版本完整保留（Event Sourcing 哲学，回放/
 *   审计可追溯）。
 *
 * 存储后盾 = 通用存储服务 records 通道（memory/sqlite/postgres 共用，
 * 与记忆/轨迹存储同构）。写入经 DefaultEvolutionWriter 管线（补丁链 +
 * 实时写 + 审计三闸门，harness_writer 收口）。
 *
 * 集合隔离（set_id 注入时 = harness:<set_id>）：多集共享同一存储时定义
 * 互不串数据；未注入 set_id 保持历史集合名（harness）。旧数据兼容 =
 * **只读回退**：按集集合无记录时回落历史集合读取 + 写通迁移（迁移失败
 * 不阻断读取；TS core 零日志，对应 Python warning 行为以静默跳过表达）。
 */
import {
  DefaultEvolutionWriter,
  harness_writer,
} from '../evolution_writer/evolution_writer.js';
import type {
  EvolutionRecord,
  EvolutionStorage,
} from '../evolution_writer/_types.js';
import { isRecord } from '../json.js';
import type { Json } from '../json.js';
import { PatchChain } from '../patch/patchChain.js';
import type { Patch } from '../patch/types.js';
import {
  HARNESS_COLLECTION,
  HarnessDefinition,
  harness_collection,
} from './definition.js';

/** 仓库存储最小契约：records 通道读/写 + 全量列举（宿主 Storage 全量实现
 *  天然满足；seam 化免去测试侧实现完整 Storage 大接口）。 */
export interface HarnessStorage extends EvolutionStorage {
  list_records(collection: string): Promise<Record<string, unknown>[]>;
}

/** HarnessVersion 构造选项。 */
export interface HarnessVersionInit {
  version: number;
  created_at: number;
  note?: string | null;
}

/**
 * harness 版本信息（仓库索引：版本号 + 写入时间 + 说明）。
 * 镜像 Python frozen dataclass：构造后不可变。
 */
export class HarnessVersion {
  readonly version: number;
  readonly created_at: number;
  readonly note: string | null;

  constructor(init: HarnessVersionInit) {
    this.version = init.version;
    this.created_at = init.created_at;
    this.note = init.note ?? null;
    Object.freeze(this);
  }
}

/** HarnessRepository 可选注入面。 */
export interface HarnessRepositoryOptions {
  /** 集 id（注入时集合 = harness:<set_id>；否则回落历史集合名）。 */
  set_id?: string | null;
  /** 时间源（等价 Python time.time）；缺省按确定值 0 落盘（core 零时间
   *  依赖可复现，ledger precedent）。 */
  now?: () => number;
}

/**
 * harness 仓库（存储后盾）：定义 = 补丁链数据，版本可回退。
 */
export class HarnessRepository {
  readonly _storage: HarnessStorage;
  /** 当前写入集合名（守卫豁免上下文按此名放行）。 */
  readonly _collection: string;
  /** 旧集合只读回退（仅当当前集合不是历史名时启用）。 */
  readonly _legacy_collection: string | null;
  readonly _writer: DefaultEvolutionWriter;
  readonly _now: () => number;

  constructor(
    storage: HarnessStorage,
    collection: string | null = null,
    options: HarnessRepositoryOptions = {},
  ) {
    this._storage = storage;
    // 集合名优先级：显式 collection > set_id 派生 > 历史默认名
    if (collection !== null && collection !== undefined) {
      this._collection = collection;
    } else if (options.set_id !== null && options.set_id !== undefined) {
      this._collection = harness_collection(options.set_id);
    } else {
      this._collection = HARNESS_COLLECTION;
    }
    // 旧集合只读回退（仅当当前集合不是历史名时启用）
    this._legacy_collection =
      this._collection !== HARNESS_COLLECTION ? HARNESS_COLLECTION : null;
    this._writer = new DefaultEvolutionWriter(storage);
    this._now = options.now ?? ((): number => 0);
  }

  /** 当前写入集合名（守卫豁免上下文按此名放行）。 */
  get collection(): string {
    return this._collection;
  }

  /**
   * 读链记录（按集集合优先；无记录时回落历史集合——只读兼容）。
   *
   * 写通迁移：命中旧集合回退时，将链记录与版本索引复制进按集集合
   * （幂等），使旧集合逐渐排空；保留只读回退作为兜底。
   */
  async _get_chain_record(name: string): Promise<Record<string, unknown> | null> {
    const record = await this._storage.get_record(this._collection, this._chain_key(name));
    if (record === null && this._legacy_collection !== null) {
      const legacy = await this._storage.get_record(
        this._legacy_collection,
        this._chain_key(name),
      );
      if (legacy !== null) {
        await this._migrate_legacy_record(name, legacy);
        return legacy;
      }
    }
    return record;
  }

  /**
   * 写通迁移：将旧集合的链记录与版本索引复制进按集集合（幂等）。
   *
   * 迁移失败（如旁路写防护拦截）静默跳过不阻断读取——后续 save 在
   * allow_mechanism 上下文中写入时自然完成迁移（Python 记 warning；
   * TS core 零日志，以静默表达同一「不阻断」语义）。
   */
  async _migrate_legacy_record(name: string, legacy_chain: Record<string, unknown>): Promise<void> {
    try {
      const existing = await this._storage.get_record(
        this._collection,
        this._chain_key(name),
      );
      if (existing !== null) return;
      await this._storage.put_record(this._collection, this._chain_key(name), legacy_chain);
      const legacy_versions = await this._storage.get_record(
        this._legacy_collection as string,
        this._versions_key(name),
      );
      if (legacy_versions !== null) {
        await this._storage.put_record(
          this._collection,
          this._versions_key(name),
          legacy_versions,
        );
      }
    } catch {
      // 迁移失败只跳过：旧集合仍作只读兜底（Python warning 语义）
    }
  }

  _chain_key(name: string): string {
    return `chain:${name}`;
  }

  /** 版本索引记录键（Python 以 staticmethod 承载；TS 实例化便于与
   *  _chain_key 同形调用）。 */
  _versions_key(name: string): string {
    return `versions:${name}`;
  }  /**
   * 写入新版本（首版 = 链 base，后续 = append 替换补丁）。
   *
   * @returns 新版本号。
   */
  async save(
    definition: HarnessDefinition,
    options: { note?: string | null } = {},
  ): Promise<number> {
    const note = options.note ?? null;
    // 旧集合链记录经只读回退取用：写入落按集集合（版本号接续旧链，
    // 首次写入即完成该 harness 的「按集迁移」，旧记录原地保留）
    const chain_record = await this._get_chain_record(definition.name);
    let chain: PatchChain;
    let version: number;
    if (chain_record === null) {
      chain = new PatchChain({
        definition: definition.to_dict() as unknown as Json,
      });
      version = 1;
    } else {
      chain = PatchChain.from_dict(
        chain_record as unknown as Parameters<typeof PatchChain.from_dict>[0],
      );
      const patch: Patch = {
        op: 'replace',
        path: ['definition'],
        value: definition.to_dict() as unknown as Json,
      };
      chain.apply(patch);
      // 版本号 = 补丁数 + 1（首版 = base 无补丁；每次演进 append 一条
      // 替换补丁，旧版本经补丁链 partial 组装还原）
      version = chain.patches.length + 1;
    }
    await harness_writer(
      this._writer,
      this._collection,
      this._chain_key(definition.name),
      chain.to_dict() as unknown as EvolutionRecord,
      { asset_id: definition.name, note },
    );
    const versions = await this._get_versions_record(definition.name);
    const entries = Array.isArray(versions)
      ? [...(versions as unknown as Array<Record<string, unknown>>)]
      : [];
    entries.push({
      version,
      created_at: this._now(),
      note,
    });
    await this._writer.write(
      this._collection,
      this._versions_key(definition.name),
      entries as unknown as EvolutionRecord,
      {
        kind: 'harness',
        asset_id: `versions:${definition.name}`,
        note: 'version_index',
      },
    );
    return version;
  }

  /**
   * 按名取定义（缺省最新版本；version = 回退/审计指定版本）。
   *
   * 回退 = 组装到指定版本（补丁链 partial 组装，不物理删除历史）。
   */
  async get(
    name: string,
    options: { version?: number | null } = {},
  ): Promise<HarnessDefinition | null> {
    const version = options.version ?? null;
    const chain_record = await this._get_chain_record(name);
    if (chain_record === null) return null;
    const chain = PatchChain.from_dict(
      chain_record as unknown as Parameters<typeof PatchChain.from_dict>[0],
    );
    let doc: { [key: string]: Json };
    if (version !== null) {
      if (version < 1 || version > chain.patches.length + 1) return null;
      doc =
        version === 1
          ? chain.assemble('base_only')
          : chain.assemble('partial', 0, version - 1);
    } else {
      doc = chain.assemble();
    }
    const raw = doc['definition'];
    return raw !== undefined && raw !== null && isRecord(raw)
      ? HarnessDefinition.from_dict(raw)
      : null;
  }

  /** 版本清单（升序：1 → 最新，含时间与说明）。 */
  async versions(name: string): Promise<HarnessVersion[]> {
    const versions = await this._get_versions_record(name);
    const rows = Array.isArray(versions)
      ? (versions as unknown as Array<Record<string, unknown>>)
      : [];
    return rows.map((entry) => {
      const rawCreated = entry['created_at'];
      const created_at =
        rawCreated !== undefined && rawCreated !== null && Number(rawCreated) !== 0
          ? Number(rawCreated)
          : this._now();
      return new HarnessVersion({
        version: Number(entry['version']),
        created_at,
        note: (entry['note'] as string | null | undefined) ?? null,
      });
    });
  }

  /**
   * 读版本索引（按集集合优先；无记录时回落历史集合——只读兼容）。
   * 返回形态不定（版本索引 = entries 清单数组），由调用方按 Array 判定。
   */
  async _get_versions_record(name: string): Promise<unknown> {
    const versions = await this._storage.get_record(
      this._collection,
      this._versions_key(name),
    );
    if (versions === null && this._legacy_collection !== null) {
      return this._storage.get_record(this._legacy_collection, this._versions_key(name));
    }
    return versions;
  }

  /**
   * 全量定义（各 harness 最新版本）。
   *
   * 仓库记录 = 补丁链数据：列表按链组装当前形态（版本演进后返回最新
   * 定义）；非链记录（版本索引表等）跳过。旧集合记录经只读回退并入
   * （同名以按集集合为准——迁移后新链权威）。
   */
  async list(): Promise<HarnessDefinition[]> {
    const definitions = new Map<string, HarnessDefinition>();
    const collections = [this._collection];
    if (this._legacy_collection !== null) {
      // 历史集合后读：同名不覆盖按集集合的新链（新链权威）
      collections.push(this._legacy_collection);
    }
    for (const collection of collections) {
      const records = await this._storage.list_records(collection);
      for (const record of records) {
        if (!isRecord(record) || !('base' in record)) continue;
        const chain = PatchChain.from_dict(
          record as unknown as Parameters<typeof PatchChain.from_dict>[0],
        );
        const doc = chain.assemble();
        const raw = doc['definition'];
        if (raw === undefined || raw === null || !isRecord(raw)) continue;
        const parsed = HarnessDefinition.from_dict(raw);
        if (!definitions.has(parsed.name)) definitions.set(parsed.name, parsed);
      }
    }
    return [...definitions.values()];
  }
}
