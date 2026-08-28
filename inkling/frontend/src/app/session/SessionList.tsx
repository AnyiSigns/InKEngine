/**
 * 会话列表（右栏上半）：搜索/新建/重命名/删除 + 今日/历史分组。
 *
 * 分组语义：最近活跃在今天的归「今天」，其余归「历史」；列表内按
 * 最近活跃降序。空态提示「发送消息开始对话」，输入框自动聚焦。
 * 重命名为行内编辑（点击行内铅笔进入，回车确认，Esc 取消）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { Check, MessageSquarePlus, Pencil, Plus, Search, Trash2, X } from 'lucide-react';

import { cn } from '@/shared/cn';
import type { SessionRecord } from '@/shared/session/sessionStore';
import { sessionTimeLabel } from '@/shared/session/sessionStore';

interface SessionListProps {
  sessions: SessionRecord[];
  activeSessionId: string;
  onActivate: (sessionId: string) => void;
  onCreate: () => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
}

interface SessionRowProps {
  session: SessionRecord;
  active: boolean;
  onActivate: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
}

function isToday(at: number): boolean {
  return new Date(at).toDateString() === new Date().toDateString();
}

function SessionRow({ session, active, onActivate, onRename, onDelete }: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commitRename = (): void => {
    const title = draft.trim();
    if (title && title !== session.title) onRename(session.id, title);
    setDraft(session.title);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="relative flex items-center gap-1 px-3 py-1.5">
        <input
          ref={inputRef}
          value={draft}
          data-ui="session_rename_input"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') {
              setDraft(session.title);
              setEditing(false);
            }
          }}
          onBlur={commitRename}
          className="ink-input w-full pr-9"
          placeholder="会话标题"
        />
        <button
          type="button"
          data-ui="session_rename_confirm"
          onClick={commitRename}
          className="absolute right-6 rounded p-0.5 text-[var(--ink-text-faint)] cursor-pointer hover:text-[var(--ink-text-base)] bg-transparent border-none"
        >
          <Check size={12} strokeWidth={1.6} aria-hidden />
        </button>
        <button
          type="button"
          data-ui="session_rename_cancel"
          onClick={() => {
            setDraft(session.title);
            setEditing(false);
          }}
          className="rounded p-0.5 text-[var(--ink-text-faint)] cursor-pointer hover:text-[var(--ink-text-base)] bg-transparent border-none"
        >
          <X size={12} strokeWidth={1.6} aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      data-ui="session_row"
      data-active={active}
      onClick={() => onActivate(session.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onActivate(session.id);
      }}
      className={cn(
        'group relative flex min-h-[2rem] cursor-pointer items-center gap-2 rounded-lg px-3 py-1 text-[11px]',
        active ? 'bg-[var(--ink-bg-elevated)]' : 'hover:bg-[var(--ink-bg-elevated)]',
      )}
    >
      {active && <span className="ink-active-bar" aria-hidden />}
      <span className={cn('min-w-0 flex-1 truncate', active ? 'font-medium' : 'ink-text-muted')}>
        {session.title || '未命名会话'}
      </span>
      <span className="shrink-0 text-[9px] ink-text-faint">{sessionTimeLabel(session.lastActiveAt)}</span>
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <button
          type="button"
          data-ui="session_rename"
          title="重命名"
          onClick={(e) => {
            e.stopPropagation();
            setDraft(session.title);
            setEditing(true);
          }}
          className="rounded p-0.5 text-[var(--ink-text-faint)] cursor-pointer hover:text-[var(--ink-text-base)] bg-transparent border-none"
        >
          <Pencil size={11} strokeWidth={1.6} aria-hidden />
        </button>
        <button
          type="button"
          data-ui="session_delete"
          title="删除"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(session.id);
          }}
          className="rounded p-0.5 text-[var(--ink-text-faint)] cursor-pointer hover:text-[var(--ink-text-base)] bg-transparent border-none"
        >
          <Trash2 size={11} strokeWidth={1.6} aria-hidden />
        </button>
      </span>
    </div>
  );
}

function SessionGroup({
  label,
  sessions,
  activeSessionId,
  onActivate,
  onRename,
  onDelete,
}: {
  label: string;
  sessions: SessionRecord[];
  activeSessionId: string;
  onActivate: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <div className="px-3 pb-0.5 pt-2 text-[9px] uppercase tracking-wide ink-text-faint">{label}</div>
      {sessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          active={session.id === activeSessionId}
          onActivate={onActivate}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

export function SessionList({ sessions, activeSessionId, onActivate, onCreate, onRename, onDelete }: SessionListProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => (session.title ?? '').toLowerCase().includes(needle));
  }, [sessions, query]);

  const today = filtered.filter((session) => isToday(session.lastActiveAt));
  const history = filtered.filter((session) => !isToday(session.lastActiveAt));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-1">
        <span className="text-[11px] font-medium">会话</span>
        <span className="text-[9px] ink-text-faint">{sessions.length} 个</span>
        <button
          type="button"
          data-ui="session_create"
          title="新建会话"
          onClick={onCreate}
          className="ml-auto rounded-lg p-1 text-[var(--ink-text-muted)] cursor-pointer hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)] bg-transparent border-none"
        >
          <Plus size={13} strokeWidth={1.6} aria-hidden />
        </button>
      </div>
      <div className="px-3 pb-2">
        <div className="ink-input-shell relative flex items-center">
          <Search size={11} strokeWidth={1.6} className="pointer-events-none absolute left-2 text-[var(--ink-text-faint)]" aria-hidden />
          <input
            ref={searchRef}
            value={query}
            data-ui="session_search"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            className="ink-input w-full pl-6"
          />
        </div>
      </div>
      <div className="ink-scroll-auto min-h-0 flex-1 pb-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
            <MessageSquarePlus size={16} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
            <div className="text-[11px] ink-text-muted">发送消息开始对话</div>
            <button
              type="button"
              data-ui="session_empty_create"
              onClick={onCreate}
              className="ink-btn-secondary px-2.5 py-1 text-[10px]"
            >
              新建会话
            </button>
          </div>
        ) : (
          <>
            <SessionGroup
              label="今天"
              sessions={today}
              activeSessionId={activeSessionId}
              onActivate={onActivate}
              onRename={onRename}
              onDelete={onDelete}
            />
            <SessionGroup
              label="历史"
              sessions={history}
              activeSessionId={activeSessionId}
              onActivate={onActivate}
              onRename={onRename}
              onDelete={onDelete}
            />
          </>
        )}
      </div>
    </div>
  );
}
