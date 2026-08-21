/**
 * 顶栏（渲染器机制件 chrome）：InKling · 领域名 + 独立视图/设置入口。
 *
 * 非领域组件：导航动作由渲染器经 onNavigate 注入（App 层持有视图状态）。
 * 纯展示组件，数据全 props 注入（可测试性）。
 */

import { FlaskConical, GitBranch, ScrollText, Settings, Sparkles } from 'lucide-react';

import type { ViewId } from '@/renderer/uiSpecTypes';

interface TopbarProps {
  title?: string;
  subtitle?: string;
  view?: string;
  onNavigate?: (view: ViewId) => void;
}

const NAV_ITEMS: Array<{ view: ViewId; label: string; icon: typeof FlaskConical }> = [
  { view: 'evolution', label: '演化', icon: FlaskConical },
  { view: 'simulation', label: '推演', icon: GitBranch },
  { view: 'source', label: '来源', icon: ScrollText },
  { view: 'settings', label: '设置', icon: Settings },
];

export function Topbar({ title = 'InKling', subtitle = '', view = 'main', onNavigate }: TopbarProps) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3 ink-border">
      <Sparkles size={13} strokeWidth={1.8} className="ink-accent" aria-hidden />
      <span className="text-xs font-semibold tracking-wide">{title}</span>
      {subtitle ? <span className="text-[10px] ink-text-faint">{subtitle}</span> : null}
      <nav className="ml-auto flex items-center gap-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = view === item.view;
          return (
            <button
              key={item.view}
              data-ui={`btn_${item.view}`}
              onClick={() => onNavigate?.(item.view)}
              className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] cursor-pointer transition-colors ${
                active
                  ? 'ink-accent ink-accent-bg'
                  : 'ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]'
              }`}
            >
              <Icon size={11} strokeWidth={1.6} />
              {item.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
