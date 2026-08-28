/**
 * 右栏：会话列表 + 线程分支 mini 树。
 * 默认 240px 展开（会话主导航，参考桌面 agent 产品形态），可折叠为 48px 图标条。
 *
 * 顶部为全宽「新会话」主按钮（参考形态），其下搜索行；会话行 13px
 * 舒适行高，hover  reveal 菜单（重命名/由此分支/删除）。
 */

import { useEffect, useRef, useState } from 'react';
import { Plus, Search, MoreVertical, ChevronRight, ChevronDown, MessageSquare, Trash2, Pencil, ChevronLeft, GitBranch } from 'lucide-react';
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
}: RightRailProps) {
  const [query, setQuery] = useState('');
  const today = sessions.filter((s) => Date.now() - s.updated_at < 86400000);
  const history = sessions.filter((s) => Date.now() - s.updated_at >= 86400000);
  const filtered = (list: SessionRemoteRecord[]) =>
    list.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));

  if (collapsed) {
    return (
      <aside className="flex w-12 flex-col items-center border-l ink-border py-2">
        <button
          type="button"
          onClick={onCreateSession}
          className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
          title="新会话"
          data-ui="session_create_collapsed"
        >
          <Plus size={16} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="flex h-8 w-8 items-center justify-center rounded-lg ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
          title="展开会话列表"
          data-ui="right_rail_expand"
        >
          <ChevronRight size={15} strokeWidth={1.6} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-60 flex-col border-l ink-border">
      {/* 新会话主按钮 + 搜索/折叠行 */}
      <div className="space-y-2 border-b ink-border p-2.5">
        <button
          type="button"
          onClick={onCreateSession}
          data-ui="session_create"
          className="ink-btn-secondary flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-medium"
        >
          <Plus size={15} strokeWidth={1.8} />
          新会话
        </button>
        <div className="flex items-center gap-1.5">
          <div className="ink-input-shell flex h-8 flex-1 items-center gap-1.5 rounded-lg border ink-border bg-[var(--ink-bg-base)] px-2">
            <Search size={13} strokeWidth={1.6} className="shrink-0 ink-text-faint" />
            <input
              className="h-full w-full flex-1 border-0 bg-transparent text-[12px] outline-none placeholder:text-[var(--ink-text-faint)]"
              placeholder="搜索会话"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-ui="session_search"
            />
          </div>
          <button
            type="button"
            onClick={onToggle}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
            title="收起会话列表"
            data-ui="right_rail_collapse"
          >
            <ChevronLeft size={15} strokeWidth={1.6} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-[12px] ink-text-faint">
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
    return null;
  }

  const currentLeaf = activeTree.current_leaf;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-[12px] font-medium ink-text-muted hover:text-[var(--ink-text-base)]"
      >
        {expanded ? <ChevronDown size={12} strokeWidth={1.6} /> : <ChevronRight size={12} strokeWidth={1.6} />}
        <GitBranch size={12} strokeWidth={1.6} />
        <span>分支</span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5 pl-2">
          {activeTree.nodes.map((node) => (
            <div
              key={node.leaf}
              className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] ${
                node.leaf === currentLeaf
                  ? 'bg-[var(--ink-bg-elevated)] text-[var(--ink-text-base)]'
                  : 'ink-text-muted hover:bg-[var(--ink-bg-elevated)]'
              }`}
              onClick={() => onBranchFromLeaf(activeSessionId, node.leaf)}
              onContextMenu={(e) => { e.preventDefault(); onBranchFromLeaf(activeSessionId, node.leaf); }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
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
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  return (
    <div
      className={`group relative flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] ${
        active ? 'bg-[var(--ink-bg-elevated)] text-[var(--ink-text-base)]' : 'ink-text-muted hover:bg-[var(--ink-bg-elevated)]'
      }`}
      onClick={onSelect}
      data-active={active}
    >
      {renaming ? (
        <input
          autoFocus
          className="ink-input h-7 flex-1 text-[12px]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => { onRename(draft.trim() || session.title); setRenaming(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { onRename(draft.trim() || session.title); setRenaming(false); } }}
        />
      ) : (
        <span className="flex-1 truncate">{session.title || '未命名会话'}</span>
      )}
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          aria-label="会话操作"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
          className="flex h-6 w-6 items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--ink-bg-surface)]"
        >
          <MoreVertical size={13} strokeWidth={1.6} />
        </button>
        {menuOpen && (
          <div className="ink-menu-pop">
            <button type="button" className="ink-menu-item" onClick={(e) => { e.stopPropagation(); setRenaming(true); setMenuOpen(false); }}>
              <Pencil size={12} strokeWidth={1.6} /> 重命名
            </button>
            <button type="button" className="ink-menu-item" onClick={(e) => { e.stopPropagation(); onBranchFromMessage(session.thread_id, '从此分支'); setMenuOpen(false); }}>
              <GitBranch size={12} strokeWidth={1.6} /> 由此分支
            </button>
            <button type="button" className="ink-menu-item" data-danger="true" onClick={(e) => { e.stopPropagation(); onDelete(); setMenuOpen(false); }}>
              <Trash2 size={12} strokeWidth={1.6} /> 删除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
