/**
 * 链接校验器（纯函数：结点契约间链接的合法性判定）——link_validator.py 移植。
 *
 * 两级校验语义：
 *
 * - 前缀可达性（弱校验，组装/路径校验用）：序列中每个结点的必填输入 ⊆
 *   入口字段 ∪ 前置结点产出并集——线性序列天然支持多源汇聚（下游结点
 *   同时消费多个前置结点的产出），相邻覆盖校验会误杀这类合法路径；
 * - 相邻覆盖（强校验，显式边/手绘图用）：起点产出必须覆盖目标全部必填
 *   输入字段。
 *
 * 其余规则（全部算法化，毫秒级）：
 *
 * - 无契约结点不可参与组装（仅可被手绘图引用——旧行为零破坏）；
 * - 安全档：目标安全档不得超过组装请求档位（高安全结点不可进低信任
 *   路径；路径档位 = 请求参数，默认 0 最严；映射策略归使用方）；
 * - 版本：引用的契约版本必须已登记（旧图定义可解析）；
 * - 通道写入：跨状态通道写入遵循 StateSchema.apply 既有语义
 *   （累积追加通道须序列写入、合并累加通道须对象写入，按
 *   is_additive_reducer / is_merge_reducer 分类检查）。
 *
 * 结构校验器不检查语义条件——策略边（声明式条件边）的运行时成立性由
 * 上下文谓词判定，不在本模块职责内。全部函数为纯函数：同输入必同输出
 * （理由清单顺序稳定，可断言）。
 *
 * TS 差异：Python 侧 frozenset 集合差/并直接参与字段覆盖演算，TS 以
 * ReadonlySet 镜像其只读语义；字段缺失后的理由清单按缺字段排序渲染，
 * 排序键与 Python sorted 一致，清单内容可逐项断言。
 */

import { SAFETY_TIER_MAX } from '../contracts/contracts.js';
import type { NodeContract } from '../contracts/contracts.js';
import { GraphDefinitionError } from '../errors.js';
import { FIELD_ARRAY, FIELD_OBJECT } from '../schema/schemaValidator.js';
import type { SchemaSpec } from '../schema/schemaValidator.js';
import type { StateSchema } from '../state/schema.js';
import { is_additive_reducer, is_merge_reducer } from '../state/reducers.js';

/** 契约版本登记表形态：类型名 → 该类型已登记版本集（可迭代集合）。 */
export type VersionRegistry = Readonly<Record<string, Iterable<number>>>;

/** validate_link 的可选规则入参（缺省 = 该规则跳过，纯增量宽容）。 */
export interface ValidateLinkOptions {
  max_safety_tier?: number | null;
  src_type?: string | null;
  dst_type?: string | null;
  known_versions?: VersionRegistry | null;
  state_schema?: StateSchema | null;
}

/** validate_prefix_reachability 的可选规则入参。 */
export interface ValidatePrefixOptions {
  entry_fields?: Iterable<string>;
  max_safety_tier?: number | null;
  state_schema?: StateSchema | null;
}

/** 无缺省键 = 用缺省值；显式传 null 与 Python None 同义（越界类错误留面）。 */
function defaultWhenMissing<T>(value: T | null | undefined, fallback: T): T {
  return value === undefined ? fallback : (value as T);
}

/** schema 必填字段名集合（缺省 schema = 无必填）。 */
export function required_field_names(schema: SchemaSpec | null): ReadonlySet<string> {
  if (schema === null) return new Set<string>();
  return new Set(schema.fields.filter((f) => f.required).map((f) => f.name));
}

/** schema 声明字段名全集（缺省 schema = 无产出）。 */
export function produced_field_names(schema: SchemaSpec | null): ReadonlySet<string> {
  if (schema === null) return new Set<string>();
  return new Set(schema.fields.map((f) => f.name));
}

// 族收敛：pyRepr 近似拷贝的统一迁移点 = core/py_repr.ts 单源（已就绪）。
// 本实现差异：非递归（对象/数组直接 String()），undefined 走 String(undefined)。
// 后续批次可按批迁移，本文件暂不改实现。
/** Python repr 口径（错误消息对齐：布尔大写/字符串带引号）。 */
function pyRepr(value: unknown): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

/** Python 列表渲染口径（已登记版本清单按升序入消息）。 */
function intListRepr(values: readonly number[]): string {
  return `[${values.join(', ')}]`;
}

/** 组装请求档位范围校验（档位是数据形态约束，越界 = 声明错误）。 */
function _check_request_tier(max_safety_tier: unknown): void {
  if (
    typeof max_safety_tier === 'boolean' ||
    typeof max_safety_tier !== 'number' ||
    !Number.isInteger(max_safety_tier)
  ) {
    throw new GraphDefinitionError(`组装请求档位须为整数: ${pyRepr(max_safety_tier)}`);
  }
  if (max_safety_tier < 0 || max_safety_tier > SAFETY_TIER_MAX) {
    throw new GraphDefinitionError(
      `组装请求档位越界: ${max_safety_tier}（仅 0-${SAFETY_TIER_MAX}）`,
    );
  }
}

/** 可迭代版本集成员判定（登记表值可为集合或清单）。 */
function hasVersion(versions: Iterable<number>, version: number): boolean {
  for (const candidate of versions) if (candidate === version) return true;
  return false;
}

/** 契约版本存在性判定（未提供类型名/登记表 = 跳过，纯增量宽容）。 */
function _version_reasons(
  node: NodeContract | null,
  type_name: string | null,
  known_versions: VersionRegistry | null,
  label: string,
): string[] {
  if (node === null || type_name === null || known_versions === null) return [];
  const versions = known_versions[type_name];
  if (versions === undefined || !hasVersion(versions, node.version)) {
    const sortedList = versions === undefined ? [] : [...versions].sort((a, b) => a - b);
    const registered =
      sortedList.length === 0
        ? '（未登记任何版本）'
        : `（已登记 ${intListRepr(sortedList)}）`;
    return [`${label}契约版本未登记: 类型 ${type_name} 的版本 ${node.version}${registered}`];
  }
  return [];
}

/** 通道写入形态判定（缺省 schema = 跳过；仅检查带 reducer 的通道）。
 *
 * 遵循 StateSchema.apply 既有语义：累积追加通道（add_messages 族）
 * 的写入须为条目序列（array）；合并累加通道（merge_metrics/
 * merge_dicts 族）的写入须为对象（object）。未分类的自定义 reducer
 * 不做形态推断（无声明语义，宽容跳过）。
 */
function _channel_write_reasons(
  node: NodeContract,
  state_schema: StateSchema | null,
  label: string,
): string[] {
  if (state_schema === null || node.output_schema === null) return [];
  const reasons: string[] = [];
  for (const field of node.output_schema.fields) {
    const channel = state_schema.channels[field.name];
    if (channel === undefined || channel.reducer === null) continue;
    if (is_additive_reducer(channel.reducer)) {
      if (field.kind !== FIELD_ARRAY) {
        reasons.push(
          `${label}字段 ${field.name} 写入累积追加通道` +
            `（reducer=${channel.reducer}），类型须为 array，声明为 ${field.kind}`,
        );
      }
    } else if (is_merge_reducer(channel.reducer) && field.kind !== FIELD_OBJECT) {
      reasons.push(
        `${label}字段 ${field.name} 写入合并累加通道` +
          `（reducer=${channel.reducer}），类型须为 object，声明为 ${field.kind}`,
      );
    }
  }
  return reasons;
}

/** 相邻覆盖（强校验，显式边/手绘图用）+ 安全档/版本/通道写入规则。
 *
 * src/dst 为链接两端结点契约（null = 无契约结点，不可参与组装）；
 * max_safety_tier 为组装请求放行档位（默认 0 最严；高安全结点不可进
 * 低信任路径）；src_type/dst_type 供契约版本存在性判定；known_versions
 * 为类型名 → 已登记契约版本集（缺省 = 跳过版本存在性规则）；state_schema
 * 为状态通道 schema（缺省 = 跳过通道写入规则）。返回 (是否通过, 理由清单)，
 * 理由顺序稳定，可断言。
 */
export function validate_link(
  src: NodeContract | null,
  dst: NodeContract | null,
  options: ValidateLinkOptions = {},
): readonly [boolean, string[]] {
  const max_safety_tier = defaultWhenMissing(options.max_safety_tier, 0);
  const src_type = options.src_type === undefined ? null : options.src_type;
  const dst_type = options.dst_type === undefined ? null : options.dst_type;
  const known_versions = options.known_versions === undefined ? null : options.known_versions;
  const state_schema = options.state_schema === undefined ? null : options.state_schema;
  _check_request_tier(max_safety_tier);
  const reasons: string[] = [];
  if (src === null) reasons.push('起点结点无契约，不可参与组装');
  if (dst === null) reasons.push('目标结点无契约，不可参与组装');
  if (src !== null && dst !== null) {
    const required = required_field_names(dst.input_schema);
    const produced = produced_field_names(src.output_schema);
    const missing = [...required].filter((name) => !produced.has(name)).sort();
    if (missing.length > 0) {
      reasons.push(`目标必填输入字段未被起点产出覆盖: ${missing.join('、')}`);
    }
  }
  if (dst !== null && dst.safety_tier > max_safety_tier) {
    reasons.push(
      `目标安全档 ${dst.safety_tier} 超过组装请求档位 ${max_safety_tier}`,
    );
  }
  reasons.push(..._version_reasons(src, src_type, known_versions, '起点'));
  reasons.push(..._version_reasons(dst, dst_type, known_versions, '目标'));
  // 通道写入规则对链接两端都生效：两端结点都会向状态通道写产出
  if (src !== null) reasons.push(..._channel_write_reasons(src, state_schema, '起点结点'));
  if (dst !== null) reasons.push(..._channel_write_reasons(dst, state_schema, '目标结点'));
  return [reasons.length === 0, reasons];
}

/** 前缀可达性（弱校验，组装/路径校验用）。
 *
 * 序列中每个结点的必填输入 ⊆ 入口字段 ∪ 前置结点产出并集——支持
 * 多源汇聚：下游结点的输入可由多个前置结点的产出合并满足；相邻覆盖
 * （validate_link）会误杀这类合法路径，组装/路径校验须用本函数。
 * 安全档按序列逐结点剪枝，通道写入规则逐结点检查。
 *
 * sequence 为按执行序排列的结点契约序列；entry_fields 为外部注入的
 * 初始可用字段。返回 (是否通过, 理由清单)，理由顺序稳定，可断言。
 */
export function validate_prefix_reachability(
  sequence: readonly (NodeContract | null)[],
  options: ValidatePrefixOptions = {},
): readonly [boolean, string[]] {
  const entry_fields = options.entry_fields === undefined ? [] : options.entry_fields;
  const max_safety_tier = defaultWhenMissing(options.max_safety_tier, 0);
  const state_schema = options.state_schema === undefined ? null : options.state_schema;
  _check_request_tier(max_safety_tier);
  const reasons: string[] = [];
  const available = new Set<string>(entry_fields);
  sequence.forEach((node, index) => {
    const label = `序列第 ${index + 1} 个结点`;
    if (node === null) {
      reasons.push(`${label}无契约，不可参与组装`);
      return;
    }
    if (node.safety_tier > max_safety_tier) {
      reasons.push(
        `${label}安全档 ${node.safety_tier} 超过组装请求档位 ${max_safety_tier}`,
      );
    }
    const required = required_field_names(node.input_schema);
    const missing = [...required].filter((name) => !available.has(name)).sort();
    if (missing.length > 0) {
      reasons.push(`${label}输入字段不可达: ${missing.join('、')}`);
    }
    for (const name of produced_field_names(node.output_schema)) available.add(name);
    reasons.push(..._channel_write_reasons(node, state_schema, label));
  });
  return [reasons.length === 0, reasons];
}
