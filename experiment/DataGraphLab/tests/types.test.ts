import { describe, expect, it } from 'vitest';

import { deepEq, t, TYPE_INDEX, TYPE_LIST } from '../world/types.js';

describe('world/types', () => {
  it('Bool 必须先于 Int 判断', () => {
    expect(t(true)).toBe('Bool');
    expect(t(false)).toBe('Bool');
    expect(t(1)).toBe('Int');
  });

  it('TYPE_LIST 恰 6 项且索引与 TYPE_INDEX 对平', () => {
    expect(TYPE_LIST).toHaveLength(6);
    TYPE_LIST.forEach((name, i) => expect(TYPE_INDEX[name]).toBe(i));
  });

  it('其余类型推断正确', () => {
    expect(t('a')).toBe('Str');
    expect(t([1, 2])).toBe('List');
    expect(t({ a: 1 })).toBe('Json');
    expect(t(null)).toBe('None');
    expect(t(undefined)).toBe('None');
  });

  it('deepEq 递归且不做隐式转换', () => {
    expect(deepEq([1, 'a'], [1, 'a'])).toBe(true);
    expect(deepEq([1], [1, 2])).toBe(false);
    expect(deepEq({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEq(1, '1')).toBe(false);
    expect(deepEq(true, 1)).toBe(false);
  });
});
