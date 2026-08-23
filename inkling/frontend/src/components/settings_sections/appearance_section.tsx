/**
 * 设置「外观」节：主题三档（light / dark / system）+ 主题 token 试穿。
 *
 * 三档切换经主题档控制器（预览即时生效、持久化注入）；试穿仅白名单
 * token 落地 CSS 变量（未声明 token 拒绝并提示），留空 + 还原按钮
 * 恢复出厂（跟随系统）。切换主题不触碰会话/草稿/展开收起状态
 * （状态经可注入界面状态存储独立于主题层）。
 */

import { useEffect } from 'react';

import { Eye, Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { applyThemeTokens, rejectedThemeTokens, THEME_TOKEN_WHITELIST } from '@/renderer/themeTokens';
import { useThemeMode } from '@/renderer/themeMode';
import type { ThemeMode } from '@/renderer/themeMode';

export interface AppearanceValue {
  themeDraft: Record<string, string>;
}

export const DEFAULT_APPEARANCE: AppearanceValue = {
  themeDraft: {},
};

const MODE_OPTIONS: Array<{ mode: ThemeMode; label: string; icon: typeof Sun }> = [
  { mode: 'light', label: '浅色', icon: Sun },
  { mode: 'dark', label: '深色', icon: Moon },
  { mode: 'system', label: '跟随系统', icon: Monitor },
];

interface AppearanceSectionProps {
  value: AppearanceValue;
  patch: (next: Partial<AppearanceValue>) => void;
}

export function AppearanceSection({ value, patch }: AppearanceSectionProps) {
  const { mode, effective, setMode } = useThemeMode();

  // 皮肤试穿：白名单 token 落地 CSS 变量（未声明 token 拒绝并提示）
  useEffect(() => {
    const rejected = rejectedThemeTokens(value.themeDraft);
    if (rejected.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[inkling:warn] [settings] 主题 token 拒绝：${rejected.join(', ')}`);
    }
    return applyThemeTokens(value.themeDraft);
  }, [value.themeDraft]);

  const updateThemeToken = (token: string, nextValue: string): void => {
    if (!(THEME_TOKEN_WHITELIST as readonly string[]).includes(token)) return;
    patch({ themeDraft: { ...value.themeDraft, [token]: nextValue } });
  };

  return (
    <div className="space-y-4">
      <div className="ink-elevated px-3.5 py-3">
        <div className="mb-2 text-[11px] font-medium tracking-wide ink-text-muted">主题档（当前{effective === 'dark' ? '深色' : '浅色'}）</div>
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
          system = 跟随 OS prefers-color-scheme，切换即时生效；首选档首启不闪屏
        </p>
      </div>
      <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
        {THEME_TOKEN_WHITELIST.map((token) => (
          <div key={token} className="flex items-center gap-3 px-3.5 py-2.5">
            <span className="w-28 shrink-0 font-mono text-[10px] ink-text-muted">{token}</span>
            <span
              className="h-5 w-5 shrink-0 rounded-md border border-[var(--ink-border-strong)] ink-shadow-soft"
              style={{ background: value.themeDraft[token] ?? 'var(--ink-bg-surface)' }}
              aria-hidden
            />
            <TextInput
              value={value.themeDraft[token] ?? ''}
              placeholder="跟随系统"
              aria-label={`${token} 色值`}
              onChange={(e) => updateThemeToken(token, e.target.value)}
            />
            <Button
              size="xs"
              variant="ghost"
              data-ui={`theme_token_reset_${token}`}
              onClick={() => {
                const next = { ...value.themeDraft };
                delete next[token];
                patch({ themeDraft: next });
              }}
            >
              还原跟随系统
            </Button>
          </div>
        ))}
      </div>
      <p className="flex items-center gap-1.5 text-[10px] leading-relaxed ink-text-faint">
        <Eye size={10} strokeWidth={1.6} className="shrink-0" aria-hidden />
        试穿即时生效（白名单内）；留空 = 跟随系统；「应用设置」持久化
      </p>
    </div>
  );
}
