/**
 * 右栏：会话列表 + 线程分支 mini 树。
 * 默认 240px 展开，可折叠为 48px 图标条。
 * 布局约定：左栏默认展开、右栏默认收起。
 */

import { useState, type ReactNode } from 'react';
import { Plus, Search, MoreVertical, ChevronRight, ChevronDown, MessageSquare, Trash2, Pencil, ChevronLeft } from 'lucide-react';
import type { SessionRemoteRecord, SessionBranchTree } from '@/shared/backend/backendAdapter';

interface RightRailProps {
  collapsed: boolean;
  onToggle: () => void;
  sessions: SessionRemoteRecord[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
  onBranchFromMessage: (messageId: string, branchLabel: string) => void;
  branchTrees: Record<string, SessionBranchTree>;
  onBranchFromLeaf: (sessionId: string, leaf: number) => void;
  /** 右栏顶部挂载位：跨回合长任务胶囊（仅长任务期间存在）。 */
  headerSlot?: ReactNode;
}

export function RightRail({
  collapsed,
  onToggle,
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onBranchFromMessage,
  branchTrees,
  onBranchFromLeaf,
  headerSlot,
}: RightRailProps) {
  const [query, setQuery] = useState('');
  const today = sessions.filter((s) => Date.now() - s.updated_at < 86400000);
  const history = sessions.filter((s) => Date.now() - s.updated_at >= 86400000);
  const filtered = (list: SessionRemoteRecord[]) =>
    list.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));

  if (collapsed) {
    return (
      <aside className="flex w-12 flex-col items-center border-l ink-border py-2">
        <button type="button" onClick={onCreateSession} className="mb-2 flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--ink-bg-elevated)]" title="新建会话">
          <Plus size={16} strokeWidth={1.5} />
        </button>
        <button type="button" onClick={onToggle} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--ink-bg-elevated)]" title="展开">
          <ChevronRight size={16} strokeWidth={1.5} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-60 flex-col border-l ink-border">
      {headerSlot && <div className="border-b ink-border p-2">{headerSlot}</div>}
      <div className="flex h-12 items-center gap-2 px-3 border-b ink-border">
        <Search size={14} strokeWidth={1.5} className="ink-text-faint" />
        <input
          className="ink-input h-7 flex-1 border-0 bg-transparent text-xs"
          placeholder="搜索会话"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" onClick={onCreateSession} className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--ink-bg-elevated)]" title="新建会话">
          <Plus size={14} strokeWidth={1.5} />
        </button>
        <button type="button" onClick={onToggle} className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--ink-bg-elevated)]" title="折叠">
          <ChevronLeft size={14} strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-xs ink-text-faint">
            <MessageSquare size={24} strokeWidth={1.5} className="mb-2 opacity-50" />
            <p>发送消息开始对话</p>
          </div>
        )}

        {filtered(today).length > 0 && (
          <div className="mb-2">
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide ink-text-faint">今日</div>
            {filtered(today).map((s) => (
              <SessionRow
                key={s.thread_id}
                session={s}
                active={s.thread_id === activeSessionId}
                onSelect={() => onSelectSession(s.thread_id)}
                onRename={(t) => onRenameSession(s.thread_id, t)}
                onDelete={() => onDeleteSession(s.thread_id)}
                onBranchFromMessage={onBranchFromMessage}
              />
            ))}
          </div>
        )}

        {filtered(history).length > 0 && (
          <div>
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide ink-text-faint">历史</div>
            {filtered(history).map((s) => (
              <SessionRow
                key={s.thread_id}
                session={s}
                active={s.thread_id === activeSessionId}
                onSelect={() => onSelectSession(s.thread_id)}
                onRename={(t) => onRenameSession(s.thread_id, t)}
                onDelete={() => onDeleteSession(s.thread_id)}
                onBranchFromMessage={onBranchFromMessage}
              />
            ))}
          </div>
        )}

        {sessions.length > 0 && (
          <div className="mt-3 border-t ink-border pt-2">
            <BranchTreeSection
              activeSessionId={activeSessionId}
              branchTrees={branchTrees}
              onBranchFromLeaf={onBranchFromLeaf}
            />
          </div>
        )}
      </div>
    </aside>
  );
}

interface BranchTreeSectionProps {
  activeSessionId: string;
  branchTrees: Record<string, SessionBranchTree>;
  onBranchFromLeaf: (sessionId: string, leaf: number) => void;
}

function BranchTreeSection({ activeSessionId, branchTrees, onBranchFromLeaf }: BranchTreeSectionProps) {
  const [expanded, setExpanded] = useState(true);
  const activeTree = branchTrees[activeSessionId];

  if (!activeTree || activeTree.nodes.length <= 1) {
    return (
      <div className="px-2 py-1 text-[10px] ink-text-faint">
        无分支
      </div>
    );
  }

  const currentLeaf = activeTree.current_leaf;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-[var(--ink-text-muted)]"
      >
        {expanded ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
        <span>分支</span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-1 pl-2">
          {activeTree.nodes.map((node) => (
            <div
              key={node.leaf}
              className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs cursor-pointer ${
                node.leaf === currentLeaf
                  ? 'bg-[var(--ink-accent-soft)] text-[var(--ink-accent-approval)]'
                  : 'ink-text-muted hover:bg-[var(--ink-bg-elevated)]'
              }`}
              onClick={() => onBranchFromLeaf(activeSessionId, node.leaf)}
              onContextMenu={(e) => { e.preventDefault(); onBranchFromLeaf(activeSessionId, node.leaf); }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              <span className="flex-1 truncate">回合 {node.leaf}</span>
              {node.leaf === currentLeaf && <span className="text-[10px] opacity-70">当前</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onRename,
  onDelete,
  onBranchFromMessage,
}: {
  session: SessionRemoteRecord;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onBranchFromMessage: (messageId: string, branchLabel: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);

  return (
    <div
      className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs cursor-pointer ${
        active ? 'bg-[var(--ink-bg-elevated)] text-[var(--ink-text-base)]' : 'ink-text-muted hover:bg-[var(--ink-bg-elevated)]'
      }`}
      onClick={onSelect}
    >
      {renaming ? (
        <input
          autoFocus
          className="ink-input h-6 flex-1 text-xs"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onRename(draft.trim() || session.title); setRenaming(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { onRename(draft.trim() || session.title); setRenaming(false); } }}
        />
      ) : (
        <>
          <MessageSquare size={12} strokeWidth={1.5} className="shrink-0" />
          <span className="flex-1 truncate">{session.title || '未命名会话'}</span>
        </>
      )}
      <div className="relative">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
          className="flex h-5 w-5 items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--ink-bg-surface)]"
        >
          <MoreVertical size={12} strokeWidth={1.5} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-5 z-20 w-28 rounded-md border ink-border bg-[var(--ink-bg-elevated)] py-1 shadow-lg">
            <button type="button" className="flex w-full items-center gap-2 px-2 py-1 text-xs hover:bg-[var(--ink-bg-surface)]" onClick={() => { setRenaming(true); setMenuOpen(false); }}>
              <Pencil size={12} strokeWidth={1.5} /> 重命名
            </button>
            <button type="button" className="flex w-full items-center gap-2 px-2 py-1 text-xs hover:bg-[var(--ink-bg-surface)]" onClick={() => { onBranchFromMessage(session.thread_id, '从此分支'); setMenuOpen(false); }}>
              <ChevronRight size={12} strokeWidth={1.5} /> 由此分支
            </button>
            <button type="button" className="flex w-full items-center gap-2 px-2 py-1 text-xs text-[var(--ink-accent-approval)] hover:bg-[var(--ink-bg-surface)]" onClick={() => { onDelete(); setMenuOpen(false); }}>
              <Trash2 size={12} strokeWidth={1.5} /> 删除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
