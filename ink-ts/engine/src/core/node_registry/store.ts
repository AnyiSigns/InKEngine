/**
 * 结点类型注册表数据存储（声明式登记 + 受控持久写 + 治理回写 seam）。
 *
 * 决策 4：结点类型注册 = 注册表数据——boot 种子登记、运行期 register 持久登记、
 * 重启从集合恢复；池治理 disable/archive/建议经本 store 经受控通道回写登记行
 * （守卫 + EvolutionWriter 补丁链 + set_audit 审计，见 runtime 装配注入的 write
 * seam）。本模块只持有登记行数据与受控写，不含执行体注册逻辑（运行时恢复由
 * Runtime 装配面执行）。
 */

import { NodeContract } from '../contracts/contracts.js';
import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';
import {
  NodeRegistration,
  type NodeRegistrationInit,
  type NodeRegistrationSuggestion,
} from './types.js';

/** 登记行读取源（records 通道 list 语义）。 */
export interface NodeRegistryRecordsSource {
  list_records(collection: string): Promise<Record<string, unknown>[]>;
}

/** 登记行受控写 seam（runtime 注入 EvolutionWriter 管线实现；写 = 补丁链 +
 *  实时数据落库 + set_audit 审计留痕）。 */
export type NodeRegistryWrite = (
  collection: string,
  type_name: string,
  data: Record<string, unknown>,
  note: string,
) => Promise<void>;

/** NodeRegistryStore 构造选项。 */
export interface NodeRegistryStoreOptions {
  /** 登记集合（`node_registry:<set_id>`）。 */
  collection: string;
  /** 登记行读取源（只读）。 */
  records: NodeRegistryRecordsSource;
  /** 受控写 seam（缺省 null = 只读 store，禁用 register/disable 等写动作）。 */
  write?: NodeRegistryWrite | null;
  /** 时间源（epoch 秒；缺省确定值 0——时间戳为登记数据副作用）。 */
  now?: (() => number) | null;
  /** 加载期跳过诊断（畸形/重复行；缺省静默跳过不阻断启动）。 */
  on_skip?: ((type_name: string, reason: string) => void) | null;
}

/**
 * 声明式结点类型注册表 store：load 恢复登记行，register/disable/archive/
 * suggest 经受控写 seam 持久并同步内存视图。幂等约束：已存在类型重复注册拒绝
 * （防静默覆盖语义，与 NodeTypeRegistry 一致）；disable/archive 对缺失/非
 * active 行 no-op（治理写幂等）。
 */
export class NodeRegistryStore {
  readonly collection: string;
  readonly #records: NodeRegistryRecordsSource;
  readonly #write: NodeRegistryWrite | null;
  readonly #now: () => number;
  readonly #onSkip: ((type_name: string, reason: string) => void) | null;
  #rows = new Map<string, NodeRegistration>();
  #loaded = false;

  constructor(options: NodeRegistryStoreOptions) {
    this.collection = options.collection;
    this.#records = options.records;
    this.#write = options.write ?? null;
    this.#now = options.now ?? (() => 0);
    this.#onSkip = options.on_skip ?? null;
  }

  /** 是否已从集合 load（未 load 直接读 = 空视图）。 */
  get loaded(): boolean {
    return this.#loaded;
  }

  /** 登记行数量（含 disabled/archived）。 */
  get size(): number {
    return this.#rows.size;
  }

  /** 按类型名取登记行（未知类型 = null）。 */
  get(type_name: string): NodeRegistration | null {
    return this.#rows.get(type_name) ?? null;
  }

  has(type_name: string): boolean {
    return this.#rows.has(type_name);
  }

  /** 全量登记行（含 disabled/archived；记录序）。 */
  list(): NodeRegistration[] {
    return [...this.#rows.values()];
  }

  /** 活跃登记行（status=active；契约池/执行体注册的数据视图）。 */
  active(): NodeRegistration[] {
    return this.list().filter((reg) => reg.is_active());
  }

  /** 活跃类型名（契约池/治理可见清单）。 */
  active_type_names(): string[] {
    return this.active().map((reg) => reg.type_name);
  }

  /** 从集合恢复登记行（幂等：重复调用重置为集合快照）。 */
  async load(): Promise<number> {
    const rows = new Map<string, NodeRegistration>();
    let loaded = 0;
    for (const record of await this.#records.list_records(this.collection)) {
      if (!isRecord(record)) {
        this.#onSkip?.('', '畸形登记行（非 dict）');
        continue;
      }
      const rawType = record['type_name'];
      const type_name = typeof rawType === 'string' ? rawType : '';
      try {
        const reg = NodeRegistration.from_dict(record);
        if (rows.has(reg.type_name)) {
          this.#onSkip?.(reg.type_name, '重复登记行（保留首行）');
          continue;
        }
        rows.set(reg.type_name, reg);
        loaded += 1;
      } catch (exc) {
        this.#onSkip?.(type_name, `登记行反序列化失败（跳过）: ${String(exc)}`);
      }
    }
    this.#rows = rows;
    this.#loaded = true;
    return loaded;
  }

  /** 缺省写 seam 缺装配即抛（只读 store 的写动作显式拒绝）。 */
  #writer(): NodeRegistryWrite {
    if (this.#write === null) {
      throw new GraphDefinitionError(
        `结点类型登记写通道未装配（只读 store）: ${this.collection}`,
      );
    }
    return this.#write;
  }

  async #persist(reg: NodeRegistration, note: string): Promise<void> {
    await this.#writer()(this.collection, reg.type_name, reg.to_dict(), note);
    this.#rows.set(reg.type_name, reg);
  }

  /** 持久登记一条新类型（已存在 = 重复注册拒绝，防静默覆盖）。 */
  async register(init: NodeRegistrationInit, note = ''): Promise<NodeRegistration> {
    if (this.#rows.has(init.type_name)) {
      throw new GraphDefinitionError(`结点类型重复登记: ${init.type_name}`);
    }
    const ts = this.#now();
    const reg = new NodeRegistration({ ...init, registered_at: ts, updated_at: ts });
    await this.#persist(reg, note);
    return reg;
  }

  /** boot 种子登记（已存在 = 跳过，保留既有登记与治理状态）。 */
  async ensure_seed(init: NodeRegistrationInit, note = ''): Promise<boolean> {
    const existing = this.#rows.get(init.type_name);
    if (existing !== undefined) return false;
    const ts = this.#now();
    const reg = new NodeRegistration({ ...init, registered_at: ts, updated_at: ts });
    await this.#persist(reg, note);
    return true;
  }

  /** 升版种子登记数据（仅覆盖契约/缺省配置/执行体绑定；状态与治理建议保留）。 */
  async refresh_seed(init: NodeRegistrationInit, note = ''): Promise<void> {
    const existing = this.#rows.get(init.type_name);
    if (existing === undefined) return;
    const reg = new NodeRegistration({
      ...init,
      provenance: existing.provenance,
      status: existing.status,
      archived_reason: existing.archived_reason,
      suggestion: existing.suggestion,
      registered_at: existing.registered_at,
      updated_at: this.#now(),
    });
    await this.#persist(reg, note);
  }

  /** 治理 disable（淘汰 dead 候选；受控回写登记，执行体由装配面卸载）。 */
  async disable(type_name: string, reason: string, note = ''): Promise<void> {
    const existing = this.#rows.get(type_name);
    if (existing === undefined || !existing.is_active()) return;
    const reg = new NodeRegistration({
      ...existing,
      status: 'disabled',
      archived_reason: reason,
      provenance: existing.provenance === 'seed' ? 'governance' : existing.provenance,
      updated_at: this.#now(),
    });
    await this.#persist(reg, note);
  }

  /** 治理 archive（归档淘汰；登记行保留可追溯）。 */
  async archive(type_name: string, reason: string, note = ''): Promise<void> {
    const existing = this.#rows.get(type_name);
    if (existing === undefined || !existing.is_active()) return;
    const reg = new NodeRegistration({
      ...existing,
      status: 'archived',
      archived_reason: reason,
      provenance: existing.provenance === 'seed' ? 'governance' : existing.provenance,
      updated_at: this.#now(),
    });
    await this.#persist(reg, note);
  }

  /** 治理修复建议字段写入（replace/merge 目标留在数据，提案路径确认）。 */
  async suggest(
    type_name: string,
    suggestion: NodeRegistrationSuggestion,
    note = '',
  ): Promise<void> {
    const existing = this.#rows.get(type_name);
    if (existing === undefined) return;
    const reg = new NodeRegistration({
      ...existing,
      suggestion: { ...existing.suggestion, ...suggestion, ts: this.#now() },
      updated_at: this.#now(),
    });
    await this.#persist(reg, note);
  }

  /** 覆盖整行（装配面内部用；不校验状态——调用方负责语义）。 */
  async replace(init: NodeRegistrationInit, note = ''): Promise<void> {
    const existing = this.#rows.get(init.type_name);
    const ts = this.#now();
    const reg = new NodeRegistration({
      ...init,
      registered_at: existing?.registered_at ?? ts,
      updated_at: ts,
    });
    await this.#persist(reg, note);
  }
}

/** 登记行产出 schema 字段名集（唯一排序；治理合并判定的字段面）。 */
export function registration_output_fields(reg: NodeRegistration): string[] {
  const contract = reg.contract;
  if (contract === null || contract.output_schema === null) return [];
  const rawFields = (contract.output_schema as unknown as { fields?: unknown }).fields;
  if (!Array.isArray(rawFields)) return [];
  const names: string[] = [];
  for (const field of rawFields) {
    if (isRecord(field) && typeof field['name'] === 'string') {
      names.push(field['name'] as string);
    }
  }
  return [...new Set(names)].sort();
}

export type { NodeContract, NodeRegistrationInit, NodeRegistrationSuggestion };
