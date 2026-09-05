/**
 * 会话侧栏（三栏布局右栏）：新建/切换/删除（需确认）/重命名。
 *
 * 会话数据经可注入 store 抽象（默认持久化存储 + 夹具种子），列表
 * 按最近活跃排序（默认最近活跃）；标题生成 ≤12 字（降级时间戳），
 * 手动重命名覆盖。激活回调注入（宿主接线：把会话消息装入主面板）。
 * 删除走内联二次确认（单步轻交互内联）。
 */

import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, MessageSquare, Pencil, Plus, Search, Trash2, X } from 'lucide-react';

import type { SessionRecord, SessionStore } from '@/shared/session/sessionStore';
import { createPersistentSessionStore, sessionTimeLabel } from '@/shared/session/sessionStore';
import { cn } from '@/shared/cn';
import { useUiState } from '@/shared/ui/uiStateStore';

interface SessionListProps {
  collapsible?: boolean;
  activeSessionId?: string;
  sessionStore?: SessionStore;
  onActivateSession?: (id: string) => void;
}

const defaultStore = createPersistentSessionStore();

export function SessionList({ collapsible = false, activeSessionId = '', sessionStore = defaultStore, onActivateSession }: SessionListProps) {
  const [collapsed, setCollapsed] = useUiState<boolean>('session_list.collapsed', false);
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-l py-2 ink-border">
        <button
          data-ui="btn_session_expand"
          title="展开会话列表"
          onClick={() => setCollapsed(false)}
          className="flex h-7 w-7 items-center justify-center rounded-lg ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
        >
          <ChevronLeft size={13} strokeWidth={1.6} />
        </button>
      </div>
    );
  }

  const sessions = sessionStore.list();
  const filtered = query ? sessions.filter((s) => s.title.includes(query)) : sessions;
  const today = filtered.filter((s) => s.lastActiveAt >= startOfToday());
  const history = filtered.filter((s) => s.lastActiveAt < startOfToday());

  const createSession = (): void => {
    const record = sessionStore.create();
    onActivateSession?.(record.id);
  };

  return (
    <div className="ink-rail flex w-60 shrink-0 flex-col border-l ink-border">
      <div className="flex items-center gap-1.5 p-2.5">
        {collapsible && (
          <button
            data-ui="btn_session_collapse"
            title="收起会话列表"
            onClick={() => setCollapsed(true)}
            className="flex h-7 w-6 shrink-0 items-center justify-center rounded-lg ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
          >
            <ChevronRight size={13} strokeWidth={1.6} />
          </button>
        )}
        <button
          data-ui="btn_new_session"
          onClick={createSession}
          className="ink-btn-secondary flex h-7 flex-1 items-center justify-center gap-1.5 text-[var(--ink-font-xs)] font-medium bg-[var(--ink-bg-base)] ink-shadow-soft cursor-pointer"
        >
          <Plus size={12} strokeWidth={2} aria-hidden />
          新会话
        </button>
      </div>
      <div className="px-2.5 pb-2">
        <div className="ink-input flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-[11px]">
          <Search size={11} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
            className="h-full w-full bg-transparent text-[11px] outline-none placeholder:text-[var(--ink-text-faint)]"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-center text-[10px] ink-text-faint">无匹配会话</div>
        )}
        {today.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-1.5 text-[9px] font-medium tracking-[0.14em] uppercase ink-text-faint">今日</div>
            {today.map((record) => (
              <SessionRow
                key={record.id}
                record={record}
                active={record.id === activeSessionId}
                pendingDelete={pendingDelete === record.id}
                renaming={renaming === record.id}
                onActivate={() => onActivateSession?.(record.id)}
                onRename={() => setRenaming(record.id)}
                onRenameCommit={(title) => {
                  sessionStore.rename(record.id, title);
                  setRenaming(null);
                }}
                onRenameCancel={() => setRenaming(null)}
                onDeleteReq={() => setPendingDelete(record.id)}
                onDeleteConfirm={() => {
                  sessionStore.remove(record.id);
                  setPendingDelete(null);
                }}
                onDeleteCancel={() => setPendingDelete(null)}
              />
            ))}
          </>
        )}
        {history.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-2 text-[9px] font-medium tracking-[0.14em] uppercase ink-text-faint">历史</div>
            {history.map((record) => (
              <SessionRow
                key={record.id}
                record={record}
                active={record.id === activeSessionId}
                pendingDelete={pendingDelete === record.id}
                renaming={renaming === record.id}
                onActivate={() => onActivateSession?.(record.id)}
                onRename={() => setRenaming(record.id)}
                onRenameCommit={(title) => {
                  sessionStore.rename(record.id, title);
                  setRenaming(null);
                }}
                onRenameCancel={() => setRenaming(null)}
                onDeleteReq={() => setPendingDelete(record.id)}
                onDeleteConfirm={() => {
                  sessionStore.remove(record.id);
                  setPendingDelete(null);
                }}
                onDeleteCancel={() => setPendingDelete(null)}
              />
            ))}
          </>
        )}
      </div>
      <div className="flex h-8 items-center justify-between border-t px-3 ink-border">
        <span className="font-mono text-[9px] ink-text-faint">~/inkling</span>
        <span className="font-mono text-[9px] ink-text-faint">会话数 {sessions.length}</span>
      </div>
    </div>
  );
}

function startOfToday(): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

interface SessionRowProps {
  record: SessionRecord;
  active: boolean;
  pendingDelete: boolean;
  renaming: boolean;
  onActivate: () => void;
  onRename: () => void;
  onRenameCommit: (title: string) => void;
  onRenameCancel: () => void;
  onDeleteReq: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}

function SessionRow({
  record,
  active,
  pendingDelete,
  renaming,
  onActivate,
  onRename,
  onRenameCommit,
  onRenameCancel,
  onDeleteReq,
  onDeleteConfirm,
  onDeleteCancel,
}: SessionRowProps) {
  if (pendingDelete) {
    return (
      <div className="ink-status-card my-0.5 flex items-center gap-1.5 px-2 py-1.5" data-ui={`session_delete_confirm_${record.id}`}>
        <span className="min-w-0 flex-1 truncate text-[10px] ink-text-muted">删除「{record.title}」？</span>
        <button
          data-ui="session_delete_ok"
          onClick={onDeleteConfirm}
          className="ink-btn-accent flex h-5 items-center gap-1 rounded-md px-1.5 text-[10px] cursor-pointer"
        >
          <Check size={9} strokeWidth={2} aria-hidden /> 删除
        </button>
        <button
          data-ui="session_delete_no"
          onClick={onDeleteCancel}
          className="flex h-5 items-center rounded-md px-1.5 text-[10px] cursor-pointer ink-text-faint hover:text-[var(--ink-text-base)] bg-transparent border-none"
        >
          <X size={9} strokeWidth={2} aria-hidden /> 取消
        </button>
      </div>
    );
  }

  if (renaming) {
    return <SessionRenameInput recordTitle={record.title} onCommit={onRenameCommit} onCancel={onRenameCancel} />;
  }

  const Icon = MessageSquare;
  return (
    <div
      data-ui={`session_${record.id}`}
      className={cn(
        'group relative flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left cursor-pointer',
        active ? 'bg-[var(--ink-bg-elevated)]' : 'hover:bg-[var(--ink-bg-elevated)]',
      )}
      onClick={onActivate}
    >
      {active && <span className="ink-active-bar" aria-hidden />}
      <Icon size={10} strokeWidth={1.6} className={cn('shrink-0', active ? '' : 'ink-text-faint')} aria-hidden />
      <span className={cn('min-w-0 flex-1 truncate text-[11px]', active && 'font-medium')}>{record.title}</span>
      <span className="shrink-0 font-mono text-[9px] ink-text-faint">{sessionTimeLabel(record.lastActiveAt)}</span>
      <span className="pointer-events-none absolute inset-y-0 right-1 hidden items-center gap-0.5 group-hover:pointer-events-auto group-hover:flex">
        {!active && (
          <button
            title="重命名"
            data-ui="session_rename_btn"
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
            className="flex h-5 w-5 items-center justify-center rounded-md bg-[var(--ink-bg-surface)] ink-text-faint cursor-pointer hover:text-[var(--ink-text-base)] border border-[var(--ink-border)]"
          >
            <Pencil size={9} strokeWidth={1.8} aria-hidden />
          </button>
        )}
        <button
          title="删除"
          data-ui="session_delete_btn"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteReq();
          }}
          className="flex h-5 w-5 items-center justify-center rounded-md bg-[var(--ink-bg-surface)] ink-text-faint cursor-pointer hover:text-[var(--ink-accent-approval)] border border-[var(--ink-border)]"
        >
          <Trash2 size={9} strokeWidth={1.8} aria-hidden />
        </button>
      </span>
    </div>
  );
}

/** 重命名内联输入（独立挂载保证草稿初值取自当前标题）。 */
function SessionRenameInput({ recordTitle, onCommit, onCancel }: { recordTitle: string; onCommit: (title: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(recordTitle);
  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed) onCommit(trimmed);
  };
  return (
    <div className="my-0.5 flex items-center gap-1 px-2 py-1" data-ui="session_rename_input">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') onCancel();
        }}
        aria-label="会话重命名"
        className="ink-input h-6 min-w-0 flex-1 rounded-md px-1.5 text-[10px]"
      />
      <button
        data-ui="session_rename_ok"
        onClick={commit}
        className="flex h-5 items-center rounded-md px-1.5 text-[10px] cursor-pointer ink-text-muted bg-transparent border-none hover:text-[var(--ink-text-base)]"
      >
        <Check size={10} strokeWidth={2} aria-hidden />
      </button>
      <button
        data-ui="session_rename_no"
        onClick={onCancel}
        className="flex h-5 items-center rounded-md px-1.5 text-[10px] cursor-pointer ink-text-faint bg-transparent border-none hover:text-[var(--ink-text-base)]"
      >
        <X size={10} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}
