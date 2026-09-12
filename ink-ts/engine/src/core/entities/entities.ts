/**
 * 实体注册表（协作者目录：可复用、可演化的执行单元）。
 *
 * 实体 = 数据（EntitySpec：id/label/persona/model/meta/role），随补丁链版本化/回退
 * （PatchKind.ENTITY → propose_patch/apply_patch → 审批卡 → 注册表生效）。
 * 运行 = 子图食谱经 spawn 物化为路径实例——本模块只承载声明形态与注册表，
 * 机制层零执行语义、零领域词。
 *
 * 作用域目录资产映射（执行模型的目录资产落位）：本目录同时充当**作用域目录**
 * ——作用域资产 = 携带可选 `scope` 声明块的实体记录（同一集合、同一受控注册
 * 通道：EvolutionWriter + GuardedStorage）。role 字段命名作用域身份
 * （main/planner/coder/critic/searcher/tester/collaborator/subagent，出厂词汇
 * 见 core/scopes/scope_spec.ts），persona/model/label/meta 即作用域身份主体，
 * `scope` 声明块承载实体字段未建模的执行维度（可用能力/规则权限/成本档/
 * 输入输出契约/登记审批档，类型与解析见 core/scopes）。旧记录无 `scope` =
 * 非作用域资产的普通实体，序列化零漂移。
 *
 * 实体复用当前 agent 全部机制：
 * - 工具全量共享：无 tools 字段；
 * - 模型按 model 引用（{provider, model_id}；None = 会话默认模型），窗口参数
 *   一律按该模型档案 context_window（不做角色槽推断）；
 * - persona 独立（每实体系统提示词不共用）；身份引导走每轮注入的参与者清单，
 *   Message.name 仅承担展示/留痕；
 * - 知识单份共享（KnowledgeSet 三级分层），实体不分割知识库。
 *
 * 配额：实体数量上限（防 AI 提案失控）；超限显式拒绝。持久化经 EvolutionWriter
 * 管线（补丁链 + 实时写 + 审计留痕三重闸门）。
 */

import { GraphDefinitionError } from '../../model/errors.js';
import type { EvolutionRecord, EvolutionWriter } from '../../evolve/proposal/evolution_writer/_types.js';
import { entity_writer } from '../../evolve/proposal/evolution_writer/evolution_writer.js';
import { isRecord } from '../../model/json.js';
import {
  parse_scope_decl,
  scope_decl_to_dict,
  type ScopeDecl,
} from '../../model/scopes/scope_spec.js';

export const DEFAULT_MAX_ENTITIES = 200;
export const ENTITY_ID_MAX_LENGTH = 48;
export const ENTITIES_COLLECTION_PREFIX = 'entities:';

/** 实体角色缺省值（实体收敛 agent 类结点的 role 前；无显式 role = 协作者）。 */
export const DEFAULT_ENTITY_ROLE = 'collaborator';

/** 受控下架标记（meta.retired=true）：作用域资产「下架同通道」的软删除——
 *  记录保留可审计/可回退，加载跳过（与池治理归档 archived 标记并列，见
 *  load 跳过条件）。 */
export const RETIRED_META_KEY = 'retired';
/** 下架记录默认归属域（写 retire_entity_record 的 retired_domain 缺省）。 */
export const ENTITY_RETIRED_DOMAIN = 'controlled_evolution';

export function entity_collection(set_id: string): string {
  return `${ENTITIES_COLLECTION_PREFIX}${set_id}`;
}

/** 构造受控下架记录（实体声明 + meta 追加下架标记与原因；供受控演化
 *  应用管线持久化使用——持久化先于活跃表移除，重启 load 跳过不复活）。 */
export function retire_entity_record(
  spec: EntitySpec,
  extra: { reason?: string | null; domain?: string } = {},
): Record<string, unknown> {
  const data = spec.to_dict();
  const meta: Record<string, unknown> = { ...(spec.meta ?? {}) };
  meta[RETIRED_META_KEY] = true;
  meta['retired_reason'] = extra.reason ?? '';
  meta['retired_domain'] = extra.domain ?? ENTITY_RETIRED_DOMAIN;
  data['meta'] = meta;
  return data;
}

export interface EntityRecordsStore {
  list_records(collection: string): Promise<Record<string, unknown>[]>;
}

export interface EntityRegistryOptions {
  recordsStore?: EntityRecordsStore;
  writer?: EvolutionWriter;
  set_id?: string;
  max_entities?: number;
  /** 加载期跳过诊断（重复/畸形/超配额）；缺省 = 静默跳过不阻断启动。 */
  on_skip?: (reason: 'duplicate' | 'malformed' | 'quota', entity_id: string) => void;
}

export class EntitySpec {
  readonly id: string;
  readonly label: string;
  readonly persona: string;
  readonly model: Record<string, string> | null;
  readonly meta: Record<string, unknown>;
  /** 实体角色（默认 'collaborator'；实体收敛 agent 结点后可演化）。
   *  作用域资产场景下 role 同时命名目录身份（planner/critic/...）。 */
  readonly role: string;
  /** 作用域资产声明块（null = 非作用域资产的普通实体；解析见
   *  core/scopes/scope_spec.ts）。 */
  readonly scope: ScopeDecl | null;

  constructor(init: {
    id: string;
    label?: string;
    persona?: string;
    model?: Record<string, string> | null;
    meta?: Record<string, unknown>;
    role?: string;
    scope?: ScopeDecl | null;
  }) {
    this.id = init.id;
    this.label = init.label ?? '';
    this.persona = init.persona ?? '';
    this.model = init.model ?? null;
    this.meta = { ...(init.meta ?? {}) };
    this.role = init.role ?? DEFAULT_ENTITY_ROLE;
    // 深拷贝 + 归一（防构造方/演化复用同一声明块实例被就地改写——seed 素材
    // 反复构造即因此保「每次返回新鲜数据」）
    this.scope =
      init.scope === undefined || init.scope === null
        ? null
        : parse_scope_decl(scope_decl_to_dict(init.scope));
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = { id: this.id };
    if (this.label) data['label'] = this.label;
    if (this.persona) data['persona'] = this.persona;
    if (this.model) data['model'] = { ...this.model };
    if (Object.keys(this.meta).length > 0) data['meta'] = { ...this.meta };
    // 缺省 role 不落序列化（旧记录/既有输出形状不变；反序列化按缺省回落）
    if (this.role && this.role !== DEFAULT_ENTITY_ROLE) data['role'] = this.role;
    if (this.scope !== null) data['scope'] = scope_decl_to_dict(this.scope);
    return data;
  }

  static from_dict(data: unknown): EntitySpec {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`实体声明非法: 期望 dict，收到 ${typeof data}`);
    }
    const entity_id = data['id'];
    if (!entity_id || typeof entity_id !== 'string') {
      throw new GraphDefinitionError('实体声明缺 id（字符串）');
    }
    const violations = _validate_entity_id(entity_id);
    if (violations.length > 0) {
      throw new GraphDefinitionError(
        `实体 id 命名非法 ${JSON.stringify(entity_id)}: ${violations.join('；')}`,
      );
    }
    const label = data['label'];
    if (label !== undefined && typeof label !== 'string') {
      throw new GraphDefinitionError(`实体 ${entity_id} 的 label 须为字符串`);
    }
    const persona = data['persona'];
    if (persona !== undefined && typeof persona !== 'string') {
      throw new GraphDefinitionError(`实体 ${entity_id} 的 persona 须为字符串`);
    }
    const rawRole = data['role'];
    if (rawRole !== undefined && typeof rawRole !== 'string') {
      throw new GraphDefinitionError(`实体 ${entity_id} 的 role 须为字符串`);
    }
    let model: Record<string, string> | null = null;
    const rawModel = data['model'];
    if (rawModel !== undefined && rawModel !== null) {
      if (!isRecord(rawModel)) {
        throw new GraphDefinitionError(`实体 ${entity_id} 的 model 须为 dict`);
      }
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawModel)) {
        if (v) cleaned[k] = String(v);
      }
      model = Object.keys(cleaned).length > 0 ? cleaned : null;
    }
    let meta: Record<string, unknown> = {};
    const rawMeta = data['meta'];
    if (rawMeta !== undefined && rawMeta !== null) {
      if (!isRecord(rawMeta)) {
        throw new GraphDefinitionError(`实体 ${entity_id} 的 meta 须为 dict`);
      }
      meta = { ...rawMeta };
    }
    let scope: ScopeDecl | null = null;
    if (data['scope'] !== undefined && data['scope'] !== null) {
      scope = parse_scope_decl(data['scope']);
    }
    return new EntitySpec({
      id: entity_id,
      label: label ?? '',
      persona: persona ?? '',
      model,
      meta,
      role: rawRole === undefined ? DEFAULT_ENTITY_ROLE : (rawRole as string),
      scope,
    });
  }
}

function _validate_entity_id(entity_id: string): string[] {
  const violations: string[] = [];
  if (entity_id.length > ENTITY_ID_MAX_LENGTH) {
    violations.push(`实体 id 超长（>${ENTITY_ID_MAX_LENGTH} 字符）`);
  }
  for (const ch of entity_id) {
    const code = ch.charCodeAt(0);
    if (code < 32 || /\s/.test(ch)) {
      violations.push('实体 id 不得含空白或控制字符');
      break;
    }
  }
  return violations;
}

export class EntityRegistry {
  #specs = new Map<string, EntitySpec>();
  #recordsStore?: EntityRecordsStore;
  #writer?: EvolutionWriter;
  #onSkip?: (reason: 'duplicate' | 'malformed' | 'quota', entity_id: string) => void;
  #setId: string;
  readonly collection: string;
  readonly maxEntities: number;

  constructor(opts: EntityRegistryOptions = {}) {
    this.#recordsStore = opts.recordsStore;
    this.#writer = opts.writer;
    this.#setId = opts.set_id ?? '-';
    this.collection = entity_collection(this.#setId);
    this.maxEntities = opts.max_entities ?? DEFAULT_MAX_ENTITIES;
    this.#onSkip = opts.on_skip;
  }

  register(spec: EntitySpec): void {
    if (this.#specs.has(spec.id)) {
      throw new GraphDefinitionError(`实体重复注册: ${spec.id}`);
    }
    if (this.#specs.size >= this.maxEntities) {
      throw new GraphDefinitionError(
        `实体数量已达配额上限（${this.maxEntities}）: 须合并/废弃既有实体后重提`,
      );
    }
    this.#specs.set(spec.id, spec);
  }

  unregister(entity_id: string): void {
    if (!this.#specs.has(entity_id)) {
      throw new GraphDefinitionError(`实体未注册: ${entity_id}`);
    }
    this.#specs.delete(entity_id);
  }

  replace(spec: EntitySpec): void {
    if (!this.#specs.has(spec.id)) {
      throw new GraphDefinitionError(`实体未注册（演化不代创建）: ${spec.id}`);
    }
    this.#specs.set(spec.id, spec);
  }

  get(entity_id: string): EntitySpec | null {
    return this.#specs.get(entity_id) ?? null;
  }

  names(): string[] {
    return [...this.#specs.keys()];
  }

  specs(): EntitySpec[] {
    return [...this.#specs.values()];
  }

  async load(): Promise<number> {
    if (this.#recordsStore === undefined) return 0;
    let loaded = 0;
    for (const record of await this.#recordsStore.list_records(this.collection)) {
      const entity_id = record['id'];
      if (!entity_id || typeof entity_id !== 'string') {
        this.#onSkip?.('malformed', String(entity_id ?? ''));
        continue;
      }
      if (this.#specs.has(entity_id)) {
        this.#onSkip?.('duplicate', entity_id);
        continue;
      }
      if (this.#specs.size >= this.maxEntities) {
        this.#onSkip?.('quota', entity_id);
        continue;
      }
      try {
        const spec = EntitySpec.from_dict(record);
        // 池治理归档留痕（meta.archived=true）与受控下架（meta.retired=true）：
        // 已归档/已下架实体不可复活，加载跳过（软删除，不重建活跃表占用配额）
        if (spec.meta['archived'] === true || spec.meta[RETIRED_META_KEY] === true) continue;
        this.#specs.set(entity_id, spec);
        loaded += 1;
      } catch {
        this.#onSkip?.('malformed', entity_id);
      }
    }
    return loaded;
  }

  async save(): Promise<void> {
    if (this.#writer === undefined) return;
    for (const spec of this.#specs.values()) {
      await entity_writer(this.#writer, this.collection, spec.id, spec.to_dict(), {
        note: 'registry_save',
      });
    }
  }
}
