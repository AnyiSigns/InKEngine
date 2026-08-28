/**
 * 设置「外观」节：主题三档（日间/夜间/系统，文案即此三词）+ 语言。
 *
 * 写 data-theme；波 1 agent 实现 token 层，此处只消费 token。
 */

import { Eye, Monitor, Moon, Sun } from 'lucide-react';

import { THEME_TOKEN_WHITELIST } from '@/renderer/themeTokens';
import { useThemeMode } from '@/renderer/themeMode';
import { setLocale, useT, type Locale } from '@/i18n/useT';
import { TextInput } from '@/shared/ui/Field';

const MODE_OPTIONS: Array<{ mode: 'light' | 'dark' | 'system'; label: string; icon: typeof Sun }> = [
  { mode: 'light', label: '日间', icon: Sun },
  { mode: 'dark', label: '夜间', icon: Moon },
  { mode: 'system', label: '系统', icon: Monitor },
];

export function AppearanceSection(): JSX.Element {
  const { mode, effective, setMode } = useThemeMode();
  const { lang } = useT();

  const LANGUAGE_OPTIONS: Array<{ value: Locale; label: string }> = [
    { value: 'zh', label: '简体中文' },
    { value: 'en', label: 'English' },
  ];

  return (
    <div className="space-y-4">
      <div className="ink-elevated px-3.5 py-3">
        <div className="mb-2 text-[11px] font-medium tracking-wide ink-text-muted">主题档（当前{effective === 'dark' ? '夜间' : '日间'}）</div>
        <div className="ink-seg" role="radiogroup" aria-label="主题档">
          {MODE_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.mode}
                role="radio"
                aria-checked={mode === option.mode}
                data-ui={`theme_mode_${option.mode}`}
                data-active={mode === option.mode}
                onClick={() => setMode(option.mode)}
                className="ink-seg-item gap-1"
              >
                <Icon size={10} strokeWidth={1.8} aria-hidden />
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[10px] leading-relaxed ink-text-faint">
          <Monitor size={10} strokeWidth={1.6} className="shrink-0" aria-hidden />
          system = 跟随 OS 偏好，切换即时生效
        </p>
      </div>

      <div className="ink-elevated px-3.5 py-3">
        <div className="mb-2 text-[11px] font-medium tracking-wide ink-text-muted">语言</div>
        <div className="ink-seg" role="radiogroup" aria-label="语言">
          {LANGUAGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              role="radio"
              aria-checked={lang === option.value}
              data-ui={`lang_${option.value}`}
              data-active={lang === option.value}
              onClick={() => setLocale(option.value)}
              className="ink-seg-item gap-1"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
        {THEME_TOKEN_WHITELIST.map((token) => (
          <div key={token} className="flex items-center gap-3 px-3.5 py-2.5">
            <span className="w-28 shrink-0 font-mono text-[10px] ink-text-muted">{token}</span>
            <span
              className="h-5 w-5 shrink-0 rounded-md border border-[var(--ink-border-strong)] ink-shadow-soft"
              style={{ background: 'var(--ink-bg-surface)' }}
              aria-hidden
            />
            <TextInput
              value=""
              placeholder="跟随系统"
              aria-label={`${token} 色值`}
              disabled
            />
          </div>
        ))}
      </div>

      <p className="flex items-center gap-1.5 text-[10px] leading-relaxed ink-text-faint">
        <Eye size={10} strokeWidth={1.6} aria-hidden />
        试穿仅白名单 token 落地；留空 = 跟随系统；token 层由波 1 agent 实现。
      </p>
    </div>
  );
}
