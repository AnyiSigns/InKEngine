/**
 * 事件类型数据形态：EventTypeSpec（声明式数据，随补丁链版本化/回退）与
 * EventVerdict（发射判定结果）。事件信封是机制（外层字段稳定），事件类型
 * 是数据——AI 可演化；注册表是增强不是收紧（未注册宽松允许 + 折叠兜底）。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';
import { SchemaSpec } from '../schema/schemaValidator.js';

export const EVENT_STATUS_REGISTERED = 'registered';
export const EVENT_STATUS_UNKNOWN = 'unknown';

export const DEFAULT_MAX_EVENT_TYPES = 200;

export const DEFAULT_ATTACHMENT_EVENT_NAME = 'attachment';
export const DEFAULT_ATTACHMENT_RENDERER = 'AttachmentRow';

const COLLECTION_EVENT_TYPES = 'event_types';
export const EVENT_TYPES_COLLECTION_PREFIX = 'event_types:';

export function event_types_collection(set_id: string): string {
  return `${EVENT_TYPES_COLLECTION_PREFIX}${set_id}`;
}

export { COLLECTION_EVENT_TYPES };

export class EventTypeSpec {
  readonly name: string;
  readonly schema: SchemaSpec | null;
  readonly renderer: string;
  readonly system: boolean;
  readonly meta: Record<string, unknown>;

  constructor(init: {
    name: string;
    schema?: SchemaSpec | null;
    renderer?: string;
    system?: boolean;
    meta?: Record<string, unknown>;
  }) {
    this.name = init.name;
    this.schema = init.schema ?? null;
    this.renderer = init.renderer ?? '';
    this.system = init.system ?? false;
    this.meta = { ...(init.meta ?? {}) };
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = { name: this.name, system: this.system };
    if (this.schema !== null) data['schema'] = this.schema.to_dict();
    if (this.renderer) data['renderer'] = this.renderer;
    if (Object.keys(this.meta).length > 0) data['meta'] = { ...this.meta };
    return data;
  }

  static from_dict(data: unknown): EventTypeSpec {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`事件类型声明非法: 期望 dict，收到 ${typeof data}`);
    }
    const name = data['name'];
    if (!name || typeof name !== 'string') {
      throw new GraphDefinitionError('事件类型声明缺 name（字符串）');
    }
    const rawSchema = data['schema'];
    const schema = rawSchema === undefined || rawSchema === null ? null : SchemaSpec.from_dict(rawSchema);
    const renderer = data['renderer'];
    if (renderer !== undefined && renderer !== null && typeof renderer !== 'string') {
      throw new GraphDefinitionError(`事件类型 ${name} 的 renderer 须为字符串`);
    }
    const meta = data['meta'];
    if (meta !== undefined && meta !== null && !isRecord(meta)) {
      throw new GraphDefinitionError(`事件类型 ${name} 的 meta 须为 dict`);
    }
    return new EventTypeSpec({
      name,
      schema,
      renderer: typeof renderer === 'string' ? renderer : '',
      system: data['system'] === true,
      meta: (meta ?? {}) as Record<string, unknown>,
    });
  }
}

export class EventVerdict {
  readonly status: string;
  readonly violations: readonly string[];
  readonly fold: boolean;

  constructor(status: string, violations: readonly string[] = [], fold = false) {
    this.status = status;
    this.violations = violations;
    this.fold = fold;
  }
}
