/**
 * 事件类型注册表：注册/枚举/重复与配额门禁/发射判定/合成 system_events/
 * 随集持久化（seam）。发射宽松：未注册不阻断 + 折叠兜底，schema 违规仅
 * 宽松标记。持久化经 seams（records 读取 + 写入器）表达，写入走宿主注入
 * 的补丁链守卫通道（evolution_writer seam 就绪前以最小写接口承接）。
 */

import { GraphDefinitionError } from '../errors.js';
import { SchemaValidator } from '../schema/schemaValidator.js';
import {
  COLLECTION_EVENT_TYPES,
  DEFAULT_MAX_EVENT_TYPES,
  EVENT_STATUS_REGISTERED,
  EVENT_STATUS_UNKNOWN,
  EventTypeSpec,
  EventVerdict,
  event_types_collection,
} from './eventTypeSpec.js';
import type { EventTypeRegistryLike } from './registryTypes.js';

export type { EventTypeRegistryLike };

export interface EventTypeRecordsStore {
  list_records(collection: string): Promise<Record<string, unknown>[]>;
}

export interface EventTypeSpecWriter {
  write(collection: string, name: string, data: Record<string, unknown>): Promise<void>;
}

export interface EventTypeRegistryOptions {
  recordsStore?: EventTypeRecordsStore;
  writer?: EventTypeSpecWriter;
  set_id?: string;
  max_types?: number;
}

export class EventTypeRegistry implements EventTypeRegistryLike {
  #specs = new Map<string, EventTypeSpec>();
  #recordsStore?: EventTypeRecordsStore;
  #writer?: EventTypeSpecWriter;
  #setId: string;
  readonly collection: string;
  readonly maxTypes: number;

  constructor(opts: EventTypeRegistryOptions = {}) {
    this.#recordsStore = opts.recordsStore;
    this.#writer = opts.writer;
    this.#setId = opts.set_id ?? '-';
    this.collection = event_types_collection(this.#setId);
    this.maxTypes = opts.max_types ?? DEFAULT_MAX_EVENT_TYPES;
  }

  register(spec: EventTypeSpec): void {
    if (this.#specs.has(spec.name)) {
      throw new GraphDefinitionError(`事件类型重复注册: ${spec.name}`);
    }
    if (this.#specs.size >= this.maxTypes) {
      throw new GraphDefinitionError(
        `事件类型数量已达配额上限（${this.maxTypes}）: 须合并/废弃既有类型后重提`,
      );
    }
    this.#specs.set(spec.name, spec);
  }

  unregister(name: string): void {
    if (!this.#specs.has(name)) {
      throw new GraphDefinitionError(`事件类型未注册: ${name}`);
    }
    this.#specs.delete(name);
  }

  get(name: string): EventTypeSpec | null {
    return this.#specs.get(name) ?? null;
  }

  names(): string[] {
    return [...this.#specs.keys()];
  }

  specs(): EventTypeSpec[] {
    return [...this.#specs.values()];
  }

  classify(etype: string, payload: Record<string, unknown>): EventVerdict {
    const spec = this.#specs.get(etype);
    if (spec === undefined) {
      return new EventVerdict(EVENT_STATUS_UNKNOWN, [], true);
    }
    let violations: string[] = [];
    if (spec.schema !== null) {
      violations = new SchemaValidator().validate(spec.schema, payload);
    }
    return new EventVerdict(EVENT_STATUS_REGISTERED, violations, !spec.renderer);
  }

  system_events(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const [name, spec] of this.#specs) if (spec.system) out.add(name);
    return out;
  }

  /** 从存储加载集内事件类型（读取顺序：按集集合 → 历史集合；脏记录跳过）。 */
  async load(): Promise<number> {
    if (this.#recordsStore === undefined) return 0;
    let loaded = 0;
    for (const collection of [this.collection, COLLECTION_EVENT_TYPES]) {
      const records = await this.#recordsStore.list_records(collection);
      for (const record of records) {
        const name = record['name'];
        if (!name || typeof name !== 'string' || this.#specs.has(name)) continue;
        let spec: EventTypeSpec;
        try {
          spec = EventTypeSpec.from_dict(record);
        } catch {
          continue; // 脏记录跳过不阻断启动
        }
        this.#specs.set(name, spec);
        loaded += 1;
      }
    }
    return loaded;
  }

  /** 全量落库（只写按集集合；无存储/写器 = 跳过）。 */
  async save(): Promise<void> {
    if (this.#writer === undefined) return;
    for (const spec of this.#specs.values()) {
      await this.#writer.write(this.collection, spec.name, spec.to_dict());
    }
  }
}
