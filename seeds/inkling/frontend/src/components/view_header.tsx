/**
 * 视图返回条（非主视图顶部）：返回主界面 + 视图标题。
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
  onNavigate?: (view: ViewId) => void;
}

export function ViewHeader({ title = '', hint = '', onNavigate }: ViewHeaderProps) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3 ink-border">
      <button
        data-ui="btn_back_main"
        onClick={() => onNavigate?.('main')}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] cursor-pointer ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
      >
        <ArrowLeft size={11} strokeWidth={1.6} aria-hidden />
        返回
      </button>
      <span className="text-[13px] font-medium">{title}</span>
      {hint ? <span className="ml-auto text-[10px] ink-text-faint">{hint}</span> : null}
    </header>
  );
}
