/**
 * 顶部状态条：会话标题（可编辑）+ 对话/轨迹页签 + 演化徽标（未读红点）。
 * 页签切换主区内容（消息流 / 回合轨迹时间线），参考桌面 agent 产品形态。
 *
 * 非常驻：由装配层「悬停触发带 + 磨砂覆盖层」（ink-topbar-veil）承载，
 * 悬停主区顶缘滑出，移出自动收回；底色/描边/阴影归覆盖层，本组件透明。
 */

import { useState } from 'react';
import { Pencil, ChevronDown } from 'lucide-react';

export type MainTab = 'chat' | 'trace';

interface TopBarProps {
  title: string;
  unreadCount: number;
  tab: MainTab;
  onTabChange: (tab: MainTab) => void;
  onTitleChange: (title: string) => void;
  onOpenEvolution?: () => void;
}

export function TopBar({ title, unreadCount, tab, onTabChange, onTitleChange, onOpenEvolution }: TopBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) onTitleChange(trimmed);
    else setDraft(title);
    setEditing(false);
  };

  return (
    <header className="flex h-12 items-stretch gap-5 px-5">
      {/* 会话标题（可编辑） */}
      <div className="flex min-w-0 items-center">
        {editing ? (
          <input
            autoFocus
            className="ink-input h-8 w-56 text-[13px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') { setDraft(title); setEditing(false); }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => { setDraft(title); setEditing(true); }}
            className="flex min-w-0 items-center gap-1.5 text-[14px] font-medium hover:opacity-80"
            title="重命名会话"
          >
            <span className="truncate">{title || '未命名会话'}</span>
            <Pencil size={12} strokeWidth={1.6} className="shrink-0 ink-text-faint" />
          </button>
        )}
      </div>

      {/* 对话 / 轨迹页签 */}
      <nav className="flex items-stretch gap-5" aria-label="主区页签">
        <button
          type="button"
          data-ui="tab_chat"
          data-active={tab === 'chat'}
          onClick={() => onTabChange('chat')}
          className="ink-tab-item"
        >
          对话
        </button>
        <button
          type="button"
          data-ui="tab_trace"
          data-active={tab === 'trace'}
          onClick={() => onTabChange('trace')}
          className="ink-tab-item"
        >
          轨迹
        </button>
      </nav>

      {/* 演化徽标 */}
      <span className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          data-ui="nav_evolution"
          onClick={onOpenEvolution}
          className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
          title="演化动态"
        >
          <span className="relative flex h-2 w-2">
            {unreadCount > 0 && (
              <span className="absolute inline-flex h-2 w-2 rounded-full bg-[var(--ink-accent-approval)] opacity-75 animate-ping" />
            )}
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--ink-accent-approval)]" />
          </span>
          <ChevronDown size={14} strokeWidth={1.6} />
        </button>
      </span>
    </header>
  );
}
