/**
 * i18n 骨架测试：useT 切换语言 → 文案切换断言。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

import { createMemoryLangPersist, setLangPersist, translate, useT } from '@/i18n/useT';

function Probe(): ReactElement {
  const { t, lang, setLang } = useT();
  return (
    <div>
      <span data-testid="txt">{t('settings.title')}</span>
      <span data-testid="lang">{lang}</span>
      <button data-testid="lang_en" onClick={() => setLang('en')}>
        en
      </button>
      <button data-testid="lang_zh" onClick={() => setLang('zh')}>
        zh
      </button>
    </div>
  );
}

describe('useT 语言切换', () => {
  beforeEach(() => {
    setLangPersist(createMemoryLangPersist('zh'));
  });

  it('默认中文文案', () => {
    render(<Probe />);
    expect(screen.getByTestId('txt').textContent).toBe('设置');
    expect(screen.getByTestId('lang').textContent).toBe('zh');
  });

  it('切换到英文文案切换', () => {
    render(<Probe />);
    fireEvent.click(screen.getByTestId('lang_en'));
    expect(screen.getByTestId('txt').textContent).toBe('Settings');
    expect(screen.getByTestId('lang').textContent).toBe('en');
  });

  it('切回中文文案恢复', () => {
    render(<Probe />);
    fireEvent.click(screen.getByTestId('lang_en'));
    fireEvent.click(screen.getByTestId('lang_zh'));
    expect(screen.getByTestId('txt').textContent).toBe('设置');
    expect(screen.getByTestId('lang').textContent).toBe('zh');
  });

  it('缺译键回退键名', () => {
    setLangPersist(createMemoryLangPersist('en'));
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });
});
