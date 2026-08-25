/**
 * 视图返回条（非主视图顶部）：返回主界面 + 视图标题 + 描边头。
 *
 * 三栏布局下所有入口统一收进设置页；从设置页进入的视图
 * （演化/推演/来源等）经本组件回到主界面（main）。
 * 导航经 onNavigate 注入（渲染器 chromeProps），纯展示组件。
 */

import { ArrowLeft } from 'lucide-react';

import type { ViewId } from '@/renderer/uiSpecTypes';

interface ViewHeaderProps {
  title?: string;
  hint?: string;
  /** 顶部操作入口（主视图借本组件承载导航） */
  actions?: Array<{ label: string; view: ViewId }>;
  onNavigate?: (view: ViewId) => void;
}

export function ViewHeader({ title = '', hint = '', actions, onNavigate }: ViewHeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-3.5 ink-border">
      <button
        data-ui="btn_back_main"
        onClick={() => onNavigate?.('main')}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] cursor-pointer ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
      >
        <ArrowLeft size={12} strokeWidth={1.7} aria-hidden />
        返回
      </button>
      <span className="text-[13.5px] font-semibold tracking-tight">{title}</span>
      {hint ? <span className="ml-auto text-[10px] tracking-wide ink-text-faint">{hint}</span> : null}
      {actions?.map((action) => (
        <button
          key={action.view}
          data-ui={`nav_${action.view}`}
          onClick={() => onNavigate?.(action.view)}
          className="rounded-lg px-2.5 py-1 text-[11px] cursor-pointer ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
        >
          {action.label}
        </button>
      ))}
    </header>
  );
}
