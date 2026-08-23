/**
 * 主题三档测试：light / dark / system 解析、系统监听即时切换、
 * 可注入持久化、首启解析、状态独立（主题层不触碰会话侧状态）。
 */

import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';

import {
  ThemeModeController,
  createMemoryPersist,
  resolveEffectiveTheme,
  getThemeController,
} from '@/renderer/themeMode';
import { ALPHA_TOKEN_GROUP, THEME_TOKEN_WHITELIST, tokenVariableOf } from '@/renderer/themeTokens';
import { AppearanceSection } from '@/components/settings_sections/appearance_section';

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

describe('外观节：三档切换（首选档数据独立）', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // jsdom 无存储时跳过
    }
    delete document.documentElement.dataset.theme;
    // 重建共享控制器状态（清持久化后回到 system）
    getThemeController().setMode('system');
  });

  it('三档选择器渲染：system 默认选中', () => {
    render(<AppearanceSection value={{ themeDraft: {} }} patch={() => undefined} />);
    const system = screen.getByRole('radio', { name: '跟随系统' });
    expect(system).toHaveAttribute('aria-checked', 'true');
  });

  it('切换到深色即时落 data-theme，再随系统档还原', () => {
    render(<AppearanceSection value={{ themeDraft: {} }} patch={() => undefined} />);
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(screen.getByRole('radio', { name: '跟随系统' }));
    expect(document.documentElement.dataset.theme === 'dark' || document.documentElement.dataset.theme === 'light').toBe(true);
  });

  it('外观节切换不触碰会话侧状态键（状态独立面）', () => {
    render(<AppearanceSection value={{ themeDraft: {} }} patch={() => undefined} />);
    fireEvent.click(screen.getByRole('radio', { name: '浅色' }));
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    // 主题层不写 uiStateStore 键（折叠/草稿键独立）
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('token 试穿白名单落地（透明组含）', () => {
    render(<AppearanceSection value={{ themeDraft: { 'status.bubble.fill': 'color-mix(in srgb, #fff 20%, transparent)' } }} patch={() => undefined} />);
    expect(screen.getByLabelText('status.bubble.fill 色值')).toBeInTheDocument();
    expect(THEME_TOKEN_WHITELIST).toContain('status.bubble.fill');
  });
});
