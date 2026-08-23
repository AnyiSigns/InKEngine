/**
 * 消息条目框架（三级视觉层 + 逐条折叠）。
 *
 * 三级视觉层规约：
 * - opaque：正文消息——完全不透明（用户实底气泡 / 助手纸面正文）；
 * - bubble：状态消息气泡——半透明底（alpha ≤ 0.5，走透明组 token）；
 * - card：状态卡片——透明底（无实底填充，仅细描边与留白）。
 *
 * 折叠语义：默认展开；收起仅影响视觉（数据不动，经可注入界面状态
 * 存储按键持久，主题/视图切换后仍保留）。
 */

import type { ReactNode } from 'react';

import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/shared/cn';
import { statusTone } from '@/shared/ui/statusTone';
import { useUiState } from '@/shared/ui/uiStateStore';

export type EntryVisual = 'opaque' | 'bubble' | 'card';

const VISUAL_CLASS: Record<EntryVisual, string> = {
  opaque: '',
  bubble: 'ink-status-bubble px-3 py-2',
  card: 'ink-status-card px-3.5 py-3',
};

interface EntryFrameProps {
  /** 条目身份（折叠键 = entry.collapsed.<id>） */
  id: string;
  visual: EntryVisual;
  /** 标题行（折叠钮在其内由框架注入） */
  header: ReactNode;
  /** 主体（collapsible 且收起时不渲染） */
  body?: ReactNode;
  collapsible?: boolean;
  /** 默认收起（蓄力区：推理/规划）；默认展开 = false */
  defaultCollapsed?: boolean;
  className?: string;
}

export function EntryFrame({ id, visual, header, body, collapsible = false, defaultCollapsed = false, className }: EntryFrameProps) {
  const [collapsed, setCollapsed] = useUiState<boolean>(`entry.collapsed.${id}`, defaultCollapsed);

  const headerNode =
    collapsible && collapsed ? (
      <button
        data-ui="entry_expand"
        title="展开"
        onClick={() => setCollapsed(false)}
        className="flex w-full items-center gap-2 cursor-pointer bg-transparent border-none text-left hover:text-[var(--ink-text-base)]"
      >
        {header}
        <ChevronRight size={12} strokeWidth={1.6} className="ml-auto shrink-0 text-[var(--ink-text-faint)]" aria-hidden />
      </button>
    ) : collapsible ? (
      <button
        data-ui="entry_collapse"
        title="收起"
        onClick={() => setCollapsed(true)}
        className="flex w-full items-center gap-2 cursor-pointer bg-transparent border-none text-left"
      >
        {header}
        <ChevronDown size={12} strokeWidth={1.6} className="ml-auto shrink-0 text-[var(--ink-text-faint)]" aria-hidden />
      </button>
    ) : (
      <div className="flex w-full items-center gap-2">{header}</div>
    );

  return (
    <div className={cn(VISUAL_CLASS[visual], 'text-[var(--ink-font-xs)] leading-[var(--ink-lh-body)]', className)}>
      {headerNode}
      {collapsible && !collapsed && body != null ? <div className="ink-feed mt-1">{body}</div> : null}
      {!collapsible && body != null ? body : null}
    </div>
  );
}

/** 状态胶囊：运行态带呼吸点（生命感），终态静默。live 仅最新一条运行中消息启用。 */
export function StatusPill({ status, live = false }: { status: string; live?: boolean }) {
  const running = status === 'running' || status === 'pending';
  return (
    <span className={cn('ink-chip shrink-0 py-px text-[9px]', statusTone(status))} data-ui="status_pill" data-status={status}>
      {running &&
        (live ? <span className="ink-live-dot" aria-hidden /> : <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />)}
      {status}
    </span>
  );
}
