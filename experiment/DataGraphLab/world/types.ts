/**
 * 类型格与值判定。
 *
 * 世界里的值只有 6 个公开类型，且 Bool 必须先于 Int 判断：JS 中 `true` 是
 * boolean、`1` 是 number，但 Python 把 `bool` 当 `int` 的子类，跨语言对齐时
 * 若先判 Int 会把 `True` 误判成整数。这里把顺序焊死，任何实现都只能 import 本函数。
 */

export type TypeName = 'Int' | 'Str' | 'Bool' | 'List' | 'Json' | 'None';

/** 恰好 6 项；索引即 one-hot 位置，禁止增删或改序。 */
export const TYPE_LIST: readonly TypeName[] = ['Int', 'Str', 'Bool', 'List', 'Json', 'None'];

export const TYPE_INDEX: Readonly<Record<TypeName, number>> = {
  Int: 0,
  Str: 1,
  Bool: 2,
  List: 3,
  Json: 4,
  None: 5,
};

/** 运行时类型推断，唯一口径。 */
export function t(v: unknown): TypeName {
  if (typeof v === 'boolean') return 'Bool';
  if (typeof v === 'number') return 'Int';
  if (typeof v === 'string') return 'Str';
  if (Array.isArray(v)) return 'List';
  if (v === null || v === undefined) return 'None';
  return 'Json';
}

/**
 * 结构相等（验收的唯一值判定）。Int 精确、Str 精确、List 逐元素递归；
 * Json 按键集合递归。不做隐式转换，类型不同直接 false。
 */
export function deepEq(a: unknown, b: unknown): boolean {
  const ta = t(a);
  if (ta !== t(b)) return false;
  switch (ta) {
    case 'None':
      return true;
    case 'Int':
    case 'Str':
    case 'Bool':
      return a === b;
    case 'List': {
      const x = a as readonly unknown[];
      const y = b as readonly unknown[];
      if (x.length !== y.length) return false;
      return x.every((v, i) => deepEq(v, y[i]));
    }
    case 'Json': {
      const x = a as Record<string, unknown>;
      const y = b as Record<string, unknown>;
      const kx = Object.keys(x).sort();
      const ky = Object.keys(y).sort();
      if (kx.length !== ky.length) return false;
      return kx.every((k, i) => k === ky[i] && deepEq(x[k], y[k]));
    }
  }
}
