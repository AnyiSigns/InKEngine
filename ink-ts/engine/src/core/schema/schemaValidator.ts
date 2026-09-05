/**
 * Schema 校验器（L1 准入机制件）：SchemaSpec/SchemaField 声明数据形态 +
 * SchemaValidator 执行体。约束取「声明式够用」子集（必填/类型/枚举/数值
 * 范围/正则），未知字段忽略（演进宽容），违规清单可读可审计。
 *
 * FieldKind 值域与 contracts generated endpointTypes.FieldKind 同源
 * （数据面 schema 的 output_field.kind 枚举），type 直接引用该数据面类型，
 * VALID_KINDS 经 satisfies + 编译期集合相等绑定，不维护第二套语义枚举。
 */

import type { FieldKind as ContractFieldKind } from '@ink-ts/contracts';
import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';

export const FIELD_STRING = 'string';
export const FIELD_NUMBER = 'number';
export const FIELD_BOOL = 'boolean';
export const FIELD_OBJECT = 'object';
export const FIELD_ARRAY = 'array';

export const VALID_KINDS = [
  FIELD_STRING,
  FIELD_NUMBER,
  FIELD_BOOL,
  FIELD_OBJECT,
  FIELD_ARRAY,
] as const satisfies readonly ContractFieldKind[];

/** 字段类型联合（数据面单一来源 = contracts FieldKind；值面经
 *  VALID_KINDS 编译期集合相等绑定，任一方向新增类型 → 类型错误）。 */
export type FieldKind = ContractFieldKind;

type _StringSetEqual<A extends string, B extends string> = Exclude<A, B> extends never
  ? Exclude<B, A> extends never
    ? true
    : false
  : false;
const _fieldKindsCoverContract: true = true as _StringSetEqual<
  ContractFieldKind,
  (typeof VALID_KINDS)[number]
>;

const FIELD_DECL_EXAMPLE = '{"name": "<字段名>", "kind": "string"[, "required": true]}';
const SCHEMA_DECL_EXAMPLE = '{"name": "<schema 名>", "fields": [{"name": "<字段名>", "kind": "string"}]}';

export const TOOL_NAME_MAX_LENGTH = 24;
export const TOOL_NAME_FORBIDDEN_CHARS = ['_'] as const;

function repr(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

function reprTuple(items: readonly unknown[]): string {
  return `(${items.map(repr).join(', ')})`;
}

export function validate_tool_name(name: string): string[] {
  if (!name) return ['工具名不能为空'];
  const violations: string[] = [];
  if (name.length > TOOL_NAME_MAX_LENGTH) {
    violations.push(`工具名长度超限: ${name.length} > ${TOOL_NAME_MAX_LENGTH}`);
  }
  for (const forbidden of TOOL_NAME_FORBIDDEN_CHARS) {
    if (name.includes(forbidden)) {
      violations.push(`工具名含禁用字符 ${repr(forbidden)}（命名规范要求短词自然语言）`);
    }
  }
  return violations;
}

export interface SchemaFieldData {
  name: string;
  required: boolean;
  kind: FieldKind;
  enum: readonly string[];
  min: number | null;
  max: number | null;
  pattern: string | null;
}

function toFloatLike(value: unknown): { ok: boolean; value: number } {
  if (typeof value === 'number') return { ok: true, value };
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return { ok: true, value: Number(value) };
  }
  return { ok: false, value: 0 };
}

export class SchemaField {
  readonly name: string;
  readonly required: boolean;
  readonly kind: FieldKind;
  readonly enum: readonly string[];
  readonly min: number | null;
  readonly max: number | null;
  readonly pattern: string | null;

  constructor(init: {
    name: string;
    required?: boolean;
    kind?: FieldKind;
    enum?: readonly string[];
    min?: number | null;
    max?: number | null;
    pattern?: string | null;
  }) {
    this.name = init.name;
    this.required = init.required ?? false;
    this.kind = init.kind ?? FIELD_STRING;
    this.enum = init.enum ?? [];
    this.min = init.min ?? null;
    this.max = init.max ?? null;
    this.pattern = init.pattern ?? null;
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = { name: this.name, kind: this.kind };
    if (this.required) data['required'] = true;
    if (this.enum.length > 0) data['enum'] = [...this.enum];
    if (this.min !== null) data['min'] = this.min;
    if (this.max !== null) data['max'] = this.max;
    if (this.pattern !== null) data['pattern'] = this.pattern;
    return data;
  }

  static from_dict(data: unknown): SchemaField {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`字段声明非法: 期望 dict，收到 ${typeof data}`);
    }
    const name = data['name'];
    if (!name || typeof name !== 'string') {
      throw new GraphDefinitionError(
        `字段声明缺 name（字符串）——字段声明合法形态: ${FIELD_DECL_EXAMPLE}`,
      );
    }
    const kind = (data['kind'] ?? FIELD_STRING) as unknown;
    if (typeof kind !== 'string' || !(VALID_KINDS as readonly string[]).includes(kind)) {
      throw new GraphDefinitionError(
        `字段 ${name} 的类型非法: ${repr(kind)}（仅 ${reprTuple(VALID_KINDS)}）`,
      );
    }
    const enumRaw = data['enum'] ?? [];
    if (!Array.isArray(enumRaw) || !enumRaw.every((item) => typeof item === 'string')) {
      throw new GraphDefinitionError(`字段 ${name} 的 enum 须为字符串清单`);
    }
    const minimum = data['min'] ?? null;
    const maximum = data['max'] ?? null;
    for (const bound of [minimum, maximum]) {
      if (bound !== null && bound !== undefined && !toFloatLike(bound).ok) {
        throw new GraphDefinitionError(`字段 ${name} 的范围边界非法: ${repr(bound)}`);
      }
    }
    const minF = minimum !== null && minimum !== undefined ? toFloatLike(minimum).value : null;
    const maxF = maximum !== null && maximum !== undefined ? toFloatLike(maximum).value : null;
    if (minF !== null && maxF !== null && minF > maxF) {
      throw new GraphDefinitionError(`字段 ${name} 的范围声明自相矛盾: min=${minF} > max=${maxF}`);
    }
    const pattern = data['pattern'] ?? null;
    if (pattern !== null) {
      if (typeof pattern !== 'string') {
        throw new GraphDefinitionError(`字段 ${name} 的 pattern 须为字符串`);
      }
      try {
        new RegExp(pattern);
      } catch (exc) {
        throw new GraphDefinitionError(`字段 ${name} 的正则非法: ${String(exc)}`);
      }
    }
    return new SchemaField({
      name,
      required: data['required'] === true,
      kind: kind as FieldKind,
      enum: [...enumRaw] as string[],
      min: minF,
      max: maxF,
      pattern: pattern as string | null,
    });
  }
}

export class SchemaSpec {
  readonly name: string;
  readonly fields: readonly SchemaField[];

  constructor(init: { name: string; fields?: readonly SchemaField[] }) {
    this.name = init.name;
    this.fields = init.fields ?? [];
  }

  to_dict(): Record<string, unknown> {
    return { name: this.name, fields: this.fields.map((f) => f.to_dict()) };
  }

  static from_dict(data: unknown): SchemaSpec {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`schema 声明非法: 期望 dict，收到 ${typeof data}`);
    }
    const name = data['name'];
    if (!name || typeof name !== 'string') {
      throw new GraphDefinitionError(
        `schema 声明缺 name（字符串）——schema 声明合法形态: ${SCHEMA_DECL_EXAMPLE}`,
      );
    }
    const rawFields = data['fields'];
    if (!Array.isArray(rawFields)) {
      throw new GraphDefinitionError(`schema 声明缺 fields 清单——schema 声明合法形态: ${SCHEMA_DECL_EXAMPLE}`);
    }
    const fields = rawFields.map((raw) => SchemaField.from_dict(raw));
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.name)) throw new GraphDefinitionError(`schema 字段名重复: ${field.name}`);
      seen.add(field.name);
    }
    return new SchemaSpec({ name, fields });
  }
}

function resolvePath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || segment.startsWith('_')) return null;
    if (isRecord(current)) {
      current = current[segment] ?? null;
    } else if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
      current = current[index];
    } else {
      return null;
    }
  }
  return current;
}

function typeNameOf(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (isRecord(value)) return 'dict';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'number') return 'int';
  if (typeof value === 'boolean') return 'bool';
  return typeof value;
}

function typeMismatch(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case FIELD_STRING:
      return typeof value !== 'string';
    case FIELD_NUMBER:
      return typeof value !== 'number' || typeof value === 'boolean';
    case FIELD_BOOL:
      return typeof value !== 'boolean';
    case FIELD_OBJECT:
      return !isRecord(value);
    case FIELD_ARRAY:
      return !Array.isArray(value);
  }
}

export class SchemaValidator {
  validate(schema: SchemaSpec, data: unknown): string[] {
    if (!isRecord(data)) {
      return [`数据对象须为 dict，收到 ${typeNameOf(data)}`];
    }
    const violations: string[] = [];
    for (const field of schema.fields) {
      const value = resolvePath(data, field.name);
      if (value === null || value === undefined) {
        if (field.required) {
          violations.push(`字段 ${field.name} 缺失（必填，期望 ${field.kind} 类型值）`);
        }
        continue;
      }
      if (typeMismatch(field.kind, value)) {
        violations.push(`字段 ${field.name} 类型不匹配: 期望 ${field.kind}，收到 ${typeNameOf(value)}`);
        continue;
      }
      if (field.kind === FIELD_STRING) {
        if (field.enum.length > 0 && !field.enum.includes(value as string)) {
          violations.push(`字段 ${field.name} 取值非法: ${repr(value)}（仅 ${reprTuple(field.enum)}）`);
        }
        if (field.pattern !== null) {
          try {
            const anchored = new RegExp(`^(?:${field.pattern})$`);
            if (!anchored.test(value as string)) {
              violations.push(`字段 ${field.name} 不满足正则约束: ${repr(field.pattern)}`);
            }
          } catch {
            violations.push(`字段 ${field.name} 不满足正则约束: ${repr(field.pattern)}`);
          }
        }
      } else if (field.kind === FIELD_NUMBER) {
        const number = value as number;
        if (field.min !== null && number < field.min) {
          violations.push(`字段 ${field.name} 低于下限: ${number} < ${field.min}`);
        }
        if (field.max !== null && number > field.max) {
          violations.push(`字段 ${field.name} 超过上限: ${number} > ${field.max}`);
        }
      }
    }
    return violations;
  }

  validate_ok(schema: SchemaSpec, data: unknown): boolean {
    return this.validate(schema, data).length === 0;
  }
}
