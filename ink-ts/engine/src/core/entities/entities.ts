/**
 * 实体注册表（协作者目录：可复用、可演化的执行单元）。
 *
 * 实体 = 数据（EntitySpec：id/label/persona/model/meta），随补丁链版本化/回退
 * （PatchKind.ENTITY → propose_patch/apply_patch → 审批卡 → 注册表生效）。
 * 运行 = 子图食谱经 spawn 物化为路径实例——本模块只承载声明形态与注册表，
 * 机制层零执行语义、零领域词。
 *
 * 实体复用当前 agent 全部机制：
 * - 工具全量共享：无 tools 字段；
 * - 模型按 model 引用（{provider, model_id}；None = 会话默认模型），窗口参数
 *   一律按该模型档案 context_window（不做档位推断）；
 * - persona 独立（每实体系统提示词不共用）；身份引导走每轮注入的参与者清单，
 *   Message.name 仅承担展示/留痕；
 * - 知识单份共享（KnowledgeSet 三级分层），实体不分割知识库。
 *
 * 配额：实体数量上限（防 AI 提案失控）；超限显式拒绝。持久化经 EvolutionWriter
 * 管线（补丁链 + 实时写 + 审计留痕三重闸门）。
 */

import { GraphDefinitionError } from '../errors.js';
import type { EvolutionRecord, EvolutionWriter } from '../evolution_writer/_types.js';
import { entity_writer } from '../evolution_writer/evolution_writer.js';
import { isRecord } from '../json.js';

export const DEFAULT_MAX_ENTITIES = 200;
export const ENTITY_ID_MAX_LENGTH = 48;
export const ENTITIES_COLLECTION_PREFIX = 'entities:';

export function entity_collection(set_id: string): string {
  return `${ENTITIES_COLLECTION_PREFIX}${set_id}`;
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

  constructor(init: {
    id: string;
    label?: string;
    persona?: string;
    model?: Record<string, string> | null;
    meta?: Record<string, unknown>;
  }) {
    this.id = init.id;
    this.label = init.label ?? '';
    this.persona = init.persona ?? '';
    this.model = init.model ?? null;
    this.meta = { ...(init.meta ?? {}) };
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = { id: this.id };
    if (this.label) data['label'] = this.label;
    if (this.persona) data['persona'] = this.persona;
    if (this.model) data['model'] = { ...this.model };
    if (Object.keys(this.meta).length > 0) data['meta'] = { ...this.meta };
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
    return new EntitySpec({
      id: entity_id,
      label: label ?? '',
      persona: persona ?? '',
      model,
      meta,
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
