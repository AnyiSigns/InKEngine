/**
 * 设置「通用」节：外观三档卡片（浅色/深色/跟随系统）+ 语言。
 *
 * 即改即存（主题走 themeMode 控制器、语言走 i18n），无保存按钮。
 */

import { Monitor, Moon, Sun } from 'lucide-react';

import { useThemeMode } from '@/renderer/themeMode';
import { setLocale, useT, type Locale } from '@/i18n/useT';

const MODE_OPTIONS: Array<{ mode: 'light' | 'dark' | 'system'; icon: typeof Sun }> = [
  { mode: 'light', icon: Sun },
  { mode: 'dark', icon: Moon },
  { mode: 'system', icon: Monitor },
];

const LANGUAGE_OPTIONS: Array<{ value: Locale; label: string }> = [
  { value: 'zh', label: '简体中文' },
  { value: 'en', label: 'English' },
];

export function GeneralSection(): JSX.Element {
  const { mode, setMode } = useThemeMode();
  const { t, lang } = useT();

  return (
    <div className="space-y-6">
      {/* 外观三档卡片（参考形态：三卡并排，选中描边） */}
      <div>
        <div className="mb-2 text-[13px] font-medium">{t('general.appearance')}</div>
        <div className="grid grid-cols-3 gap-3" role="radiogroup" aria-label="外观">
          {MODE_OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = mode === option.mode;
            return (
              <button
                key={option.mode}
                type="button"
                role="radio"
                aria-checked={active}
                data-ui={`theme_mode_${option.mode}`}
                data-active={active}
                onClick={() => setMode(option.mode)}
                className={[
                  'flex flex-col items-center gap-1.5 rounded-xl border px-3 py-4 transition-all duration-150',
                  active
                    ? 'ink-border-strong bg-[var(--ink-bg-elevated)] ink-shadow-soft'
                    : 'ink-border hover:border-[var(--ink-border-strong)] hover:bg-[var(--ink-bg-surface)]',
                ].join(' ')}
              >
                <Icon size={18} strokeWidth={1.6} className={active ? '' : 'ink-text-muted'} aria-hidden />
                <span className="text-[13px] font-medium">{t(`general.mode.${option.mode}`)}</span>
                <span className="text-[11px] ink-text-faint">{t(`general.mode.${option.mode}.hint`)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 语言 */}
      <div className="flex items-center justify-between gap-4 border-t ink-border pt-4">
        <div>
          <div className="text-[13px] font-medium">{t('general.language')}</div>
          <div className="mt-0.5 text-[11px] ink-text-faint">{t('general.language.help')}</div>
        </div>
        <div className="ink-seg" role="radiogroup" aria-label="语言">
          {LANGUAGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={lang === option.value}
              data-ui={`lang_${option.value}`}
              data-active={lang === option.value}
              onClick={() => setLocale(option.value)}
              className="ink-seg-item"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
