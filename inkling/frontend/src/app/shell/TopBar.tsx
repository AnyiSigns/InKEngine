/**
 * 顶部状态条：会话标题（可编辑）+ 演化徽标（未读红点）。
 */

import { useState } from 'react';
import { Pencil, ChevronDown } from 'lucide-react';

interface TopBarProps {
  title: string;
  unreadCount: number;
  onTitleChange: (title: string) => void;
}

export function TopBar({ title, unreadCount, onTitleChange }: TopBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) onTitleChange(trimmed);
    else setDraft(title);
    setEditing(false);
  };

  return (
    <header className="flex h-12 items-center gap-3 border-b ink-border px-4">
      {editing ? (
        <input
          autoFocus
          className="ink-input h-8 w-48 text-sm"
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
          className="flex items-center gap-2 text-sm font-medium hover:opacity-80"
          title="重命名会话"
        >
          <span className="truncate">{title || '未命名会话'}</span>
          <Pencil size={14} strokeWidth={1.5} className="ink-text-faint" />
        </button>
      )}
      <span className="ml-auto flex items-center gap-1.5 text-xs ink-text-muted">
        <span className="relative flex h-2 w-2">
          {unreadCount > 0 && (
            <span className="absolute inline-flex h-2 w-2 rounded-full bg-[var(--ink-accent-approval)] opacity-75 animate-ping" />
          )}
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--ink-accent-approval)]" />
        </span>
        <ChevronDown size={14} strokeWidth={1.5} />
      </span>
    </header>
  );
}
