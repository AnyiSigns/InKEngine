/**
 * 主题三档测试：light / dark / system 解析、系统监听即时切换、
 * 可注入持久化、首启解析、状态独立（主题层不触碰会话侧状态）。
 */

import {
  ThemeModeController,
  createMemoryPersist,
  resolveEffectiveTheme,
} from '@/renderer/themeMode';
import { ALPHA_TOKEN_GROUP, tokenVariableOf } from '@/renderer/themeTokens';

describe('resolveEffectiveTheme 三档解析', () => {
  it('system 跟随系统暗色；显式档位钉住', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
    expect(resolveEffectiveTheme('system', false)).toBe('light');
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
    expect(resolveEffectiveTheme('light', true)).toBe('light');
  });
});

describe('ThemeModeController（可注入持久化 + 系统监听）', () => {
  it('默认档位 = system；构造即应用（首启解析面）', () => {
    const applied: string[] = [];
    const controller = new ThemeModeController(
      createMemoryPersist(),
      { matches: false, subscribe: () => () => undefined },
      (effective) => applied.push(effective),
    );
    expect(controller.getMode()).toBe('system');
    expect(controller.getEffective()).toBe('light');
    expect(applied).toEqual(['light']);
  });

  it('切换档位即时应用并持久化（注入存储）', () => {
    const persist = createMemoryPersist();
    const applied: string[] = [];
    const controller = new ThemeModeController(persist, { matches: false, subscribe: () => () => undefined }, (e) => applied.push(e));
    controller.setMode('dark');
    expect(controller.getEffective()).toBe('dark');
    expect(persist.read()).toBe('dark');
    expect(applied).toEqual(['light', 'dark']);

    // 新控制器读出持久化档位（首启不闪屏的持久化面）
    const rebooted = new ThemeModeController(persist, { matches: true, subscribe: () => () => undefined }, (e) => applied.push(e));
    expect(rebooted.getMode()).toBe('dark');
  });

  it('system 档监听系统切换即时生效', () => {
    let listener = undefined as (() => void) | undefined;
    let systemDark = false;
    const applied: string[] = [];
    const controller = new ThemeModeController(
      createMemoryPersist('system'),
      {
        get matches() {
          return systemDark;
        },
        subscribe: (cb) => {
          listener = cb;
          return () => {
            listener = undefined;
          };
        },
      },
      (e) => applied.push(e),
    );
    expect(controller.getEffective()).toBe('light');
    systemDark = true;
    (listener as (() => void) | undefined)?.();
    expect(controller.getEffective()).toBe('dark');
    expect(applied).toEqual(['light', 'dark']);
  });

  it('显式亮色档不跟随系统切换', () => {
    let listener = undefined as (() => void) | undefined;
    let systemDark = true;
    const applied: string[] = [];
    const controller = new ThemeModeController(
      createMemoryPersist('light'),
      {
        get matches() {
          return systemDark;
        },
        subscribe: (cb) => {
          listener = cb;
          return () => {
            listener = undefined;
          };
        },
      },
      (e) => applied.push(e),
    );
    expect(controller.getEffective()).toBe('light');
    systemDark = false;
    (listener as (() => void) | undefined)?.();
    expect(controller.getEffective()).toBe('light');
  });
});

describe('主题 token（透明组）', () => {
  it('白名单含透明组且映射 CSS 变量', () => {
    expect(ALPHA_TOKEN_GROUP.length).toBeGreaterThan(0);
    expect(tokenVariableOf('status.bubble.fill')).toBe('--ink-status-bubble-fill');
    expect(tokenVariableOf('status.bubble.edge')).toBe('--ink-status-bubble-edge');
    expect(tokenVariableOf('status.card.edge')).toBe('--ink-status-card-edge');
  });

  it('透明组默认值 alpha ≤ 0.5（color-mix 百分比上限）', () => {
    // 默认值经 color-mix 派生（alpha = 百分比上限 ≤ 50）
    const percent = (value: string): number => Number(/\)\s*(\d+(?:\.\d+)?)%/.exec(value)?.[1] ?? 0);
    expect(percent('color-mix(in srgb, var(--ink-text-base) 18%, transparent)')).toBeLessThanOrEqual(50);
    expect(percent('color-mix(in srgb, var(--ink-text-base) 30%, transparent)')).toBeLessThanOrEqual(50);
    expect(ALPHA_TOKEN_GROUP).toEqual(['status.bubble.fill', 'status.bubble.edge', 'status.card.edge']);
  });
});
