/**
 * 分支迷你树（右栏下半）：回合分支的链条呈现。
 *
 * 节点 = 回合（checkpoint），当前叶高亮；父→子经 hairline 连接线
 * 逐层缩进，行首箭头控制展开/收起（旋转 180°）。分支入口两条：
 * 行内消息的「由此分支」（在消息流侧提供）与本树的节点右键
 * 「在此分支」——右键弹上下文菜单，选定节点即开新分支。
 */

import { useMemo, useState } from 'react';

import { ChevronRight, CornerDownRight, GitFork } from 'lucide-react';

import { cn } from '@/shared/cn';
import type { SessionBranchTree } from '@/shared/backend/backendAdapter';

interface BranchTreeProps {
  tree: SessionBranchTree | null;
  onBranchHere: (leaf: number) => void;
}

interface TreeNode {
  leaf: number;
  reason?: string | null;
  parent: number | null;
  children: TreeNode[];
}

interface MenuState {
  leaf: number;
  label: string;
  x: number;
  y: number;
}

function buildTree(tree: SessionBranchTree): TreeNode[] {
  const byLeaf = new Map<number, TreeNode>();
  for (const node of tree.nodes) {
    byLeaf.set(node.leaf, { leaf: node.leaf, reason: node.reason, parent: node.parent, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const node of byLeaf.values()) {
    const parent = node.parent === null ? null : byLeaf.get(node.parent);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortChildren = (node: TreeNode): void => {
    node.children.sort((a, b) => a.leaf - b.leaf);
    for (const child of node.children) sortChildren(child);
  };
  roots.sort((a, b) => a.leaf - b.leaf);
  for (const root of roots) sortChildren(root);
  return roots;
}

export function BranchTree({ tree, onBranchHere }: BranchTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);

  const roots = useMemo(() => (tree ? buildTree(tree) : []), [tree]);
  if (!tree || roots.length === 0) return null;

  const toggle = (leaf: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(leaf)) next.delete(leaf);
      else next.add(leaf);
      return next;
    });
  };

  const openMenu = (e: React.MouseEvent, node: TreeNode): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ leaf: node.leaf, label: node.reason ?? `回合 ${node.leaf}`, x: e.clientX, y: e.clientY });
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isCurrent = node.leaf === tree.current_leaf;
    const isCollapsed = collapsed.has(node.leaf);
    const hasChildren = node.children.length > 0;
    return (
      <div key={node.leaf}>
        <div
          data-ui="branch_node"
          data-current={isCurrent}
          onContextMenu={(e) => openMenu(e, node)}
          className={cn(
            'group flex cursor-pointer items-center gap-1 rounded-md py-0.5 pr-1.5 text-[10px]',
            isCurrent ? 'bg-[var(--ink-bg-elevated)] font-medium' : 'hover:bg-[var(--ink-bg-elevated)]',
          )}
          style={{ paddingLeft: depth * 10 + 6 }}
          onClick={() => {
            if (hasChildren) toggle(node.leaf);
          }}
        >
          {hasChildren ? (
            <ChevronRight
              size={10}
              strokeWidth={1.75}
              className={cn('shrink-0 text-[var(--ink-text-faint)] transition-transform duration-150', !isCollapsed && 'rotate-90')}
              aria-hidden
            />
          ) : (
            <CornerDownRight size={10} strokeWidth={1.6} className="shrink-0 text-[var(--ink-text-faint)]" aria-hidden />
          )}
          <span className={cn('min-w-0 flex-1 truncate', isCurrent ? 'ink-text-base' : 'ink-text-muted')}>
            {node.reason ?? `回合 ${node.leaf}`}
          </span>
          {isCurrent && <span className="ink-chip shrink-0 py-px text-[8px] ink-text-faint">当前</span>}
        </div>
        {!isCollapsed && node.children.length > 0 && (
          <div className="relative ml-[9px] border-l border-[var(--ink-border)]">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-col border-t border-[var(--ink-border)]">
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2">
        <GitFork size={11} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        <span className="text-[11px] font-medium">分支</span>
      </div>
      <div className="ink-scroll-auto min-h-0 flex-1 pb-2 pr-1">
        {roots.map((node) => renderNode(node, 0))}
      </div>
      {menu && (
        <div
          data-ui="branch_context_menu"
          className="ink-panel ink-pop-in ink-z-card fixed z-[var(--ink-z-card)] px-1 py-1"
          style={{ left: menu.x, top: menu.y }}
          onMouseLeave={() => setMenu(null)}
        >
          <button
            type="button"
            data-ui="branch_branch_here"
            onClick={() => {
              onBranchHere(menu.leaf);
              setMenu(null);
            }}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[10px] cursor-pointer text-left hover:bg-[var(--ink-bg-elevated)] bg-transparent border-none"
          >
            <GitFork size={10} strokeWidth={1.6} aria-hidden />
            在此分支
            <span className="ml-1 truncate ink-text-faint">{menu.label}</span>
          </button>
        </div>
      )}
    </div>
  );
}
