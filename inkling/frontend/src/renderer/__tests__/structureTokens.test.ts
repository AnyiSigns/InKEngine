/**
 * 结构 token 白名单测试：合法放行 / 非法拒绝（各域至少一条）+
 * 与主题色表语义隔离断言。
 */

import {
  applyStructureTokens,
  isStructureToken,
  rejectedStructureTokens,
  STRUCTURE_TOKEN_WHITELIST,
  structureTokenVariable,
  tokenTableOf,
  validateStructureToken,
} from '@/renderer/structureTokens';
import { THEME_TOKEN_WHITELIST } from '@/renderer/themeTokens';

describe('结构 token 白名单：各域合法放行', () => {
  it('间距域：space.8 取值 8 放行', () => {
    expect(validateStructureToken('space.8', '8')).toBe(true);
    expect(validateStructureToken('space.24', '24')).toBe(true);
  });

  it('圆角域：radius.12 取值 12 放行', () => {
    expect(validateStructureToken('radius.12', '12')).toBe(true);
  });

  it('阴影域：shadow.2 取值 2 放行', () => {
    expect(validateStructureToken('shadow.2', '2')).toBe(true);
  });

  it('字号域：type.15 取值 15 放行', () => {
    expect(validateStructureToken('type.15', '15')).toBe(true);
  });

  it('层级域：z.floater 取值 floater 放行', () => {
    expect(validateStructureToken('z.floater', 'floater')).toBe(true);
  });

  it('动效域：motion.base 取值 base 放行', () => {
    expect(validateStructureToken('motion.base', 'base')).toBe(true);
  });
});

describe('结构 token 白名单：各域非法拒绝（fail-closed）', () => {
  it('间距越界（非尺度数值）拒绝', () => {
    expect(validateStructureToken('space.8', '5')).toBe(false);
    expect(validateStructureToken('space.8', '999')).toBe(false);
  });

  it('圆角越界拒绝', () => {
    expect(validateStructureToken('radius.12', '99')).toBe(false);
  });

  it('阴影越界（非档位）拒绝', () => {
    expect(validateStructureToken('shadow.2', '9')).toBe(false);
  });

  it('字号越界拒绝', () => {
    expect(validateStructureToken('type.15', '40')).toBe(false);
  });

  it('层级越界（非枚举）拒绝', () => {
    expect(validateStructureToken('z.floater', 'basement')).toBe(false);
  });

  it('动效越界（非枚举）拒绝', () => {
    expect(validateStructureToken('motion.base', 'slow')).toBe(false);
  });

  it('白名单外 token 名拒绝（连取值合法也拒绝）', () => {
    expect(validateStructureToken('space.99', '8')).toBe(false);
    expect(validateStructureToken('radius.nope', '12')).toBe(false);
  });
});

describe('结构 token → CSS 变量映射 + 落地', () => {
  it('通过校验的条目落地为 --ink-* 变量', () => {
    const root = document.documentElement;
    const cleanup = applyStructureTokens({ 'space.8': '8', 'radius.12': '12', 'motion.base': 'base' } as Record<string, string>);
    expect(root.style.getPropertyValue('--ink-space-8')).toBe('8px');
    expect(root.style.getPropertyValue('--ink-radius-12')).toBe('12px');
    expect(root.style.getPropertyValue('--ink-motion-base')).toBe('180ms');
    expect(structureTokenVariable('z.floater')).toBe('--ink-z-floater');
    cleanup();
  });

  it('越界 / 白名单外条目拒绝落地（不写变量）', () => {
    const root = document.documentElement;
    const cleanup = applyStructureTokens({ 'space.8': '999', 'evil.token': '8' } as Record<string, string>);
    expect(root.style.getPropertyValue('--ink-space-8')).toBe('');
    expect(rejectedStructureTokens({ 'space.8': '999', 'z.floater': 'floater' })).toEqual(['space.8']);
    cleanup();
  });

  it('结构表仅含几何/节奏语义，不含颜色 token', () => {
    expect(isStructureToken('bg.base')).toBe(false);
    expect(isStructureToken('accent.approval')).toBe(false);
  });
});

describe('两表语义隔离断言', () => {
  it('结构表与主题色表无交集（并列不混）', () => {
    const overlap = STRUCTURE_TOKEN_WHITELIST.filter((name) => (THEME_TOKEN_WHITELIST as readonly string[]).includes(name));
    expect(overlap).toEqual([]);
  });

  it('颜色 token 被结构校验器拒绝（颜色走 alpha 合成，不进结构表）', () => {
    for (const colorToken of THEME_TOKEN_WHITELIST) {
      expect(validateStructureToken(colorToken, '8')).toBe(false);
      expect(isStructureToken(colorToken)).toBe(false);
    }
  });

  it('tokenTableOf 正确归类：色表→color / 结构表→structure / 其余→null', () => {
    expect(tokenTableOf('bg.base')).toBe('color');
    expect(tokenTableOf('space.8')).toBe('structure');
    expect(tokenTableOf('unknown.token')).toBeNull();
  });
});
