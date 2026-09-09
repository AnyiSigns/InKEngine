/**
 * 实例级契约派生（P4.2a-3：实例契约随 config 派生，运行时视图）。
 *
 * 现 NodeContract 为类型级静态契约（声明「该类型结点做什么」）；实例化 config
 * （config_defaults/实例 config）可把同一执行体内核分化成不同数据通道面——
 * 组装契约喂给面须按**实例**区分候选，而非只按注册类型契约。本模块 = 纯函数
 * 派生视图：给定注册类型契约 + 实例 config，推导该实例的可喂输出面与输入
 * 需求面：
 *
 * - `output_field` 非空且非 `reply`：产出面 = 基础产出字段中替换 reply 为
 *   output_field（llm 内核把「回复」写入该键；不再产出 reply）；
 * - `read_fields` 非空：输入需求面 = 基础输入面并入这些字段（必读——链上
 *   前序须产出，前缀可达性按字段真对接）；
 * - 两者均缺省：派生契约 == 原类型契约（**零漂移**：实例无字段分化时不改变
 *   类型契约的任意既有消费/断言）。
 *
 * 派生是**运行时视图**：只发生在注册/池种子装配等内存装配点，不在契约
 * schema 数据面新增硬字段（契约序列化形态不变，见 schemas/generated）。
 */

import { NodeContract } from '../contracts/contracts.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../schema/schemaValidator.js';
import { STATE_REPLY } from './constants.js';
import { config_read_fields, parse_output_field_key } from './field_io.js';

/** 输入面并入 read_fields（保留基础输入字段；重复字段不追加）。 */
function _derive_input_schema(
  base_input: SchemaSpec | null,
  read_fields: readonly string[],
): { schema: SchemaSpec | null; changed: boolean } {
  const existing: SchemaField[] = base_input === null ? [] : [...base_input.fields];
  const names = new Set(existing.map((field) => field.name));
  const added: SchemaField[] = [];
  for (const name of read_fields) {
    if (names.has(name)) continue;
    names.add(name);
    added.push(new SchemaField({ name, required: true, kind: FIELD_STRING }));
  }
  if (added.length === 0 && base_input !== null) return { schema: base_input, changed: false };
  if (added.length === 0) return { schema: null, changed: false };
  return {
    schema: new SchemaSpec({
      name: base_input !== null ? base_input.name : 'instance.input',
      fields: [...existing, ...added],
    }),
    changed: true,
  };
}

/** 输出面把 reply 替换为 output_field（基础无 reply 时补加；已含目标键 = 不变）。 */
function _derive_output_schema(
  base_output: SchemaSpec | null,
  output_field: string,
): { schema: SchemaSpec | null; changed: boolean } {
  const existing: SchemaField[] = base_output === null ? [] : [...base_output.fields];
  const names = new Set(existing.map((field) => field.name));
  if (names.has(output_field)) return { schema: base_output, changed: false };
  const next: SchemaField[] = [];
  let replaced = false;
  for (const field of existing) {
    if (!replaced && field.name === STATE_REPLY) {
      next.push(new SchemaField({ name: output_field, required: field.required, kind: field.kind }));
      replaced = true;
    } else {
      next.push(field);
    }
  }
  if (!replaced) {
    next.push(new SchemaField({ name: output_field, required: true, kind: FIELD_STRING }));
  }
  return {
    schema: new SchemaSpec({
      name: base_output !== null ? base_output.name : 'instance.output',
      fields: next,
    }),
    changed: true,
  };
}

/**
 * 实例级契约派生（纯函数）：config 无 output_field/read_fields 分化 = 原契约
 * 原样返回（零漂移）；有分化 = 按上面输入/输出面规则派生新契约。
 * 保留键（_ 前缀内部通道等）经 parse_output_field_key 拒绝（与执行面同一护栏）。
 */
export function derive_instance_contract(
  base: NodeContract,
  config: Record<string, unknown>,
): NodeContract {
  const outputField = parse_output_field_key(config);
  const readFields = config_read_fields(config);
  if (outputField === '' && readFields.length === 0) return base;
  if (outputField !== '' && outputField === STATE_REPLY && readFields.length === 0) return base;
  let input_schema: SchemaSpec | null = base.input_schema;
  let output_schema: SchemaSpec | null = base.output_schema;
  if (outputField !== '' && outputField !== STATE_REPLY) {
    const derived = _derive_output_schema(base.output_schema, outputField);
    output_schema = derived.schema;
  }
  if (readFields.length > 0) {
    const derived = _derive_input_schema(base.input_schema, readFields);
    input_schema = derived.schema;
  }
  return new NodeContract({
    input_schema,
    output_schema,
    safety_tier: base.safety_tier,
    version: base.version,
  });
}
