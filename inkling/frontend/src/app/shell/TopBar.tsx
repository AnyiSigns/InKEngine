/**
 * 顶部状态条：会话标题（可编辑）+ 对话/演化页签。
 * 页签切换主区内容（消息流 / 演化动态时间线），演化已内联为主页签，
 * 不再需要独立徽标入口。
 *
 * 非常驻：由装配层「悬停触发带 + 磨砂覆盖层」（ink-topbar-veil）承载，
 * 悬停主区顶缘滑出，移出自动收回；底色/描边/阴影归覆盖层，本组件透明。
 */

import { useState } from 'react';
import { Pencil } from 'lucide-react';

export type MainTab = 'chat' | 'evolution' | 'ledger';

interface TopBarProps {
  title: string;
  unreadCount: number;
  tab: MainTab;
  onTabChange: (tab: MainTab) => void;
  onTitleChange: (title: string) => void;
  onOpenEvolution?: () => void;
}

export function TopBar({ title, tab, onTabChange, onTitleChange }: TopBarProps) {
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

      {/* 对话 / 演化 / 账本页签 */}
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
          data-ui="tab_evolution"
          data-active={tab === 'evolution'}
          onClick={() => onTabChange('evolution')}
          className="ink-tab-item"
        >
          演化
        </button>
        <button
          type="button"
          data-ui="tab_ledger"
          data-active={tab === 'ledger'}
          onClick={() => onTabChange('ledger')}
          className="ink-tab-item"
        >
          账本
        </button>
      </nav>
    </header>
  );
}
