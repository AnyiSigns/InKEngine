/**
 * 用户样式注入测试：白名单样式生效 + 越界/危险样式拒绝（fail-closed）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { injectUserStyle, sanitizeUserStyle } from '@/renderer/styleInjection';

describe('用户样式注入：白名单生效', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--ink-radius-user');
    document.documentElement.style.removeProperty('--ink-space-user');
  });

  afterEach(() => {
    document.querySelectorAll('style[data-ink-user-style]').forEach((el) => el.remove());
    document.documentElement.style.removeProperty('--ink-radius-user');
    document.documentElement.style.removeProperty('--ink-space-user');
  });

  it('仅 --ink-* 声明净化通过并落地生效', () => {
    const res = injectUserStyle('--ink-radius-user: 6px; --ink-space-user: 12px;');
    expect(res.ok).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--ink-radius-user')).toBe('6px');
    expect(document.documentElement.style.getPropertyValue('--ink-space-user')).toBe('12px');
  });

  it('净化文本只含白名单声明', () => {
    const res = sanitizeUserStyle('--ink-radius-user: 6px;');
    expect(res.ok).toBe(true);
    expect(res.sanitized).toContain('--ink-radius-user: 6px;');
  });
});

describe('用户样式注入：越界拒绝（fail-closed）', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--ink-evil');
    document.documentElement.style.removeProperty('--ink-x');
  });

  afterEach(() => {
    document.querySelectorAll('style[data-ink-user-style]').forEach((el) => el.remove());
    document.documentElement.style.removeProperty('--ink-evil');
    document.documentElement.style.removeProperty('--ink-x');
  });

  it('含选择器/其它属性的样式整段拒绝（不注入）', () => {
    const res = injectUserStyle('--ink-evil: red; body { background: red }');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('越界');
    expect(document.documentElement.style.getPropertyValue('--ink-evil')).toBe('');
  });

  it('全局选择器样式拒绝', () => {
    const res = sanitizeUserStyle('* { color: red }');
    expect(res.ok).toBe(false);
  });

  it('取值含 url() 危险片段拒绝', () => {
    const res = sanitizeUserStyle('--ink-x: url(evil.example)');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('危险片段');
  });

  it('空输入 / 无白名单声明拒绝', () => {
    expect(sanitizeUserStyle('   ').ok).toBe(false);
    expect(sanitizeUserStyle('color: red;').ok).toBe(false);
  });
});
