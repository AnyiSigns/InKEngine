import { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { invokeOp } from '../../shared/invokeOp';

export type ThemeMode = 'light' | 'dark' | 'system';

export function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeMode>('system');

  const handleThemeChange = async (mode: ThemeMode) => {
    setTheme(mode);
    document.documentElement.setAttribute('data-theme', mode === 'system' ? '' : mode);
    await invokeOp('settings_put', { theme: mode });
  };

  return (
    <div data-ui="appearance_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Sun size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">外观</h3>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-[11px] text-[var(--ink-text-muted)]">主题</div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={theme === 'light' ? 'primary' : 'ghost'}
            onClick={() => handleThemeChange('light')}
            data-ui="theme_light"
          >
            <Sun size={12} strokeWidth={1.6} />
            日间
          </Button>
          <Button
            size="sm"
            variant={theme === 'dark' ? 'primary' : 'ghost'}
            onClick={() => handleThemeChange('dark')}
            data-ui="theme_dark"
          >
            <Moon size={12} strokeWidth={1.6} />
            夜间
          </Button>
          <Button
            size="sm"
            variant={theme === 'system' ? 'primary' : 'ghost'}
            onClick={() => handleThemeChange('system')}
            data-ui="theme_system"
          >
            <Monitor size={12} strokeWidth={1.6} />
            系统
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-[11px] text-[var(--ink-text-muted)]">AI 插件</div>
        <div className="text-[10px] text-[var(--ink-text-faint)]">
          组件市场挂载的 AI 自写组件/皮肤即时生效
        </div>
        <Button size="xs" variant="secondary">
          前往组件市场
        </Button>
      </div>
    </div>
  );
}
