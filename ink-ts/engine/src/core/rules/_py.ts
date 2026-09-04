/**
 * Python 语义的标量工具（规则 DSL 移植的对齐面）。
 *
 * 规则引擎的违规消息与判定沿用 Python 语义：repr/str/bool/== 的行为
 * 直接影响消息文案与谓词判定（如空列表在 Python 为假、1 == True、
 * 混合类型不可比较）。本模块集中实现这几个标量语义，避免在每个谓词里
 * 重复特判；数据面限定 JSON 兼容值，对象/数组/标量即全部形态。
 */

import { deepEqual, isRecord } from '../json.js';

/** Python repr()：消息文案与声明错误文案的统一形态（单引号字符串/True/None）。 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(pyRepr).join(', ')}]`;
  }
  if (isRecord(value)) {
    const parts = Object.entries(value).map(
      ([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`,
    );
    return `{${parts.join(', ')}}`;
  }
  return String(value);
}

/** Python str()：entity_id 等留痕字段的字符串化（None → "None"）。 */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/** Python 真值语义（bool()）：空列表/空字典为假，其余 JSON 值按直觉。 */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python 相等语义（==）：数值/布尔同族可等、结构深度比较、跨类型不等。 */
export function pyEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  const numA = typeof a === 'boolean' || typeof a === 'number';
  const numB = typeof b === 'boolean' || typeof b === 'number';
  if (numA && numB) return Number(a) === Number(b);
  if (typeof a === 'string' && typeof b === 'string') return false;
  if (Array.isArray(a) && Array.isArray(b)) return deepEqual(a, b);
  if (isRecord(a) && isRecord(b)) return deepEqual(a, b);
  return false;
}

/** Python `in` 语义的包含判定：字符串子串/清单成员（结构相等）/字典键。 */
export function pyContains(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === 'string') {
    return typeof needle === 'string' && haystack.includes(needle);
  }
  if (Array.isArray(haystack)) return haystack.some((item) => pyEq(item, needle));
  if (isRecord(haystack)) {
    return Object.keys(haystack).some((key) => pyEq(key, needle));
  }
  return false;
}

/** 集合形态（Python list/tuple/set/frozenset 的 JSON 表达）= 数组。 */
export function isCollection(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * 排序显示（Python sorted() 的消息形态）：字符串/数值按自然序，其余按
 * repr 文本兜底——仅供违规/声明错误消息展示，不做数据语义排序。
 */
export function pySorted(values: Iterable<unknown>): unknown[] {
  return [...values].sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    return pyRepr(a) < pyRepr(b) ? -1 : pyRepr(a) > pyRepr(b) ? 1 : 0;
  });
}