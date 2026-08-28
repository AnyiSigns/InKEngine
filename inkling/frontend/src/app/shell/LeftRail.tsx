/**
 * 左栏：机制/能力导航入口（装配层）+ 文件树（授权挂载点驱动）+ 底部设置/管理台入口。
 * 默认 200px 展开，可折叠为 48px 图标条。
 */

import { ChevronLeft, ChevronRight, FolderPlus, Settings2, LayoutDashboard } from 'lucide-react';

import type { NavEntry } from '@/app/wiring/navEntries';

interface LeftRailProps {
  collapsed: boolean;
  onToggle: () => void;
  authorized: boolean;
  onAddWorkspace: () => void;
  navEntries: NavEntry[];
  onOpenNav: (key: string) => void;
  onOpenSettings: () => void;
  onOpenConsole: () => void;
}

export function LeftRail({
  collapsed,
  onToggle,
  authorized,
  onAddWorkspace,
  navEntries,
  onOpenNav,
  onOpenSettings,
  onOpenConsole,
}: LeftRailProps) {
  return (
    <aside
      className={`ink-rail flex flex-col border-r ink-border transition-all duration-180 ${collapsed ? 'w-12' : 'w-52'}`}
    >
      <div className="flex h-12 items-center justify-between px-3 border-b ink-border">
        {!collapsed && <span className="text-xs font-medium ink-text-muted">工作区</span>}
        <button
          type="button"
          onClick={onToggle}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--ink-bg-elevated)]"
          title={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? <ChevronRight size={14} strokeWidth={1.5} /> : <ChevronLeft size={14} strokeWidth={1.5} />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {authorized ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ink-text-muted">
              <FolderPlus size={14} strokeWidth={1.5} />
              {!collapsed && <span>项目根目录</span>}
            </div>
            <div className="pl-5 space-y-1 text-xs ink-text-faint">
              <div>src/</div>
              <div>inkling/</div>
              <div>README.md</div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={onAddWorkspace}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed ink-border px-3 py-4 text-xs ink-text-muted hover:border-[var(--ink-border-strong)] hover:text-[var(--ink-text-base)]"
          >
            <FolderPlus size={14} strokeWidth={1.5} />
            {!collapsed && <span>添加工作区</span>}
          </button>
        )}

        <div className="mt-3 border-t ink-border pt-2">
          {!collapsed && <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide ink-text-faint">导航</div>}
          <div className="space-y-0.5">
            {navEntries.map((entry) => {
              const Icon = entry.icon;
              return (
                <button
                  key={entry.key}
                  type="button"
                  data-ui={`nav_${entry.key}`}
                  onClick={() => onOpenNav(entry.key)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs ink-text-muted hover:text-[var(--ink-text-base)] hover:bg-[var(--ink-bg-elevated)]"
                  title={entry.label}
                >
                  <Icon size={14} strokeWidth={1.5} className="shrink-0" />
                  {!collapsed && <span className="truncate">{entry.label}</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="border-t ink-border">
        <button
          type="button"
          data-ui="nav_settings"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 px-3 py-2 text-xs ink-text-muted hover:text-[var(--ink-text-base)] hover:bg-[var(--ink-bg-elevated)]"
          title="设置"
        >
          <Settings2 size={16} strokeWidth={1.5} />
          {!collapsed && <span>设置</span>}
        </button>
        <button
          type="button"
          data-ui="nav_console"
          onClick={onOpenConsole}
          className="flex w-full items-center gap-2 px-3 py-2 text-xs ink-text-muted hover:text-[var(--ink-text-base)] hover:bg-[var(--ink-bg-elevated)]"
          title="管理台"
        >
          <LayoutDashboard size={16} strokeWidth={1.5} />
          {!collapsed && <span>管理台</span>}
        </button>
      </div>
    </aside>
  );
}
