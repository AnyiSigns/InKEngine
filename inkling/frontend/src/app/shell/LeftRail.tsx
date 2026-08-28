/**
 * 左栏：品牌行（折叠钮）+ 工作区（授权根目录）+ 底部设置入口。
 * 默认 208px 展开，可折叠为 48px 图标条。
 *
 * 机制/市场导航不进左栏（统一收纳在设置「高级」节，开发者模式可见）；
 * 添加工作区走原生目录选择器 + workspace_authorize（由装配层回调执行）。
 */

import { ChevronLeft, ChevronRight, FolderOpen, FolderPlus, Settings2 } from 'lucide-react';

interface LeftRailProps {
  collapsed: boolean;
  onToggle: () => void;
  authorized: boolean;
  /** 已授权根目录（authorized 时展示；未授权为 null）。 */
  workspaceRoot?: string | null;
  /** 点击添加/更换工作区（装配层弹原生目录选择器并执行授权）。 */
  onAddWorkspace: () => void;
  onOpenSettings: () => void;
}

export function LeftRail({
  collapsed,
  onToggle,
  authorized,
  workspaceRoot,
  onAddWorkspace,
  onOpenSettings,
}: LeftRailProps) {
  const rootName = workspaceRoot ? workspaceRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? workspaceRoot : null;

  return (
    <aside
      className={`ink-rail flex flex-col border-r ink-border transition-all duration-180 ${collapsed ? 'w-12' : 'w-52'}`}
    >
      {/* 品牌行：产品名 + 折叠钮（参考形态：logo 左、折叠图标右） */}
      <div className={`flex h-12 items-center border-b ink-border ${collapsed ? 'justify-center px-2' : 'justify-between px-3'}`}>
        {!collapsed && (
          <span className="text-[13px] font-semibold tracking-tight">InKling</span>
        )}
        <button
          type="button"
          onClick={onToggle}
          className="flex h-7 w-7 items-center justify-center rounded-lg ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          data-ui="left_rail_toggle"
        >
          {collapsed ? <ChevronRight size={15} strokeWidth={1.6} /> : <ChevronLeft size={15} strokeWidth={1.6} />}
        </button>
      </div>

      {/* 工作区 */}
      <div className="flex-1 overflow-y-auto p-2">
        {!collapsed && (
          <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wide ink-text-faint">工作区</div>
        )}
        {authorized && rootName ? (
          <button
            type="button"
            onClick={onAddWorkspace}
            title={workspaceRoot ?? ''}
            data-ui="workspace_root"
            className={`flex w-full items-center gap-2 rounded-lg ink-text-base hover:bg-[var(--ink-bg-elevated)] ${collapsed ? 'justify-center px-0 py-2' : 'px-2 py-1.5'}`}
          >
            <FolderOpen size={15} strokeWidth={1.6} className="shrink-0 ink-text-muted" />
            {!collapsed && <span className="truncate text-[12px]">{rootName}</span>}
          </button>
        ) : (
          <button
            type="button"
            onClick={onAddWorkspace}
            data-ui="workspace_add"
            title="选择目录并授权"
            className={`flex w-full items-center gap-2 rounded-lg border border-dashed ink-border ink-text-muted transition-colors hover:border-[var(--ink-border-strong)] hover:text-[var(--ink-text-base)] ${
              collapsed ? 'justify-center border-0 px-0 py-2' : 'justify-center px-3 py-2.5'
            }`}
          >
            <FolderPlus size={15} strokeWidth={1.6} />
            {!collapsed && <span className="text-[12px]">添加工作区</span>}
          </button>
        )}
      </div>

      {/* 底部设置 */}
      <div className="border-t ink-border p-2">
        <button
          type="button"
          data-ui="nav_settings"
          onClick={onOpenSettings}
          title="设置"
          className={`flex w-full items-center gap-2 rounded-lg ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)] ${
            collapsed ? 'justify-center px-0 py-2' : 'px-2 py-1.5'
          }`}
        >
          <Settings2 size={16} strokeWidth={1.6} />
          {!collapsed && <span className="text-[12px]">设置</span>}
        </button>
      </div>
    </aside>
  );
}
