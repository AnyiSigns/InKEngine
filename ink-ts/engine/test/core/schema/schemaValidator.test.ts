import { describe, expect, it } from 'vitest';

import {
  TOOL_NAME_MAX_LENGTH,
  SchemaField,
  SchemaSpec,
  SchemaValidator,
  validate_tool_name,
} from '../../../src/core/schema/schemaValidator.js';

function entrySchema(): SchemaSpec {
  return SchemaSpec.from_dict({
    name: 'knowledge_entry',
    fields: [
      { name: 'id', required: true, kind: 'string' },
      { name: 'level', required: true, kind: 'string', enum: ['work', 'project', 'user'] },
      { name: 'kind', required: true, kind: 'string' },
      { name: 'credibility', kind: 'number', min: 0.0, max: 1.0 },
      { name: 'data.message', kind: 'string', required: true },
    ],
  });
}

const validator = new SchemaValidator();

describe('SchemaSpec/SchemaField 声明', () => {
  it('序列化 round-trip（补丁链版本化契约）', () => {
    const spec = entrySchema();
    const rebuilt = SchemaSpec.from_dict(spec.to_dict());
    expect(rebuilt.name).toBe(spec.name);
    expect(rebuilt.fields.map((f) => f.name)).toEqual(['id', 'level', 'kind', 'credibility', 'data.message']);
    expect(rebuilt.fields[1]!.enum).toEqual(['work', 'project', 'user']);
    expect(rebuilt.fields[3]!.min).toBe(0);
    expect(rebuilt.fields[3]!.max).toBe(1);
  });

  it('字段名重复拒绝', () => {
    expect(() =>
      SchemaSpec.from_dict({
        name: 's',
        fields: [
          { name: 'x', kind: 'string' },
          { name: 'x', kind: 'number' },
        ],
      }),
    ).toThrow(/重复/);
  });

  it('未知字段类型拒绝', () => {
    expect(() => SchemaField.from_dict({ name: 'x', kind: 'datetime' })).toThrow(/类型非法/);
  });

  it('范围声明自相矛盾拒绝', () => {
    expect(() => SchemaField.from_dict({ name: 'x', kind: 'number', min: 5, max: 1 })).toThrow(/自相矛盾/);
  });

  it('非法正则构造期拒绝', () => {
    expect(() => SchemaField.from_dict({ name: 'x', kind: 'string', pattern: '(' })).toThrow(/正则/);
  });
});

describe('SchemaValidator 校验语义', () => {
  it('必填字段缺失 → 违规（附期望类型）', () => {
    const violations = validator.validate(entrySchema(), { id: 'k1' });
    expect(violations.some((v) => v.includes('level') && v.includes('缺失'))).toBe(true);
    expect(violations.some((v) => v.includes('data.message') && v.includes('缺失'))).toBe(true);
    expect(violations.some((v) => v.includes('缺失') && v.includes('期望 string 类型值'))).toBe(true);
  });

  it('类型不匹配（number 不接受 bool）', () => {
    const violations = validator.validate(entrySchema(), {
      id: 'k1',
      level: 'work',
      kind: 'rule',
      credibility: true,
      data: { message: 'hello' },
    });
    expect(violations.some((v) => v.includes('credibility') && v.includes('类型不匹配'))).toBe(true);
  });

  it('枚举取值非法', () => {
    const violations = validator.validate(entrySchema(), {
      id: 'k1',
      level: 'archive',
      kind: 'rule',
      data: { message: 'm' },
    });
    expect(violations.some((v) => v.includes('level') && v.includes('取值非法'))).toBe(true);
  });

  it('数值范围越界', () => {
    const violations = validator.validate(entrySchema(), {
      id: 'k1',
      level: 'work',
      kind: 'rule',
      credibility: 1.5,
      data: { message: 'm' },
    });
    expect(violations.some((v) => v.includes('credibility') && v.includes('超过上限'))).toBe(true);
  });

  it('正则整串匹配', () => {
    const schema = SchemaSpec.from_dict({
      name: 's',
      fields: [{ name: 'id', kind: 'string', pattern: '^k-[a-z0-9]+$' }],
    });
    expect(validator.validate(schema, { id: 'BAD_ID' }).length).toBeGreaterThan(0);
    expect(validator.validate(schema, { id: 'k-abc123' })).toEqual([]);
  });

  it('点分路径嵌套校验', () => {
    const schema = entrySchema();
    expect(
      validator.validate(schema, { id: 'k1', level: 'work', kind: 'rule', data: { message: 'm' } }),
    ).toEqual([]);
    const violations = validator.validate(schema, { id: 'k1', level: 'work', kind: 'rule', data: {} });
    expect(violations.some((v) => v.includes('data.message'))).toBe(true);
  });

  it('未知字段忽略（演进宽容）', () => {
    expect(
      validator.validate(entrySchema(), {
        id: 'k1',
        level: 'work',
        kind: 'rule',
        data: { message: 'm' },
        future_field: 'anything',
      }),
    ).toEqual([]);
  });

  it('validate_ok 布尔判定', () => {
    const okData = { id: 'k1', level: 'work', kind: 'rule', data: { message: 'm' } };
    expect(validator.validate_ok(entrySchema(), okData)).toBe(true);
    expect(validator.validate_ok(entrySchema(), { id: 'k1' })).toBe(false);
  });

  it('全部字段类型各自匹配/拒绝', () => {
    const schema = SchemaSpec.from_dict({
      name: 's',
      fields: [
        { name: 'a', kind: 'string' },
        { name: 'b', kind: 'number' },
        { name: 'c', kind: 'boolean' },
        { name: 'd', kind: 'object' },
        { name: 'e', kind: 'array' },
      ],
    });
    expect(validator.validate(schema, { a: 's', b: 1.5, c: true, d: {}, e: [] })).toEqual([]);
    expect(validator.validate(schema, { a: 1, b: 'x', c: 1, d: [], e: {} }).length).toBeGreaterThan(0);
  });
});

describe('工具名命名规范断言', () => {
  it('合规工具名零违规', () => {
    for (const name of ['webquery', 'grep', 'glob', 'notify', 'schedule', 'a'.repeat(TOOL_NAME_MAX_LENGTH)]) {
      expect(validate_tool_name(name)).toEqual([]);
    }
  });

  it('下划线工具名违规', () => {
    expect(validate_tool_name('web_search').some((v) => v.includes('禁用字符'))).toBe(true);
  });

  it('长度超限违规', () => {
    expect(validate_tool_name('x'.repeat(TOOL_NAME_MAX_LENGTH + 1)).length).toBeGreaterThan(0);
    expect(validate_tool_name('x'.repeat(TOOL_NAME_MAX_LENGTH))).toEqual([]);
  });

  it('空工具名违规', () => {
    expect(validate_tool_name('').some((v) => v.includes('不能为空'))).toBe(true);
  });
});

describe('形态示例增强', () => {
  it('字段声明缺 name 附合法形态', () => {
    expect(() => SchemaField.from_dict({ kind: 'string' })).toThrow(/字段声明合法形态/);
  });

  it('schema 声明缺 name/fields 附合法形态', () => {
    expect(() => SchemaSpec.from_dict({ fields: [] })).toThrow(/schema 声明合法形态/);
    expect(() => SchemaSpec.from_dict({ name: 's' })).toThrow(/schema 声明合法形态/);
  });
});
