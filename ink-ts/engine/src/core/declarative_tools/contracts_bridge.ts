/**
 * 声明 → 结点契约映射（declarative_tools.py :1198-1359 移植）。
 *
 * 工具表 = 结点池单一登记来源：tool_node_mapping 生成 {tool_name:
 * node_type}（本实现口径下恒为同名字典，契约锚点）；node_contracts_from_tools
 * 为每个定义自动生成 NodeContract（input = parameters JSON Schema 逐项
 * 映射为 SchemaField，output = 端点操作结果形态，安全档 = 审批档同阶
 * 映射 allow=0/review=1/deny=2）；validate_tool_node_consistency 是
 * 离线审计/回归工具（ENG6-8）：结点池 ↔ 工具表一致性核对，违规清单供
 * 装配期门禁消费（本函数只做纯计算，无任何装配副作用）。
 *
 * 契约生成是纯数据变换：parameters 的 JSON Schema 属性逐项映射为
 * SchemaField（必填/类型/枚举/边界透传），未知类型回落字符串（宁宽松
 * 不误拒）；output 按端点注册表条目取数（process_exec → stdout/
 * exit_code，file_ops → result，mcp → result 对象，http_fetch →
 * status_code/body，web_search → results 数组），条目缺省 = result 字符串。
 * 契约版本缺省取声明 meta.contract_version，无则 1。
 *
 * 状态标注（机制就绪 / 宿主接线点待定）：离线一致性审计（工具表 ↔ 结点
 * 池），供引擎侧自检工具使用——非运行时机制，无回合内自动接线（默认
 * 开关：自检入口按需调用）。
 */
import { NodeContract } from '../contracts/contracts.js';
import { GraphDefinitionError } from '../errors.js';
import { deepEqual, isRecord } from '../json.js';
import {
  FIELD_ARRAY,
  FIELD_BOOL,
  FIELD_NUMBER,
  FIELD_OBJECT,
  FIELD_STRING,
  SchemaField,
  SchemaSpec,
} from '../schema/schemaValidator.js';
import type { FieldKind } from '../schema/schemaValidator.js';
import type { DeclarativeToolSpec } from './declarative_spec.js';
import { endpoint_registry } from './endpoint_registry.js';

// JSON Schema 类型 → SchemaField 类型映射（未知类型回落字符串，宁宽松不误拒）
const _JSON_SCHEMA_TO_FIELD: Readonly<Record<string, FieldKind>> = {
  string: FIELD_STRING,
  integer: FIELD_NUMBER,
  number: FIELD_NUMBER,
  boolean: FIELD_BOOL,
  object: FIELD_OBJECT,
  array: FIELD_ARRAY,
};

// 审批档 → 契约安全档（与审批档同阶：allow=0 最严 / review=1 / deny=2）
const _APPROVAL_TO_SAFETY_TIER: Readonly<Record<string, number>> = {
  allow: 0,
  review: 1,
  deny: 2,
};

/** JSON Schema 属性 → SchemaField（类型/枚举/边界透传；未知回落字符串）。 */
function _field_from_property(
  name: string,
  prop: unknown,
  required: boolean,
): SchemaField {
  if (!isRecord(prop)) {
    return new SchemaField({ name, required, kind: FIELD_STRING });
  }
  const rawType = prop['type'];
  const mapped = rawType !== undefined ? _JSON_SCHEMA_TO_FIELD[String(rawType)] : undefined;
  const kind: FieldKind = mapped ?? FIELD_STRING;
  const enumRaw = prop['enum'];
  const enumList = Array.isArray(enumRaw) ? enumRaw.map((item) => String(item)) : [];
  const minimum = prop['minimum'];
  const maximum = prop['maximum'];
  return new SchemaField({
    name,
    required,
    kind,
    enum: enumList,
    min: typeof minimum === 'number' && typeof minimum !== 'boolean' ? minimum : null,
    max: typeof maximum === 'number' && typeof maximum !== 'boolean' ? maximum : null,
  });
}

/**
 * 工具声明 → 结点契约（input=parameters，output=端点操作结果形态）。
 *
 * @param spec 声明式工具定义（工具表唯一登记来源）。
 * @param options.version 契约版本覆盖（缺省 = meta.contract_version 或 1）。
 */
export function tool_contract_from_declaration(
  spec: DeclarativeToolSpec,
  options: { version?: number | null } = {},
): NodeContract {
  const rawProps = spec.parameters['properties'] ?? {};
  if (!isRecord(rawProps)) {
    throw new GraphDefinitionError(`工具 ${spec.name} 参数 properties 须为 dict（契约映射前提）`);
  }
  const rawRequired = spec.parameters['required'];
  const required = new Set(Array.isArray(rawRequired) ? rawRequired.filter((r): r is string => typeof r === 'string') : []);
  const input_fields: SchemaField[] = Object.entries(rawProps).map(([name, prop]) =>
    _field_from_property(name, prop, required.has(name)),
  );
  const endpoint_spec = endpoint_registry.get(String(spec.endpoint));
  let output_fields = endpoint_spec !== undefined ? endpoint_spec.output_fields : [];
  if (output_fields.length === 0) {
    output_fields = [new SchemaField({ name: 'result', required: true, kind: FIELD_STRING })];
  }
  let contract_version = options.version ?? null;
  if (contract_version === null) {
    const raw = spec.meta['contract_version'];
    contract_version = typeof raw === 'number' && typeof raw !== 'boolean' ? raw : 1;
  }
  return new NodeContract({
    input_schema: new SchemaSpec({
      name: `${spec.name}.input`,
      fields: input_fields,
    }),
    output_schema: new SchemaSpec({
      name: `${spec.name}.output`,
      fields: output_fields,
    }),
    safety_tier:
      _APPROVAL_TO_SAFETY_TIER[String(spec.meta['approval'] ?? 'review')] ?? 1,
    version: contract_version,
  });
}

/**
 * 工具表 → 结点池映射（node_type == tool_name，同源单一事实）。
 *
 * 结点池条目与工具表共享同一登记来源：工具登记即结点类型登记，任一
 * 漂移（工具名重复/结点类型被占）在此显式报错，不做静默覆盖。
 *
 * @returns {tool_name: node_type}（本实现口径下恒为同名字典，契约锚点）。
 */
export function tool_node_mapping(
  definitions: readonly DeclarativeToolSpec[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const definition of definitions) {
    if (mapping[definition.name] !== undefined) {
      throw new GraphDefinitionError(`工具名重复（结点池同源冲突）: ${definition.name}`);
    }
    mapping[definition.name] = definition.name;
  }
  return mapping;
}

/**
 * 工具表 → 结点池条目（结点类型 = 工具名；契约 = 自动生成）。
 *
 * @returns {node_type: NodeContract}——结点池按此登记，与工具表同源。
 */
export function node_contracts_from_tools(
  definitions: readonly DeclarativeToolSpec[],
): Record<string, NodeContract> {
  const mapping = tool_node_mapping(definitions);
  const contracts: Record<string, NodeContract> = {};
  for (const definition of definitions) {
    contracts[mapping[definition.name]!] = tool_contract_from_declaration(definition);
  }
  return contracts;
}

/** SchemaSpec 形态等值比较（NodeContract 无 TS 值等值；比 to_dict 数据面）。 */
function _schemaEqual(a: SchemaSpec | null, b: SchemaSpec | null): boolean {
  if (a === null || b === null) return a === b;
  return deepEqual(a.to_dict(), b.to_dict());
}

/**
 * 结点池 ↔ 工具表一致性校验（同源门禁的观察侧）。
 *
 * 离线审计工具（ENG6-8）：本门禁不被 harness 装配路径自动调用（harness
 * 注册期校验在 harness 模块归口）——定位 = 离线审计/回归工具：装配期
 * 门禁消费由宿主在构建处显式调用（如 CI/self_check 对登记结果跑一致性
 * 核对），本函数只做纯计算不做任何装配副作用。
 *
 * @returns 违规清单（空 = 一致）：结点池条目与工具表同源——结点类型
 *   缺失、多余、契约输入/输出形态与自动生成不一致均列入。
 */
export function validate_tool_node_consistency(
  node_pool: Record<string, NodeContract>,
  definitions: readonly DeclarativeToolSpec[],
): string[] {
  const issues: string[] = [];
  const expected = node_contracts_from_tools(definitions);
  const nodeTypes = new Set<string>([...Object.keys(node_pool), ...Object.keys(expected)]);
  for (const node_type of [...nodeTypes].sort()) {
    const actual = node_pool[node_type];
    if (actual === undefined) {
      issues.push(`结点池缺工具映射类型: ${node_type}`);
      continue;
    }
    const want = expected[node_type];
    if (want === undefined) {
      issues.push(`结点池存在工具表外类型: ${node_type}`);
      continue;
    }
    if (!_schemaEqual(actual.input_schema, want.input_schema)) {
      issues.push(`结点 ${node_type} 输入契约与工具声明不符`);
    }
    if (!_schemaEqual(actual.output_schema, want.output_schema)) {
      issues.push(`结点 ${node_type} 输出契约与工具声明不符`);
    }
  }
  return issues;
}
