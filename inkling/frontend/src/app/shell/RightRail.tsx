/**
 * 右栏：会话列表 + 线程分支 mini 树。
 * 全高贯穿窗口右侧（顶栏不再常驻，栏体不被顶栏截断），
 * 默认 256px 展开（会话主导航，参考桌面 agent 产品形态），可折叠为 48px 图标条。
 *
 * 顶部为全宽「新会话」主按钮（参考形态），其下搜索行；会话行 13px
 * 舒适行高 + 右侧相对时间，hover reveal 菜单（重命名/由此分支/删除）。
 */

import { useEffect, useRef, useState } from 'react';
import { Plus, Search, MoreVertical, ChevronRight, ChevronDown, MessageSquare, Trash2, Pencil, PanelLeftClose, PanelLeftOpen, GitBranch } from 'lucide-react';
import type { SessionRemoteRecord, SessionBranchTree } from '@/shared/backend/backendAdapter';

/** 相对时间（会话行右侧：刚刚 / N 分钟 / N 小时 / N 天，超一周落月-日）。 */
function relativeTime(at: number): string {
  if (!at) return '';
  const diff = Date.now() - at;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天`;
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

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
      <aside className="ink-rail flex w-12 shrink-0 flex-col items-center border-l ink-border py-3">
        <button
          type="button"
          onClick={onCreateSession}
          className="mb-1.5 flex h-8 w-8 items-center justify-center rounded-lg ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
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
          <PanelLeftOpen size={15} strokeWidth={1.6} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="ink-rail flex w-64 shrink-0 flex-col border-l ink-border">
      {/* 新会话主按钮 + 搜索/折叠行 */}
      <div className="space-y-2.5 p-3.5">
        <button
          type="button"
          onClick={onCreateSession}
          data-ui="session_create"
          className="ink-btn-secondary flex h-10 w-full items-center justify-center gap-1.5 rounded-xl text-[13px] font-medium"
        >
          <Plus size={15} strokeWidth={1.8} />
          新会话
        </button>
        <div className="flex items-center gap-1.5">
          <div className="ink-input-shell flex h-9 flex-1 items-center gap-2 rounded-xl border ink-border bg-[var(--ink-bg-base)] px-2.5">
            <Search size={14} strokeWidth={1.6} className="shrink-0 ink-text-faint" />
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
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
            title="收起会话列表"
            data-ui="right_rail_collapse"
          >
            <PanelLeftClose size={15} strokeWidth={1.6} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-[12px] ink-text-faint">
            <MessageSquare size={24} strokeWidth={1.5} className="mb-2 opacity-50" />
            <p>发送消息开始对话</p>
          </div>
        )}

        {filtered(today).length > 0 && (
          <div className="mb-2">
            <div className="px-1.5 py-1.5 text-[11px] font-medium tracking-wide ink-text-faint">今日</div>
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
            <div className="px-1.5 py-1.5 text-[11px] font-medium tracking-wide ink-text-faint">历史</div>
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
        className="flex w-full items-center gap-1.5 px-1.5 py-1.5 text-[12px] font-medium ink-text-muted hover:text-[var(--ink-text-base)]"
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
      className={`group relative flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-[13px] ${
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
        <>
          <span className="min-w-0 flex-1 truncate">{session.title || '未命名会话'}</span>
          {/* 相对时间：hover 时让位给操作菜单 */}
          <span className="shrink-0 text-[11px] tabular-nums ink-text-faint transition-opacity group-hover:opacity-0">
            {relativeTime(session.updated_at)}
          </span>
        </>
      )}
      {!renaming && (
      <div className="absolute right-2 top-1/2 -translate-y-1/2" ref={menuRef}>
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
      )}
    </div>
  );
}
