/**
 * ui_schema 支持件：布局节点类型/绑定协议键/保留前缀常量 + Python 口径
 * 工具（repr/真值/int/type 名/白名单判定）。与模型/校验器拆分以保持
 * 单文件行数纪律。
 */

import { isRecord } from '../json.js';

export const NODE_KIND_CONTAINER = 'container';
export const NODE_KIND_COMPONENT = 'component';
export const VALID_NODE_KINDS: readonly string[] = [NODE_KIND_CONTAINER, NODE_KIND_COMPONENT];

/** 绑定协议键（布局树内嵌声明）。 */
export const BIND_KEY = 'bind';
export const BIND_CHANNEL_KEY = 'channel';
export const BIND_PATH_KEY = 'path';

/** 默认放行的绑定通道（机制层基线：回合状态通道；宿主可装配扩展）。 */
export const DEFAULT_BIND_CHANNELS: readonly string[] = ['state'];

/** 绑定路径保留前缀：以该前缀开头的路径段视为内部数据（补丁链/审批/审计等
 *  机制内部态），禁止作为绑定路径——通道白名单之外的第二道路径级防线。 */
export const RESERVED_BIND_PREFIXES: readonly string[] = ['_'];

/** Python repr() 口径（错误消息呈现；None → 'None'、字符串单引号）。 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (isRecord(value)) {
    const parts = Object.keys(value).map((k) => `${pyRepr(k)}: ${pyRepr(value[k])}`);
    return `{${parts.join(', ')}}`;
  }
  return String(value);
}

/** Python tuple repr() 口径（白名单/枚举清单；单元素补尾逗号）。 */
export function pyTupleRepr(items: readonly unknown[]): string {
  if (items.length === 0) return '()';
  const body = items.map(pyRepr).join(', ');
  return items.length === 1 ? `(${body},)` : `(${body})`;
}

/** Python 真值语义（空列表/空 dict 为假，[] 与 {} 在 JS 中为真需归一）。 */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python int() 口径数值转换（数值截断 / 整数字符串解析；无法解析抛错）。 */
export function pyInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`int() 无法解析数值: ${value}`);
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const match = /^\s*[+-]?\d+\s*$/.exec(value);
    if (match !== null) return Number.parseInt(match[0], 10);
    throw new Error(`int() 无法解析字符串: ${pyRepr(value)}`);
  }
  throw new Error(`int() 需要数值/字符串，收到 ${typeNameOf(value)}`);
}

/** Python type(x).__name__ 口径（消息用；未知值取 typeof 兜底）。 */
export function typeNameOf(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (isRecord(value)) return 'dict';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'number') return 'int';
  if (typeof value === 'boolean') return 'bool';
  return typeof value;
}

/** 白名单成员判定（Python `in` 元组语义：逐项相等比较，容忍任意值型）。 */
export function tupleHas(items: readonly string[], value: unknown): boolean {
  return items.includes(value as string);
}

/** 界面数据绑定声明（组件数据挂到状态通道的指定路径）。 */
